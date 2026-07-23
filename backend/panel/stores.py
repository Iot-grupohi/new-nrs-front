"""Proxy de agentes Powpay e status de lojas."""

from __future__ import annotations

import time
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from panel.lav60_env import env_value
from panel.gateway import _gateway_verify_cache

router = APIRouter(prefix="/api/stores", tags=["panel-stores"])


def register_stores(
    *,
    powpay_domain: str,
    agent_token: str,
    gateway_url: str,
    gateway_token: str,
) -> APIRouter:
    gw_base = gateway_url.rstrip("/")

    def agent_url(store_id: str) -> str:
        sid = store_id.strip().lower()
        return f"https://{sid}.{powpay_domain}"

    @router.get("/status")
    async def stores_status() -> dict[str, Any]:
        from panel import deps
        from panel.catalog import build_catalog

        if deps.upstream_get is None:
            return {"items": []}
        catalog = await build_catalog(deps.upstream_get)
        items: list[dict] = []
        for meta in catalog.get("stores") or []:
            sid = str(meta.get("id") or "").lower()
            if not sid:
                continue
            cached = _gateway_verify_cache.get(sid, {}).get("payload")
            if cached:
                items.append({
                    "store": sid,
                    "gateway_online": cached.get("gateway_online", False),
                    "gateway_error": cached.get("gateway_error"),
                    "gateway_checked_at_ms": cached.get("gateway_checked_at_ms"),
                })
        return {"items": items}

    @router.get("/{store_id}/agent/config")
    async def agent_config(store_id: str) -> Any:
        sid = store_id.strip().lower()
        url = f"{agent_url(sid)}/api/agent/config"
        headers = {"Accept": "application/json"}
        if agent_token:
            headers["X-Token"] = agent_token
        async with httpx.AsyncClient(timeout=20.0) as client:
            try:
                res = await client.get(url, headers=headers)
            except httpx.RequestError as exc:
                raise HTTPException(502, f"Agente indisponível: {exc}") from exc
        if res.status_code >= 400:
            raise HTTPException(res.status_code, res.text or f"HTTP {res.status_code}")
        return res.json()

    @router.api_route("/{store_id}/gateway/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def store_gateway_proxy(store_id: str, path: str, request: Request) -> Response:
        sid = store_id.strip().lower()
        sub = path.strip("/")
        url = f"{gw_base}/{sid}/{sub}" if sub else f"{gw_base}/{sid}"
        headers = {"Accept": "application/json"}
        if gateway_token:
            headers["X-Token"] = gateway_token
        body = await request.body()
        if body:
            headers["Content-Type"] = request.headers.get("content-type", "application/json")
        async with httpx.AsyncClient(timeout=60.0) as client:
            try:
                upstream = await client.request(
                    request.method,
                    url,
                    headers=headers,
                    content=body if body else None,
                )
            except httpx.RequestError as exc:
                raise HTTPException(502, f"Gateway indisponível: {exc}") from exc
        content_type = upstream.headers.get("content-type", "")
        if "application/json" in content_type and upstream.content:
            try:
                return JSONResponse(content=upstream.json(), status_code=upstream.status_code)
            except Exception:
                pass
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            media_type=content_type or "text/plain",
        )

    return router
