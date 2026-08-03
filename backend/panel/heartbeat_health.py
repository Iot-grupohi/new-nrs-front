"""Heartbeats via probe GET https://{loja}.powpay.com.br/health (túnel Powpay)."""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any

import httpx

from panel import http_client
from panel.lav60_env import env_bool
from server.powpay import tunnel_url

log = logging.getLogger("lav60.heartbeat_health")

_PROBE_CONCURRENCY = 10
_PROBE_TIMEOUT_SEC = 12.0
_PROBE_BATCH_SIZE = 30
_FULL_SWEEP_EVERY = 6
_probe_cycle = 0
_batch_cursor = 0
_last_sync_at = 0.0
_last_sync_count = 0
_last_sync_online = 0
_last_sync_batch = 0
_last_sync_error: str | None = None


def enabled() -> bool:
    """Probe Powpay /health — desligado quando pulso RTDB está ativo."""
    from panel import heartbeat_rtdb

    if heartbeat_rtdb.enabled():
        return False
    if not env_bool("HEARTBEAT_POWPAY_HEALTH_ENABLED", default=False):
        return False
    return True


def health_probe_url(store_id: str, domain_suffix: str) -> str:
    return f"{tunnel_url(store_id, domain_suffix)}/health"


def _normalize_store_id(store_id: str) -> str:
    return str(store_id or "").strip().lower()


def _health_body_ok(body: Any, status_code: int) -> bool:
    if status_code >= 400:
        return False
    if isinstance(body, dict):
        raw = str(body.get("status") or body.get("state") or "").strip().lower()
        if raw in {"ok", "healthy", "up", "online"}:
            return True
        if body.get("service") and status_code < 400:
            return True
    return status_code < 400


async def _probe_one(
    client: httpx.AsyncClient,
    store_id: str,
    domain_suffix: str,
) -> tuple[str, dict[str, Any] | None, dict[str, Any] | None]:
    sid = _normalize_store_id(store_id)
    if not sid:
        return sid, None, None

    url = health_probe_url(sid, domain_suffix)
    try:
        res = await client.get(url, timeout=_PROBE_TIMEOUT_SEC)
        body: Any = {}
        if res.content:
            try:
                body = res.json()
            except Exception:
                body = {}
        if _health_body_ok(body, res.status_code):
            now = time.time()
            agent_base = tunnel_url(sid, domain_suffix)
            payload = {
                "store": sid,
                "heartbeat_source": "health",
                "health": body if isinstance(body, dict) else {},
                "agent_url": agent_base,
                "timestamp": int(now * 1000),
            }
            return sid, {
                "store": sid,
                "received_at": now,
                "received_at_iso": datetime.fromtimestamp(now, tz=timezone.utc).isoformat(),
                "payload": payload,
                "heartbeat_source": "health",
            }, None
        return sid, None, {
            "store": sid,
            "error": f"HTTP {res.status_code}",
            "status_code": res.status_code,
        }
    except httpx.RequestError as exc:
        return sid, None, {"store": sid, "error": str(exc), "status_code": 502}


async def _probe_metas(
    metas: list[dict[str, Any]],
    domain: str,
) -> tuple[dict[str, dict[str, Any]], set[str]]:
    if not metas:
        return {}, set()

    sem = asyncio.Semaphore(_PROBE_CONCURRENCY)
    client = http_client.client()
    rows: dict[str, dict[str, Any]] = {}
    failed: set[str] = set()

    async def _run(meta: dict[str, Any]) -> None:
        sid = _normalize_store_id(meta.get("id"))
        if not sid:
            return
        async with sem:
            _, entry, _offline = await _probe_one(client, sid, domain)
        if entry:
            rows[sid] = entry
        else:
            failed.add(sid)

    await asyncio.gather(*[_run(meta) for meta in metas])
    return rows, failed


