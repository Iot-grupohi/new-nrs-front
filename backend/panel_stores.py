"""Validação de lojas cadastradas no sistema Lav60 (API de máquinas)."""
from __future__ import annotations

import threading
import time

import requests

from lav60_env import env_value

MACHINES_API_URL = (
    env_value('LAV60_MACHINES_API_URL')
    or 'https://sistema.lavanderia60minutos.com.br/api/v1/machines'
).strip()

_REGISTRY_CACHE: dict[str, tuple[bool, float]] = {}
_CACHE_LOCK = threading.Lock()
_CACHE_TTL_OK_SEC = 3600
_CACHE_TTL_FAIL_SEC = 300


def normalize_store_id(store: str) -> str:
    return str(store or '').strip().lower()


def machines_api_token() -> str:
    for name in ('LAV60_API_TOKEN', 'LAV60_MACHINES_API_TOKEN', 'MACHINES_API_TOKEN'):
        value = (env_value(name) or '').strip()
        if value:
            return value
    return ''


def catalog_whitelist_ids(catalog: dict | None) -> set[str]:
    ids: set[str] = set()
    for item in (catalog or {}).get('stores') or []:
        if not isinstance(item, dict):
            continue
        sid = normalize_store_id(item.get('id'))
        if sid:
            ids.add(sid)
    return ids


def store_registered_in_lav60_api(store_id: str) -> bool | None:
    """True/False se consultou a API; None se token/API indisponível."""
    token = machines_api_token()
    if not token:
        return None

    sid = normalize_store_id(store_id)
    if not sid:
        return False

    now = time.time()
    with _CACHE_LOCK:
        cached = _REGISTRY_CACHE.get(sid)
        if cached:
            ok, ts = cached
            ttl = _CACHE_TTL_OK_SEC if ok else _CACHE_TTL_FAIL_SEC
            if now - ts < ttl:
                return ok

    ok = False
    try:
        response = requests.get(
            MACHINES_API_URL,
            params={'store_code': sid.upper()},
            headers={'X-Token': token, 'Accept': 'application/json'},
            timeout=12,
        )
        ok = response.status_code == 200
    except requests.RequestException:
        ok = False

    with _CACHE_LOCK:
        _REGISTRY_CACHE[sid] = (ok, now)
    return ok


def is_allowed_store(store_id: str, catalog: dict | None = None) -> bool:
    sid = normalize_store_id(store_id)
    if not sid:
        return False

    whitelist = catalog_whitelist_ids(catalog)
    if whitelist:
        return sid in whitelist

    registered = store_registered_in_lav60_api(sid)
    if registered is not None:
        return registered

    # Sem API e sem whitelist explícita — não aceita lojas novas desconhecidas.
    return False


def reject_store_detail(store_id: str) -> str:
    code = normalize_store_id(store_id).upper() or store_id
    return f"Loja '{code}' não cadastrada no sistema Lav60."
