"""Sincroniza heartbeats gravados pelos agentes no Firebase Realtime Database."""

from __future__ import annotations

import logging
import re
import time
from datetime import datetime, timezone
from typing import Any

from panel.firebase_client import get_rtdb_reference, rtdb_status
from panel.lav60_env import env_bool, env_value

log = logging.getLogger("lav60.heartbeat_rtdb")

_STORE_CODE_RE = re.compile(r"^[a-z]{2}\d+$", re.I)
_SKIP_ROOT_KEYS = frozenset(
    {
        "heartbeats",
        "audit_logs",
        "config",
        "panel",
        "settings",
        "metadata",
    }
)


def enabled() -> bool:
    if env_bool("FIREBASE_RTD_HEARTBEAT_DISABLED"):
        return False
    if not rtdb_status().get("available"):
        return False
    if env_bool("FIREBASE_RTD_HEARTBEAT_ENABLED", default=False):
        return True
    if env_bool("FIREBASE_RTDB_ENABLED", default=False):
        return True
    return bool(env_value("FIREBASE_DATABASE_URL"))


def heartbeat_path() -> str:
    """Vazio = raiz do RTDB (/PB11/heartbeat, /PB11/gateway_heartbeat, …)."""
    raw = env_value("FIREBASE_RTD_HEARTBEAT_PATH")
    if not raw or raw.lower() in {"root", "/"}:
        return ""
    return str(raw).strip().strip("/")


def heartbeat_path_label() -> str:
    path = heartbeat_path()
    return f"/{path}" if path else "/"


def _normalize_store_id(store_id: str) -> str:
    return str(store_id or "").strip().lower()


def _looks_like_store_id(key: str) -> bool:
    clean = str(key or "").strip()
    if not clean or clean.lower() in _SKIP_ROOT_KEYS:
        return False
    return bool(_STORE_CODE_RE.match(clean))


def _ms_to_seconds(value: Any) -> float | None:
    if not isinstance(value, (int, float)):
        return None
    fv = float(value)
    if fv <= 0:
        return None
    if fv > 1e12:
        return fv / 1000.0
    if fv > 1e9:
        return fv / 1000.0
    return fv


def _received_at_seconds(raw: dict[str, Any]) -> float:
    for key in ("received_at_ms", "updated_at_ms", "timestamp_ms", "sent_at_ms"):
        parsed = _ms_to_seconds(raw.get(key))
        if parsed is not None:
            return parsed

    for key in ("received_at", "updated_at", "timestamp", "ts", "sent_at"):
        value = raw.get(key)
        if isinstance(value, (int, float)):
            fv = float(value)
            if fv > 1e12:
                return fv / 1000.0
            return fv

    return time.time()


def _extract_agent_received_at_ms(node: dict[str, Any]) -> int | None:
    heartbeat_raw = node.get("heartbeat")
    if isinstance(heartbeat_raw, (int, float)):
        return int(heartbeat_raw)
    if isinstance(heartbeat_raw, dict):
        for key in ("timestamp", "updated_at_ms", "received_at_ms", "ts"):
            value = heartbeat_raw.get(key)
            if isinstance(value, (int, float)):
                return int(value)

    pc_status = node.get("pc_status")
    if isinstance(pc_status, dict):
        value = pc_status.get("timestamp")
        if isinstance(value, (int, float)):
            return int(value)

    gateway = node.get("gateway_heartbeat")
    if isinstance(gateway, dict):
        for key in ("updated_at_ms", "received_at_ms", "timestamp", "timestamp_ms"):
            value = gateway.get(key)
            if isinstance(value, (int, float)):
                return int(value)

    return None


def _build_payload(store_id: str, raw: dict[str, Any]) -> dict[str, Any]:
    sid = _normalize_store_id(store_id)
    nested = raw.get("payload")
    if isinstance(nested, dict):
        payload = {**nested, **{k: v for k, v in raw.items() if k not in {"payload", "store"}}}
    else:
        payload = dict(raw)
    payload["store"] = _normalize_store_id(payload.get("store") or sid)
    payload.setdefault("heartbeat_source", "rtdb")
    return payload


