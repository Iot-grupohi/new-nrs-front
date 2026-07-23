"""Lav60 API Portal + MQTT Gateway + Powpay Cloudflare — proxy local."""

from __future__ import annotations

import os
import time
from contextlib import asynccontextmanager
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse

import panel_infra as infra_svc

from server.gateway import (
    gateway_info,
    gateway_public_paths,
    is_gateway_path,
    proxy_gateway,
    require_gateway_token,
)
from server.powpay import (
    is_powpay_path,
    is_powpay_public,
    powpay_info,
    proxy_powpay,
    require_powpay_token,
)
from server.routes import build_routes_map
from server.totem import (
    is_totem_path,
    is_totem_public,
    proxy_totem,
    require_totem_token,
    totem_info,
    totem_relative_path,
)
from panel.paths import is_panel_path, is_frontend_static_path
from panel.router import mount_panel

load_dotenv()

PORT = int(os.getenv("PORT", "3100"))
UPSTREAM_URL = os.getenv(
    "LAV60_UPSTREAM_URL", "https://sistema.lavanderia60minutos.com.br"
).rstrip("/")
TOTEM_URL = os.getenv(
    "BASE_URL", "https://staging.lavanderia60minutos.com.br"
).rstrip("/")
SERVER_URL = os.getenv("LAV60_SERVER_URL", f"http://127.0.0.1:{PORT}")
API_TOKEN = (
    os.getenv("LAV60_API_TOKEN")
    or os.getenv("X_TOKEN")
    or os.getenv("X_TOKEN_API", "")
)
GATEWAY_URL = os.getenv(
    "LAV60_GATEWAY_URL", "https://gateway.lav60.com"
).rstrip("/")
GATEWAY_API_TOKEN = os.getenv("GATEWAY_API_TOKEN") or os.getenv("API_TOKEN", "")
POWPAY_DOMAIN_SUFFIX = os.getenv("POWPAY_DOMAIN_SUFFIX", "powpay.com.br")
CLOUDFLARE_API_TOKEN = os.getenv("CLOUDFLARE_API_TOKEN", "")
STORE_CODES_TTL = int(os.getenv("STORE_CODES_CACHE_TTL", "300"))

PUBLIC_PATHS = {
    "/",
    "/health",
    "/api/health",
    "/api/routes",
    "/api/v1/upstream",
    "/api/v1/gateway",
    "/api/v1/powpay",
    "/api/v1/totem",
    *gateway_public_paths(),
}

_store_codes_cache: dict[str, Any] = {"data": None, "expires_at": 0.0}


@asynccontextmanager
async def _app_lifespan(_app: FastAPI):
    infra_svc.start_db_metrics_poller()
    yield
    infra_svc.stop_db_metrics_poller()


app = FastAPI(
    title="Lav60 Unified API Proxy",
    description=(
        "Domínio único local para Portal, Totem, MQTT Gateway e Powpay. "
        "Todas as collections Postman apontam para este servidor."
    ),
    version="2.0.0",
    lifespan=_app_lifespan,
)


def _routes_payload() -> dict[str, Any]:
    return build_routes_map(
        server_url=SERVER_URL,
        portal_url=UPSTREAM_URL,
        totem_url=TOTEM_URL,
        gateway_url=GATEWAY_URL,
        powpay_domain=POWPAY_DOMAIN_SUFFIX,
        tokens={
            "portal": bool(API_TOKEN),
            "totem": bool(API_TOKEN),
            "gateway": bool(GATEWAY_API_TOKEN),
            "powpay": bool(CLOUDFLARE_API_TOKEN),
        },
    )


def _require_portal_token(request: Request) -> None:
    if (
        request.url.path in PUBLIC_PATHS
        or is_panel_path(request.url.path)
        or is_frontend_static_path(request.url.path)
        or is_gateway_path(request.url.path)
        or is_powpay_path(request.url.path)
        or is_totem_path(request.url.path)
    ):
        return
    token = request.headers.get("X-Token", "")
    if not API_TOKEN:
        raise HTTPException(
            500,
            "LAV60_API_TOKEN (ou X_TOKEN) não configurado no servidor",
        )
    if token != API_TOKEN:
        raise HTTPException(401, "X-Token inválido ou ausente (API Portal)")


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    try:
        if is_totem_path(request.url.path):
            require_totem_token(request, API_TOKEN)
        elif is_powpay_path(request.url.path):
            require_powpay_token(request, CLOUDFLARE_API_TOKEN)
        elif is_gateway_path(request.url.path):
            require_gateway_token(request, GATEWAY_API_TOKEN)
        else:
            _require_portal_token(request)
    except HTTPException as exc:
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail},
        )
    return await call_next(request)


