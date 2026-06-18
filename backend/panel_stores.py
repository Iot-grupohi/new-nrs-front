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

_STATUS_CACHE: dict[str, tuple[str, float]] = {}
_CACHE_LOCK = threading.Lock()
_CACHE_TTL_OK_SEC = 3600
_CACHE_TTL_SUSPENDED_SEC = 600
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


def parse_lav60_machines_api_status(response: requests.Response) -> str:
    """ok | suspended | not_found | rejected"""
    if response.status_code == 200:
        return 'ok'
    if response.status_code == 404:
        return 'not_found'

    blob = (response.text or '').lower()
    try:
        data = response.json()
        err = data.get('error')
        if isinstance(err, dict):
            blob += ' ' + str(err.get('message') or '').lower()
        else:
            blob += ' ' + str(data.get('message') or data.get('detail') or err or '').lower()
    except Exception:
        pass

    if response.status_code == 400 and 'suspend' in blob:
        return 'suspended'
    return 'rejected'


def _cache_ttl_for_status(status: str) -> int:
    if status == 'ok':
        return _CACHE_TTL_OK_SEC
    if status == 'suspended':
        return _CACHE_TTL_SUSPENDED_SEC
    return _CACHE_TTL_FAIL_SEC


def resolve_store_lav60_status(store_id: str, payload: dict | None = None) -> str:
    """Prioriza agente (heartbeat) e API Lav60; suspended vence ok."""
    agent = str((payload or {}).get('lav60_status') or '').strip().lower()
    if (payload or {}).get('store_suspended') is True:
        agent = 'suspended'
    api = get_store_lav60_status(store_id)
    if agent == 'suspended' or api == 'suspended':
        return 'suspended'
    if agent == 'ok' or api == 'ok':
        return 'ok'
    if agent and agent != 'unknown':
        return agent
    return api or 'unknown'


def get_store_lav60_status(store_id: str) -> str:
    """ok | suspended | not_found | rejected | unknown"""
    token = machines_api_token()
    sid = normalize_store_id(store_id)
    if not sid:
        return 'rejected'
    if not token:
        return 'unknown'

    now = time.time()
    with _CACHE_LOCK:
        cached = _STATUS_CACHE.get(sid)
        if cached:
            status, ts = cached
            if now - ts < _cache_ttl_for_status(status):
                return status

    status = 'rejected'
    try:
        response = requests.get(
            MACHINES_API_URL,
            params={'store_code': sid.upper()},
            headers={'X-Token': token, 'Accept': 'application/json'},
            timeout=12,
        )
        status = parse_lav60_machines_api_status(response)
    except requests.RequestException:
        status = 'rejected'

    with _CACHE_LOCK:
        _STATUS_CACHE[sid] = (status, now)
    return status


def store_registered_in_lav60_api(store_id: str) -> bool | None:
    """True/False se consultou a API; None se token/API indisponível."""
    token = machines_api_token()
    if not token:
        return None
    status = get_store_lav60_status(store_id)
    return status in ('ok', 'suspended')


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

    return False


def reject_store_detail(store_id: str) -> str:
    code = normalize_store_id(store_id).upper() or store_id
    return f"Loja '{code}' não cadastrada no sistema Lav60."
