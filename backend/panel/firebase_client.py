"""Firebase Admin — inicialização única e thread-safe."""

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

        path = service_account_path()
        if not path:
            raise RuntimeError("Arquivo de service account do Firebase não encontrado")

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
