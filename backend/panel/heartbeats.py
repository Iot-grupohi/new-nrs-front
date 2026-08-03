"""Heartbeats das lojas — snapshot/SSE alimentados pelo Firebase Realtime Database."""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import Response, StreamingResponse

from panel.catalog import _catalog_settings
from panel.http_cache import conditional_json, weak_etag
from panel import heartbeat_rtdb, status_store

router = APIRouter(prefix="/api/heartbeats", tags=["panel-heartbeats"])

_heartbeats: dict[str, dict[str, Any]] = {}
_listeners: list[asyncio.Queue] = []
_last_rtdb_sync = 0.0
_RTD_SYNC_INTERVAL = 5.0
_SSE_QUEUE_MAX = 64

_sync_lock = asyncio.Lock()
_sync_task: asyncio.Task | None = None
_rtdb_in_flight = False


def _normalize_store_id(store_id: str) -> str:
    return str(store_id or "").strip().lower()


def _heartbeat_timeout_seconds() -> int:
    settings = _catalog_settings()
    try:
        return max(15, int(settings.get("heartbeat_timeout_seconds") or 120))
    except (TypeError, ValueError):
        return 120


def _received_at_seconds(entry: dict[str, Any]) -> float:
    raw = entry.get("received_at")
    if isinstance(raw, (int, float)):
        value = float(raw)
        if value > 1e12:
            return value / 1000.0
        return value
    return 0.0


def _rtdb_only_mode() -> bool:
    return heartbeat_rtdb.enabled()


def _broadcast(message: dict[str, Any]) -> None:
    for queue in list(_listeners):
        try:
            queue.put_nowait(message)
        except asyncio.QueueFull:
            try:
                queue.get_nowait()
            except Exception:
                pass
            try:
                queue.put_nowait(message)
            except Exception:
                pass
        except Exception:
            pass


