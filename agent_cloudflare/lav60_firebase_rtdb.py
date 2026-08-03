"""Firebase RTDB heartbeat — espelha payload do agente em /{loja}/gateway_heartbeat."""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_lock = threading.Lock()
_init_error: str | None = None
_app_ready = False


def _agent_root() -> Path:
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def _env_bool(key: str, default: bool = False) -> bool:
    raw = (os.getenv(key) or '').strip().lower()
    if not raw:
        return default
    if raw in {'0', 'false', 'no', 'off'}:
        return False
    return raw in {'1', 'true', 'yes', 'on'}


def firebase_rtdb_enabled() -> bool:
    if _env_bool('FIREBASE_RTD_HEARTBEAT_DISABLED'):
        return False
    if _env_bool('FIREBASE_RTD_HEARTBEAT_ENABLED'):
        return bool((os.getenv('FIREBASE_DATABASE_URL') or '').strip())
    if _env_bool('FIREBASE_RTDB_ENABLED'):
        return bool((os.getenv('FIREBASE_DATABASE_URL') or '').strip())
    return False


def _parse_service_account_json(raw: str) -> dict[str, Any] | None:
    text = (raw or '').strip()
    if not text:
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) and data.get('type') == 'service_account' else None


def _service_account_dict() -> dict[str, Any] | None:
    inline = _parse_service_account_json(os.getenv('FIREBASE_SERVICE_ACCOUNT_JSON') or '')
    if inline:
        return inline

    raw_path = (os.getenv('FIREBASE_SERVICE_ACCOUNT_FILE') or '').strip()
    if raw_path:
        path = Path(raw_path)
        if not path.is_absolute():
            path = (_agent_root() / raw_path).resolve()
        if path.is_file():
            try:
                data = json.loads(path.read_text(encoding='utf-8'))
            except (OSError, json.JSONDecodeError):
                data = None
            if isinstance(data, dict) and data.get('type') == 'service_account':
                return data

    if not getattr(sys, 'frozen', False):
        repo_root = _agent_root().parent.parent
        if repo_root.is_dir():
            for match in sorted(repo_root.glob('portal-franqueado-*-firebase-adminsdk-*.json')):
                try:
                    data = json.loads(match.read_text(encoding='utf-8'))
                except (OSError, json.JSONDecodeError):
                    continue
                if isinstance(data, dict) and data.get('type') == 'service_account':
                    return data
    return None


def _service_account_source() -> str:
    if _parse_service_account_json(os.getenv('FIREBASE_SERVICE_ACCOUNT_JSON') or ''):
        return '.env'
    if (os.getenv('FIREBASE_SERVICE_ACCOUNT_FILE') or '').strip():
        return 'arquivo'
    if not getattr(sys, 'frozen', False) and _service_account_dict():
        return 'dev (repo)'
    return ''


def _database_url() -> str:
    explicit = (os.getenv('FIREBASE_DATABASE_URL') or '').strip()
    if explicit:
        return explicit.rstrip('/')
    project_id = (os.getenv('FIREBASE_PROJECT_ID') or '').strip()
    if project_id:
        return f'https://{project_id}-default-rtdb.firebaseio.com'
    return ''


def _ensure_app() -> None:
    global _app_ready, _init_error
    if _app_ready:
        return
    with _lock:
        if _app_ready:
            return
        try:
            import firebase_admin
            from firebase_admin import credentials
        except ImportError as exc:
            _init_error = 'Instale firebase-admin: pip install firebase-admin'
            raise RuntimeError(_init_error) from exc

        if firebase_admin._apps:
            _app_ready = True
            return

        account = _service_account_dict()
        if not account:
            _init_error = 'Firebase: defina FIREBASE_SERVICE_ACCOUNT_JSON no .env'
            raise RuntimeError(_init_error)

        cred = credentials.Certificate(account)
        opts: dict[str, str] = {}
        url = _database_url()
        if url:
            opts['databaseURL'] = url
        firebase_admin.initialize_app(cred, opts or None)
        _app_ready = True


def firebase_rtdb_status() -> dict[str, Any]:
    url = _database_url()
    enabled = firebase_rtdb_enabled()
    account = _service_account_dict()
    available = enabled and bool(account) and bool(url)
    source = _service_account_source()
    reason = None
    if not enabled:
        reason = 'RTDB desativado (FIREBASE_RTD_HEARTBEAT_ENABLED / FIREBASE_RTDB_ENABLED)'
    elif not url:
        reason = 'FIREBASE_DATABASE_URL ausente'
    elif not account:
        reason = 'FIREBASE_SERVICE_ACCOUNT_JSON ausente no .env'
    elif _init_error:
        reason = _init_error
    return {
        'enabled': enabled,
        'available': available,
        'database_url': url or None,
        'service_account': source or None,
        'reason': reason,
    }


def send_firebase_rtdb_heartbeat(store_id: str, payload: dict[str, Any]) -> bool:
    if not firebase_rtdb_enabled():
        return False

    sid = str(store_id or payload.get('store') or '').strip().lower()
    if not sid:
        return False

    try:
        _ensure_app()
        from firebase_admin import db
    except Exception:
        return False

    now_ms = int(time.time() * 1000)
    gateway_payload = {
        **dict(payload or {}),
        'store': sid,
        'updated_at_ms': now_ms,
        'received_at_ms': payload.get('post_received_at_ms') or now_ms,
        'heartbeat_source': payload.get('heartbeat_source') or 'rtdb',
    }
    if not gateway_payload.get('timestamp'):
        gateway_payload['timestamp'] = datetime.now(timezone.utc).isoformat()

    root = db.reference(sid)
    root.update({
        'gateway_heartbeat': gateway_payload,
        'heartbeat': now_ms,
    })
    return True
