"""Auditoria de operações — Firestore."""

from __future__ import annotations

import asyncio
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from panel import audit_store
from panel.auth import auth_enabled, get_session_user

router = APIRouter(prefix="/api/audit", tags=["panel-audit"])

_operator_stats_cache: dict[str, Any] = {"key": None, "data": None, "expires_at": 0.0}
_OPERATOR_STATS_TTL_SEC = 60.0


def _client_meta(request: Request) -> tuple[str | None, str | None]:
    ip = (request.headers.get("X-Forwarded-For") or request.client.host or "").split(",")[0].strip()
    ua = (request.headers.get("User-Agent") or "")[:400]
    return ip or None, ua or None


@router.get("/status")
async def audit_status() -> dict[str, Any]:
    return await asyncio.to_thread(audit_store.audit_status)


@router.post("/log")
async def audit_log(request: Request) -> dict[str, Any]:
    status = await asyncio.to_thread(audit_store.audit_status)
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
        await asyncio.to_thread(
            audit_store.write_log,
            body,
            user=user,
            client_ip=client_ip,
            user_agent=user_agent,
        )
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc
    _operator_stats_cache["key"] = None
    _operator_stats_cache["data"] = None
    _operator_stats_cache["expires_at"] = 0.0
    return {"ok": True, "collection": status.get("collection")}


def _invalidate_operator_stats_cache() -> None:
    _operator_stats_cache["key"] = None
    _operator_stats_cache["data"] = None
    _operator_stats_cache["expires_at"] = 0.0


@router.post("/clear")
async def audit_clear(request: Request) -> dict[str, Any]:
    """Apaga todos os registros de auditoria. Requer sessão e confirmação explícita."""
    status = await asyncio.to_thread(audit_store.audit_status)
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
    if body.get("confirm") != "CLEAR_ALL_AUDIT_LOGS":
        raise HTTPException(
            400,
            'Confirme com {"confirm":"CLEAR_ALL_AUDIT_LOGS"}',
        )

    try:
        result = await asyncio.to_thread(audit_store.clear_all_logs)
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc

    _invalidate_operator_stats_cache()
    return result


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
    status = await asyncio.to_thread(audit_store.audit_status)
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
        return await asyncio.to_thread(
            audit_store.query_logs,
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


async def _load_operator_stats(limit: int = 20, store: str | None = None) -> dict[str, Any]:
    """Lógica compartilhada — não usar defaults Query() (quebram chamada interna)."""
    status = await asyncio.to_thread(audit_store.audit_status)
    if not status.get("available"):
        return {"operators": [], "truncated": False, "cached": False}

    store_key = str(store or "").strip().lower()
    cache_key = f"{store_key}|{int(limit)}"
    now = time.time()
    if (
        _operator_stats_cache.get("key") == cache_key
        and _operator_stats_cache.get("data")
        and float(_operator_stats_cache.get("expires_at") or 0) > now
    ):
        cached = dict(_operator_stats_cache["data"])
        cached["cached"] = True
        return cached

    try:
        result = await asyncio.to_thread(
            audit_store.query_logs,
            limit=500,
            store=store_key or None,
            include_total=False,
        )
        rows = result.get("items") or []
        counts: dict[str, dict[str, Any]] = {}
        for row in rows:
            email = str(row.get("operator_email") or "").strip().lower()
            if not email:
                continue
            counts.setdefault(email, {"email": email, "count": 0})
            counts[email]["count"] += 1
        operators = sorted(counts.values(), key=lambda x: x["count"], reverse=True)[:limit]
        payload = {"operators": operators, "truncated": len(counts) > limit, "cached": False}
        _operator_stats_cache["key"] = cache_key
        _operator_stats_cache["data"] = dict(payload)
        _operator_stats_cache["expires_at"] = now + _OPERATOR_STATS_TTL_SEC
        return payload
    except Exception:
        return {"operators": [], "truncated": False, "cached": False}


@router.get("/operator-stats")
async def audit_operator_stats(
    limit: int = Query(20, ge=1, le=100),
    store: str | None = Query(None),
) -> dict[str, Any]:
    return await _load_operator_stats(limit=limit, store=store)


@router.get("/operators")
async def audit_operators() -> dict[str, Any]:
    stats = await _load_operator_stats(limit=100, store=None)
    return {
        "operators": [
            {"email": row["email"], "name": row.get("name")}
            for row in stats.get("operators") or []
        ]
    }


@router.get("/dashboard-summary")
async def audit_dashboard_summary(hours: int = Query(24, ge=1, le=168)) -> dict[str, Any]:
    status = await asyncio.to_thread(audit_store.audit_status)
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
        return await asyncio.to_thread(audit_store.dashboard_summary, hours=hours)
    except Exception as exc:
        return {
            "hours": hours,
            "total": 0,
            "available": False,
            "detail": "audit_unavailable",
            "hint": str(exc),
        }
