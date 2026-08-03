"""Monitoramento de sites das lojas."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx
from fastapi import APIRouter

from panel import cache_metrics, http_client
from panel.catalog import build_catalog
from panel.lav60_env import env_value

router = APIRouter(prefix="/api/monitor", tags=["panel-monitor"])

_cache: dict[str, Any] = {
    "data": None,
    "expires_at": 0.0,
    "stale_until": 0.0,
    "inflight": None,
}
_PROBE_CONCURRENCY = 8
_FRESH_TTL_SEC = 60.0
_STALE_TTL_SEC = 300.0  # serve stale enquanto revalida
_lock = asyncio.Lock()


async def _fetch_remote_monitor() -> dict[str, Any] | None:
    api_url = env_value("MONITOR_SITES_API_URL")
    token = env_value("MONITOR_SITES_BEARER_TOKEN")
    if not api_url:
        return None
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        res = await http_client.client().get(api_url, headers=headers, timeout=30.0)
    except httpx.RequestError:
        return None
    if res.status_code >= 400:
        return None
    try:
        data = res.json()
    except Exception:
        return None
    if isinstance(data, dict) and (data.get("sites") or data.get("summary")):
        data.setdefault("available", True)
        data.setdefault("fetched_at", int(time.time()))
        return data
    return None


async def _fetch_local_probe() -> dict[str, Any]:
    from panel import deps

    if deps.upstream_get is None:
        return {
            "available": False,
            "detail": "Painel não configurado",
            "sites": [],
            "summary": {"total": 0, "online": 0, "offline": 0},
        }

    catalog = await build_catalog(deps.upstream_get)
    domain = catalog.get("domain_suffix") or env_value("POWPAY_DOMAIN_SUFFIX", "powpay.com.br")
    metas = [m for m in (catalog.get("stores") or [])[:30] if str(m.get("id") or "").strip()]
    sem = asyncio.Semaphore(_PROBE_CONCURRENCY)
    client = http_client.client()

    async def _probe(meta: dict[str, Any]) -> dict[str, Any]:
        sid = str(meta.get("id") or "").lower()
        url = f"https://{sid}.{domain}/"
        row: dict[str, Any] = {
            "hostname": f"{sid}.{domain}",
            "url": url,
            "name": meta.get("name") or sid.upper(),
            "online": False,
        }
        async with sem:
            try:
                res = await client.get(url, timeout=8.0)
                row["online"] = res.status_code < 500
                row["http_code"] = res.status_code
                row["http_status"] = str(res.status_code)
                row["status_label"] = "online" if row["online"] else "offline"
                row["checked_at"] = int(time.time())
            except httpx.RequestError:
                row["status_label"] = "offline"
                row["checked_at"] = int(time.time())
        return row

    sites = await asyncio.gather(*[_probe(meta) for meta in metas])
    online = sum(1 for row in sites if row.get("online"))

    return {
        "available": True,
        "fetched_at": int(time.time()),
        "interval_sec": 60,
        "summary": {
            "total": len(sites),
            "online": online,
            "offline": len(sites) - online,
        },
        "sites": list(sites),
    }


async def _load_monitor_payload() -> dict[str, Any]:
    payload = await _fetch_remote_monitor()
    if not payload:
        payload = await _fetch_local_probe()
    return payload


async def _refresh_monitor_cache() -> dict[str, Any]:
    timer = cache_metrics.Timer()
    try:
        payload = await _load_monitor_payload()
        now = time.time()
        _cache["data"] = payload
        _cache["expires_at"] = now + _FRESH_TTL_SEC
        _cache["stale_until"] = now + _STALE_TTL_SEC
        cache_metrics.record("monitor_sites", hit=False, latency_ms=timer.ms())
        return payload
    finally:
        _cache["inflight"] = None


def _with_cache_flags(payload: dict[str, Any], *, cached: bool, stale: bool = False) -> dict[str, Any]:
    out = dict(payload)
    out["cached"] = cached
    out["stale"] = stale
    return out


@router.get("/sites")
async def monitor_sites(force: int = 0) -> dict[str, Any]:
    now = time.time()
    cached = _cache.get("data")

    if not force and cached and float(_cache.get("expires_at") or 0) > now:
        cache_metrics.record("monitor_sites", hit=True, latency_ms=0.1)
        return _with_cache_flags(cached, cached=True, stale=False)

    # Stale-while-revalidate: devolve cache antigo e atualiza em background.
    if not force and cached and float(_cache.get("stale_until") or 0) > now:
        if _cache.get("inflight") is None:
            _cache["inflight"] = asyncio.create_task(_refresh_monitor_cache())
        cache_metrics.record("monitor_sites", hit=True, latency_ms=0.1)
        return _with_cache_flags(cached, cached=True, stale=True)

    async with _lock:
        now = time.time()
        cached = _cache.get("data")
        if not force and cached and float(_cache.get("expires_at") or 0) > now:
            cache_metrics.record("monitor_sites", hit=True, latency_ms=0.1)
            return _with_cache_flags(cached, cached=True, stale=False)

        inflight = _cache.get("inflight")
        if inflight is None:
            inflight = asyncio.create_task(_refresh_monitor_cache())
            _cache["inflight"] = inflight

    payload = await inflight
    return _with_cache_flags(payload, cached=False, stale=False)
