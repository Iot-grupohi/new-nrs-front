"""Heartbeats de agentes — hub local (POST) + snapshot/SSE para o painel."""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from panel.catalog import _catalog_settings
from panel.lav60_env import env_value
from panel import status_store

router = APIRouter(prefix="/api/heartbeats", tags=["panel-heartbeats"])
ingest_router = APIRouter(tags=["panel-heartbeats"])

_heartbeats: dict[str, dict[str, Any]] = {}
_listeners: list[asyncio.Queue] = []
_last_sync = 0.0
_SYNC_INTERVAL = 15.0


def _normalize_store_id(store_id: str) -> str:
    return str(store_id or "").strip().lower()


def _agent_token() -> str:
    return (
        env_value("PANEL_TOKEN")
        or env_value("API_TOKEN")
        or env_value("CLOUDFLARE_API_TOKEN")
        or env_value("X_TOKEN")
    )


def _verify_agent_token(request: Request) -> None:
    expected = _agent_token()
    if not expected:
        return
    token = request.headers.get("X-Token", "")
    if token != expected:
        raise HTTPException(401, "Invalid or missing X-Token header.")


def _heartbeat_timeout_seconds() -> int:
    settings = _catalog_settings()
    try:
        return max(15, int(settings.get("heartbeat_timeout_seconds") or 60))
    except (TypeError, ValueError):
        return 60


def _received_at_seconds(entry: dict[str, Any]) -> float:
    raw = entry.get("received_at")
    if isinstance(raw, (int, float)):
        value = float(raw)
        if value > 1e12:
            return value / 1000.0
        return value
    return 0.0


def _central_snapshot_url() -> str:
    explicit = env_value("PANEL_HEARTBEAT_SNAPSHOT_URL")
    if explicit:
        return explicit
    central = env_value("PANEL_CENTRAL_URL")
    if central:
        return f"{central.rstrip('/')}/api/heartbeats"
    heartbeat_url = env_value("PANEL_HEARTBEAT_URL")
    if heartbeat_url:
        url = heartbeat_url.rstrip("/")
        if url.endswith("/api/heartbeat"):
            return f"{url[:-len('/api/heartbeat')]}/api/heartbeats"
        if url.endswith("/heartbeat"):
            return f"{url[:-len('heartbeat')]}heartbeats"
    return ""


def _broadcast(message: dict[str, Any]) -> None:
    for queue in list(_listeners):
        try:
            queue.put_nowait(message)
        except Exception:
            pass


def ingest_heartbeat(store_id: str, payload: dict[str, Any]) -> None:
    sid = _normalize_store_id(store_id)
    if not sid:
        return
    received_at = time.time()
    entry = {
        "store": sid,
        "received_at": received_at,
        "received_at_iso": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
    }
    _heartbeats[sid] = entry
    try:
        status_store.ingest_heartbeat_entry(sid, entry, _heartbeat_timeout_seconds())
    except Exception:
        pass
    _broadcast(
        {
            "type": "heartbeat",
            "store": sid,
            "received_at": received_at,
            "payload": payload,
        }
    )


def build_snapshot() -> dict[str, Any]:
    timeout = _heartbeat_timeout_seconds()
    now = time.time()
    out: dict[str, Any] = {}
    for store_id, entry in _heartbeats.items():
        age = now - _received_at_seconds(entry)
        row = dict(entry)
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
        lav60_status = payload.get("lav60_status")
        if isinstance(lav60_status, str):
            row["lav60_status"] = lav60_status.strip().lower()
        out[store_id] = {
            **row,
            "alive": age <= timeout,
            "age_seconds": round(age, 1),
        }
    return {
        "heartbeats": out,
        "timeout_seconds": timeout,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def _merge_snapshot(data: dict[str, Any]) -> None:
    global _last_sync
    rows = data.get("heartbeats")
    if not isinstance(rows, dict):
        if isinstance(data, dict) and all(isinstance(v, dict) for v in data.values()):
            rows = data
        else:
            return
    for store_id, entry in rows.items():
        if isinstance(entry, dict):
            sid = _normalize_store_id(store_id)
            _heartbeats[sid] = entry
            try:
                status_store.ingest_heartbeat_entry(sid, entry, _heartbeat_timeout_seconds())
            except Exception:
                pass
    _last_sync = time.time()


async def _sync_from_central() -> None:
    url = _central_snapshot_url()
    if not url:
        return
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            res = await client.get(url, headers={"Accept": "application/json"})
        except httpx.RequestError:
            return
    if res.status_code >= 400:
        return
    try:
        _merge_snapshot(res.json())
    except Exception:
        return


async def _ensure_sync() -> None:
    if time.time() - _last_sync < _SYNC_INTERVAL:
        return
    await _sync_from_central()


@ingest_router.post("/api/heartbeat")
async def receive_heartbeat(request: Request) -> dict[str, Any]:
    """Recebe pulse dos agentes das lojas (LAV60_Gateway)."""
    _verify_agent_token(request)
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(400, "JSON inválido")
    store_id = _normalize_store_id(body.get("store"))
    if not store_id:
        raise HTTPException(400, "Field 'store' is required.")
    ingest_heartbeat(store_id, body)
    received_at = _received_at_seconds(_heartbeats[store_id])
    return {"ok": True, "store": store_id, "received_at": received_at}


@router.get("")
async def heartbeats_snapshot() -> dict[str, Any]:
    await _ensure_sync()
    return build_snapshot()


@router.get("/stream")
async def heartbeats_stream() -> StreamingResponse:
    await _ensure_sync()
    queue: asyncio.Queue = asyncio.Queue()
    _listeners.append(queue)

    async def event_generator():
        try:
            snapshot = {"type": "snapshot", **build_snapshot()}
            yield f"data: {json.dumps(snapshot, ensure_ascii=False)}\n\n"
            while True:
                try:
                    if time.time() - _last_sync >= _SYNC_INTERVAL:
                        await _sync_from_central()
                        refresh = {"type": "snapshot", **build_snapshot()}
                        yield f"data: {json.dumps(refresh, ensure_ascii=False)}\n\n"
                    msg = await asyncio.wait_for(queue.get(), timeout=25.0)
                    yield f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            if queue in _listeners:
                _listeners.remove(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
