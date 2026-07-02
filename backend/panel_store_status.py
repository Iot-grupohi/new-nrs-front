"""Status operacional das lojas — Firestore (preferencial) + arquivo local."""
from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from lav60_env import env_value
from panel_auth import firebase_init_error, init_firebase_admin, service_account_configured
from panel_stores import normalize_store_id

_STATUS_LOCK = threading.Lock()
_STATUS_FILE = Path(__file__).resolve().parent.parent / 'data' / 'store_status.json'
_STATUS_VERSION = 1


def status_collection() -> str:
    name = (env_value('FIREBASE_STORE_STATUS_COLLECTION') or 'store_status').strip().strip('/')
    return name or 'store_status'


def status_persistence_available() -> bool:
    return _STATUS_FILE.parent.exists() or True


def firestore_status_available() -> bool:
    return bool(service_account_configured() and init_firebase_admin())


def status_unavailable_payload() -> dict[str, Any]:
    return {
        'available': False,
        'detail': 'store_status_unavailable',
        'reason': firebase_init_error() or 'persistence_unavailable',
    }


def _now_ms() -> int:
    return int(time.time() * 1000)


def _empty_store_row(store_id: str) -> dict[str, Any]:
    sid = normalize_store_id(store_id)
    return {
        'store': sid,
        'agent_last_seen_at_ms': None,
        'agent_offline_since_ms': None,
        'gateway_online': None,
        'gateway_error': None,
        'gateway_checked_at_ms': None,
        'gateway_offline_since_ms': None,
        'updated_at_ms': None,
    }


def _load_file_root() -> dict[str, Any]:
    try:
        raw = json.loads(_STATUS_FILE.read_text(encoding='utf-8'))
    except Exception:
        return {'version': _STATUS_VERSION, 'stores': {}}
    if not isinstance(raw, dict):
        return {'version': _STATUS_VERSION, 'stores': {}}
    stores = raw.get('stores')
    if not isinstance(stores, dict):
        stores = {}
    return {'version': _STATUS_VERSION, 'stores': stores}


def _save_file_root(root: dict[str, Any]) -> None:
    _STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
    _STATUS_FILE.write_text(json.dumps(root, ensure_ascii=False, indent=2), encoding='utf-8')


def _read_store_raw(store_id: str) -> dict[str, Any]:
    sid = normalize_store_id(store_id)
    if not sid:
        return _empty_store_row('')
    with _STATUS_LOCK:
        root = _load_file_root()
        row = root['stores'].get(sid)
        if isinstance(row, dict):
            merged = _empty_store_row(sid)
            merged.update(row)
            merged['store'] = sid
            return merged
    return _empty_store_row(sid)


