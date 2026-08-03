"""Firebase Admin — Firestore + Realtime Database (thread-safe)."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

from panel.lav60_env import ROOT, env_value

_lock = threading.Lock()
_db = None
_init_error: str | None = None


def service_account_path() -> Path | None:
    raw = env_value("FIREBASE_SERVICE_ACCOUNT_FILE")
    if not raw:
        return None
    path = Path(raw)
    if not path.is_absolute():
        path = ROOT / raw
    return path if path.is_file() else None


def database_url() -> str:
    explicit = env_value("FIREBASE_DATABASE_URL")
    if explicit:
        return explicit.rstrip("/")
    project_id = env_value("FIREBASE_PROJECT_ID")
    if project_id:
        return f"https://{project_id}-default-rtdb.firebaseio.com"
    return ""


def _init_options() -> dict[str, str]:
    opts: dict[str, str] = {}
    url = database_url()
    if url:
        opts["databaseURL"] = url
    return opts


def _ensure_app():
    import firebase_admin
    from firebase_admin import credentials

    if firebase_admin._apps:
        return

    path = service_account_path()
    if not path:
        raise RuntimeError("Arquivo de service account do Firebase não encontrado")

    cred = credentials.Certificate(str(path))
    opts = _init_options()
    firebase_admin.initialize_app(cred, opts or None)


def get_firestore():
    global _db, _init_error

    if _db is not None:
        return _db
    if _init_error:
        raise RuntimeError(_init_error)

    with _lock:
        if _db is not None:
            return _db
        if _init_error:
            raise RuntimeError(_init_error)

        try:
            import firebase_admin
            from firebase_admin import firestore
        except ImportError as exc:
            _init_error = "Instale firebase-admin: pip install firebase-admin"
            raise RuntimeError(_init_error) from exc

        try:
            _ensure_app()
            _db = firestore.client()
            return _db
        except Exception as exc:
            msg = str(exc)
            if "already exists" in msg.lower():
                try:
                    _db = firestore.client()
                    return _db
                except Exception as retry_exc:
                    _init_error = str(retry_exc)
                    raise RuntimeError(_init_error) from retry_exc
            _init_error = msg
            raise RuntimeError(_init_error) from exc


def get_rtdb_reference(path: str = "/"):
    from firebase_admin import db

    if not database_url():
        raise RuntimeError("FIREBASE_DATABASE_URL não configurada")
    _ensure_app()
    clean = str(path or "").strip().strip("/")
    return db.reference(clean or "/")


def firebase_status(*, not_configured_reason: str) -> dict[str, Any]:
    path = service_account_path()
    if not path:
        return {
            "available": False,
            "reason": not_configured_reason,
            "hint": (
                "Copie o JSON da service account para o VPS e defina "
                "FIREBASE_SERVICE_ACCOUNT_FILE com caminho absoluto no .env"
            ),
        }
    try:
        get_firestore()
        return {"available": True}
    except Exception as exc:
        return {
            "available": False,
            "reason": "firestore_error",
            "hint": str(exc),
        }


def rtdb_status() -> dict[str, Any]:
    path = service_account_path()
    url = database_url()
    if not path:
        return {
            "available": False,
            "reason": "rtdb_not_configured",
            "hint": "Defina FIREBASE_SERVICE_ACCOUNT_FILE no .env",
        }
    if not url:
        return {
            "available": False,
            "reason": "rtdb_url_missing",
            "hint": "Defina FIREBASE_DATABASE_URL ou FIREBASE_PROJECT_ID no .env",
        }
    try:
        get_rtdb_reference("/")
        return {"available": True, "database_url": url}
    except Exception as exc:
        return {
            "available": False,
            "reason": "rtdb_error",
            "hint": str(exc),
            "database_url": url,
        }
