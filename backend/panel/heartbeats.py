"""Heartbeats de agentes — snapshot local + sync do painel central."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import httpx
from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from panel.lav60_env import env_value

router = APIRouter(prefix="/api/heartbeats", tags=["panel-heartbeats"])

_heartbeats: dict[str, dict[str, Any]] = {}
_listeners: list[asyncio.Queue] = []
_last_sync = 0.0
_SYNC_INTERVAL = 15.0


def _central_snapshot_url() -> str:
    explicit = env_value("PANEL_HEARTBEAT_SNAPSHOT_URL")
    if explicit:
        return explicit
    base = env_value("PANEL_HEARTBEAT_URL")
    if base:
        return base.replace("/api/heartbeat", "/api/heartbeats").rstrip("/")
    central = env_value("PANEL_CENTRAL_URL")
    if central:
        return f"{central.rstrip('/')}/api/heartbeats"
    return ""


def ingest_heartbeat(store_id: str, payload: dict[str, Any]) -> None:
    sid = store_id.strip().lower()
    entry = {
        "received_at": int(time.time()),
        "alive": True,
        "payload": payload,
    }
    _heartbeats[sid] = entry
    msg = {"type": "heartbeat", "store": sid, **entry}
    for queue in list(_listeners):
        try:
            queue.put_nowait(msg)
        except Exception:
            pass


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
            _heartbeats[str(store_id).strip().lower()] = entry
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


@router.get("")
async def heartbeats_snapshot() -> dict[str, Any]:
    await _ensure_sync()
    return {"heartbeats": _heartbeats}


@router.get("/stream")
async def heartbeats_stream() -> StreamingResponse:
    await _ensure_sync()
    queue: asyncio.Queue = asyncio.Queue()
    _listeners.append(queue)

    async def event_generator():
        try:
            snapshot = {"type": "snapshot", "heartbeats": _heartbeats}
            yield f"data: {json.dumps(snapshot, ensure_ascii=False)}\n\n"
            while True:
                try:
                    if time.time() - _last_sync >= _SYNC_INTERVAL:
                        await _sync_from_central()
                        yield f"data: {json.dumps({'type': 'snapshot', 'heartbeats': _heartbeats}, ensure_ascii=False)}\n\n"
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
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )
