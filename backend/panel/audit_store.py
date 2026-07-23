"""Firestore — auditoria do painel."""

from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from panel.lav60_env import ROOT, env_value

_db = None
_init_error: str | None = None
_MAX_FIELD_LEN = 4000
_MAX_RESPONSE_KEYS = 24
_DEVICE_PATH_RE = re.compile(r"/(washer|dryer|doser|ac)(?:/([^/?#]+))?", re.IGNORECASE)

ACTION_LABELS_PT: dict[str, str] = {
    "auth_login": "Login no painel",
    "auth_logout": "Logout do painel",
    "auth_login_failed": "Tentativa de login recusada",
    "washer_release": "Liberou lavadora",
    "washer_unlock": "Reativou botões da lavadora",
    "dryer_release": "Liberou secadora",
    "dryer_unlock": "Reativou botões da secadora",
    "doser_command": "Comando na dosadora",
    "doser_consult": "Consulta na dosadora",
    "doser_settime": "Ajuste de tempo na dosadora",
    "ac_control": "Comando no ar-condicionado",
    "operation": "Operação",
    "support_procedure_create": "Runbook adicionado",
    "support_procedure_update": "Runbook atualizado",
    "support_procedure_delete": "Runbook excluído",
    "support_category_create": "Categoria runbook criada",
    "support_category_update": "Categoria runbook atualizada",
    "support_category_delete": "Categoria runbook excluída",
}

DEVICE_LABELS_PT: dict[str, str] = {
    "washer": "lavadora",
    "dryer": "secadora",
    "doser": "dosadora",
    "ac": "ar-condicionado",
}

CHANNEL_LABELS_PT: dict[str, str] = {
    "agente_local": "Agente local",
    "redundancia": "Redundância",
    "suporte": "Suporte",
}


def _service_account_path() -> Path | None:
    raw = env_value("FIREBASE_SERVICE_ACCOUNT_FILE")
    if not raw:
        return None
    path = Path(raw)
    if not path.is_absolute():
        path = ROOT / raw
    return path if path.is_file() else None


def _collection_name() -> str:
    name = env_value("FIREBASE_AUDIT_COLLECTION") or env_value("FIREBASE_AUDIT_ROOT") or "audit_logs"
    return str(name).strip().strip("/") or "audit_logs"


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
                "Copie o JSON da service account para o VPS e defina "
                "FIREBASE_SERVICE_ACCOUNT_FILE com caminho absoluto no .env"
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


