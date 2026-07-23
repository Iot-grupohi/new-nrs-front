"""Auditoria de operações — Firestore."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, Response

from panel import audit_store
from panel.auth import auth_enabled, get_session_user

router = APIRouter(prefix="/api/audit", tags=["panel-audit"])


def _client_meta(request: Request) -> tuple[str | None, str | None]:
    ip = (request.headers.get("X-Forwarded-For") or request.client.host or "").split(",")[0].strip()
    ua = (request.headers.get("User-Agent") or "")[:400]
    return ip or None, ua or None


@router.get("/status")
async def audit_status() -> dict[str, Any]:
    return audit_store.audit_status()


@router.post("/log")
async def audit_log(request: Request) -> dict[str, Any]:
    status = audit_store.audit_status()
    if not status.get("available"):
        raise HTTPException(503, "audit_unavailable")

    user = get_session_user(request)
    if auth_enabled() and not user:
        raise HTTPException(401, "Login required")

    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(400, "JSON inválido") from exc
    if not isinstance(body, dict):
        raise HTTPException(400, "JSON inválido")

    client_ip, user_agent = _client_meta(request)
    try:
        audit_store.write_log(body, user=user, client_ip=client_ip, user_agent=user_agent)
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc
    return {"ok": True, "collection": status.get("collection")}


@router.get("/logs")
async def audit_logs(
    limit: int = Query(50, ge=1, le=200),
    store: str | None = Query(None),
    operator: str | None = Query(None),
    action: str | None = Query(None),
    success: str | None = Query(None),
    before_ms: int | None = Query(None),
    skip_total: bool = Query(False),
) -> dict[str, Any]:
    status = audit_store.audit_status()
    if not status.get("available"):
        return {
            "items": [],
            "has_more": False,
            "available": False,
            "detail": "audit_unavailable",
            "hint": status.get("hint"),
            "reason": status.get("reason"),
            "action_labels": audit_store.ACTION_LABELS_PT,
            "device_labels": audit_store.DEVICE_LABELS_PT,
        }
    try:
        return audit_store.query_logs(
            limit=limit,
            store=store,
            operator=operator,
            action=action,
            success=success,
            before_ms=before_ms,
            include_total=not skip_total and before_ms is None,
        )
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc


@router.get("/operator-stats")
async def audit_operator_stats(
    limit: int = Query(20, ge=1, le=100),
    store: str | None = Query(None),
) -> dict[str, Any]:
    status = audit_store.audit_status()
    if not status.get("available"):
        return {"operators": [], "truncated": False}
    try:
        rows = audit_store.query_logs(limit=500, store=store).get("items") or []
        counts: dict[str, dict[str, Any]] = {}
        for row in rows:
            email = str(row.get("operator_email") or "").strip().lower()
            if not email:
                continue
            counts.setdefault(email, {"email": email, "count": 0})
            counts[email]["count"] += 1
        operators = sorted(counts.values(), key=lambda x: x["count"], reverse=True)[:limit]
        return {"operators": operators, "truncated": len(counts) > limit}
    except Exception:
        return {"operators": [], "truncated": False}


@router.get("/operators")
async def audit_operators() -> dict[str, Any]:
    stats = await audit_operator_stats(limit=100)
    return {
        "operators": [
            {"email": row["email"], "name": row.get("name")}
            for row in stats.get("operators") or []
        ]
    }


@router.get("/dashboard-summary")
async def audit_dashboard_summary(hours: int = Query(24, ge=1, le=168)) -> dict[str, Any]:
    status = audit_store.audit_status()
    if not status.get("available"):
        return {
            "hours": hours,
            "total": 0,
            "success_rate": None,
            "available": False,
            "detail": "audit_unavailable",
            "hint": status.get("hint"),
        }
    try:
        return audit_store.dashboard_summary(hours=hours)
    except Exception as exc:
        return {
            "hours": hours,
            "total": 0,
            "available": False,
            "detail": "audit_unavailable",
            "hint": str(exc),
        }
