"""Monitor sites: cache fresco + SWR."""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from panel import monitor  # noqa: E402


def test_monitor_sites_serves_fresh_cache(monkeypatch):
    payload = {
        "available": True,
        "sites": [{"hostname": "a.example", "online": True}],
        "summary": {"total": 1, "online": 1, "offline": 0},
        "fetched_at": int(time.time()),
    }
    monitor._cache["data"] = payload
    monitor._cache["expires_at"] = time.time() + 60
    monitor._cache["stale_until"] = time.time() + 300
    monitor._cache["inflight"] = None

    calls = {"n": 0}

    async def boom():
        calls["n"] += 1
        raise AssertionError("não deveria recarregar com cache fresco")

    monkeypatch.setattr(monitor, "_load_monitor_payload", boom)
    result = asyncio.run(monitor.monitor_sites(force=0))
    assert result["cached"] is True
    assert result["stale"] is False
    assert calls["n"] == 0


def test_monitor_sites_stale_while_revalidate(monkeypatch):
    payload = {
        "available": True,
        "sites": [],
        "summary": {"total": 0, "online": 0, "offline": 0},
        "fetched_at": int(time.time()) - 120,
    }
    monitor._cache["data"] = payload
    monitor._cache["expires_at"] = time.time() - 1  # fresco expirou
    monitor._cache["stale_until"] = time.time() + 120
    monitor._cache["inflight"] = None

    started = asyncio.Event()

    async def slow_refresh():
        started.set()
        await asyncio.sleep(0.05)
        return {
            "available": True,
            "sites": [{"hostname": "b.example", "online": True}],
            "summary": {"total": 1, "online": 1, "offline": 0},
            "fetched_at": int(time.time()),
        }

    monkeypatch.setattr(monitor, "_load_monitor_payload", slow_refresh)

    async def run():
        first = await monitor.monitor_sites(force=0)
        assert first["cached"] is True
        assert first["stale"] is True
        await started.wait()
        # deixa o refresh concluir
        if monitor._cache.get("inflight"):
            await monitor._cache["inflight"]
        second = await monitor.monitor_sites(force=0)
        assert second.get("summary", {}).get("total") == 1

    asyncio.run(run())
