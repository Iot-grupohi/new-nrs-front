"""Relatórios do painel — adapta /api/v1 para /api/reports."""

from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query

from panel import stores_cache
from panel.cnpj_lookup import cnpj_profile_fields, lookup_cnpj

UpstreamGet = Callable[[str, dict | None], Awaitable[Any]]

router = APIRouter(prefix="/api/reports", tags=["panel-reports"])

_store_details_cache: dict[str, Any] = {"data": None, "expires_at": 0.0, "refreshing": False}


def _digits_only(value: str) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def _format_cnpj(value: str) -> str:
    digits = _digits_only(value)
    if len(digits) != 14:
        return str(value or "").strip()
    return f"{digits[:2]}.{digits[2:5]}.{digits[5:8]}/{digits[8:12]}-{digits[12:]}"


def _format_zipcode(value: str) -> str:
    digits = _digits_only(value)
    if len(digits) == 8:
        return f"{digits[:5]}-{digits[5:]}"
    return str(value or "").strip()


def _format_store_address(attrs: dict[str, Any]) -> str:
    street = (
        attrs.get("address")
        or attrs.get("street")
        or attrs.get("street-address")
        or ""
    )
    city = str(attrs.get("city") or "").strip()
    state = str(attrs.get("state") or "").strip()
    zipcode = _format_zipcode(str(attrs.get("zipcode") or "").strip())
    parts: list[str] = []
    if str(street).strip():
        parts.append(str(street).strip())
    location = ", ".join(part for part in [city, state] if part)
    if location:
        parts.append(location)
    if zipcode:
        parts.append(f"CEP {zipcode}")
    return " — ".join(parts)


def _store_cnpj_raw(attrs: dict[str, Any]) -> str:
    return str(attrs.get("tax_id_number") or attrs.get("tax-id-number") or "").strip()


def _format_hi_bank_holder(
    attrs: dict[str, Any],
    hi_bank_attrs: dict[str, Any] | None = None,
    cnpj_info: dict[str, Any] | None = None,
) -> str:
    holder_name = ""
    if hi_bank_attrs:
        holder_name = str(hi_bank_attrs.get("representative_name") or "").strip()
    if not holder_name:
        holder_name = str(
            attrs.get("hibank-holder")
            or attrs.get("hi-bank-holder")
            or attrs.get("hi_bank_holder")
            or attrs.get("company-name")
            or attrs.get("legal-name")
            or attrs.get("razao-social")
            or attrs.get("name")
            or ""
        ).strip()

    cnpj_raw = _store_cnpj_raw(attrs)
    cnpj = _format_cnpj(cnpj_raw) if cnpj_raw else ""
    razao_social = str((cnpj_info or {}).get("razao_social") or "").strip()
    display_name = razao_social or holder_name

    if display_name and cnpj:
        if _digits_only(display_name) == _digits_only(cnpj_raw):
            return cnpj
        return f"{display_name} — {cnpj}"
    if cnpj:
        return cnpj
    return display_name or holder_name


def _hi_bank_representative_name(
    attrs: dict[str, Any],
    hi_bank_attrs: dict[str, Any] | None = None,
) -> str:
    if hi_bank_attrs:
        name = str(hi_bank_attrs.get("representative_name") or "").strip()
        if name:
            return name
    return str(
        attrs.get("hibank-holder")
        or attrs.get("hi-bank-holder")
        or attrs.get("hi_bank_holder")
        or ""
    ).strip()


async def _lookup_store_cnpj(attrs: dict[str, Any]) -> dict[str, Any] | None:
    cnpj_raw = _store_cnpj_raw(attrs)
    if not cnpj_raw:
        return None
    return await lookup_cnpj(cnpj_raw)


def _hi_bank_active_flag(
    store_attrs: dict[str, Any],
    hi_bank_attrs: dict[str, Any] | None = None,
) -> bool | None:
    status = None
    if hi_bank_attrs and hi_bank_attrs.get("status") is not None:
        status = hi_bank_attrs.get("status")
    elif store_attrs.get("hibank-status") is not None:
        status = store_attrs.get("hibank-status")
    elif store_attrs.get("hibank_status") is not None:
        status = store_attrs.get("hibank_status")
    if status is None:
        return False
    return str(status).lower() in {"active", "ok", "true", "1"}


