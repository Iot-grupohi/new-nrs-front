"""Catálogo de lojas e bootstrap do painel."""

from __future__ import annotations

import time
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, HTTPException

from panel import deps
from panel.lav60_env import FRONTEND_DIR, env_value, read_json_file

router = APIRouter(tags=["panel-catalog"])

UpstreamGet = Callable[[str, dict | None], Awaitable[Any]]

_catalog_cache: dict[str, Any] = {"data": None, "expires_at": 0.0}
_SETTINGS_PATH = FRONTEND_DIR / "stores.json"
_TTL = 300


def _catalog_settings() -> dict[str, Any]:
    defaults = {
        "domain_suffix": env_value("POWPAY_DOMAIN_SUFFIX", "powpay.com.br"),
        "cache_ttl_seconds": 300,
        "heartbeat_interval_seconds": 15,
        "heartbeat_timeout_seconds": 60,
        "offline_display_delay_seconds": 120,
        "refresh_concurrency": 20,
        "ac_id": env_value("PANEL_AC_ID", "110"),
    }
    stored = read_json_file(_SETTINGS_PATH, {}) or {}
    return {**defaults, **stored}


async def build_catalog(upstream_get: UpstreamGet, *, force: bool = False) -> dict[str, Any]:
    now = time.time()
    if not force and _catalog_cache["data"] and _catalog_cache["expires_at"] > now:
        return _catalog_cache["data"]

    settings = _catalog_settings()
    stores: list[dict[str, Any]] = []

    try:
        raw = await upstream_get("/api/v1/stores/codes")
        codes = raw.get("store_codes") or []
        for code in codes:
            sid = str(code).strip().lower()
            if sid:
                stores.append({"id": sid, "name": sid.upper()})
    except Exception:
        pass

    payload = {**settings, "stores": stores}
    _catalog_cache["data"] = payload
    _catalog_cache["expires_at"] = now + _TTL
    return payload


@router.get("/api/catalog")
async def get_catalog() -> dict[str, Any]:
    if deps.upstream_get is None:
        raise HTTPException(500, "Painel não configurado")
    return await build_catalog(deps.upstream_get)


@router.get("/api/panel/bootstrap")
async def panel_bootstrap() -> dict[str, Any]:
    token = (
        env_value("CLOUDFLARE_API_TOKEN")
        or env_value("GATEWAY_API_TOKEN")
        or env_value("X_TOKEN")
    )
    return {"default_agent_token": token}