def normalize_agent_store_node(store_id: str, node: dict[str, Any]) -> dict[str, Any] | None:
    """Formato LAV60 Gateway: /PB11/heartbeat + /PB11/gateway_heartbeat + /PB11/pc_status."""
    sid = _normalize_store_id(store_id)
    if not sid or not isinstance(node, dict):
        return None

    gateway = node.get("gateway_heartbeat")
    if not isinstance(gateway, dict):
        gateway = {}

    received_at_ms = _extract_agent_received_at_ms(node)
    if received_at_ms is None:
        return None

    received_at = float(received_at_ms) / 1000.0
    payload = dict(gateway)
    payload["store"] = sid
    payload.setdefault("heartbeat_source", "rtdb")

    heartbeat_raw = node.get("heartbeat")
    if heartbeat_raw is not None:
        payload["heartbeat"] = heartbeat_raw

    if isinstance(node.get("pc_status"), dict):
        payload["pc_status"] = node["pc_status"]

    for key in ("agent_online_since_ms", "agent_url", "lav60_status"):
        if payload.get(key) is None and node.get(key) is not None:
            payload[key] = node.get(key)

    return {
        "store": sid,
        "received_at": received_at,
        "received_at_iso": datetime.fromtimestamp(received_at, tz=timezone.utc).isoformat(),
        "payload": payload,
        "heartbeat_source": "rtdb",
    }