async def upstream_get(path: str, params: dict | None = None) -> Any:
    if not API_TOKEN:
        raise HTTPException(500, "Token da API não configurado no servidor")

    url = f"{UPSTREAM_URL}{path}"
    headers = {"X-Token": API_TOKEN, "Accept": "application/json"}

    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            response = await client.get(url, headers=headers, params=params or {})
        except httpx.RequestError as exc:
            raise HTTPException(502, f"Erro ao conectar upstream: {exc}") from exc

    if response.status_code >= 400:
        try:
            detail = response.json()
        except Exception:
            detail = response.text
        raise HTTPException(response.status_code, detail)

    if not response.content:
        return {}
    return response.json()


def parse_store(data: dict) -> dict:
    attrs = data.get("attributes") or {}
    return {
        "id": data.get("id"),
        "code": attrs.get("code"),
        "name": attrs.get("name"),
        "city": attrs.get("city"),
        "state": attrs.get("state"),
        "status": attrs.get("status"),
        "hibank_status": attrs.get("hibank-status"),
        "accept_cash": attrs.get("accept-cash"),
        "accept_card": attrs.get("accept-card"),
        "machine_type": attrs.get("machine-type"),
        "execute_machine_method": attrs.get("execute-machine-method"),
        "zipcode": attrs.get("zipcode"),
    }


def parse_machine(item: dict) -> dict:
    attrs = item.get("attributes") or {}
    return {
        "id": item.get("id"),
        "code": attrs.get("name"),
        "name": attrs.get("name"),
        "status": attrs.get("status"),
        "machine_type": attrs.get("machine-type"),
        "store_code": attrs.get("store_code"),
        "address": attrs.get("address"),
        "waiting_minutes": attrs.get("waiting-minutes"),
    }


@app.get("/")
async def root():
    return _routes_payload()


@app.get("/api/routes")
async def routes_map():
    return _routes_payload()


@app.get("/health")
@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "server_url": SERVER_URL,
        "upstream": UPSTREAM_URL,
        "totem": TOTEM_URL,
        "gateway": GATEWAY_URL,
        "powpay_domain": POWPAY_DOMAIN_SUFFIX,
        "token_configured": bool(API_TOKEN),
        "gateway_token_configured": bool(GATEWAY_API_TOKEN),
        "cloudflare_token_configured": bool(CLOUDFLARE_API_TOKEN),
        "routes": f"{SERVER_URL.rstrip('/')}/api/routes",
    }


@app.get("/api/v1/upstream")
async def upstream_info():
    return {
        "upstream_url": UPSTREAM_URL,
        "endpoints": {
            "stores_codes": f"{UPSTREAM_URL}/api/v1/stores/codes",
            "store_detail": f"{UPSTREAM_URL}/api/v1/stores/{{code}}",
            "machines": f"{UPSTREAM_URL}/api/v1/machines",
        },
    }


@app.get("/api/v1/gateway")
async def gateway_upstream_info():
    return gateway_info(GATEWAY_URL)


@app.get("/gateway")
@app.get("/gateway/")
async def gateway_health():
    return await proxy_gateway(
        gateway_url=GATEWAY_URL,
        gateway_token=GATEWAY_API_TOKEN,
        method="GET",
        path="",
        require_token=False,
    )


@app.api_route("/gateway/{path:path}", methods=["GET", "POST"])
async def gateway_proxy(path: str, request: Request):
    body = await request.body()
    content_type = request.headers.get("content-type")
    return await proxy_gateway(
        gateway_url=GATEWAY_URL,
        gateway_token=GATEWAY_API_TOKEN,
        method=request.method,
        path=path,
        body=body if body else None,
        content_type=content_type,
    )


@app.get("/api/v1/powpay")
async def powpay_upstream_info(store_code: str = Query("pb05")):
    return powpay_info(POWPAY_DOMAIN_SUFFIX, store_code)


async def _powpay_forward(store_code: str, path: str, request: Request):
    body = await request.body()
    content_type = request.headers.get("content-type")
    return await proxy_powpay(
        store_code=store_code,
        domain_suffix=POWPAY_DOMAIN_SUFFIX,
        api_token=CLOUDFLARE_API_TOKEN,
        method=request.method,
        path=path,
        body=body if body else None,
        content_type=content_type,
        query=request.url.query,
        require_token=not is_powpay_public(path),
    )


@app.api_route("/powpay/{store_code}", methods=["GET", "POST"])
@app.api_route("/powpay/{store_code}/", methods=["GET", "POST"])
async def powpay_root(store_code: str, request: Request):
    return await _powpay_forward(store_code, "", request)


@app.api_route("/powpay/{store_code}/{path:path}", methods=["GET", "POST"])
async def powpay_proxy(store_code: str, path: str, request: Request):
    return await _powpay_forward(store_code, path, request)