async def _catalog_context() -> tuple[str, list[dict[str, Any]]] | None:
    from panel import deps
    from panel.catalog import build_catalog

    if not enabled() or deps.upstream_get is None:
        return None
    try:
        catalog = await build_catalog(deps.upstream_get)
    except Exception:
        return None
    domain = str(catalog.get("domain_suffix") or deps.powpay_domain or "powpay.com.br")
    metas = [
        m
        for m in (catalog.get("stores") or [])
        if _normalize_store_id(m.get("id"))
        and str(m.get("lav60_status") or "").lower() != "suspended"
    ]
    return domain, metas


async def probe_store_ids(store_ids: list[str]) -> tuple[dict[str, dict[str, Any]], set[str]]:
    """Probe imediato de lojas específicas (ex.: após POST do agente)."""
    global _last_sync_at, _last_sync_online, _last_sync_error

    ctx = await _catalog_context()
    if not ctx:
        _last_sync_error = "health_probe_unavailable"
        return {}, set()
    domain, metas = ctx
    wanted = {_normalize_store_id(s) for s in store_ids if _normalize_store_id(s)}
    batch = [m for m in metas if _normalize_store_id(m.get("id")) in wanted]
    rows, failed = await _probe_metas(batch, domain)
    _last_sync_at = time.time()
    _last_sync_online = len(rows)
    _last_sync_error = None
    return rows, failed


async def fetch_and_probe_rows(
    priority_ids: list[str] | None = None,
) -> tuple[dict[str, dict[str, Any]], set[str]]:
    """Varre catálogo: prioridade + lote rotativo; sweep completo periódico."""
    global _last_sync_at, _last_sync_count, _last_sync_online, _last_sync_batch, _last_sync_error
    global _batch_cursor, _probe_cycle

    ctx = await _catalog_context()
    if not ctx:
        _last_sync_error = "health_probe_unavailable"
        return {}, set()

    domain, metas = ctx
    if not metas:
        return {}, set()

    _probe_cycle += 1
    total = len(metas)
    priority = {_normalize_store_id(s) for s in (priority_ids or []) if _normalize_store_id(s)}
    full_sweep = _probe_cycle == 1 or (_probe_cycle % _FULL_SWEEP_EVERY == 0)

    if full_sweep:
        batch = list(metas)
    else:
        by_id = {_normalize_store_id(m.get("id")): m for m in metas}
        batch: list[dict[str, Any]] = []
        seen: set[str] = set()
        for sid in sorted(priority):
            meta = by_id.get(sid)
            if meta and sid not in seen:
                batch.append(meta)
                seen.add(sid)
        start = _batch_cursor % total
        end = min(start + _PROBE_BATCH_SIZE, total)
        for meta in metas[start:end]:
            sid = _normalize_store_id(meta.get("id"))
            if sid and sid not in seen:
                batch.append(meta)
                seen.add(sid)
        if len(batch) < _PROBE_BATCH_SIZE + len(priority):
            need = min(_PROBE_BATCH_SIZE, total)
            for meta in metas:
                sid = _normalize_store_id(meta.get("id"))
                if sid and sid not in seen:
                    batch.append(meta)
                    seen.add(sid)
                if len(batch) >= need + len(priority):
                    break
        _batch_cursor = (start + _PROBE_BATCH_SIZE) % total

    rows, failed = await _probe_metas(batch, domain)

    _last_sync_at = time.time()
    _last_sync_count = total
    _last_sync_online = len(rows)
    _last_sync_batch = len(batch)
    _last_sync_error = None
    log.debug(
        "health probe: %d online, %d failed, batch=%d/%d sweep=%s",
        len(rows),
        len(failed),
        len(batch),
        total,
        full_sweep,
    )
    return rows, failed


def sync_status() -> dict[str, Any]:
    return {
        "enabled": enabled(),
        "probe_path": "/powpay/{store}/health",
        "last_sync_at": _last_sync_at,
        "last_sync_count": _last_sync_count,
        "last_sync_online": _last_sync_online,
        "last_sync_batch": _last_sync_batch,
        "probe_batch_size": _PROBE_BATCH_SIZE,
        "probe_cycle": _probe_cycle,
        "last_sync_error": _last_sync_error,
    }
