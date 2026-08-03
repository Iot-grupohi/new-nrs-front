"""Catálogo de lojas e bootstrap do painel."""

from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from panel import deps
from panel.http_cache import conditional_json, payload_etag, weak_etag
from panel.lav60_env import FRONTEND_DIR, env_value, read_json_file

router = APIRouter(tags=["panel-catalog"])

UpstreamGet = Callable[[str, dict | None], Awaitable[Any]]

_catalog_cache: dict[str, Any] = {"data": None, "expires_at": 0.0, "version": 0}
_catalog_lock = asyncio.Lock()
_SETTINGS_PATH = FRONTEND_DIR / "stores.json"
_TTL = 300


def _mqtt_gateway_enabled() -> bool:
    gw_url = (env_value("LAV60_GATEWAY_URL", "https://gateway.lav60.com") or "").strip()
    gw_token = (env_value("GATEWAY_API_TOKEN") or env_value("API_TOKEN") or "").strip()
    return bool(gw_url and gw_token)


def _catalog_settings() -> dict[str, Any]:
    # Agente GET01: HEARTBEAT_INTERVAL (15s) + varredura de rede NETWORK_CHECK_INTERVAL (15s).
    # heartbeat_timeout_seconds: ~3× intervalo do agente (15s) — offline rápido sem oscilar com varredura de rede.
    defaults = {
        "domain_suffix": env_value("POWPAY_DOMAIN_SUFFIX", "powpay.com.br"),
        "cache_ttl_seconds": 300,
        "heartbeat_interval_seconds": 15,
        "network_check_interval_seconds": 15,
        "heartbeat_timeout_seconds": 60,
        "offline_display_delay_seconds": 60,
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


def catalog_etag(payload: dict[str, Any] | None = None) -> str:
    data = payload or _catalog_cache.get("data") or {}
    stores = data.get("stores") or []
    ids = ",".join(str(s.get("id") or "") for s in stores)
    suspended = ",".join(str(x) for x in (data.get("suspended_store_ids") or []))
    return weak_etag(
        _catalog_cache.get("version") or 0,
        len(stores),
        ids,
        suspended,
        data.get("cache_ttl_seconds"),
    )


def invalidate_catalog_cache() -> None:
    _catalog_cache["data"] = None
    _catalog_cache["expires_at"] = 0.0


async def _build_catalog_uncached(upstream_get: UpstreamGet) -> dict[str, Any]:
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
    version = int(_catalog_cache.get("version") or 0) + 1
    payload = {
        **settings,
        "stores": stores,
        "suspended_store_ids": suspended_store_ids,
        "suspended_count": len(suspended_store_ids),
        "mqtt_gateway_enabled": _mqtt_gateway_enabled(),
        "version": version,
        "generated_at": int(time.time()),
    }
    now = time.time()
    _catalog_cache["data"] = payload
    _catalog_cache["expires_at"] = now + _TTL
    _catalog_cache["version"] = version
    return payload


async def build_catalog(upstream_get: UpstreamGet, *, force: bool = False) -> dict[str, Any]:
    now = time.time()
    if not force and _catalog_cache["data"] and _catalog_cache["expires_at"] > now:
        return _catalog_cache["data"]

    async with _catalog_lock:
        now = time.time()
        if not force and _catalog_cache["data"] and _catalog_cache["expires_at"] > now:
            return _catalog_cache["data"]
        return await _build_catalog_uncached(upstream_get)


@router.get("/api/catalog")
async def get_catalog(request: Request, force: int = 0) -> Response:
    from panel import cache_metrics

    if deps.upstream_get is None:
        raise HTTPException(500, "Painel não configurado")
    timer = cache_metrics.Timer()
    now = time.time()
    memory_hit = (
        not force
        and bool(_catalog_cache["data"])
        and float(_catalog_cache["expires_at"]) > now
    )
    payload = await build_catalog(deps.upstream_get, force=bool(force))
    # Alinha com TTL backend (300s) e SWR do frontend (fresh 2min / L1 10min).
    cache_control = "private, max-age=60, stale-while-revalidate=240"
    if force:
        cache_control = "private, no-cache"
    return conditional_json(
        request,
        payload,
        etag=catalog_etag(payload),
        cache_control=cache_control,
        metric_name="catalog",
        latency_ms=timer.ms(),
        memory_hit=memory_hit,
        extra_headers={"X-Catalog-Version": str(payload.get("version") or 0)},
    )


@router.get("/api/panel/bootstrap")
async def panel_bootstrap(request: Request) -> Response:
    from panel import cache_metrics

    timer = cache_metrics.Timer()
    agent_token = (
        env_value("CLOUDFLARE_API_TOKEN")
        or env_value("GATEWAY_API_TOKEN")
        or env_value("API_TOKEN")
        or ""
    ).strip()
    gw_token = (env_value("GATEWAY_API_TOKEN") or env_value("API_TOKEN") or "").strip()
    payload = {
        "default_agent_token": agent_token,
        "agent_token_configured": bool(agent_token),
        "mqtt_gateway_enabled": _mqtt_gateway_enabled(),
        "gateway_token_configured": bool(gw_token),
    }
    return conditional_json(
        request,
        payload,
        etag=payload_etag(payload),
        cache_control="private, max-age=1800, stale-while-revalidate=1800",
        metric_name="panel_bootstrap",
        latency_ms=timer.ms(),
        memory_hit=True,
    )


@router.get("/api/panel/cache-metrics")
async def panel_cache_metrics() -> dict[str, Any]:
    """Snapshot dos contadores HIT/MISS/latência dos endpoints quentes."""
    from panel import cache_metrics

    return {
        "ok": True,
        "metrics": cache_metrics.snapshot(),
        "generated_at": int(time.time()),
    }
