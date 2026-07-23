"""Consulta CNPJ via BrasilAPI com cache em disco."""

from __future__ import annotations

import json
import time
from typing import Any

import httpx

from panel.lav60_env import DATA_DIR

CNPJ_CACHE_PATH = DATA_DIR / "cnpj_cache.json"
CNPJ_CACHE_TTL_SEC = 24 * 60 * 60
BRASILAPI_CNPJ_URL = "https://brasilapi.com.br/api/cnpj/v1/{cnpj}"
RECEITAWS_CNPJ_URL = "https://www.receitaws.com.br/v1/cnpj/{cnpj}"


def _digits_only(value: str) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def format_cnpj(value: str) -> str:
    digits = _digits_only(value)
    if len(digits) != 14:
        return str(value or "").strip()
    return f"{digits[:2]}.{digits[2:5]}.{digits[5:8]}/{digits[8:12]}-{digits[12:]}"


def _ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _read_cache_file() -> dict[str, Any]:
    if not CNPJ_CACHE_PATH.is_file():
        return {"entries": {}}
    try:
        data = json.loads(CNPJ_CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"entries": {}}
    if not isinstance(data, dict):
        return {"entries": {}}
    entries = data.get("entries")
    if not isinstance(entries, dict):
        data["entries"] = {}
    return data


def _write_cache_file(data: dict[str, Any]) -> None:
    _ensure_data_dir()
    CNPJ_CACHE_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _get_cached(cnpj_digits: str) -> dict[str, Any] | None:
    cache = _read_cache_file()
    row = cache.get("entries", {}).get(cnpj_digits)
    if not isinstance(row, dict):
        return None
    if float(row.get("expires_at") or 0) <= time.time():
        return None
    payload = row.get("data")
    return payload if isinstance(payload, dict) else None


def _set_cached(cnpj_digits: str, payload: dict[str, Any]) -> None:
    cache = _read_cache_file()
    entries = cache.setdefault("entries", {})
    entries[cnpj_digits] = {
        "data": payload,
        "expires_at": int(time.time()) + CNPJ_CACHE_TTL_SEC,
        "updated_at": int(time.time()),
    }
    _write_cache_file(cache)


def _address_has_street(raw: dict[str, Any]) -> bool:
    logradouro = str(raw.get("logradouro") or "").strip()
    numero = str(raw.get("numero") or "").strip()
    complemento = str(raw.get("complemento") or "").strip()
    return bool(logradouro or numero or complemento)


def format_cnpj_address(raw: dict[str, Any]) -> str:
    tipo = str(
        raw.get("descricao_tipo_de_logradouro")
        or raw.get("descricao_tipo_logradouro")
        or ""
    ).strip()
    logradouro = str(raw.get("logradouro") or "").strip()
    numero = str(raw.get("numero") or "").strip()
    complemento = str(raw.get("complemento") or "").strip()
    bairro = str(raw.get("bairro") or "").strip()
    municipio = str(raw.get("municipio") or "").strip()
    uf = str(raw.get("uf") or "").strip()
    cep_digits = _digits_only(str(raw.get("cep") or ""))
    cep = (
        f"{cep_digits[:5]}-{cep_digits[5:]}"
        if len(cep_digits) == 8
        else str(raw.get("cep") or "").strip()
    )

    if tipo and logradouro and not logradouro.upper().startswith(tipo.upper()):
        logradouro = f"{tipo} {logradouro}"

    street_parts = [part for part in [logradouro, numero, complemento] if part]
    parts: list[str] = []
    if street_parts:
        parts.append(", ".join(street_parts))
    if bairro:
        parts.append(bairro)
    location = ", ".join(part for part in [municipio, uf] if part)
    if location:
        parts.append(location)
    if cep:
        parts.append(f"CEP {cep}")
    return " — ".join(parts)


async def _fetch_receitaws_cnpj(cnpj_digits: str) -> dict[str, Any] | None:
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                RECEITAWS_CNPJ_URL.format(cnpj=cnpj_digits),
                headers={"User-Agent": "lav60-panel/1.0"},
            )
            if response.status_code != 200:
                return None
            raw = response.json()
    except Exception:
        return None

    if not isinstance(raw, dict) or raw.get("status") == "ERROR":
        return None
    return raw