def _write_store_raw(store_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    sid = normalize_store_id(store_id)
    if not sid:
        return _empty_store_row('')
    now_ms = _now_ms()
    with _STATUS_LOCK:
        root = _load_file_root()
        prev = root['stores'].get(sid)
        row = _empty_store_row(sid)
        if isinstance(prev, dict):
            row.update(prev)
        row.update(patch)
        row['store'] = sid
        row['updated_at_ms'] = now_ms
        root['stores'][sid] = row
        _save_file_root(root)
    _write_firestore_row(sid, row)
    return row


def _write_firestore_row(store_id: str, row: dict[str, Any]) -> None:
    if not firestore_status_available():
        return
    sid = normalize_store_id(store_id)
    if not sid:
        return
    try:
        from firebase_admin import firestore

        firestore.client().collection(status_collection()).document(sid).set(row, merge=True)
    except Exception:
        pass


def _read_firestore_row(store_id: str) -> dict[str, Any] | None:
    if not firestore_status_available():
        return None
    sid = normalize_store_id(store_id)
    if not sid:
        return None
    try:
        from firebase_admin import firestore

        snap = firestore.client().collection(status_collection()).document(sid).get()
        if not snap.exists:
            return None
        data = snap.to_dict() or {}
        if not isinstance(data, dict):
            return None
        merged = _empty_store_row(sid)
        merged.update(data)
        merged['store'] = sid
        return merged
    except Exception:
        return None


def _load_store_raw(store_id: str) -> dict[str, Any]:
    fs_row = _read_firestore_row(store_id)
    file_row = _read_store_raw(store_id)
    if not fs_row:
        return file_row
    merged = _empty_store_row(store_id)
    merged.update(file_row)
    merged.update(fs_row)
    merged['store'] = normalize_store_id(store_id)
    return merged


def _truncate_error(value: Any, limit: int = 480) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text if len(text) <= limit else text[: limit - 1] + '…'


def enrich_store_status_row(row: dict[str, Any], *, heartbeat_timeout_seconds: int) -> dict[str, Any]:
    sid = normalize_store_id(row.get('store'))
    now_ms = _now_ms()
    timeout_ms = max(1, int(heartbeat_timeout_seconds)) * 1000
    last_seen = row.get('agent_last_seen_at_ms')
    agent_alive = False
    if last_seen is not None:
        try:
            agent_alive = (now_ms - int(last_seen)) <= timeout_ms
        except (TypeError, ValueError):
            agent_alive = False

    agent_offline_since = row.get('agent_offline_since_ms')
    if not agent_alive and last_seen is not None:
        if agent_offline_since is None:
            agent_offline_since = int(last_seen) + timeout_ms
            _write_store_raw(sid, {'agent_offline_since_ms': agent_offline_since})
    elif agent_alive:
        agent_offline_since = None

    gateway_online = row.get('gateway_online')
    gateway_offline_since = row.get('gateway_offline_since_ms')
    if gateway_online is False and gateway_offline_since is None and row.get('gateway_checked_at_ms'):
        gateway_offline_since = row.get('gateway_checked_at_ms')

    checked_ms = row.get('gateway_checked_at_ms')
    return {
        'store': sid,
        'agent_alive': agent_alive,
        'agent_last_seen_at_ms': last_seen,
        'agent_last_seen_at': _ms_to_iso(last_seen),
        'agent_offline_since_ms': agent_offline_since if not agent_alive else None,
        'agent_offline_since': _ms_to_iso(agent_offline_since if not agent_alive else None),
        'gateway_online': gateway_online if gateway_online is not None else None,
        'gateway_error': row.get('gateway_error'),
        'gateway_checked_at_ms': checked_ms,
        'gateway_checked_at': _ms_to_iso(checked_ms),
        'gateway_offline_since_ms': gateway_offline_since if gateway_online is False else None,
        'gateway_offline_since': _ms_to_iso(gateway_offline_since if gateway_online is False else None),
        'updated_at_ms': row.get('updated_at_ms'),
        'updated_at': _ms_to_iso(row.get('updated_at_ms')),
    }


def _ms_to_iso(value: Any) -> str | None:
    if value is None:
        return None
    try:
        ms = int(value)
    except (TypeError, ValueError):
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def record_agent_seen(store_id: str, *, name: str | None = None) -> dict[str, Any]:
    sid = normalize_store_id(store_id)
    if not sid:
        return _empty_store_row('')
    now_ms = _now_ms()
    patch: dict[str, Any] = {
        'agent_last_seen_at_ms': now_ms,
        'agent_offline_since_ms': None,
    }
    if name:
        patch['name'] = str(name).strip()[:120]
    row = _write_store_raw(sid, patch)
    return row


def record_gateway_status(
    store_id: str,
    online: bool,
    error: str | None = None,
    *,
    heartbeat_timeout_seconds: int = 60,
) -> dict[str, Any]:
    sid = normalize_store_id(store_id)
    now_ms = _now_ms()
    prev = _load_store_raw(sid)
    patch: dict[str, Any] = {
        'gateway_online': bool(online),
        'gateway_error': None if online else _truncate_error(error),
        'gateway_checked_at_ms': now_ms,
    }
    if online:
        patch['gateway_offline_since_ms'] = None
    elif prev.get('gateway_online') is True or prev.get('gateway_offline_since_ms') is None:
        patch['gateway_offline_since_ms'] = now_ms
    row = _write_store_raw(sid, patch)
    return enrich_store_status_row(row, heartbeat_timeout_seconds=heartbeat_timeout_seconds)


def get_store_status(store_id: str, *, heartbeat_timeout_seconds: int = 60) -> dict[str, Any]:
    row = _load_store_raw(store_id)
    return enrich_store_status_row(row, heartbeat_timeout_seconds=heartbeat_timeout_seconds)


def list_store_statuses(
    store_ids: list[str] | None = None,
    *,
    heartbeat_timeout_seconds: int = 60,
) -> list[dict[str, Any]]:
    with _STATUS_LOCK:
        root = _load_file_root()
        file_ids = set(root.get('stores') or {})
    ids: set[str] = set()
    if store_ids:
        for raw in store_ids:
            sid = normalize_store_id(raw)
            if sid:
                ids.add(sid)
    else:
        ids.update(file_ids)
        if firestore_status_available():
            try:
                from firebase_admin import firestore

                for doc in firestore.client().collection(status_collection()).stream():
                    ids.add(normalize_store_id(doc.id))
            except Exception:
                pass

    rows = [get_store_status(sid, heartbeat_timeout_seconds=heartbeat_timeout_seconds) for sid in sorted(ids)]
    return rows


def enrich_catalog_stores(
    stores: list[dict[str, Any]],
    *,
    heartbeat_timeout_seconds: int = 60,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for store in stores:
        sid = normalize_store_id(store.get('id'))
        if not sid:
            continue
        status = get_store_status(sid, heartbeat_timeout_seconds=heartbeat_timeout_seconds)
        merged = dict(store)
        merged['agent_alive'] = status.get('agent_alive')
        merged['agent_last_seen_at'] = status.get('agent_last_seen_at')
        merged['agent_offline_since'] = status.get('agent_offline_since')
        merged['agent_offline_since_ms'] = status.get('agent_offline_since_ms')
        merged['gateway_online'] = status.get('gateway_online')
        merged['gateway_error'] = status.get('gateway_error')
        merged['gateway_checked_at'] = status.get('gateway_checked_at')
        merged['gateway_offline_since'] = status.get('gateway_offline_since')
        merged['gateway_offline_since_ms'] = status.get('gateway_offline_since_ms')
        out.append(merged)
    return out
