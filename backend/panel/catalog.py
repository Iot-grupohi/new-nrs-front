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
    # Agente LAV60: HEARTBEAT_INTERVAL (15s) + heartbeat extra após NETWORK_CHECK_INTERVAL (60s).
    # heartbeat_timeout_seconds: margem offline = 2× varredura de rede (120s) — tolera falhas de POST
    # e pausa da thread 15s enquanto a varredura 60s ainda envia pulso.
    defaults = {
        "domain_suffix": env_value("POWPAY_DOMAIN_SUFFIX", "powpay.com.br"),
        "cache_ttl_seconds": 300,
        "heartbeat_interval_seconds": 15,
        "network_check_interval_seconds": 60,
        "heartbeat_timeout_seconds": 120,
        "offline_display_delay_seconds": 180,
        "refresh_concurrency": 20,
        "ac_id": env_value("PANEL_AC_ID", "110"),
    }
    stored = read_json_file(_SETTINGS_PATH, {}) or {}
    return {**defaults, **stored}


def _normalize_store_id(code: str | None) -> str:
    return str(code or "").strip().lower()


def _catalog_store_entry(
    store_id: str,
    *,
    name: str | None = None,
    lav60_status: str | None = None,
) -> dict[str, Any]:
    sid = _normalize_store_id(store_id)
    entry: dict[str, Any] = {
        "id": sid,
        "name": (name or sid.upper()).strip() or sid.upper(),
    }
    if lav60_status:
        entry["lav60_status"] = lav60_status
    return entry


def _merge_catalog_store(
    stores_by_id: dict[str, dict[str, Any]],
    entry: dict[str, Any],
) -> None:
    sid = _normalize_store_id(entry.get("id"))
    if not sid:
        return
    prev = stores_by_id.get(sid)
    if not prev:
        stores_by_id[sid] = entry
        return
    merged = {**prev, **entry, "id": sid}
    if entry.get("lav60_status") == "suspended":
        merged["lav60_status"] = "suspended"
    stores_by_id[sid] = merged


async def _fetch_active_store_codes(upstream_get: UpstreamGet) -> list[dict[str, Any]]:
    raw = await upstream_get("/api/v1/stores/codes")
    rows: list[dict[str, Any]] = []
    for code in raw.get("store_codes") or []:
        sid = _normalize_store_id(code)
        if sid:
            rows.append(_catalog_store_entry(sid))
    return rows


async def _fetch_suspended_stores(upstream_get: UpstreamGet) -> list[dict[str, Any]]:
    raw = await upstream_get("/api/v1/stores", {"status": "suspended"})
    rows: list[dict[str, Any]] = []
    for item in raw.get("data") or []:
        attrs = item.get("attributes") or {}
        sid = _normalize_store_id(attrs.get("code"))
        if not sid:
            continue
        name = str(attrs.get("name") or sid.upper()).strip() or sid.upper()
        rows.append(
            _catalog_store_entry(
                sid,
                name=name,
                lav60_status="suspended",
            )
        )
    return rows


async def build_catalog(upstream_get: UpstreamGet, *, force: bool = False) -> dict[str, Any]:
    now = time.time()
    if not force and _catalog_cache["data"] and _catalog_cache["expires_at"] > now:
        return _catalog_cache["data"]

    settings = _catalog_settings()
    stores_by_id: dict[str, dict[str, Any]] = {}

    try:
        for entry in await _fetch_active_store_codes(upstream_get):
            _merge_catalog_store(stores_by_id, entry)
    except Exception:
        pass

    try:
        for entry in await _fetch_suspended_stores(upstream_get):
            _merge_catalog_store(stores_by_id, entry)
    except Exception:
        pass

    stores = sorted(stores_by_id.values(), key=lambda row: row["id"])
    suspended_store_ids = sorted(
        row["id"] for row in stores if row.get("lav60_status") == "suspended"
    )
    payload = {
        **settings,
        "stores": stores,
        "suspended_store_ids": suspended_store_ids,
        "suspended_count": len(suspended_store_ids),
    }
    _catalog_cache["data"] = payload
    _catalog_cache["expires_at"] = now + _TTL
    return payload


@router.get("/api/catalog")
async def get_catalog(force: int = 0) -> dict[str, Any]:
    if deps.upstream_get is None:
        raise HTTPException(500, "Painel não configurado")
    return await build_catalog(deps.upstream_get, force=bool(force))


@router.get("/api/panel/bootstrap")
async def panel_bootstrap() -> dict[str, Any]:
    token = env_value("CLOUDFLARE_API_TOKEN") or env_value("GATEWAY_API_TOKEN")
    return {
        "default_agent_token": token,
        "agent_token_configured": bool(token),
    }