def _merge_address_fields(
    primary: dict[str, Any],
    fallback: dict[str, Any],
) -> dict[str, Any]:
    merged = dict(primary)
    for key in (
        "descricao_tipo_de_logradouro",
        "descricao_tipo_logradouro",
        "logradouro",
        "numero",
        "complemento",
        "bairro",
        "cep",
        "municipio",
        "uf",
        "razao_social",
        "nome_fantasia",
    ):
        current = str(merged.get(key) or "").strip()
        candidate = str(fallback.get(key) or "").strip()
        if candidate and not current:
            merged[key] = fallback.get(key)
    if not str(merged.get("descricao_situacao_cadastral") or "").strip():
        situacao = str(fallback.get("situacao") or "").strip()
        if situacao:
            merged["descricao_situacao_cadastral"] = situacao
    return merged


def _parse_brasilapi_payload(raw: dict[str, Any], cnpj_digits: str) -> dict[str, Any]:
    municipio = str(raw.get("municipio") or "").strip()
    uf = str(raw.get("uf") or "").strip()
    location = ", ".join(part for part in [municipio, uf] if part)
    address = format_cnpj_address(raw)
    return {
        "cnpj": format_cnpj(cnpj_digits),
        "cnpj_digits": cnpj_digits,
        "razao_social": str(raw.get("razao_social") or raw.get("nome") or "").strip(),
        "nome_fantasia": str(raw.get("nome_fantasia") or raw.get("fantasia") or "").strip(),
        "situacao": str(
            raw.get("descricao_situacao_cadastral") or raw.get("situacao_cadastral") or raw.get("situacao") or ""
        ).strip(),
        "municipio": municipio,
        "uf": uf,
        "location": location,
        "address": address,
        "address_complete": _address_has_street(raw),
        "cnae": str(raw.get("cnae_fiscal_descricao") or "").strip(),
        "source": str(raw.get("_source") or "brasilapi"),
    }


def cnpj_profile_fields(cnpj_info: dict[str, Any] | None) -> dict[str, Any]:
    if not cnpj_info:
        return {}
    return {
        "cnpj": cnpj_info.get("cnpj") or "",
        "cnpj_razao_social": cnpj_info.get("razao_social") or "",
        "cnpj_nome_fantasia": cnpj_info.get("nome_fantasia") or "",
        "cnpj_situacao": cnpj_info.get("situacao") or "",
        "cnpj_municipio": cnpj_info.get("municipio") or "",
        "cnpj_uf": cnpj_info.get("uf") or "",
        "cnpj_location": cnpj_info.get("location") or "",
        "cnpj_address": cnpj_info.get("address") or "",
    }


async def lookup_cnpj(cnpj: str) -> dict[str, Any] | None:
    digits = _digits_only(cnpj)
    if len(digits) != 14:
        return None

    cached = _get_cached(digits)
    if cached and cached.get("address_complete"):
        return cached

    raw: dict[str, Any] | None = None
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            response = await client.get(
                BRASILAPI_CNPJ_URL.format(cnpj=digits),
                headers={"User-Agent": "lav60-panel/1.0"},
            )
            if response.status_code == 404:
                raw = None
            else:
                response.raise_for_status()
                payload = response.json()
                raw = payload if isinstance(payload, dict) else None
    except Exception:
        raw = None

    if raw and not _address_has_street(raw):
        receita = await _fetch_receitaws_cnpj(digits)
        if receita:
            raw = _merge_address_fields(raw, receita)
            raw["_source"] = "brasilapi+receitaws"
    elif raw:
        raw["_source"] = "brasilapi"

    if not raw:
        receita = await _fetch_receitaws_cnpj(digits)
        if receita:
            raw = dict(receita)
            raw["_source"] = "receitaws"

    if not isinstance(raw, dict):
        return None

    parsed = _parse_brasilapi_payload(raw, digits)
    _set_cached(digits, parsed)
    return parsed
