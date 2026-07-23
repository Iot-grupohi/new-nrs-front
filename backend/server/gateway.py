"""Proxy para MQTT Gateway (gateway.lav60.com)."""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response


def normalize_gateway_path(path: str) -> str:
    parts = path.strip("/").split("/")
    if parts and parts[0]:
        parts[0] = parts[0].lower()
    return "/".join(parts)


async def proxy_gateway(
    *,
    gateway_url: str,
    gateway_token: str,
    method: str,
    path: str,
    body: bytes | None = None,
    content_type: str | None = None,
    require_token: bool = True,
) -> Response | JSONResponse:
    if require_token and not gateway_token:
        raise HTTPException(
            500,
            "GATEWAY_API_TOKEN não configurado no servidor",
        )

    normalized = normalize_gateway_path(path)
    url = f"{gateway_url.rstrip('/')}/{normalized}" if normalized else gateway_url.rstrip("/")

    headers: dict[str, str] = {"Accept": "application/json"}
    if gateway_token:
        headers["X-Token"] = gateway_token
    if body is not None and content_type:
        headers["Content-Type"] = content_type

    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            response = await client.request(method, url, headers=headers, content=body)
        except httpx.RequestError as exc:
            raise HTTPException(502, f"Erro ao conectar MQTT Gateway: {exc}") from exc

    resp_type = response.headers.get("content-type", "")
    if "application/json" in resp_type and response.content:
        try:
            return JSONResponse(
                content=response.json(),
                status_code=response.status_code,
            )
        except Exception:
            pass

    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type=resp_type or "text/plain",
    )


def gateway_public_paths() -> set[str]:
    return {"/gateway", "/gateway/"}


def is_gateway_path(path: str) -> bool:
    return path == "/gateway" or path.startswith("/gateway/")


def require_gateway_token(request: Request, gateway_token: str) -> None:
    if request.url.path in gateway_public_paths():
        return
    if not gateway_token:
        raise HTTPException(500, "GATEWAY_API_TOKEN não configurado no servidor")
    token = request.headers.get("X-Token", "")
    if token != gateway_token:
        raise HTTPException(401, "X-Token inválido ou ausente (MQTT Gateway)")


def gateway_info(gateway_url: str) -> dict[str, Any]:
    base = gateway_url.rstrip("/")
    return {
        "gateway_url": base,
        "local_prefix": "/gateway",
        "swagger": f"{base}/docs",
        "openapi": f"{base}/openapi.json",
        "examples": {
            "health": "GET /gateway/",
            "status_all": "GET /gateway/{store}/status",
            "washer": "POST /gateway/{store}/washer/{id}",
        },
    }
