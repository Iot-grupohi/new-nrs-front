"""Cache persistente do catálogo de lojas (arquivo JSON em panel/data)."""

from __future__ import annotations

import json
import time
from typing import Any

from panel.lav60_env import DATA_DIR

STORES_CATALOG_PATH = DATA_DIR / "stores_catalog.json"
STORES_CATALOG_TTL_SEC = 24 * 60 * 60


def _ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def read_catalog_file() -> dict[str, Any] | None:
    if not STORES_CATALOG_PATH.is_file():
        return None
    try:
        data = json.loads(STORES_CATALOG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("stores"), list):
        return None
    return data


def write_catalog_file(stores: list[dict[str, Any]]) -> None:
    _ensure_data_dir()
    payload = {
        "stores": stores,
        "updated_at": int(time.time()),
        "expires_at": int(time.time()) + STORES_CATALOG_TTL_SEC,
    }
    STORES_CATALOG_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def catalog_is_fresh(data: dict[str, Any] | None = None) -> bool:
    row = data if data is not None else read_catalog_file()
    if not row:
        return False
    return float(row.get("expires_at") or 0) > time.time()


def stores_by_id(stores: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for store in stores:
        sid = str(store.get("id") or store.get("store_code") or "").strip().lower()
        if sid:
            out[sid] = store
    return out


def merge_with_catalog(basic_stores: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], bool]:
    cached = read_catalog_file()
    cached_rows = cached.get("stores") if cached else []
    if not cached_rows:
        return basic_stores, False

    by_id = stores_by_id(cached_rows)
    merged: list[dict[str, Any]] = []
    for basic in basic_stores:
        sid = str(basic.get("id") or "").strip().lower()
        hit = by_id.get(sid)
        if hit:
            merged.append({**basic, **hit, "id": sid})
        else:
            merged.append(basic)
    return merged, True
