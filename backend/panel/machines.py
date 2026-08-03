"""Catálogo de equipamentos por loja (API Lav60 upstream)."""

from __future__ import annotations

import re
from typing import Any

from fastapi import HTTPException

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

_MACHINE_TYPE_LABELS = {
    "washer": "Lavadora",
    "dryer": "Secadora",
    "doser": "Dosadora",
}


def _looks_like_uuid(value: Any) -> bool:
    return bool(_UUID_RE.match(str(value or "").strip()))


def _machine_type_key(raw: Any) -> str:
    value = str(raw or "").strip().lower().replace("_", "-")
    aliases = {
        "washer": "washer",
        "lavadora": "washer",
        "dryer": "dryer",
        "secadora": "dryer",
        "doser": "doser",
        "dosadora": "doser",
    }
    return aliases.get(value, value)


def _operational_id(attrs: dict[str, Any], resource_id: Any) -> str:
    for key in ("name", "code", "address"):
        val = str(attrs.get(key) or "").strip()
        if val and not _looks_like_uuid(val):
            return val
    rid = str(resource_id or "").strip()
    return rid


def parse_machine_item(item: dict[str, Any]) -> dict[str, Any]:
    attrs = item.get("attributes") or {}
    resource_id = item.get("id")
    machine_type = _machine_type_key(attrs.get("machine-type"))
    operational_id = _operational_id(attrs, resource_id)
    friendly_name = str(attrs.get("name") or attrs.get("code") or operational_id).strip()
    return {
        "id": operational_id,
        "catalog_id": str(resource_id).strip() if _looks_like_uuid(resource_id) else None,
        "code": attrs.get("name") or operational_id,
        "name": friendly_name if not _looks_like_uuid(friendly_name) else operational_id,
        "display_name": friendly_name if not _looks_like_uuid(friendly_name) else None,
        "status": attrs.get("status"),
        "machine_type": machine_type,
        "machine_type_label": _MACHINE_TYPE_LABELS.get(machine_type, machine_type),
        "store_code": attrs.get("store_code"),
        "address": attrs.get("address"),
        "waiting_minutes": attrs.get("waiting-minutes"),
        "liter_capacity": attrs.get("liter-capacity"),
        "machine_capacity": attrs.get("machine-capacity"),
        "time_dosage": attrs.get("time-dosage"),
    }


async def fetch_store_machines(store_id: str) -> dict[str, Any]:
    from panel import deps

    sid = str(store_id or "").strip().lower()
    if not sid:
        raise HTTPException(400, "Loja inválida")
    if deps.upstream_get is None:
        return {"store_code": sid, "machines": [], "count": 0}

    # API Lav60 exige código em maiúsculas (PB05); minúsculas retorna 404.
    upper = sid.upper()
    candidates = [upper] if upper == sid else [upper, sid]

    last_exc: HTTPException | None = None
    for code in candidates:
        try:
            raw = await deps.upstream_get("/api/v1/machines", {"store_code": code})
        except HTTPException as exc:
            last_exc = exc
            if exc.status_code in (404, 502, 503, 504):
                continue
            raise
        else:
            items = [
                parse_machine_item(m)
                for m in raw.get("data") or []
                if isinstance(m, dict)
            ]
            return {"store_code": sid, "machines": items, "count": len(items)}

    if last_exc and last_exc.status_code not in (404, 502, 503, 504):
        raise last_exc
    return {"store_code": sid, "machines": [], "count": 0}
