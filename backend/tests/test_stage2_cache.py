"""Testes da Etapa 2: fields, lite snapshot, metrics, sync fresh."""

from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from panel import cache_metrics, heartbeats, status_store  # noqa: E402


def test_project_public_doc_dashboard_omits_config():
    doc = {
        "store": "sp01",
        "alive": True,
        "network": {"summary": {"total": 2}},
        "machines": [{"id": "1"}],
        "config_snapshot": {"machines": [{"id": "x"}]},
        "last_network_check": {"ok": True},
        "agent_url": "https://sp01.example",
    }
    projected = status_store.project_public_doc(doc, "dashboard")
    assert "network" in projected
    assert "machines" in projected
    assert "agent_url" in projected
    assert "config_snapshot" not in projected
    assert "last_network_check" not in projected


def test_project_public_doc_summary_minimal():
    doc = {
        "store": "sp01",
        "alive": True,
        "age_seconds": 1.2,
        "network": {"washers": {"a": {}}},
        "machines": [{"id": "1"}],
        "lav60_status": "ok",
    }
    projected = status_store.project_public_doc(doc, "summary")
    assert projected["alive"] is True
    assert "network" not in projected
    assert "machines" not in projected


def test_list_store_cache_fields_and_stable_revision():
    status_store.ingest_heartbeat_entry(
        "aa01",
        {
            "store": "aa01",
            "received_at": time.time(),
            "payload": {
                "store": "aa01",
                "network": {"summary": {"total": 1}, "washers": {"w1": {"online": True}}},
                "machines": [{"id": "w1", "type": "washer"}],
            },
            "heartbeat_source": "post",
        },
        timeout_seconds=120,
    )
    rev_before = status_store.memory_revision()
    full = status_store.list_store_cache(timeout_seconds=120, fields="full")
    dash = status_store.list_store_cache(timeout_seconds=120, fields="dashboard")
    rev_after = status_store.memory_revision()
    # Leituras não devem inflar revision (bug corrigido na Etapa 2).
    assert rev_after == rev_before
    assert full["fields"] == "full"
    assert dash["fields"] == "dashboard"
    assert "aa01" in dash["stores"]
    assert "config_snapshot" not in dash["stores"]["aa01"]


def test_heartbeat_lite_payload_strips_devices(monkeypatch):
    heartbeats._heartbeats.clear()
    monkeypatch.setattr(heartbeats.heartbeat_rtdb, "enabled", lambda: True)
    heartbeats._merge_rtdb_entry(
        {
            "store": "bb02",
            "received_at": time.time(),
            "payload": {
                "store": "bb02",
                "heartbeat_source": "rtdb",
                "agent_url": "https://bb02.example",
                "lav60_status": "ok",
                "network": {
                    "summary": {"total": 3, "online": 2},
                    "washers": {"w1": {"online": True}},
                    "dryers": {},
                    "dosers": {},
                },
                "machines": [{"id": "w1", "type": "washer"}],
            },
            "heartbeat_source": "rtdb",
        }
    )
    full = heartbeats.build_snapshot(lite=False)
    lite = heartbeats.build_snapshot(lite=True)
    full_payload = full["heartbeats"]["bb02"]["payload"]
    lite_payload = lite["heartbeats"]["bb02"]["payload"]
    assert "washers" in (full_payload.get("network") or {})
    assert lite_payload.get("agent_url") == "https://bb02.example"
    assert lite_payload.get("network", {}).get("summary", {}).get("total") == 3
    assert "washers" in (lite_payload.get("network") or {})
    assert lite_payload.get("machines")
    assert lite["lite"] is True


def test_cache_metrics_record_and_snapshot():
    cache_metrics.reset()
    cache_metrics.record("catalog", hit=True, latency_ms=12.5)
    cache_metrics.record("catalog", hit=False, latency_ms=40)
    cache_metrics.record("catalog", not_modified=True, latency_ms=1)
    snap = cache_metrics.snapshot()["catalog"]
    assert snap["hits"] == 2
    assert snap["misses"] == 1
    assert snap["not_modified"] == 1
    assert snap["hit_ratio"] == round(2 / 3, 4)
    assert snap["samples"] == 3
