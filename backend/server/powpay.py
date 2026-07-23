"""Proxy para agentes Powpay via Cloudflare Tunnel ({store}.powpay.com.br)."""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

POWPAY_PUBLIC_SUFFIXES = {
    "",
    "health",
    "api/health",
    "api/agent/config",
    "debug",
    "tunnel-status",
    "api/tunnel-status",
    "tunnel-test",
    "tunnel-monitoring",
}


def tunnel_url(store_code: str, domain_suffix: str) -> str:
    return f"https://{store_code.lower()}.{domain_suffix.rstrip('/')}"


def normalize_powpay_path(path: str) -> str:
    parts = path.strip("/").split("/")
    if parts and parts[0]:
        parts[0] = parts[0].lower()
    return "/".join(parts)


def is_powpay_path(path: str) -> bool:
    return path == "/powpay" or path.startswith("/powpay/")


def parse_powpay_path(path: str) -> tuple[str, str] | None:
    """Retorna (store_code, relative_path) ou None se inválido."""
    parts = path.strip("/").split("/")
    if len(parts) < 2 or parts[0] != "powpay":
        return None
    store_code = parts[1].lower()
    relative = "/".join(parts[2:]) if len(parts) > 2 else ""
    return store_code, relative


def is_powpay_public(relative_path: str) -> bool:
    return relative_path.strip("/") in POWPAY_PUBLIC_SUFFIXES


def require_powpay_token(
    request: Request,
    api_token: str,
    *,
    allow_public: bool = True,
) -> None:
    parsed = parse_powpay_path(request.url.path)
    if not parsed:
        return

    _, relative = parsed
    if allow_public and is_powpay_public(relative):
        return

    if not api_token:
        raise HTTPException(500, "CLOUDFLARE_API_TOKEN não configurado no servidor")

    token = request.headers.get("X-Token", "")
    if token != api_token:
        raise HTTPException(401, "X-Token inválido ou ausente (Powpay / Cloudflare)")


async def proxy_powpay(
    *,
    store_code: str,
    domain_suffix: str,
    api_token: str,
    method: str,
    path: str,
    body: bytes | None = None,
    content_type: str | None = None,
    query: str | None = None,
    require_token: bool = True,
) -> Response | JSONResponse:
    if require_token and not api_token:
        raise HTTPException(500, "CLOUDFLARE_API_TOKEN não configurado no servidor")

    base = tunnel_url(store_code, domain_suffix)
    normalized = normalize_powpay_path(path)
    url = f"{base}/{normalized}" if normalized else base
    if query:
        url = f"{url}?{query}"

    headers: dict[str, str] = {"Accept": "application/json"}
    if require_token:
        if not api_token:
            raise HTTPException(500, "CLOUDFLARE_API_TOKEN não configurado no servidor")
        headers["X-Token"] = api_token
    if body is not None and content_type:
        headers["Content-Type"] = content_type

    async with httpx.AsyncClient(timeout=90.0, follow_redirects=True) as client:
        try:
            response = await client.request(method, url, headers=headers, content=body)
        except httpx.RequestError as exc:
            raise HTTPException(
                502,
                f"Erro ao conectar túnel Powpay ({store_code}): {exc}",
            ) from exc

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


def powpay_info(domain_suffix: str, store_code: str = "pb05") -> dict[str, Any]:
    store = store_code.lower()
    base = tunnel_url(store, domain_suffix)
    local = f"/powpay/{store}"
    return {
        "domain_suffix": domain_suffix,
        "tunnel_url_template": f"https://{{store}}.{domain_suffix}",
        "example_tunnel_url": base,
        "local_prefix": local,
        "local_base_url": f"http://127.0.0.1:3100{local}",
        "examples": {
            "health": f"GET {local}/health",
            "status": f"GET {local}/{store}/status",
            "washer": f"POST {local}/{store}/washer/{{id}}",
            "tunnel_status": f"GET {local}/tunnel-status",
        },
    }