def _parse_store_row(
    data: dict,
    hi_bank_attrs: dict[str, Any] | None = None,
    cnpj_info: dict[str, Any] | None = None,
) -> dict[str, Any]:
    attrs = data.get("attributes") or data
    code = str(attrs.get("code") or data.get("code") or "").strip().lower()
    city = str(attrs.get("city") or "").strip()
    return {
        "id": code,
        "store_code": code.upper(),
        "name": attrs.get("name") or code.upper(),
        "address": (
            str(cnpj_info.get("address") or "").strip()
            if cnpj_info and cnpj_info.get("address")
            else _format_store_address(attrs)
        ),
        "neighborhood": (
            attrs.get("neighborhood")
            or attrs.get("district")
            or attrs.get("bairro")
            or city
            or ""
        ),
        "hi_bank_holder": _format_hi_bank_holder(attrs, hi_bank_attrs, cnpj_info),
        "hi_bank_active": _hi_bank_active_flag(attrs, hi_bank_attrs),
        "hi_bank_email": (
            str(hi_bank_attrs.get("representative_email") or "").strip()
            if hi_bank_attrs
            else ""
        ),
        **cnpj_profile_fields(cnpj_info),
    }


async def _fetch_hi_bank_account(
    upstream_get: UpstreamGet,
    store_code: str,
) -> dict[str, Any] | None:
    sid = store_code.strip().upper()
    if not sid:
        return None
    try:
        raw = await upstream_get("/api/v1/hi_banks/account", {"store_code": sid})
        attrs = (raw.get("data") or {}).get("attributes") or {}
        return attrs if attrs else None
    except Exception:
        return None


async def _load_store_profile_row(
    upstream_get: UpstreamGet,
    store_code: str,
) -> dict[str, Any]:
    sid = store_code.strip().upper()
    store_raw, hi_bank_attrs = await asyncio.gather(
        upstream_get(f"/api/v1/stores/{sid}"),
        _fetch_hi_bank_account(upstream_get, sid),
    )
    data = store_raw.get("data") or store_raw
    attrs = data.get("attributes") or data
    cnpj_info = await _lookup_store_cnpj(attrs)
    row = _parse_store_row(data, hi_bank_attrs, cnpj_info)
    row["store_code"] = sid
    return row


