"""Métricas leves de cache/latência dos endpoints quentes do painel."""

from __future__ import annotations

import threading
import time
from typing import Any

_lock = threading.Lock()
_stats: dict[str, dict[str, Any]] = {}


def _bucket(name: str) -> dict[str, Any]:
    row = _stats.get(name)
    if row is None:
        row = {
            "hits": 0,
            "misses": 0,
            "not_modified": 0,
            "errors": 0,
            "latency_ms_sum": 0.0,
            "latency_count": 0,
            "latency_ms_max": 0.0,
            "last_ms": 0.0,
        }
        _stats[name] = row
    return row


def record(
    name: str,
    *,
    hit: bool | None = None,
    not_modified: bool = False,
    error: bool = False,
    latency_ms: float | None = None,
) -> None:
    with _lock:
        row = _bucket(name)
        if error:
            row["errors"] += 1
        elif not_modified:
            row["not_modified"] += 1
            row["hits"] += 1
        elif hit is True:
            row["hits"] += 1
        elif hit is False:
            row["misses"] += 1
        if latency_ms is not None:
            ms = max(0.0, float(latency_ms))
            row["latency_ms_sum"] += ms
            row["latency_count"] += 1
            row["latency_ms_max"] = max(float(row["latency_ms_max"]), ms)
            row["last_ms"] = ms


def snapshot() -> dict[str, Any]:
    with _lock:
        out: dict[str, Any] = {}
        for name, row in _stats.items():
            count = int(row["latency_count"])
            avg = (row["latency_ms_sum"] / count) if count else 0.0
            hits = int(row["hits"])
            misses = int(row["misses"])
            total = hits + misses
            out[name] = {
                "hits": hits,
                "misses": misses,
                "not_modified": int(row["not_modified"]),
                "errors": int(row["errors"]),
                "hit_ratio": round(hits / total, 4) if total else None,
                "latency_ms_avg": round(avg, 2),
                "latency_ms_max": round(float(row["latency_ms_max"]), 2),
                "latency_ms_last": round(float(row["last_ms"]), 2),
                "samples": count,
            }
        return out


def reset() -> None:
    with _lock:
        _stats.clear()


class Timer:
    __slots__ = ("_start",)

    def __init__(self) -> None:
        self._start = time.perf_counter()

    def ms(self) -> float:
        return (time.perf_counter() - self._start) * 1000.0
