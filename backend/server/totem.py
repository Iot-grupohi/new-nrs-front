"""Proxy para API Totem / Security (staging.lavanderia60minutos.com.br)."""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

TOTEM_PUBLIC_SUFFIXES = {
    "oauth/token",
}


def is_totem_path(path: str) -> bool:
    return path == "/totem" or path.startswith("/totem/")


def totem_relative_path(path: str) -> str:
    parts = path.strip("/").split("/")
    if len(parts) < 2 or parts[0] != "totem":
        return ""
    return "/".join(parts[1:])


def is_totem_public(relative_path: str) -> bool:
    return relative_path.strip("/") in TOTEM_PUBLIC_SUFFIXES


def require_totem_token(request: Request, api_token: str) -> None:
    relative = totem_relative_path(request.url.path)
    if is_totem_public(relative):
        return
    if not api_token:
        raise HTTPException(500, "X_TOKEN não configurado no servidor (totem)")
    token = request.headers.get("X-Token", "")
    if token != api_token:
        raise HTTPException(401, "X-Token inválido ou ausente (Totem)")


async def proxy_totem(
    *,
    totem_url: str,
    api_token: str,
    method: str,
    path: str,
    body: bytes | None = None,
    content_type: str | None = None,
    query: str | None = None,
    authorization: str | None = None,
    require_token: bool = True,
) -> Response | JSONResponse:
    if require_token and not api_token:
        raise HTTPException(500, "X_TOKEN não configurado no servidor (totem)")

    relative = path.strip("/")
    url = f"{totem_url.rstrip('/')}/{relative}" if relative else totem_url.rstrip("/")
    if query:
        url = f"{url}?{query}"

    headers: dict[str, str] = {"Accept": "application/json"}
    if api_token:
        headers["X-Token"] = api_token
    if authorization:
        headers["Authorization"] = authorization
    if body is not None and content_type:
        headers["Content-Type"] = content_type

    async with httpx.AsyncClient(timeout=90.0, follow_redirects=True) as client:
        try:
            response = await client.request(method, url, headers=headers, content=body)
        except httpx.RequestError as exc:
            raise HTTPException(502, f"Erro ao conectar API Totem: {exc}") from exc

    resp_type = response.headers.get("content-type", "")
    if "application/json" in resp_type and response.content:
        try:
            return JSONResponse(content=response.json(), status_code=response.status_code)
        except Exception:
            pass

    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type=resp_type or "text/plain",
    )


def totem_info(totem_url: str) -> dict[str, Any]:
    return {
        "totem_url": totem_url,
        "local_prefix": "/totem",
        "examples": {
            "login": "POST /totem/api/v1/customers/auth/login",
            "stores": "GET /totem/api/v1/stores",
            "products": "GET /totem/api/v1/products",
            "pix": "POST /totem/api/v1/payments/pix_to_hipag",
            "oauth": "POST /totem/oauth/token",
        },
    }