async def _fetch_all_store_profiles(
    upstream_get: UpstreamGet,
    stores_meta: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    rows: list[dict] = []

    async def fetch_one(meta: dict) -> None:
        sid = str(meta.get("id") or "").upper()
        if not sid:
            return
        try:
            rows.append(await _load_store_profile_row(upstream_get, sid))
        except Exception:
            rows.append({
                "id": sid.lower(),
                "store_code": sid,
                "name": meta.get("name") or sid,
            })

    sem = asyncio.Semaphore(8)

    async def guarded(meta: dict) -> None:
        async with sem:
            await fetch_one(meta)

    await asyncio.gather(*(guarded(m) for m in stores_meta))
    rows.sort(key=lambda row: str(row.get("id") or ""))
    return rows


async def _refresh_store_catalog_disk(
    upstream_get: UpstreamGet,
    stores_meta: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    try:
        rows = await _fetch_all_store_profiles(upstream_get, stores_meta)
        stores_cache.write_catalog_file(rows)
        now = time.time()
        _store_details_cache["data"] = rows
        _store_details_cache["expires_at"] = now + 3600
        return rows
    finally:
        _store_details_cache["refreshing"] = False


def _schedule_store_catalog_refresh(
    background_tasks: BackgroundTasks,
    upstream_get: UpstreamGet,
    stores_meta: list[dict[str, Any]],
) -> None:
    if _store_details_cache.get("refreshing"):
        return
    _store_details_cache["refreshing"] = True
    background_tasks.add_task(_refresh_store_catalog_disk, upstream_get, stores_meta)


def register_reports(upstream_get: UpstreamGet) -> APIRouter:
    @router.get("/store-codes")
    async def store_codes(
        background_tasks: BackgroundTasks,
        details: int = Query(0),
    ) -> dict[str, Any]:
        from panel.catalog import build_catalog

        catalog = await build_catalog(upstream_get)
        stores = catalog.get("stores") or []
        if details:
            stores, cached = stores_cache.merge_with_catalog(stores)
            file_row = stores_cache.read_catalog_file()
            refreshing = bool(_store_details_cache.get("refreshing"))
            if (not file_row or not stores_cache.catalog_is_fresh(file_row)) and not refreshing:
                _schedule_store_catalog_refresh(background_tasks, upstream_get, catalog.get("stores") or [])
                refreshing = True
            return {
                "stores": stores,
                "cached": cached,
                "fresh": stores_cache.catalog_is_fresh(file_row),
                "refreshing": refreshing,
            }
        return {"stores": stores}

    @router.get("/store-details")
    async def store_details(
        background_tasks: BackgroundTasks,
        force: int = Query(0),
    ) -> dict[str, Any]:
        from panel.catalog import build_catalog

        catalog = await build_catalog(upstream_get)
        stores_meta = catalog.get("stores") or []
        file_row = stores_cache.read_catalog_file()

        if not force and file_row and file_row.get("stores"):
            refreshing = bool(_store_details_cache.get("refreshing"))
            if not stores_cache.catalog_is_fresh(file_row) and not refreshing:
                _schedule_store_catalog_refresh(background_tasks, upstream_get, stores_meta)
                refreshing = True
            return {
                "stores": file_row["stores"],
                "refreshing": refreshing,
                "cached": True,
                "updated_at": file_row.get("updated_at"),
            }

        now = time.time()
        if not force and _store_details_cache["data"] and _store_details_cache["expires_at"] > now:
            return {
                "stores": _store_details_cache["data"],
                "refreshing": _store_details_cache.get("refreshing", False),
                "cached": True,
            }

        rows = await _refresh_store_catalog_disk(upstream_get, stores_meta)
        return {"stores": rows, "refreshing": False, "cached": False}

    @router.get("/store-profile")
    async def store_profile(
        store_code: str = Query(...),
        include_hibank: int = Query(0),
    ) -> dict[str, Any]:
        sid = store_code.strip().upper()
        if include_hibank:
            return await _load_store_profile_row(upstream_get, sid)
        store_raw = await upstream_get(f"/api/v1/stores/{sid}")
        data = store_raw.get("data") or store_raw
        attrs = data.get("attributes") or data
        cnpj_info = await _lookup_store_cnpj(attrs)
        row = _parse_store_row(data, None, cnpj_info)
        row["store_code"] = sid
        return row

    @router.get("/cnpj")
    async def cnpj_lookup(cnpj: str = Query(...)) -> dict[str, Any]:
        info = await lookup_cnpj(cnpj)
        if not info:
            raise HTTPException(status_code=404, detail="CNPJ não encontrado")
        return info

    @router.get("/hi-bank/profile")
    async def hi_bank_profile(store_code: str = Query(...)) -> dict[str, Any]:
        sid = store_code.strip().upper()
        hi_bank_attrs = await _fetch_hi_bank_account(upstream_get, sid)
        store_raw = await upstream_get(f"/api/v1/stores/{sid}")
        data = store_raw.get("data") or store_raw
        attrs = data.get("attributes") or data
        cnpj_info = await _lookup_store_cnpj(attrs)
        representative = _hi_bank_representative_name(attrs, hi_bank_attrs)
        return {
            "store_code": sid,
            "hi_bank_holder": _format_hi_bank_holder(attrs, hi_bank_attrs, cnpj_info),
            "hi_bank_active": _hi_bank_active_flag(attrs, hi_bank_attrs),
            "hi_bank_email": (
                str(hi_bank_attrs.get("representative_email") or "").strip()
                if hi_bank_attrs
                else ""
            ),
            "hi_bank_representative": representative,
            **cnpj_profile_fields(cnpj_info),
        }

    @router.get("/hi-bank/statuses")
    async def hi_bank_statuses() -> dict[str, Any]:
        from panel.catalog import build_catalog

        catalog = await build_catalog(upstream_get)
        statuses: dict[str, bool] = {}
        for meta in catalog.get("stores") or []:
            sid = str(meta.get("id") or "").lower()
            if not sid:
                continue
            try:
                raw = await upstream_get(f"/api/v1/stores/{sid.upper()}")
                attrs = (raw.get("data") or {}).get("attributes") or {}
                hibank = attrs.get("hibank-status")
                if hibank is not None:
                    statuses[sid] = str(hibank).lower() in {"active", "ok", "true", "1"}
            except Exception:
                continue
        return {"statuses": statuses, "refreshing": False}

    return router
