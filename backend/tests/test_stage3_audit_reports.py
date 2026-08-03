"""Testes da Etapa 3: audit cache, hi-bank statuses sem N+1, monitor SWR."""

from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from panel import audit_store, reports  # noqa: E402


def test_dashboard_summary_cache_and_invalidate(monkeypatch):
    audit_store.invalidate_audit_caches()
    calls = {"n": 0}

    class FakeDoc:
        def __init__(self, data):
            self._data = data
            self.id = "x"

        def to_dict(self):
            return self._data

    class FakeQuery:
        def where(self, *args, **kwargs):
            return self

        def order_by(self, *args, **kwargs):
            return self

        def limit(self, n):
            return self

        def stream(self):
            calls["n"] += 1
            now_ms = int(time.time() * 1000)
            return [
                FakeDoc(
                    {
                        "ts_ms": now_ms,
                        "action": "washer_release",
                        "success": True,
                        "operator_email": "a@x.com",
                        "store": "sp01",
                    }
                )
            ]

    class FakeCollection:
        def order_by(self, *args, **kwargs):
            return FakeQuery()

        def where(self, *args, **kwargs):
            return FakeQuery()

    class FakeDb:
        def collection(self, name):
            return FakeCollection()

    monkeypatch.setattr(audit_store, "_get_db", lambda: FakeDb())
    monkeypatch.setattr(
        audit_store,
        "firestore",
        type("fs", (), {"Query": type("Q", (), {"DESCENDING": "DESC"})()})(),
        raising=False,
    )

    # firebase_admin.firestore import inside function — stub via injecting into builtins path
    import panel.audit_store as mod

    class FakeFirestoreMod:
        class Query:
            DESCENDING = "DESCENDING"

    import sys as _sys

    _sys.modules.setdefault("firebase_admin", type(_sys)("firebase_admin"))
    _sys.modules["firebase_admin"].firestore = FakeFirestoreMod  # type: ignore[attr-defined]

    first = audit_store.dashboard_summary(hours=24, force=True)
    second = audit_store.dashboard_summary(hours=24, force=False)
    assert first["total"] == 1
    assert second.get("cached") is True
    assert calls["n"] == 1

    audit_store.invalidate_audit_caches()
    third = audit_store.dashboard_summary(hours=24, force=False)
    assert third.get("cached") is not True
    assert calls["n"] == 2


def test_statuses_from_store_rows():
    rows = [
        {"id": "sp01", "hi_bank_active": True},
        {"store_code": "RJ02", "hi_bank_active": False},
        {"id": "xx03"},  # sem campo — ignorado
    ]
    statuses = reports._statuses_from_store_rows(rows)
    assert statuses["sp01"] is True
    assert statuses["rj02"] is False
    assert "xx03" not in statuses


def test_count_logs_uses_cache(monkeypatch):
    audit_store.invalidate_audit_caches()
    calls = {"n": 0}

    class FakeDoc:
        def __init__(self, data):
            self._data = data
            self.id = "1"

        def to_dict(self):
            return self._data

    class FakeQuery:
        def where(self, *a, **k):
            return self

        def order_by(self, *a, **k):
            return self

        def limit(self, n):
            return self

        def stream(self):
            calls["n"] += 1
            return [
                FakeDoc({"action": "washer_release", "success": True, "operator_email": "a@x.com"})
            ]

    class FakeDb:
        def collection(self, name):
            return FakeQuery()

    monkeypatch.setattr(audit_store, "_get_db", lambda: FakeDb())

    import sys as _sys

    class FakeFirestoreMod:
        class Query:
            DESCENDING = "DESCENDING"

    _sys.modules.setdefault("firebase_admin", type(_sys)("firebase_admin"))
    _sys.modules["firebase_admin"].firestore = FakeFirestoreMod  # type: ignore[attr-defined]

    a, _ = audit_store.count_logs()
    b, _ = audit_store.count_logs()
    assert a == 1
    assert b == 1
    assert calls["n"] == 1