def _lite_payload(payload: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    keep_keys = (
        "store",
        "store_name",
        "name",
        "lav60_status",
        "store_suspended",
        "agent_url",
        "agent_local_url",
        "heartbeat_source",
        "agent_online_since_ms",
        "agent_offline_since_ms",
        "timestamp",
    )
    out = {key: payload[key] for key in keep_keys if key in payload}
    network = payload.get("network")
    if isinstance(network, dict):
        lite_net: dict[str, Any] = {}
        summary = network.get("summary")
        if isinstance(summary, dict):
            lite_net["summary"] = summary
        for key in ("washers", "dryers", "dosers", "ac", "timestamp"):
            if key in network:
                lite_net[key] = network[key]
        if lite_net:
            out["network"] = lite_net
    machines = payload.get("machines")
    if isinstance(machines, list) and machines:
        out["machines"] = machines
    return out


def _entry_alive(entry: dict[str, Any], timeout: int, now: float) -> bool:
    return now - _received_at_seconds(entry) <= timeout


def build_snapshot(*, lite: bool = False) -> dict[str, Any]:
    timeout = _heartbeat_timeout_seconds()
    settings = _catalog_settings()
    now = time.time()
    out: dict[str, Any] = {}
    for store_id, entry in _heartbeats.items():
        if str(entry.get("heartbeat_source") or "").strip().lower() != "rtdb":
            continue
        age = now - _received_at_seconds(entry)
        alive = _entry_alive(entry, timeout, now)
        row = dict(entry)
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
        lav60_status = payload.get("lav60_status")
        if isinstance(lav60_status, str):
            row["lav60_status"] = lav60_status.strip().lower()
        if lite:
            row["payload"] = _lite_payload(payload)
        out[store_id] = {
            **row,
            "alive": alive,
            "age_seconds": round(age, 1),
        }
    return {
        "heartbeats": out,
        "timeout_seconds": timeout,
        "heartbeat_interval_seconds": max(
            1, int(settings.get("heartbeat_interval_seconds") or 15)
        ),
        "network_check_interval_seconds": max(
            1, int(settings.get("network_check_interval_seconds") or 15)
        ),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "lite": bool(lite),
        "sources": {
            "post": 0,
            "rtdb": sum(1 for row in out.values() if row.get("heartbeat_source") == "rtdb"),
            "health": 0,
        },
        "rtdb": {
            **heartbeat_rtdb.sync_status(),
            **heartbeat_rtdb.last_sync_meta(),
        },
        "rtdb_only": _rtdb_only_mode(),
        "health_probe": False,
        "heartbeat_powpay_health": False,
    }


def _merge_entry(entry: dict[str, Any]) -> bool:
    if not isinstance(entry, dict):
        return False
    sid = _normalize_store_id(entry.get("store") or "")
    if not sid:
        return False
    if str(entry.get("heartbeat_source") or "").strip().lower() != "rtdb":
        return False
    existing = _heartbeats.get(sid)
    if existing:
        existing_at = _received_at_seconds(existing)
        incoming_at = _received_at_seconds(entry)
        if incoming_at < existing_at:
            return False
    _heartbeats[sid] = entry
    try:
        status_store.ingest_heartbeat_entry(sid, entry, _heartbeat_timeout_seconds())
    except Exception:
        pass
    return True


def _merge_rtdb_entry(entry: dict[str, Any]) -> bool:
    if not isinstance(entry, dict):
        return False
    payload = entry.get("payload") if isinstance(entry.get("payload"), dict) else {}
    sid = _normalize_store_id(entry.get("store") or payload.get("store"))
    if not sid:
        return False
    received_at = _received_at_seconds(entry)
    merged = _merge_entry(
        {
            "store": sid,
            "received_at": received_at,
            "received_at_iso": entry.get("received_at_iso")
            or datetime.fromtimestamp(received_at, tz=timezone.utc).isoformat(),
            "payload": payload or entry,
            "heartbeat_source": "rtdb",
        }
    )
    if merged:
        _broadcast(
            {
                "type": "heartbeat",
                "store": sid,
                "received_at": received_at,
                "payload": payload or entry,
                "heartbeat_source": "rtdb",
            }
        )
    return merged


async def _sync_from_rtdb() -> None:
    """Lê RTDB em thread; aplica merges no event loop."""
    global _last_rtdb_sync, _rtdb_in_flight
    if not heartbeat_rtdb.enabled():
        return
    if _rtdb_in_flight:
        return
    if time.time() - _last_rtdb_sync < _RTD_SYNC_INTERVAL:
        return
    _rtdb_in_flight = True
    try:
        loop = asyncio.get_running_loop()
        rows = await loop.run_in_executor(None, heartbeat_rtdb.fetch_and_record_rows)
        sync_meta = heartbeat_rtdb.last_sync_meta()
        if sync_meta.get("last_sync_error"):
            return
        live_ids = set(rows.keys())
        for entry in rows.values():
            _merge_rtdb_entry(entry)
        _last_rtdb_sync = time.time()
        # Só remove entradas ausentes se o RTDB devolveu ao menos 1 loja — evita apagar
        # tudo quando o Firebase retorna vazio por hiato transitório (token refresh, throttle).
        if not live_ids:
            return
        stale = [
            sid
            for sid, row in _heartbeats.items()
            if str(row.get("heartbeat_source") or "").strip().lower() == "rtdb"
            and sid not in live_ids
        ]
        for sid in stale:
            del _heartbeats[sid]
            _broadcast({"type": "heartbeat_removed", "store": sid})
    finally:
        _rtdb_in_flight = False


def _sync_is_fresh() -> bool:
    if not heartbeat_rtdb.enabled():
        return True
    return time.time() - _last_rtdb_sync < _RTD_SYNC_INTERVAL


async def _ensure_sync(*, force: bool = False) -> bool:
    if not force and _sync_is_fresh():
        return False
    async with _sync_lock:
        if not force and _sync_is_fresh():
            return False
        await _sync_from_rtdb()
        return True


async def _background_sync_loop() -> None:
    while True:
        try:
            await _ensure_sync(force=True)
        except Exception:
            pass
        await asyncio.sleep(_RTD_SYNC_INTERVAL)


def start_sync_loop() -> None:
    global _sync_task
    if _sync_task and not _sync_task.done():
        return
    _sync_task = asyncio.create_task(_background_sync_loop())


def stop_sync_loop() -> None:
    global _sync_task
    if _sync_task and not _sync_task.done():
        _sync_task.cancel()
    _sync_task = None


@router.get("/status")
async def heartbeats_status() -> dict[str, Any]:
    from panel import cache_metrics

    return {
        "pulse_source": "rtdb" if heartbeat_rtdb.enabled() else None,
        "rtdb": heartbeat_rtdb.sync_status(),
        "rtdb_sync": heartbeat_rtdb.last_sync_meta(),
        "rtdb_only": _rtdb_only_mode(),
        "in_memory_count": len(_heartbeats),
        "sync_fresh": _sync_is_fresh(),
        "metrics": cache_metrics.snapshot().get("heartbeats_snapshot"),
    }


def _snapshot_etag(snapshot: dict[str, Any]) -> str:
    rows = snapshot.get("heartbeats") or {}
    max_received = 0.0
    for row in rows.values():
        try:
            max_received = max(max_received, float(row.get("received_at") or 0))
        except (TypeError, ValueError):
            continue
    return weak_etag(
        "heartbeats",
        len(rows),
        round(max_received, 3),
        snapshot.get("timeout_seconds"),
        snapshot.get("rtdb_only"),
        snapshot.get("lite"),
        (snapshot.get("sources") or {}).get("rtdb"),
    )


@router.get("")
async def heartbeats_snapshot(request: Request, lite: int = 0) -> Response:
    from panel import cache_metrics

    timer = cache_metrics.Timer()
    synced = await _ensure_sync(force=False)
    use_lite = bool(lite)
    payload = build_snapshot(lite=use_lite)
    return conditional_json(
        request,
        payload,
        etag=_snapshot_etag(payload),
        cache_control="private, max-age=3, stale-while-revalidate=8",
        metric_name="heartbeats_snapshot",
        latency_ms=timer.ms(),
        memory_hit=not synced,
        extra_headers={
            "X-Heartbeat-Count": str(len(payload.get("heartbeats") or {})),
            "X-Heartbeat-Lite": "1" if use_lite else "0",
            "X-Sync": "ran" if synced else "skipped",
        },
    )


@router.get("/stream")
async def heartbeats_stream() -> StreamingResponse:
    await _ensure_sync(force=False)
    queue: asyncio.Queue = asyncio.Queue(maxsize=_SSE_QUEUE_MAX)
    _listeners.append(queue)

    async def event_generator():
        try:
            snapshot = {"type": "snapshot", **build_snapshot(lite=False)}
            yield f"data: {json.dumps(snapshot, ensure_ascii=False)}\n\n"
            while True:
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=25.0)
                    yield f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    ping = {
                        "type": "ping",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "count": len(_heartbeats),
                    }
                    yield f"data: {json.dumps(ping, ensure_ascii=False)}\n\n"
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