def normalize_rtdb_entry(store_id: str, raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    sid = _normalize_store_id(store_id or raw.get("store"))
    if not sid:
        return None

    if "gateway_heartbeat" in raw or "heartbeat" in raw or "pc_status" in raw:
        return normalize_agent_store_node(sid, raw)

    payload = _build_payload(sid, raw)
    received_at = _received_at_seconds(raw)
    return {
        "store": sid,
        "received_at": received_at,
        "received_at_iso": datetime.fromtimestamp(received_at, tz=timezone.utc).isoformat(),
        "payload": payload,
        "heartbeat_source": "rtdb",
    }


def _fetch_agent_root_rows(data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    for store_id, node in data.items():
        if not _looks_like_store_id(store_id) or not isinstance(node, dict):
            continue
        entry = normalize_agent_store_node(str(store_id), node)
        if entry:
            rows[entry["store"]] = entry
    return rows


def _fetch_legacy_collection_rows(data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    first_key = next(iter(data), None)
    first_val = data.get(first_key) if first_key else None

    if isinstance(first_val, dict) and (
        first_val.get("store")
        or first_val.get("network")
        or first_val.get("lav60_status")
        or first_val.get("agent_online_since_ms") is not None
        or "gateway_heartbeat" in first_val
    ):
        for store_id, raw in data.items():
            entry = normalize_rtdb_entry(str(store_id), raw)
            if entry:
                rows[entry["store"]] = entry
        return rows

    for store_id, raw in data.items():
        if not isinstance(raw, dict):
            continue
        if any(
            key in raw
            for key in (
                "store",
                "network",
                "lav60_status",
                "agent_online_since_ms",
                "received_at",
                "gateway_heartbeat",
                "heartbeat",
            )
        ):
            entry = normalize_rtdb_entry(str(store_id), raw)
            if entry:
                rows[entry["store"]] = entry
            continue
        for nested_id, nested_raw in raw.items():
            entry = normalize_rtdb_entry(str(nested_id or store_id), nested_raw)
            if entry:
                rows[entry["store"]] = entry
    return rows


def fetch_rtdb_heartbeat_rows() -> dict[str, dict[str, Any]]:
    global _last_root_keys

    path = heartbeat_path()
    ref = get_rtdb_reference(path or "/")
    data = ref.get()
    if not isinstance(data, dict) or not data:
        _last_root_keys = []
        return {}

    if not path:
        _last_root_keys = sorted(str(key) for key in data.keys())
        rows = _fetch_agent_root_rows(data)
        if rows:
            return rows

    _last_root_keys = sorted(str(key) for key in data.keys())
    return _fetch_legacy_collection_rows(data)


def sync_status() -> dict[str, Any]:
    base = rtdb_status()
    base.update(
        {
            "enabled": enabled(),
            "path": heartbeat_path_label(),
            "layout": "agent_root" if not heartbeat_path() else "collection",
        }
    )
    return base


_last_sync_at = 0.0
_last_sync_count = 0
_last_sync_error: str | None = None
_last_sync_stores: list[str] = []
_last_applied_stores: list[str] = []
_last_root_keys: list[str] = []
_last_missing_online_since: list[str] = []
_first_sync_logged = False


def _stores_missing_online_since(rows: dict[str, dict[str, Any]]) -> list[str]:
    missing: list[str] = []
    for sid, entry in rows.items():
        payload = entry.get("payload") if isinstance(entry.get("payload"), dict) else {}
        if payload.get("agent_online_since_ms") is None:
            missing.append(_normalize_store_id(sid))
    return sorted(s for s in missing if s)


def _format_store_list(stores: list[str], limit: int = 40) -> str:
    if not stores:
        return "—"
    if len(stores) <= limit:
        return ", ".join(stores)
    head = ", ".join(stores[:limit])
    return f"{head}, … (+{len(stores) - limit})"


def _ensure_log_config() -> None:
    if logging.getLogger().handlers:
        return
    logging.basicConfig(
        level=logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )


def _log_first_sync(rows: dict[str, dict[str, Any]], applied_stores: list[str]) -> None:
    global _first_sync_logged
    if _first_sync_logged:
        return
    _first_sync_logged = True
    _ensure_log_config()

    found = sorted(rows.keys())
    path = heartbeat_path_label()
    layout = "agent_root" if not heartbeat_path() else "collection"

    if found:
        log.info(
            "RTDB heartbeat 1ª sync | path=%s layout=%s | encontradas=%d [%s] | aplicadas=%d [%s]",
            path,
            layout,
            len(found),
            _format_store_list(found),
            len(applied_stores),
            _format_store_list(sorted(applied_stores)),
        )
        samples: list[str] = []
        now = time.time()
        for sid in found[:12]:
            entry = rows.get(sid) or {}
            payload = entry.get("payload") if isinstance(entry.get("payload"), dict) else {}
            age = max(0.0, now - float(entry.get("received_at") or now))
            online_since = payload.get("agent_online_since_ms")
            samples.append(
                f"{sid.upper()}(age={age:.0f}s"
                + (f", online_since={online_since}" if online_since is not None else "")
                + ")"
            )
        if samples:
            log.info("RTDB heartbeat amostra: %s", " · ".join(samples))
        missing_online = _stores_missing_online_since(rows)
        if missing_online:
            log.warning(
                "RTDB heartbeat sem agent_online_since_ms em gateway_heartbeat — "
                "card não mostra 'Online há…' | lojas: [%s] — "
                "agente deve enviar agent_online_since_ms (Unix ms, fixo enquanto online)",
                _format_store_list(missing_online),
            )
        return

    root_keys = _last_root_keys or []
    log.warning(
        "RTDB heartbeat 1ª sync | path=%s layout=%s | nenhuma loja encontrada | "
        "root_keys=%d [%s] — confira FIREBASE_RTD_HEARTBEAT_PATH e formato /PB11/heartbeat",
        path,
        layout,
        len(root_keys),
        _format_store_list(root_keys, limit=25),
    )


def last_sync_meta() -> dict[str, Any]:
    return {
        "last_sync_at": _last_sync_at,
        "last_sync_count": _last_sync_count,
        "last_sync_error": _last_sync_error,
        "stores_found": list(_last_sync_stores),
        "stores_applied": list(_last_applied_stores),
        "root_keys_sample": list(_last_root_keys[:40]),
        "stores_missing_online_since": list(_last_missing_online_since),
        "first_sync_logged": _first_sync_logged,
    }


def sync_into(merge_fn) -> int:
    """Lê RTDB e chama merge_fn(entry) para cada loja. Retorna quantidade aplicada."""
    global _last_sync_count, _last_applied_stores
    rows = fetch_and_record_rows()
    if not rows and _last_sync_error:
        return 0
    applied = 0
    applied_stores: list[str] = []
    for entry in rows.values():
        if merge_fn(entry):
            applied += 1
            applied_stores.append(str(entry.get("store") or ""))
    _last_applied_stores = sorted(s for s in applied_stores if s)
    _last_sync_count = applied
    if applied and log.isEnabledFor(logging.DEBUG):
        log.debug(
            "RTDB heartbeat sync | aplicadas=%d [%s]",
            applied,
            _format_store_list(_last_applied_stores),
        )
    return applied


def fetch_and_record_rows() -> dict[str, dict[str, Any]]:
    """Lê RTDB e atualiza meta; NÃO aplica merges (fazer no event loop)."""
    global _last_sync_at, _last_sync_count, _last_sync_error
    global _last_sync_stores, _last_applied_stores, _last_missing_online_since

    if not enabled():
        _last_sync_count = 0
        _last_sync_error = None
        _last_sync_stores = []
        _last_applied_stores = []
        _last_missing_online_since = []
        return {}

    try:
        rows = fetch_rtdb_heartbeat_rows()
        _last_sync_stores = sorted(rows.keys())
        _last_missing_online_since = _stores_missing_online_since(rows)
        _last_sync_at = time.time()
        _last_sync_count = len(rows)
        _last_sync_error = None
        _last_applied_stores = []
        _log_first_sync(rows, list(rows.keys()))
        return rows
    except Exception as exc:
        _last_sync_at = time.time()
        _last_sync_count = 0
        _last_sync_error = str(exc)
        _last_sync_stores = []
        _last_applied_stores = []
        _last_missing_online_since = []
        if not _first_sync_logged:
            log.exception("RTDB heartbeat 1ª sync falhou: %s", exc)
        else:
            log.warning("RTDB heartbeat sync falhou: %s", exc)
        return {}
