"""Infraestrutura DigitalOcean — /api/infra/*."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

import panel_infra as infra_svc

router = APIRouter(prefix="/api/infra", tags=["panel-infra"])


@router.get("/vps")
async def list_vps() -> dict[str, Any]:
    items = await infra_svc.list_vps_items()
    return {"items": items, "configured": infra_svc.infra_configured()}


@router.post("/vps")
async def add_vps(body: dict[str, Any]) -> dict[str, Any]:
    host_id = str(body.get("host_id") or "").strip()
    if not host_id:
        raise HTTPException(400, "host_id obrigatório")
    try:
        infra_svc.add_host_id(host_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"item": {"id": host_id}}


@router.delete("/vps/{host_id}")
async def remove_vps(host_id: str) -> dict[str, Any]:
    remaining = infra_svc.remove_host_id(host_id)
    return {"host_ids": remaining}


@router.get("/databases")
async def list_databases() -> dict[str, Any]:
    items = await infra_svc.list_database_items()
    return {"items": items, "configured": infra_svc.infra_configured()}


@router.post("/databases")
async def add_database(body: dict[str, Any]) -> dict[str, Any]:
    db_id = str(body.get("db_id") or "").strip()
    if not db_id:
        raise HTTPException(400, "db_id obrigatório")
    try:
        infra_svc.add_db_id(db_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    item: dict[str, Any] = {"id": db_id}
    try:
        item.update(await infra_svc.ensure_database_trusted_source(db_id))
    except Exception as exc:
        item["trusted_source_warning"] = str(exc)
    return {"item": item}


@router.post("/databases/{db_id}/trusted-source")
async def add_database_trusted_source(db_id: str) -> dict[str, Any]:
    sid = db_id.strip()
    if not sid:
        raise HTTPException(400, "db_id obrigatório")
    try:
        return await infra_svc.ensure_database_trusted_source(sid)
    except Exception as exc:
        raise HTTPException(502, str(exc)) from exc


@router.get("/public-ip")
async def infra_public_ip() -> dict[str, Any]:
    ip = await infra_svc.detect_public_ip()
    return {"ip": ip}


@router.delete("/databases/{db_id}")
async def remove_database(db_id: str) -> dict[str, Any]:
    remaining = infra_svc.remove_db_id(db_id)
    return {"db_ids": remaining}


@router.get("/metrics")
async def infra_metrics(
    window: int = 900,
    host_id: str | None = None,
    db_id: str | None = None,
    include_databases: int = 0,
    force: int = 0,
) -> dict[str, Any]:
    return await infra_svc.build_metrics_payload(
        window=max(300, window),
        host_id=(host_id or "").strip() or None,
        db_id=(db_id or "").strip() or None,
        include_databases=bool(include_databases),
        force=bool(force),
    )
