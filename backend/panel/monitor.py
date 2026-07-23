"""Monitoramento de sites das lojas."""

from __future__ import annotations

import time
from typing import Any

import httpx
from fastapi import APIRouter

from panel.catalog import build_catalog
from panel.lav60_env import env_value

router = APIRouter(prefix="/api/monitor", tags=["panel-monitor"])

_cache: dict[str, Any] = {"data": None, "expires_at": 0.0}


async def _fetch_remote_monitor() -> dict[str, Any] | None:
    api_url = env_value("MONITOR_SITES_API_URL")
    token = env_value("MONITOR_SITES_BEARER_TOKEN")
    if not api_url:
        return None
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        try:
            res = await client.get(api_url, headers=headers)
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
    sites: list[dict] = []
    online = 0

    async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
        for meta in (catalog.get("stores") or [])[:30]:
            sid = str(meta.get("id") or "").lower()
            if not sid:
                continue
            url = f"https://{sid}.{domain}/"
            row: dict[str, Any] = {
                "hostname": f"{sid}.{domain}",
                "url": url,
                "name": meta.get("name") or sid.upper(),
                "online": False,
            }
            try:
                res = await client.get(url)
                row["online"] = res.status_code < 500
                row["http_code"] = res.status_code
                row["http_status"] = str(res.status_code)
                row["status_label"] = "online" if row["online"] else "offline"
                row["checked_at"] = int(time.time())
            except httpx.RequestError:
                row["status_label"] = "offline"
                row["checked_at"] = int(time.time())
            if row["online"]:
                online += 1
            sites.append(row)

    return {
        "available": True,
        "fetched_at": int(time.time()),
        "interval_sec": 60,
        "summary": {
            "total": len(sites),
            "online": online,
            "offline": len(sites) - online,
        },
        "sites": sites,
    }


@router.get("/sites")
async def monitor_sites(force: int = 0) -> dict[str, Any]:
    now = time.time()
    if not force and _cache["data"] and _cache["expires_at"] > now:
        return _cache["data"]

    payload = await _fetch_remote_monitor()
    if not payload:
        payload = await _fetch_local_probe()

    _cache["data"] = payload
    _cache["expires_at"] = now + 60
    return payload
