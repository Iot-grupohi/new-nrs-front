"""Gateway MQTT via painel — /api/gateway/*."""

from __future__ import annotations

import time
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from panel.lav60_env import env_value

router = APIRouter(prefix="/api/gateway", tags=["panel-gateway"])

_gateway_verify_cache: dict[str, dict[str, Any]] = {}


def register_gateway(
    *,
    gateway_url: str,
    gateway_token: str,
) -> APIRouter:
    base = gateway_url.rstrip("/")

    @router.get("/config")
    async def gateway_config() -> dict[str, Any]:
        return {
            "token_configured": bool(gateway_token),
            "gateway_url": base,
            "washers": [],
            "dryers": [],
            "dosers": [],
            "dryer_minutes": [15, 30, 45, 60],
            "ac_temperatures": ["18", "20", "22", "24"],
        }

    @router.get("/health")
    async def gateway_health() -> dict[str, Any]:
        headers = {"Accept": "application/json"}
        if gateway_token:
            headers["X-Token"] = gateway_token
        async with httpx.AsyncClient(timeout=15.0) as client:
            try:
                res = await client.get(f"{base}/", headers=headers)
                if res.status_code < 400:
                    data = res.json() if res.content else {"status": "ok"}
                    if isinstance(data, dict):
                        data.setdefault("online", True)
                        data.setdefault("system_online", True)
                        data.setdefault("message", "MQTT Gateway API LAV60 online")
                        return data
                    return {
                        "status": "ok",
                        "online": True,
                        "system_online": True,
                        "message": "MQTT Gateway API LAV60 online",
                    }
            except httpx.RequestError:
                pass
        raise HTTPException(502, "MQTT Gateway indisponível")

    @router.post("/{store}/verify")
    async def verify_store_gateway(store: str) -> dict[str, Any]:
        sid = store.strip().lower()
        cached = _gateway_verify_cache.get(sid)
        if cached and time.time() - cached.get("checked_at", 0) < 60:
            return cached["payload"]

        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if gateway_token:
            headers["X-Token"] = gateway_token

        online = False
        error = None
        api_online = False
        async with httpx.AsyncClient(timeout=25.0) as client:
            try:
                res = await client.post(
                    f"{base}/{sid}/led/on",
                    headers=headers,
                    json={"command": "ON"},
                )
            except httpx.RequestError as exc:
                error = str(exc)
            else:
                body_text = (res.text or "").lower()
                api_online = res.status_code not in (502, 503, 504) and "connection" not in body_text
                if res.status_code < 400:
                    online = True
                elif res.status_code == 400 and (
                    "esp8266" in body_text
                    or "did not respond" in body_text
                    or "timeout" in body_text
                ):
                    online = False
                    error = "Módulo da loja não respondeu (API do gateway está online)"
                    api_online = True
                elif res.status_code == 404:
                    online = False
                    error = "Loja não encontrada no gateway"
                    api_online = True
                else:
                    online = False
                    try:
                        detail = res.json()
                        error = (
                            detail.get("detail")
                            or detail.get("message")
                            or detail.get("error")
                            or f"HTTP {res.status_code}"
                        )
                    except Exception:
                        error = res.text.strip() or f"HTTP {res.status_code}"

        payload = {
            "gateway_online": online,
            "gateway_api_online": api_online,
            "gateway_error": error,
            "gateway_checked_at_ms": int(time.time() * 1000),
        }
        _gateway_verify_cache[sid] = {"checked_at": time.time(), "payload": payload}
        return payload

    @router.api_route("/{store}/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def gateway_proxy(store: str, path: str, request: Request) -> Response:
        sid = store.strip().lower()
        sub = path.strip("/")
        url = f"{base}/{sid}/{sub}" if sub else f"{base}/{sid}"
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
                raise HTTPException(502, f"Erro ao conectar MQTT Gateway: {exc}") from exc

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
