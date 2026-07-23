"""Firestore — auditoria do painel."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from panel.lav60_env import ROOT, env_value

_db = None
_init_error: str | None = None


def _service_account_path() -> Path | None:
    raw = env_value("FIREBASE_SERVICE_ACCOUNT_FILE")
    if not raw:
        return None
    path = Path(raw)
    if not path.is_absolute():
        path = ROOT / raw
    return path if path.is_file() else None


def _collection_name() -> str:
    return env_value("FIREBASE_AUDIT_COLLECTION", "audit_logs") or "audit_logs"


def _get_db():
    global _db, _init_error
    if _db is not None:
        return _db
    if _init_error:
        raise RuntimeError(_init_error)

    path = _service_account_path()
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
        _init_error = str(exc)
        raise RuntimeError(_init_error) from exc


def audit_status() -> dict[str, Any]:
    path = _service_account_path()
    if not path:
        return {
            "available": False,
            "reason": "audit_not_configured",
            "hint": (
                "Coloque o arquivo JSON do Firebase (FIREBASE_SERVICE_ACCOUNT_FILE) "
                "na pasta do projeto e reinicie o backend"
            ),
        }
    try:
        _get_db()
        return {"available": True, "collection": _collection_name()}
    except Exception as exc:
        return {
            "available": False,
            "reason": "firestore_error",
            "hint": str(exc),
        }


def write_log(entry: dict[str, Any], *, operator_email: str | None = None) -> None:
    db = _get_db()
    now_ms = int(time.time() * 1000)
    doc = {
        **entry,
        "ts_ms": now_ms,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "operator_email": operator_email or entry.get("operator_email"),
    }
    db.collection(_collection_name()).add(doc)


def _doc_to_item(doc_id: str, data: dict[str, Any]) -> dict[str, Any]:
    row = dict(data)
    row["id"] = doc_id
    if "ts" not in row and row.get("ts_ms"):
        row["ts"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(row["ts_ms"] / 1000))
    return row


def query_logs(
    *,
    limit: int = 50,
    store: str | None = None,
    operator: str | None = None,
    action: str | None = None,
    success: str | None = None,
    before_ms: int | None = None,
) -> dict[str, Any]:
    db = _get_db()
    limit = max(1, min(limit, 200))
    query = db.collection(_collection_name()).order_by("ts_ms", direction="DESCENDING")

    if store:
        query = query.where("store", "==", store.strip().lower())
    if operator:
        query = query.where("operator_email", "==", operator.strip().lower())
    if action:
        query = query.where("action", "==", action.strip())
    if success in {"0", "false", "False"}:
        query = query.where("success", "==", False)
    elif success in {"1", "true", "True"}:
        query = query.where("success", "==", True)
    if before_ms:
        query = query.where("ts_ms", "<", int(before_ms))

    docs = list(query.limit(limit + 1).stream())
    has_more = len(docs) > limit
    items = [_doc_to_item(doc.id, doc.to_dict() or {}) for doc in docs[:limit]]
    next_before = items[-1].get("ts_ms") if has_more and items else None
    return {
        "items": items,
        "has_more": has_more,
        "next_before_ms": next_before,
        "available": True,
    }


def dashboard_summary(hours: int = 24) -> dict[str, Any]:
    db = _get_db()
    since_ms = int((time.time() - max(1, hours) * 3600) * 1000)
    docs = (
        db.collection(_collection_name())
        .where("ts_ms", ">=", since_ms)
        .order_by("ts_ms", direction="DESCENDING")
        .limit(500)
        .stream()
    )
    total = 0
    success = 0
    by_operator: dict[str, int] = {}
    by_store: dict[str, int] = {}
    for doc in docs:
        data = doc.to_dict() or {}
        total += 1
        if data.get("success") is not False:
            success += 1
        email = str(data.get("operator_email") or "").strip().lower()
        if email:
            by_operator[email] = by_operator.get(email, 0) + 1
        store = str(data.get("store") or "").strip().lower()
        if store:
            by_store[store] = by_store.get(store, 0) + 1
    top_operator = None
    if by_operator:
        email, count = max(by_operator.items(), key=lambda x: x[1])
        top_operator = {"email": email, "count": count}
    top_store = None
    if by_store:
        store, count = max(by_store.items(), key=lambda x: x[1])
        top_store = {"store": store, "count": count}
    return {
        "hours": hours,
        "total": total,
        "success_rate": round(success / total * 100, 1) if total else None,
        "truncated": total >= 500,
        "top_operator": top_operator,
        "top_store": top_store,
        "available": True,
    }
