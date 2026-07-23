"""Proxy de agentes Powpay e status de lojas."""

from __future__ import annotations

import time
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from panel.catalog import _catalog_settings
from panel.gateway import _gateway_verify_cache
from panel import status_store

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

    @router.get("/status-cache")
    async def stores_status_cache_bulk() -> dict[str, Any]:
        timeout = 60
        try:
            timeout = max(15, int(_catalog_settings().get("heartbeat_timeout_seconds") or 60))
        except (TypeError, ValueError):
            pass
        return status_store.list_store_cache(timeout_seconds=timeout)

    @router.get("/status-cache/status")
    async def stores_status_cache_info() -> dict[str, Any]:
        return status_store.status_cache_status()

    @router.get("/{store_id}/status-cache")
    async def store_status_cache(store_id: str) -> dict[str, Any]:
        timeout = 60
        try:
            timeout = max(15, int(_catalog_settings().get("heartbeat_timeout_seconds") or 60))
        except (TypeError, ValueError):
            pass
        return status_store.get_store_cache(store_id, timeout_seconds=timeout)

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
        data = res.json()
        try:
            status_store.ingest_agent_config(sid, data if isinstance(data, dict) else {})
        except Exception:
            pass
        return data

    def _gateway_target_url(store_id: str, sub: str) -> str:
        sid = store_id.strip().lower()
        return f"{gw_base}/{sid}/{sub}" if sub else f"{gw_base}/{sid}"

    def _should_fallback_to_gateway(response: httpx.Response | None, error: Exception | None) -> bool:
        if not gw_base:
            return False
        if error is not None:
            return True
        if response is None:
            return True
        if response.status_code in (502, 503, 504):
            return True
        body = (response.text or "").lower()
        return (
            "cloudflare" in body
            or "origin web server" in body
            or "cloudflare_error" in body
            or "bad gateway" in body
        )

    def _proxy_response(upstream: httpx.Response) -> Response:
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

    @router.api_route("/{store_id}/gateway/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def store_gateway_proxy(store_id: str, path: str, request: Request) -> Response:
        """Comandos de equipamento: agente Powpay (rede local) com fallback no MQTT Gateway."""
        sid = store_id.strip().lower()
        sub = path.strip("/")
        powpay_target = f"{agent_url(sid)}/{sid}/{sub}" if sub else f"{agent_url(sid)}/{sid}"
        gateway_target = _gateway_target_url(sid, sub)
        body = await request.body()
        content_type = request.headers.get("content-type", "application/json") if body else None

        powpay_headers: dict[str, str] = {"Accept": "application/json"}
        if agent_token:
            powpay_headers["X-Token"] = agent_token
        if body:
            powpay_headers["Content-Type"] = content_type or "application/json"

        gateway_headers: dict[str, str] = {"Accept": "application/json"}
        if gateway_token:
            gateway_headers["X-Token"] = gateway_token
        if body:
            gateway_headers["Content-Type"] = content_type or "application/json"

        powpay_error: Exception | None = None
        powpay_response: httpx.Response | None = None

        async with httpx.AsyncClient(timeout=90.0, follow_redirects=True) as client:
            try:
                powpay_response = await client.request(
                    request.method,
                    powpay_target,
                    headers=powpay_headers,
                    content=body if body else None,
                )
            except httpx.RequestError as exc:
                powpay_error = exc

            if not _should_fallback_to_gateway(powpay_response, powpay_error):
                return _proxy_response(powpay_response)

            try:
                gateway_response = await client.request(
                    request.method,
                    gateway_target,
                    headers=gateway_headers,
                    content=body if body else None,
                )
            except httpx.RequestError as exc:
                if powpay_error is not None:
                    raise HTTPException(
                        502,
                        "Túnel da loja indisponível (Cloudflare) e MQTT Gateway sem resposta. "
                        "Aguarde e tente novamente.",
                    ) from exc
                raise HTTPException(502, f"MQTT Gateway indisponível: {exc}") from exc

            return _proxy_response(gateway_response)

    return router
