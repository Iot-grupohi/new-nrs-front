"""Testes de cache/singleflight do catálogo e status-cache revision."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from panel import catalog, status_store  # noqa: E402


async def _fake_upstream(path: str, params=None):
    if path.endswith("/stores/codes"):
        return {"store_codes": ["sp01", "rj02"]}
    if path.endswith("/stores"):
        return {
            "data": [
                {
                    "attributes": {
                        "code": "sp01",
                        "name": "SP01 Suspensa",
                        "status": "suspended",
                    }
                }
            ]
        }
    return {}


def test_build_catalog_caches_and_versions():
    catalog.invalidate_catalog_cache()

    async def run():
        first = await catalog.build_catalog(_fake_upstream, force=True)
        second = await catalog.build_catalog(_fake_upstream, force=False)
        assert first["version"] == second["version"]
        assert first is second or first == second
        assert "sp01" in {s["id"] for s in first["stores"]}
        assert first["suspended_count"] >= 1
        etag1 = catalog.catalog_etag(first)
        etag2 = catalog.catalog_etag(second)
        assert etag1 == etag2

        third = await catalog.build_catalog(_fake_upstream, force=True)
        assert third["version"] > first["version"]
        assert catalog.catalog_etag(third) != etag1

    asyncio.run(run())


def test_build_catalog_singleflight():
    catalog.invalidate_catalog_cache()
    calls = {"n": 0}

    async def counting_upstream(path: str, params=None):
        calls["n"] += 1
        await asyncio.sleep(0.05)
        return await _fake_upstream(path, params)

    async def run():
        results = await asyncio.gather(
            catalog.build_catalog(counting_upstream, force=False),
            catalog.build_catalog(counting_upstream, force=False),
            catalog.build_catalog(counting_upstream, force=False),
        )
        assert results[0]["version"] == results[1]["version"] == results[2]["version"]
        # Lock + double-check: um único build (codes + suspended).
        assert calls["n"] == 2

    asyncio.run(run())


def test_status_cache_revision_and_etag_change_on_ingest():
    before = status_store.memory_revision()
    etag_before = status_store.status_cache_etag(60)
    status_store.ingest_heartbeat_entry(
        "zz99",
        {
            "store": "zz99",
            "received_at": 1_700_000_000,
            "payload": {"store": "zz99", "alive": True},
            "heartbeat_source": "post",
        },
        timeout_seconds=120,
    )
    after = status_store.memory_revision()
    etag_after = status_store.status_cache_etag(60)
    assert after > before
    assert etag_after != etag_before
    bulk = status_store.list_store_cache(timeout_seconds=120)
    assert bulk.get("revision") >= after
    assert "zz99" in (bulk.get("stores") or {})
