"""Cache Firestore de status das lojas (heartbeat + config leve).

Leituras da API usam memória local (heartbeats). Firestore é persistência assíncrona
com intervalo mínimo por loja para reduzir custo de leitura/escrita.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from typing import Any

from panel.lav60_env import ROOT, env_bool, env_value

_db = None
_init_error: str | None = None
_memory: dict[str, dict[str, Any]] = {}
_memory_lock = threading.Lock()
_CONFIG_TTL = 300.0
_write_queue: dict[str, dict[str, Any]] = {}
_write_lock = threading.Lock()
_writer_started = False
_last_firestore_write: dict[str, float] = {}
_hydrated = False


def _write_interval_seconds() -> float:
    raw = env_value("FIREBASE_STATUS_WRITE_INTERVAL_SEC") or "45"
    try:
        return max(10.0, float(raw))
    except (TypeError, ValueError):
        return 45.0


def _read_from_firestore_enabled() -> bool:
    return env_bool("FIREBASE_STATUS_READ_FIRESTORE", default=False)


def _hydrate_on_start_enabled() -> bool:
    return env_bool("FIREBASE_STATUS_HYDRATE_ON_START", default=False)


def _normalize_store_id(store_id: str) -> str:
    return str(store_id or "").strip().lower()


def _collection_name() -> str:
    name = env_value("FIREBASE_STATUS_COLLECTION") or "store_status"
    return str(name).strip().strip("/") or "store_status"


def _service_account_path():
    raw = env_value("FIREBASE_SERVICE_ACCOUNT_FILE")
    if not raw:
        return None
    from pathlib import Path

    path = Path(raw)
    if not path.is_absolute():
        path = ROOT / raw
    return path if path.is_file() else None


def _get_db():
    global _db, _init_error
    if _db is not None:
        return _db
    if _init_error:
        raise RuntimeError(_init_error)

    path = _service_account_path()
    if not path:
        raise RuntimeError("Firebase service account não configurado")

    try:
        import firebase_admin
        from firebase_admin import credentials, firestore
    except ImportError as exc:
        _init_error = "Instale firebase-admin: pip install firebase-admin"
        raise RuntimeError(_init_error) from exc

    try:
        if not firebase_admin._apps:
            cred = credentials.Certificate(str(path))
            firebase_admin.initialize_app(cred)
        _db = firestore.client()
        return _db
    except Exception as exc:
        _init_error = str(exc)
        raise RuntimeError(_init_error) from exc


def status_cache_status() -> dict[str, Any]:
    if not _service_account_path():
        return {
            "available": False,
            "reason": "status_cache_not_configured",
            "hint": "Configure FIREBASE_SERVICE_ACCOUNT_FILE no .env",
        }
    try:
        _get_db()
        with _memory_lock:
            memory_count = len(_memory)
        return {
            "available": True,
            "collection": _collection_name(),
            "read_source": "firestore" if _read_from_firestore_enabled() else "memory",
            "write_interval_seconds": _write_interval_seconds(),
            "memory_count": memory_count,
        }
    except Exception as exc:
        return {"available": False, "reason": "firestore_error", "hint": str(exc)}


def _compact_machines(machines: Any, limit: int = 24) -> list[dict[str, Any]]:
    if not isinstance(machines, list):
        return []
    out: list[dict[str, Any]] = []
    for row in machines[:limit]:
        if not isinstance(row, dict):
            continue
        out.append(
            {
                "id": row.get("id"),
                "type": row.get("type") or row.get("machine_type"),
                "status": row.get("status") or row.get("status_raw"),
                "status_label": row.get("status_label"),
                "machine_type_label": row.get("machine_type_label"),
                "online": row.get("online"),
            }
        )
    return out


def _compact_config(config: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(config, dict):
        return {}
    return {
        "store": _normalize_store_id(config.get("store") or ""),
        "token_required": bool(config.get("token_required")),
        "devices": config.get("devices") if isinstance(config.get("devices"), dict) else {},
        "washer_am_options": config.get("washer_am_options") or [],
        "washer_dosage_options": config.get("washer_dosage_options") or [],
        "doser_types": config.get("doser_types") or [],
        "dryer_minutes": config.get("dryer_minutes") or [],
        "ac_temperatures": config.get("ac_temperatures") or [],
        "machines": _compact_machines(config.get("machines")),
        "agent_url": config.get("agent_url"),
        "network_check_interval": config.get("network_check_interval"),
    }


def _build_doc_from_heartbeat(store_id: str, entry: dict[str, Any], timeout_seconds: int) -> dict[str, Any]:
    sid = _normalize_store_id(store_id)
    payload = entry.get("payload") if isinstance(entry.get("payload"), dict) else {}
    received_at = entry.get("received_at")
    if isinstance(received_at, (int, float)) and received_at > 1e12:
        received_at = float(received_at) / 1000.0
    received_at = float(received_at or time.time())
    age = max(0.0, time.time() - received_at)
    network = payload.get("network") if isinstance(payload.get("network"), dict) else {}
    if not network and isinstance(payload.get("lav60_status"), str):
        network = {}

    doc: dict[str, Any] = {
        "store": sid,
        "received_at": received_at,
        "received_at_iso": entry.get("received_at_iso")
        or datetime.fromtimestamp(received_at, tz=timezone.utc).isoformat(),
        "updated_at_ms": int(time.time() * 1000),
        "lav60_status": str(payload.get("lav60_status") or entry.get("lav60_status") or "ok").lower(),
        "agent_url": payload.get("agent_url") or entry.get("agent_url"),
        "network": network,
        "machines": _compact_machines(payload.get("machines")),
        "alive": age <= timeout_seconds,
        "age_seconds": round(age, 1),
        "timeout_seconds": timeout_seconds,
        "source": "heartbeat",
    }
    last_check = payload.get("last_network_check")
    if isinstance(last_check, dict):
        doc["last_network_check"] = last_check
    return doc


def _memory_set(store_id: str, data: dict[str, Any]) -> None:
    sid = _normalize_store_id(store_id)
    with _memory_lock:
        existing = _memory.get(sid)
        if existing and isinstance(data, dict):
            merged = dict(existing)
            merged.update(data)
            _memory[sid] = merged
        else:
            _memory[sid] = dict(data)


def _memory_get(store_id: str) -> dict[str, Any] | None:
    sid = _normalize_store_id(store_id)
    with _memory_lock:
        row = _memory.get(sid)
        return dict(row) if row else None


def _memory_all() -> dict[str, dict[str, Any]]:
    with _memory_lock:
        return {sid: dict(row) for sid, row in _memory.items()}


def _hydrate_from_firestore_once() -> None:
    global _hydrated
    if _hydrated or not _service_account_path():
        return
    if not (_hydrate_on_start_enabled() or _read_from_firestore_enabled()):
        _hydrated = True
        return
    try:
        db = _get_db()
        for snap in db.collection(_collection_name()).limit(800).stream():
            data = snap.to_dict() or {}
            sid = _normalize_store_id(snap.id)
            _memory_set(sid, data)
    except Exception:
        pass
    _hydrated = True


def _ensure_writer() -> None:
    global _writer_started

    def _loop() -> None:
        while True:
            time.sleep(0.5)
            batch: list[dict[str, Any]] = []
            with _write_lock:
                if _write_queue:
                    batch = list(_write_queue.values())[:20]
            if not batch:
                continue

            interval = _write_interval_seconds()
            now = time.time()
            for item in batch:
                sid = item["store"]
                force = bool(item.get("force"))
                last = _last_firestore_write.get(sid, 0.0)
                if not force and now - last < interval:
                    continue
                latest = _memory_get(sid) or item.get("data") or {}
                try:
                    _firestore_set(sid, latest, merge=item.get("merge", True))
                    _last_firestore_write[sid] = time.time()
                    with _write_lock:
                        _write_queue.pop(sid, None)
                except Exception:
                    pass

    with _write_lock:
        if _writer_started:
            return
        _writer_started = True
    _hydrate_from_firestore_once()
    threading.Thread(target=_loop, name="lav60-status-store-writer", daemon=True).start()


def _firestore_set(store_id: str, data: dict[str, Any], *, merge: bool = True) -> None:
    db = _get_db()
    sid = _normalize_store_id(store_id)
    ref = db.collection(_collection_name()).document(sid)
    if merge:
        ref.set(data, merge=True)
    else:
        ref.set(data)


def _read_doc_from_firestore(store_id: str) -> dict[str, Any] | None:
    sid = _normalize_store_id(store_id)
    try:
        db = _get_db()
        snap = db.collection(_collection_name()).document(sid).get()
        if not snap.exists:
            return None
        data = snap.to_dict() or {}
        _memory_set(sid, data)
        return data
    except Exception:
        return None


def _read_doc(store_id: str) -> dict[str, Any] | None:
    doc = _memory_get(store_id)
    if doc:
        return doc
    if _read_from_firestore_enabled():
        return _read_doc_from_firestore(store_id)
    return None


def _queue_write(
    store_id: str,
    data: dict[str, Any],
    *,
    merge: bool = True,
    force_firestore: bool = False,
) -> None:
    if not _service_account_path():
        _memory_set(store_id, data)
        return
    sid = _normalize_store_id(store_id)
    _memory_set(sid, data)
    _ensure_writer()
    with _write_lock:
        _write_queue[sid] = {
            "store": sid,
            "data": dict(_memory_get(sid) or data),
            "merge": merge,
            "force": force_firestore,
        }


def ingest_heartbeat_entry(store_id: str, entry: dict[str, Any], timeout_seconds: int = 60) -> None:
    if not entry:
        return
    doc = _build_doc_from_heartbeat(store_id, entry, timeout_seconds)
    _queue_write(store_id, doc, merge=True)


def ingest_agent_config(store_id: str, config: dict[str, Any]) -> None:
    if not config:
        return
    sid = _normalize_store_id(store_id)
    snapshot = _compact_config(config)
    snapshot["config_updated_at_ms"] = int(time.time() * 1000)
    _queue_write(
        sid,
        {
            "store": sid,
            "config_snapshot": snapshot,
            "updated_at_ms": int(time.time() * 1000),
            "source_config": "agent",
        },
        merge=True,
        force_firestore=True,
    )


def _public_doc(raw: dict[str, Any] | None, timeout_seconds: int = 60) -> dict[str, Any] | None:
    if not raw:
        return None
    doc = dict(raw)
    received_at = doc.get("received_at")
    if isinstance(received_at, (int, float)):
        if received_at > 1e12:
            received_at = float(received_at) / 1000.0
        age = max(0.0, time.time() - float(received_at))
        doc["age_seconds"] = round(age, 1)
        doc["alive"] = age <= timeout_seconds
    doc["timeout_seconds"] = timeout_seconds
    config_snap = doc.get("config_snapshot")
    if isinstance(config_snap, dict):
        cfg_age_ms = int(config_snap.get("config_updated_at_ms") or doc.get("updated_at_ms") or 0)
        doc["config_fresh"] = cfg_age_ms > 0 and (time.time() * 1000 - cfg_age_ms) <= _CONFIG_TTL * 1000
    return doc


def get_store_cache(store_id: str, timeout_seconds: int = 60) -> dict[str, Any]:
    base = status_cache_status()
    if not base.get("available"):
        return {**base, "store": _normalize_store_id(store_id)}

    doc = _read_doc(store_id)
    if not doc:
        return {
            "available": True,
            "store": _normalize_store_id(store_id),
            "hit": False,
            "timeout_seconds": timeout_seconds,
            "read_source": base.get("read_source"),
        }

    public = _public_doc(doc, timeout_seconds) or {}
    return {
        "available": True,
        "hit": True,
        "store": _normalize_store_id(store_id),
        "read_source": base.get("read_source"),
        **public,
    }


def list_store_cache(timeout_seconds: int = 60, limit: int = 800) -> dict[str, Any]:
    base = status_cache_status()
    if not base.get("available"):
        return {**base, "stores": {}}

    stores: dict[str, Any] = {}
    rows = _memory_all()
    if not rows and _read_from_firestore_enabled():
        _hydrate_from_firestore_once()
        rows = _memory_all()

    for sid, data in list(rows.items())[:limit]:
        public = _public_doc(data, timeout_seconds)
        if public:
            stores[sid] = public

    return {
        "available": True,
        "collection": _collection_name(),
        "timeout_seconds": timeout_seconds,
        "count": len(stores),
        "stores": stores,
        "read_source": base.get("read_source"),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