def _truncate(value: Any, limit: int = _MAX_FIELD_LEN) -> Any:
    if value is None:
        return None
    if isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value if len(value) <= limit else value[: limit - 1] + "…"
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for idx, (key, item) in enumerate(value.items()):
            if idx >= _MAX_RESPONSE_KEYS:
                out["_truncated"] = True
                break
            out[str(key)[:80]] = _truncate(item, limit)
        return out
    if isinstance(value, list):
        return [_truncate(item, limit) for item in value[:_MAX_RESPONSE_KEYS]]
    text = str(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _sanitize_payload(data: Any) -> Any:
    if not isinstance(data, dict):
        return _truncate(data)
    blocked = {"token", "idtoken", "password", "api_token", "x-token", "authorization"}
    clean: dict[str, Any] = {}
    for key, value in data.items():
        if str(key).lower() in blocked:
            continue
        clean[str(key)] = _truncate(value)
    return clean


def _operator_display_name(user: dict[str, Any] | None) -> str:
    email = str((user or {}).get("email") or "").strip()
    if email:
        local = email.split("@", 1)[0].strip()
        if local:
            return local.replace(".", " ").replace("_", " ").title()
        return email
    return "Operador desconhecido"


def _infer_device_from_path(path: str | None) -> tuple[str | None, str | None]:
    text = str(path or "").strip()
    if not text:
        return None, None
    match = _DEVICE_PATH_RE.search(text)
    if not match:
        return None, None
    device_type = match.group(1).lower()
    device_id = match.group(2)
    if device_type == "ac":
        device_id = device_id or "110"
    return device_type, device_id or None


def _resolve_device_fields(body: dict[str, Any]) -> tuple[str | None, str | None]:
    meta = body.get("meta") if isinstance(body.get("meta"), dict) else {}
    device_type = str(body.get("device_type") or meta.get("device_type") or "").strip().lower() or None
    device_id = str(body.get("device_id") or meta.get("device_id") or "").strip() or None
    if device_type and device_id:
        return device_type, device_id
    path_type, path_id = _infer_device_from_path(body.get("path"))
    return device_type or path_type, device_id or path_id


def _build_operation_summary(
    *,
    operator_name: str,
    action: str,
    label: str | None,
    store: str | None,
    device_type: str | None,
    device_id: str | None,
    payload: Any,
    success: bool,
    channel: str | None,
) -> str:
    verb = ACTION_LABELS_PT.get(action, label or action or "Operação")
    parts = [operator_name, verb]
    if device_id:
        dtype_label = DEVICE_LABELS_PT.get(device_type or "", device_type or "equipamento")
        parts.append(f"{dtype_label} {device_id}")
    if isinstance(payload, dict):
        minutes = payload.get("minutes")
        if minutes is not None:
            parts.append(f"{minutes} min")
        am = payload.get("am")
        if am:
            parts.append(f"dosagem {am}")
        temperature = payload.get("temperature")
        if temperature is not None:
            parts.append(f"temp {temperature}")
    if store:
        parts.append(store.upper())
    if channel:
        parts.append(f"via {CHANNEL_LABELS_PT.get(channel, channel)}")
    summary = " · ".join(str(p) for p in parts if p)
    if not success:
        summary = f"{summary} · falhou" if summary else "Operação falhou"
    return summary[:480]


def build_audit_record(
    user: dict[str, Any] | None,
    body: dict[str, Any],
    *,
    client_ip: str | None = None,
    user_agent: str | None = None,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    store = str(body.get("store") or "").strip().lower()
    action = str(body.get("action") or "operation").strip()[:120] or "operation"
    label = _truncate(body.get("label") or "", 240) or None
    success = body.get("success") is not False
    payload = _sanitize_payload(body.get("payload"))
    device_type, device_id = _resolve_device_fields(body)
    operator_email = (
        (user or {}).get("email")
        or body.get("operator_email")
        or body.get("email")
        or None
    )
    operator_name = _operator_display_name(user if (user or {}).get("email") else {"email": operator_email})
    meta = body.get("meta") if isinstance(body.get("meta"), dict) else {}
    channel = str(meta.get("channel") or body.get("channel") or "").strip() or None
    if not channel:
        page_key = str(body.get("page") or "").strip().lower()
        if page_key == "gateway":
            channel = "redundancia"
        elif page_key == "store":
            channel = "agente_local"
        elif page_key == "suporte":
            channel = "suporte"

    record: dict[str, Any] = {
        "ts": now.isoformat(),
        "ts_ms": int(now.timestamp() * 1000),
        "source": "lav60_panel",
        "page": _truncate(body.get("page") or "", 40) or None,
        "store": store or None,
        "action": action,
        "label": label,
        "operation_summary": _build_operation_summary(
            operator_name=operator_name,
            action=action,
            label=label,
            store=store or None,
            device_type=device_type,
            device_id=device_id,
            payload=payload,
            success=success,
            channel=channel,
        ),
        "operator_name": operator_name,
        "operator_email": operator_email,
        "device_type": device_type,
        "device_id": device_id,
        "channel": channel,
        "method": str(body.get("method") or "").strip().upper()[:12] or None,
        "path": _truncate(body.get("path") or "", 240) or None,
        "success": success,
        "payload": payload,
        "response": _sanitize_payload(body.get("response")),
        "error": _truncate(body.get("error") or "", 800) or None,
        "meta": _sanitize_payload(meta) if meta else None,
        "user_email": operator_email,
    }
    if client_ip:
        record["client_ip"] = client_ip
    if user_agent:
        record["user_agent"] = _truncate(user_agent, 400)
    return {key: value for key, value in record.items() if value is not None}


def write_log(
    entry: dict[str, Any],
    *,
    user: dict[str, Any] | None = None,
    client_ip: str | None = None,
    user_agent: str | None = None,
) -> None:
    db = _get_db()
    record = build_audit_record(
        user,
        entry,
        client_ip=client_ip,
        user_agent=user_agent,
    )
    db.collection(_collection_name()).add(record)


def _row_listable(data: dict[str, Any]) -> bool:
    action = str(data.get("action") or "").strip()
    if action not in ("auth_login", "auth_logout"):
        return True
    email = str(data.get("operator_email") or data.get("user_email") or "").strip()
    return bool(email)


def _row_matches(
    data: dict[str, Any],
    *,
    operator: str | None,
    action: str | None,
    success: str | None,
) -> bool:
    if operator:
        row_email = str(data.get("operator_email") or data.get("user_email") or "").strip().lower()
        if row_email != operator.strip().lower():
            return False
    if action and data.get("action") != action.strip():
        return False
    if success in {"0", "false", "False"} and data.get("success") is not False:
        return False
    if success in {"1", "true", "True"} and data.get("success") is False:
        return False
    return True


def _doc_to_item(doc_id: str, data: dict[str, Any]) -> dict[str, Any]:
    row = dict(data)
    row["id"] = doc_id
    if "ts" not in row and row.get("ts_ms"):
        row["ts"] = datetime.fromtimestamp(row["ts_ms"] / 1000, tz=timezone.utc).isoformat()
    return row


def count_logs(
    *,
    store: str | None = None,
    operator: str | None = None,
    action: str | None = None,
    success: str | None = None,
) -> tuple[int, bool]:
    db = _get_db()
    from firebase_admin import firestore

    query = db.collection(_collection_name()).order_by("ts_ms", direction=firestore.Query.DESCENDING)
    if store:
        query = query.where("store", "==", store.strip().lower())
    needs_scan = bool(operator or action or success)
    scan_limit = 5000 if needs_scan else 500
    total = 0
    for doc in query.limit(scan_limit).stream():
        data = doc.to_dict() or {}
        if not _row_listable(data):
            continue
        if not _row_matches(data, operator=operator, action=action, success=success):
            continue
        total += 1
    truncated = total >= scan_limit
    return total, truncated


def query_logs(
    *,
    limit: int = 50,
    store: str | None = None,
    operator: str | None = None,
    action: str | None = None,
    success: str | None = None,
    before_ms: int | None = None,
    include_total: bool = False,
) -> dict[str, Any]:
    db = _get_db()
    from firebase_admin import firestore

    page_size = max(1, min(limit, 200))
    query = db.collection(_collection_name()).order_by("ts_ms", direction=firestore.Query.DESCENDING)
    if store:
        query = query.where("store", "==", store.strip().lower())
    if before_ms:
        query = query.where("ts_ms", "<", int(before_ms))

    needs_scan = bool(operator or action or success)
    fetch_size = min(page_size * 4, 400) if needs_scan else page_size + 1
    docs = list(query.limit(fetch_size).stream())

    items: list[dict[str, Any]] = []
    for doc in docs:
        data = doc.to_dict() or {}
        if not _row_listable(data):
            continue
        if not _row_matches(data, operator=operator, action=action, success=success):
            continue
        items.append(_doc_to_item(doc.id, data))
        if len(items) > page_size:
            break

    has_more = len(items) > page_size
    page_items = items[:page_size]
    next_before = page_items[-1].get("ts_ms") if has_more and page_items else None

    payload: dict[str, Any] = {
        "items": page_items,
        "has_more": has_more,
        "next_before_ms": next_before,
        "available": True,
        "collection": _collection_name(),
        "action_labels": ACTION_LABELS_PT,
        "device_labels": DEVICE_LABELS_PT,
    }
    if include_total and before_ms is None:
        total, truncated = count_logs(
            store=store,
            operator=operator,
            action=action,
            success=success,
        )
        payload["total"] = total
        payload["total_truncated"] = truncated
    return payload


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
        if not _row_listable(data):
            continue
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
        sid, count = max(by_store.items(), key=lambda x: x[1])
        top_store = {"store": sid, "count": count}
    return {
        "hours": hours,
        "total": total,
        "success_rate": round(success / total * 100, 1) if total else None,
        "truncated": total >= 500,
        "top_operator": top_operator,
        "top_store": top_store,
        "available": True,
    }