@app.get("/api/v1/totem")
async def totem_upstream_info():
    return totem_info(TOTEM_URL)


async def _totem_forward(path: str, request: Request):
    body = await request.body()
    content_type = request.headers.get("content-type")
    relative = path
    return await proxy_totem(
        totem_url=TOTEM_URL,
        api_token=API_TOKEN,
        method=request.method,
        path=relative,
        body=body if body else None,
        content_type=content_type,
        query=request.url.query,
        authorization=request.headers.get("Authorization"),
        require_token=not is_totem_public(relative),
    )


@app.api_route("/totem", methods=["GET", "POST"])
@app.api_route("/totem/", methods=["GET", "POST"])
async def totem_root(request: Request):
    return await _totem_forward("", request)


@app.api_route("/totem/{path:path}", methods=["GET", "POST"])
async def totem_proxy(path: str, request: Request):
    return await _totem_forward(path, request)


@app.get("/api/v1/stores/codes")
async def store_codes(
    force: int = Query(0),
    parsed: int = Query(1),
):
    now = time.time()
    if not force and _store_codes_cache["data"] and _store_codes_cache["expires_at"] > now:
        raw = _store_codes_cache["data"]
    else:
        raw = await upstream_get("/api/v1/stores/codes")
        _store_codes_cache["data"] = raw
        _store_codes_cache["expires_at"] = now + STORE_CODES_TTL

    if not parsed:
        return raw

    codes = raw.get("store_codes") or []
    return {
        "store_codes": codes,
        "count": len(codes),
        "cached": not bool(force),
        "cache_ttl_seconds": STORE_CODES_TTL,
    }


@app.get("/api/v1/stores/{store_code}")
async def store_detail(store_code: str, parsed: int = Query(1)):
    raw = await upstream_get(f"/api/v1/stores/{store_code}")
    if not parsed:
        return raw
    data = raw.get("data") or {}
    return {"data": parse_store(data)}


@app.get("/api/v1/stores/{store_code}/profile")
async def store_profile(store_code: str):
    store_raw = await upstream_get(f"/api/v1/stores/{store_code}")
    hi_bank_raw = await upstream_get(
        "/api/v1/hi_banks/account",
        {"store_code": store_code},
    )
    data = store_raw.get("data") or {}
    attrs = data.get("attributes") or {}
    hi_bank_attrs = (hi_bank_raw.get("data") or {}).get("attributes") or {}
    store = parse_store(data)
    return {
        "store": store,
        "hibank": {
            "store_code": store_code,
            "status": hi_bank_attrs.get("status") or attrs.get("hibank-status"),
            "representative_name": hi_bank_attrs.get("representative_name"),
            "representative_email": hi_bank_attrs.get("representative_email"),
            "source": "hi_banks_account" if hi_bank_attrs else "store_attributes",
        },
    }


@app.get("/api/v1/hi-banks/account")
@app.get("/api/v1/hi_banks/account")
async def hibank_account(
    store_code: str = Query(..., alias="store_code"),
    parsed: int = Query(1),
    raw: int = Query(0),
):
    upstream = await upstream_get("/api/v1/hi_banks/account", {"store_code": store_code})
    if raw or not parsed:
        return upstream

    data = upstream.get("data") or {}
    attrs = data.get("attributes") or {}
    return {
        "data": {
            "store_code": store_code.upper(),
            "representative_name": attrs.get("representative_name"),
            "representative_email": attrs.get("representative_email"),
            "status": attrs.get("status"),
            "pix_key_receive": attrs.get("pix_key_receive"),
            "id_ref": attrs.get("id_ref"),
            "created_at": attrs.get("created_at"),
            "updated_at": attrs.get("updated_at"),
        }
    }


@app.get("/api/v1/machines")
async def machines(
    store_code: str = Query(..., alias="store_code"),
    raw: int = Query(0),
):
    raw_data = await upstream_get("/api/v1/machines", {"store_code": store_code})
    if raw:
        return raw_data

    store_raw = await upstream_get(f"/api/v1/stores/{store_code}")
    store_status = (store_raw.get("data") or {}).get("attributes", {}).get("status")
    lav60_status = "suspended" if store_status == "suspended" else "ok"

    items = [parse_machine(m) for m in raw_data.get("data") or []]
    return {
        "store_code": store_code,
        "lav60_status": lav60_status,
        "machines": items,
        "count": len(items),
    }


mount_panel(
    app,
    upstream_get=upstream_get,
    gateway_url=GATEWAY_URL,
    gateway_token=GATEWAY_API_TOKEN,
    powpay_domain=POWPAY_DOMAIN_SUFFIX,
    agent_token=CLOUDFLARE_API_TOKEN,
)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server.app:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=PORT,
        reload=os.getenv("RELOAD", "0") == "1",
    )
