"""Painel LAV60 — serve o frontend e recebe heartbeat dos agentes (push)."""
from __future__ import annotations

import json
import os
import queue
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests
from flask import Flask, Response, jsonify, request, send_from_directory, session, stream_with_context

from lav60_env import env_value, load_local_env
from panel_stores import get_store_lav60_status, is_allowed_store, reject_store_detail, resolve_store_lav60_status
from panel_audit import (
    ACTION_LABELS_PT,
    DEVICE_LABELS_PT,
    audit_dashboard_summary,
    audit_collection,
    audit_logging_available,
    audit_unavailable_payload,
    count_audit_events,
    list_audit_events,
    list_audit_operator_stats,
    list_audit_operators,
    log_audit_event,
    log_audit_event_async,
)
from panel_auth import (
    auth_verify_mode,
    firebase_auth_enabled,
    firebase_init_error,
    firebase_public_config,
    init_firebase_admin,
    service_account_configured,
    service_account_path,
    verify_firebase_id_token,
)

load_local_env()

BACKEND = Path(__file__).resolve().parent
ROOT = BACKEND.parent
FRONTEND = ROOT / 'frontend'
STORES_JSON = FRONTEND / 'stores.json'
KNOWN_STORES_PATH = ROOT / 'data' / 'known_stores.json'

app = Flask(__name__, static_folder=None)
app.secret_key = os.getenv('FLASK_SECRET_KEY', '').strip() or os.urandom(32).hex()
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=7)

PANEL_TOKEN = os.getenv('PANEL_TOKEN', '').strip() or os.getenv('API_TOKEN', '').strip()
DEFAULT_PORT = int(os.getenv('FRONTEND_PORT', '3000'))

PUBLIC_API_PATHS = frozenset({
    '/api/auth/config',
    '/api/auth/me',
    '/api/auth/session',
    '/api/auth/logout',
    '/api/audit/status',
})

heartbeats: dict[str, dict] = {}
heartbeats_lock = threading.Lock()
known_stores_lock = threading.Lock()
sse_clients: list[queue.Queue] = []
sse_lock = threading.Lock()


def normalize_store_id(store: str) -> str:
    return str(store or '').strip().lower()


def load_catalog() -> dict:
    try:
        return json.loads(STORES_JSON.read_text(encoding='utf-8'))
    except Exception:
        return {}


def heartbeat_timeout_seconds() -> int:
    catalog = load_catalog()
    return int(catalog.get('heartbeat_timeout_seconds') or 90)


def verify_panel_token() -> bool:
    if not PANEL_TOKEN:
        return True
    return request.headers.get('X-Token') == PANEL_TOKEN


def panel_user() -> dict | None:
    uid = session.get('firebase_uid')
    if not uid:
        return None
    return {
        'uid': uid,
        'email': session.get('email') or '',
    }


def require_panel_user():
    if not firebase_auth_enabled():
        return None
    if not session.get('firebase_uid'):
        return jsonify({'detail': 'Login required', 'code': 'auth_required'}), 401
    return None


@app.before_request
def enforce_panel_auth():
    if not firebase_auth_enabled():
        return None
    if request.method == 'OPTIONS':
        return None
    path = request.path.rstrip('/') or '/'
    if not path.startswith('/api/'):
        return None
    if path == '/api/heartbeat' and request.method == 'POST':
        return None
    if path in ('/api/heartbeats', '/api/heartbeats/stream', '/api/catalog') and request.method == 'GET':
        return None
    if path in PUBLIC_API_PATHS:
        return None
    return require_panel_user()


def broadcast_sse(message: dict) -> None:
    data = json.dumps(message, ensure_ascii=False)
    with sse_lock:
        dead: list[queue.Queue] = []
        for client in sse_clients:
            try:
                client.put_nowait(data)
            except Exception:
                dead.append(client)
        for client in dead:
            if client in sse_clients:
                sse_clients.remove(client)


@app.after_request
def cors_headers(response):
    origin = request.headers.get('Origin')
    if origin:
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Token, Accept'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
        response.headers['Access-Control-Allow-Credentials'] = 'true'
    return response


@app.route('/api/auth/config', methods=['GET'])
def api_auth_config():
    enabled = firebase_auth_enabled()
    public = firebase_public_config() if enabled else None
    return jsonify({
        'enabled': enabled,
        'firebase': public,
        'server_verify': auth_verify_mode() != 'none',
        'verify_mode': auth_verify_mode(),
    }), 200


@app.route('/api/auth/me', methods=['GET'])
def api_auth_me():
    if not firebase_auth_enabled():
        return jsonify({'authenticated': True, 'auth_disabled': True, 'user': None}), 200

    user = panel_user()
    if not user:
        return jsonify({'authenticated': False, 'user': None}), 200
    return jsonify({'authenticated': True, 'user': user}), 200


@app.route('/api/auth/session', methods=['POST', 'DELETE', 'OPTIONS'])
def api_auth_session():
    if request.method == 'OPTIONS':
        return '', 204
    if not firebase_auth_enabled():
        return jsonify({'detail': 'Firebase auth is not configured'}), 503

    if request.method == 'DELETE':
        user = panel_user()
        session.clear()
        log_audit_event_async(
            user,
            {
                'action': 'auth_logout',
                'label': 'Logout do painel',
                'success': True,
                'page': 'panel',
            },
            request,
        )
        return jsonify({'ok': True}), 200

    body = request.get_json(silent=True) or {}
    id_token = str(body.get('idToken') or '').strip()
    if not id_token:
        return jsonify({'detail': "Field 'idToken' is required."}), 400

    decoded, verify_error = verify_firebase_id_token(id_token)
    if not decoded:
        print(f'Login recusado: {verify_error or "token inválido"}')
        log_audit_event_async(
            None,
            {
                'action': 'auth_login_failed',
                'label': 'Tentativa de login recusada',
                'success': False,
                'page': 'login',
                'error': verify_error or 'Token inválido',
            },
            request,
        )
        return jsonify({
            'detail': verify_error or 'Token inválido ou expirado. Verifique e-mail/senha no Firebase.',
            'code': 'invalid_token',
        }), 401

    uid = decoded.get('uid') or ''
    email = decoded.get('email') or ''

    session.permanent = True
    session['firebase_uid'] = uid
    session['email'] = email
    user = panel_user()
    log_audit_event_async(
        user,
        {
            'action': 'auth_login',
            'label': f'Login · {email}',
            'success': True,
            'page': 'login',
        },
        request,
    )
    return jsonify({
        'ok': True,
        'user': user,
    }), 200


@app.route('/api/auth/logout', methods=['POST', 'OPTIONS'])
def api_auth_logout():
    if request.method == 'OPTIONS':
        return '', 204
    user = panel_user()
    session.clear()
    log_audit_event_async(
        user,
        {
            'action': 'auth_logout',
            'label': 'Logout do painel',
            'success': True,
            'page': 'panel',
        },
        request,
    )
    return jsonify({'ok': True}), 200


def load_known_stores() -> dict[str, dict]:
    try:
        raw = json.loads(KNOWN_STORES_PATH.read_text(encoding='utf-8'))
    except Exception:
        return {}
    if isinstance(raw, list):
        out: dict[str, dict] = {}
        for item in raw:
            if not isinstance(item, dict):
                continue
            sid = normalize_store_id(item.get('id'))
            if sid:
                out[sid] = {'id': sid, 'name': str(item.get('name') or sid.upper()).strip() or sid.upper()}
        return out
    if isinstance(raw, dict):
        out = {}
        for key, value in raw.items():
            sid = normalize_store_id(key)
            if not sid:
                continue
            if isinstance(value, dict):
                out[sid] = {
                    'id': sid,
                    'name': str(value.get('name') or sid.upper()).strip() or sid.upper(),
                }
            else:
                out[sid] = {'id': sid, 'name': sid.upper()}
        return out
    return {}


def save_known_stores(stores: dict[str, dict]) -> None:
    KNOWN_STORES_PATH.parent.mkdir(parents=True, exist_ok=True)
    items = sorted(stores.values(), key=lambda s: s.get('id', ''))
    KNOWN_STORES_PATH.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding='utf-8')


def upsert_known_store(store_id: str, name: str | None = None) -> None:
    sid = normalize_store_id(store_id)
    if not sid:
        return
    with known_stores_lock:
        stores = load_known_stores()
        prev = stores.get(sid, {})
        stores[sid] = {
            'id': sid,
            'name': str(name or prev.get('name') or sid.upper()).strip() or sid.upper(),
            'last_seen_at': datetime.utcnow().isoformat() + 'Z',
        }
        save_known_stores(stores)


def purge_unregistered_stores(catalog: dict | None = None) -> None:
    """Remove lojas não cadastradas (ex.: pb100) de heartbeats e known_stores."""
    cfg = catalog if catalog is not None else load_catalog()
    with heartbeats_lock:
        for sid in list(heartbeats.keys()):
            if not is_allowed_store(sid, cfg):
                heartbeats.pop(sid, None)
    with known_stores_lock:
        stores = load_known_stores()
        filtered = {sid: meta for sid, meta in stores.items() if is_allowed_store(sid, cfg)}
        if filtered != stores:
            save_known_stores(filtered)


def catalog_stores_from_heartbeats() -> list[dict]:
    """Lojas cadastradas no sistema — offline continua visível, inválidas são removidas."""
    config = load_catalog()
    purge_unregistered_stores(config)
    stores_map: dict[str, dict] = {}

    for item in config.get('stores') or []:
        if not isinstance(item, dict):
            continue
        sid = normalize_store_id(item.get('id'))
        if not sid or not is_allowed_store(sid, config):
            continue
        stores_map[sid] = {
            'id': sid,
            'name': str(item.get('name') or sid.upper()).strip() or sid.upper(),
        }

    for sid, meta in load_known_stores().items():
        if not is_allowed_store(sid, config):
            continue
        stores_map.setdefault(sid, meta)

    with heartbeats_lock:
        items = list(heartbeats.items())
    for store_id, entry in items:
        sid = normalize_store_id(store_id)
        if not sid or not is_allowed_store(sid, config):
            continue
        payload = entry.get('payload') or {}
        name = str(payload.get('store_name') or payload.get('name') or sid.upper()).strip()
        stores_map[sid] = {
            'id': sid,
            'name': name or stores_map.get(sid, {}).get('name') or sid.upper(),
            'lav60_status': resolve_store_lav60_status(sid, payload),
        }

    with known_stores_lock:
        save_known_stores({k: {'id': v['id'], 'name': v['name']} for k, v in stores_map.items()})

    return sorted(
        [
            {
                'id': s['id'],
                'name': s.get('name') or s['id'].upper(),
                'lav60_status': s.get('lav60_status') or resolve_store_lav60_status(s['id'], None),
            }
            for s in stores_map.values()
        ],
        key=lambda s: s['id'],
    )


def build_panel_catalog_payload() -> dict:
    config = load_catalog()
    payload = {k: v for k, v in config.items() if k != 'stores'}
    payload['stores'] = catalog_stores_from_heartbeats()
    return payload


def catalog_json_response():
    resp = jsonify(build_panel_catalog_payload())
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'
    resp.headers['Pragma'] = 'no-cache'
    return resp


@app.route('/stores.json')
def dynamic_stores_json():
    """Catálogo dinâmico — lojas descobertas via heartbeat (substitui lista manual)."""
    return catalog_json_response()


@app.route('/api/catalog', methods=['GET'])
def api_catalog():
    """Config do painel + lojas descobertas automaticamente via heartbeat dos agentes."""
    return catalog_json_response()


@app.route('/api/heartbeat', methods=['POST', 'OPTIONS'])
def api_heartbeat():
    if request.method == 'OPTIONS':
        return '', 204
    if not verify_panel_token():
        return jsonify({'detail': 'Invalid or missing X-Token header.'}), 401

    body = request.get_json(silent=True) or {}
    store_id = normalize_store_id(body.get('store'))
    if not store_id:
        return jsonify({'detail': "Field 'store' is required."}), 400

    catalog = load_catalog()
    if not is_allowed_store(store_id, catalog):
        return jsonify({'detail': reject_store_detail(store_id)}), 403

    received_at = time.time()
    entry = {
        'store': store_id,
        'received_at': received_at,
        'received_at_iso': datetime.utcnow().isoformat() + 'Z',
        'payload': body,
    }
    with heartbeats_lock:
        heartbeats[store_id] = entry

    payload_name = str(body.get('store_name') or body.get('name') or store_id.upper()).strip()
    upsert_known_store(store_id, payload_name or store_id.upper())

    broadcast_sse({
        'type': 'heartbeat',
        'store': store_id,
        'received_at': received_at,
        'payload': body,
    })
    return jsonify({'ok': True, 'store': store_id, 'received_at': received_at}), 200


def heartbeat_snapshot() -> dict:
    timeout = heartbeat_timeout_seconds()
    now = time.time()
    with heartbeats_lock:
        items = {k: dict(v) for k, v in heartbeats.items()}
    out = {}
    for store_id, entry in items.items():
        age = now - float(entry.get('received_at') or 0)
        out[store_id] = {
            **entry,
            'alive': age <= timeout,
            'age_seconds': round(age, 1),
        }
    return {
        'heartbeats': out,
        'timeout_seconds': timeout,
        'timestamp': datetime.now().isoformat(),
    }


def get_heartbeat_entry(store_id: str) -> dict | None:
    sid = normalize_store_id(store_id)
    with heartbeats_lock:
        entry = heartbeats.get(sid)
        return dict(entry) if entry else None


def is_store_heartbeat_alive(store_id: str) -> bool:
    entry = get_heartbeat_entry(store_id)
    if not entry:
        return False
    age = time.time() - float(entry.get('received_at') or 0)
    return age <= heartbeat_timeout_seconds()


def require_registered_store(store_id: str):
    sid = normalize_store_id(store_id)
    if not sid:
        return None, (jsonify({'detail': 'Invalid store id'}), 400)
    if not is_allowed_store(sid, load_catalog()):
        return None, (jsonify({'detail': reject_store_detail(sid)}), 403)
    return sid, None


def agent_base_urls_for_store(store_id: str) -> list[str]:
    entry = get_heartbeat_entry(store_id)
    if not entry:
        return []
    payload = entry.get('payload') or {}
    urls: list[str] = []
    for key in ('agent_url', 'agent_local_url'):
        raw = str(payload.get(key) or '').strip().rstrip('/')
        if raw and raw not in urls:
            urls.append(raw)
    return urls


def build_agent_config_from_heartbeat(store_id: str) -> dict | None:
    """Config mínima para a página da loja quando o túnel do agente está indisponível."""
    entry = get_heartbeat_entry(store_id)
    if not entry:
        return None
    payload = entry.get('payload') or {}
    network = payload.get('network') or {}
    machines = payload.get('machines') or []
    devices = {
        'washers': sorted(str(k) for k in (network.get('washers') or {}).keys()),
        'dryers': sorted(str(k) for k in (network.get('dryers') or {}).keys()),
        'dosers': sorted(str(k) for k in (network.get('dosers') or {}).keys()),
        'ac': '110',
    }
    return {
        'store': normalize_store_id(store_id),
        'agent_url': payload.get('agent_url'),
        'token_required': bool(os.getenv('API_TOKEN', '').strip()),
        'network_check_interval': int(load_catalog().get('network_check_interval') or 60),
        'devices': devices,
        'machines': machines,
        'washer_am_options': ['am01-1', 'am01-2', 'am02-1', 'am02-2'],
        'dryer_minutes': [15, 30, 45],
        'ac_temperatures': ['18', '22', 'off'],
        'doser_types': [
            'softener0', 'softener1', 'softener2', 'softener3',
            'am01-1', 'am01-2', 'am02-1', 'am02-2',
            'rele1on', 'rele2on', 'rele3on', 'status',
        ],
        'last_network_check': network,
        'from_heartbeat': True,
    }


CENTRAL_GATEWAY_MACHINES = {
    'washers': ['321', '432', '543', '654'],
    'dryers': ['765', '876', '987', '210'],
    'dosers': ['321', '432', '543', '654'],
}

GATEWAY_STATUS_TIMEOUT = int(env_value('GATEWAY_STATUS_TIMEOUT') or '25')
GATEWAY_PROBE_TIMEOUT = int(env_value('GATEWAY_PROBE_TIMEOUT') or '8')
GATEWAY_PROBE_TIMEOUT_FAST = int(env_value('GATEWAY_PROBE_TIMEOUT_FAST') or '6')


def central_gateway_base_url() -> str:
    return (env_value('GATEWAY_API_URL') or 'https://gateway.lav60.com').rstrip('/')


def central_gateway_token() -> str:
    return (env_value('GATEWAY_API_TOKEN') or env_value('API_TOKEN') or '').strip()


def friendly_gateway_transport_error(exc: Exception) -> str:
    msg = str(exc or '').strip()
    lower = msg.lower()
    if 'read timed out' in lower or 'timed out' in lower:
        return (
            'Gateway MQTT demorou para responder. '
            'ESP8266 da loja pode estar offline ou fora do broker.'
        )
    if 'connection refused' in lower or 'failed to establish' in lower:
        return 'Sem conexão com gateway.lav60.com.'
    if 'name or service not known' in lower or 'getaddrinfo failed' in lower:
        return 'Host gateway.lav60.com não encontrado.'
    return msg[:500] if msg else 'Erro de comunicação com gateway.lav60.com.'


def forward_central_gateway(method: str, path: str, timeout: int = 60):
    """Encaminha requisição à API MQTT central (sem depender de heartbeat/agente)."""
    base = central_gateway_base_url()
    token = central_gateway_token()
    clean_path = path if path.startswith('/') else f'/{path}'
    if clean_path != '/' and not token:
        raise ValueError('GATEWAY_API_TOKEN (ou API_TOKEN) não configurado no servidor')

    headers = {'Accept': 'application/json'}
    if token:
        headers['X-Token'] = token

    json_body = None
    if method in ('POST', 'PUT', 'PATCH'):
        json_body = request.get_json(silent=True)
        if json_body is not None:
            headers['Content-Type'] = 'application/json'

    url = f'{base}{clean_path}'
    return requests.request(method, url, headers=headers, json=json_body, timeout=timeout)


def forward_agent_request(store_id: str, method: str, agent_path: str, timeout: int = 45):
    """Encaminha requisição ao agente da loja (server-side — evita CORS no browser)."""
    headers = {'Accept': 'application/json'}
    token = request.headers.get('X-Token')
    if token:
        headers['X-Token'] = token

    json_body = None
    if method in ('POST', 'PUT', 'PATCH'):
        json_body = request.get_json(silent=True)
        if json_body is not None:
            headers['Content-Type'] = 'application/json'

    last_error: str | None = None
    for base in agent_base_urls_for_store(store_id):
        url = f"{base.rstrip('/')}{agent_path}"
        try:
            return requests.request(
                method,
                url,
                headers=headers,
                json=json_body,
                timeout=timeout,
            )
        except Exception as exc:
            last_error = str(exc)
    raise ConnectionError(last_error or 'Agente da loja indisponível')


def agent_proxy_response(resp: requests.Response):
    try:
        payload = resp.json()
    except Exception:
        payload = {'detail': resp.text or resp.reason}
    return jsonify(payload), resp.status_code


def agent_proxy_status_response(resp: requests.Response):
    """Status de equipamento: sempre HTTP 200 no painel, com online no JSON."""
    try:
        payload = resp.json()
    except Exception:
        payload = {'detail': resp.text or resp.reason}
    if not isinstance(payload, dict):
        payload = {'detail': str(payload)}

    upstream_status = resp.status_code
    if 'online' not in payload:
        if upstream_status == 200:
            payload['online'] = True
        elif upstream_status >= 400:
            payload['online'] = False

    payload['upstream_status'] = upstream_status
    return jsonify(payload), 200


def parse_upstream_gateway_json(resp: requests.Response) -> dict:
    try:
        data = resp.json()
        return data if isinstance(data, dict) else {'detail': resp.text or resp.reason}
    except Exception:
        return {'detail': resp.text or resp.reason or f'HTTP {resp.status_code}'}


def extract_online_from_probe(data: dict) -> bool | None:
    if not isinstance(data, dict):
        return None
    if 'online' in data:
        return bool(data['online'])
    for key in ('devices', 'statuses'):
        items = data.get(key)
        if isinstance(items, list) and items:
            values = [bool(item.get('online')) for item in items if isinstance(item, dict) and 'online' in item]
            if values:
                return any(values)
    return None


def probe_central_device_online(store_id: str, subpath: str, timeout: int = 12) -> bool | None:
    path = f'/{store_id}/{subpath.lstrip("/")}'
    try:
        resp = forward_central_gateway('GET', path, timeout=timeout)
        data = parse_upstream_gateway_json(resp)
        online = extract_online_from_probe(data)
        if online is not None:
            return online
        if resp.status_code == 200:
            return True
        if resp.status_code >= 400:
            return False
    except Exception:
        return None
    return None


def build_default_status_summary(store_id: str) -> dict:
    return {
        'store': store_id,
        'esp_online': None,
        'esp_error': None,
        'washers': {mid: None for mid in CENTRAL_GATEWAY_MACHINES['washers']},
        'dryers': {mid: None for mid in CENTRAL_GATEWAY_MACHINES['dryers']},
        'dosers': {mid: None for mid in CENTRAL_GATEWAY_MACHINES['dosers']},
        'ac': None,
        'checked_at': datetime.utcnow().isoformat() + 'Z',
    }


def merge_aggregate_gateway_status(data: dict, summary: dict) -> None:
    for key in ('washers', 'dryers', 'dosers'):
        block = data.get(key)
        if isinstance(block, dict):
            for mid, val in block.items():
                mid_str = str(mid)
                if mid_str in summary[key]:
                    summary[key][mid_str] = bool(val) if val is not None else None
    if 'ac' in data:
        summary['ac'] = bool(data['ac']) if data['ac'] is not None else None


def fill_status_summary_probes(store_id: str, summary: dict, timeout: int | None = None) -> None:
    probe_timeout = timeout if timeout is not None else GATEWAY_PROBE_TIMEOUT
    probes: list[tuple[str, str | None, str]] = []
    for mid in CENTRAL_GATEWAY_MACHINES['washers']:
        probes.append(('washers', mid, f'status/washer/{mid}'))
    for mid in CENTRAL_GATEWAY_MACHINES['dryers']:
        probes.append(('dryers', mid, f'status/dryer/{mid}'))
    for mid in CENTRAL_GATEWAY_MACHINES['dosers']:
        probes.append(('dosers', mid, f'status/doser/{mid}'))
    probes.append(('ac', None, 'status/ac'))

    for key, mid, subpath in probes:
        online = probe_central_device_online(store_id, subpath, timeout=probe_timeout)
        if key == 'ac':
            summary['ac'] = online
        elif mid is not None:
            summary[key][mid] = online


@app.route('/api/stores/<store_id>/agent/config', methods=['GET', 'OPTIONS'])
def api_store_agent_config(store_id: str):
    if request.method == 'OPTIONS':
        return '', 204
    sid, err = require_registered_store(store_id)
    if err:
        return err
    if not is_store_heartbeat_alive(sid):
        return jsonify({'detail': 'Loja offline ou sem heartbeat recente'}), 503
    try:
        resp = forward_agent_request(sid, 'GET', '/api/agent/config', timeout=20)
        return agent_proxy_response(resp)
    except ConnectionError as exc:
        fallback = build_agent_config_from_heartbeat(sid)
        if fallback:
            return jsonify(fallback), 200
        return jsonify({'detail': str(exc)}), 502


@app.route('/api/stores/<store_id>/gateway/<path:subpath>', methods=['GET', 'POST', 'OPTIONS'])
def api_store_agent_gateway(store_id: str, subpath: str):
    if request.method == 'OPTIONS':
        return '', 204
    sid, err = require_registered_store(store_id)
    if err:
        return err
    if not is_store_heartbeat_alive(sid):
        return jsonify({'detail': 'Loja offline ou sem heartbeat recente'}), 503
    agent_path = f'/{sid}/{subpath.lstrip("/")}'
    try:
        resp = forward_agent_request(sid, request.method, agent_path, timeout=60)
        return agent_proxy_response(resp)
    except ConnectionError as exc:
        return jsonify({'detail': str(exc)}), 502


@app.route('/api/gateway/config', methods=['GET'])
def api_gateway_config():
    return jsonify({
        'base_url': central_gateway_base_url(),
        'token_configured': bool(central_gateway_token()),
        'washers': CENTRAL_GATEWAY_MACHINES['washers'],
        'dryers': CENTRAL_GATEWAY_MACHINES['dryers'],
        'dosers': CENTRAL_GATEWAY_MACHINES['dosers'],
        'washer_am_options': ['am01-1', 'am01-2', 'am02-1', 'am02-2'],
        'dryer_minutes': [15, 30, 45],
        'ac_temperatures': ['18', '22', 'off'],
        'doser_types': [
            'softener0', 'softener1', 'softener2', 'softener3',
            'am01-1', 'am01-2', 'am02-1', 'am02-2',
            'rele1on', 'rele2on', 'rele3on', 'status',
        ],
    }), 200


@app.route('/api/gateway/health', methods=['GET', 'OPTIONS'])
def api_gateway_health():
    if request.method == 'OPTIONS':
        return '', 204
    try:
        resp = forward_central_gateway('GET', '/', timeout=15)
        return agent_proxy_response(resp)
    except ValueError as exc:
        return jsonify({'detail': str(exc)}), 503
    except requests.RequestException as exc:
        return jsonify({'detail': str(exc)}), 502


@app.route('/api/gateway/<store_id>/status-summary', methods=['GET'])
def api_gateway_status_summary(store_id: str):
    """Status via um único GET /{store}/status (evita inundar o ESP8266)."""
    sid, err = require_registered_store(store_id)
    if err:
        return err

    use_probes = request.args.get('probes', '').strip().lower() in ('1', 'true', 'yes')
    summary = build_default_status_summary(sid)
    summary['status_source'] = 'none'

    try:
        resp = forward_central_gateway('GET', f'/{sid}/status', timeout=GATEWAY_STATUS_TIMEOUT)
        data = parse_upstream_gateway_json(resp)
        print(f'[gateway status-summary] {sid} aggregate HTTP {resp.status_code} keys={list(data.keys())[:8]}')
        if resp.status_code == 200 and isinstance(data.get('washers'), dict):
            summary['esp_online'] = True
            summary['esp_error'] = None
            summary['status_source'] = 'aggregate'
            merge_aggregate_gateway_status(data, summary)
            return jsonify(summary), 200

        detail = str(data.get('detail') or data.get('error') or data.get('message') or '').strip()
        summary['esp_error'] = detail or f'HTTP {resp.status_code}'
        summary['esp_online'] = False
    except ValueError as exc:
        return jsonify({'detail': str(exc)}), 503
    except requests.Timeout as exc:
        summary['esp_error'] = friendly_gateway_transport_error(exc)
        summary['esp_online'] = False
        print(f'[gateway status-summary] {sid} aggregate timeout')
    except requests.RequestException as exc:
        summary['esp_error'] = friendly_gateway_transport_error(exc)
        summary['esp_online'] = False
        print(f'[gateway status-summary] {sid} aggregate error: {exc}')

    if use_probes:
        print(f'[gateway status-summary] {sid} running individual probes (explicit probes=1)')
        summary['status_source'] = 'probes'
        fill_status_summary_probes(sid, summary, timeout=GATEWAY_PROBE_TIMEOUT_FAST)
        any_online = any(
            value is True
            for block in (summary['washers'], summary['dryers'], summary['dosers'])
            for value in block.values()
        ) or summary['ac'] is True
        if any_online and summary['esp_online'] is False:
            summary['esp_online'] = True
            summary['esp_error'] = None

    return jsonify(summary), 200


@app.route('/api/gateway/<store_id>/<path:subpath>', methods=['GET', 'POST', 'OPTIONS'])
def api_central_gateway_proxy(store_id: str, subpath: str):
    if request.method == 'OPTIONS':
        return '', 204
    sid, err = require_registered_store(store_id)
    if err:
        return err
    path = f'/{sid}/{subpath.lstrip("/")}'
    is_status_read = request.method == 'GET' and subpath.lstrip('/').startswith('status')
    try:
        resp = forward_central_gateway(request.method, path, timeout=60)
        if is_status_read:
            return agent_proxy_status_response(resp)
        return agent_proxy_response(resp)
    except ValueError as exc:
        return jsonify({'detail': str(exc)}), 503
    except requests.RequestException as exc:
        return jsonify({'detail': str(exc)}), 502


@app.route('/api/heartbeats', methods=['GET'])
def api_heartbeats_list():
    return jsonify(heartbeat_snapshot()), 200


@app.route('/api/heartbeats/stream', methods=['GET'])
def api_heartbeats_stream():
    def generate():
        client_q: queue.Queue = queue.Queue()
        with sse_lock:
            sse_clients.append(client_q)
        try:
            yield f"data: {json.dumps({'type': 'connected'})}\n\n"
            snapshot = heartbeat_snapshot()
            yield f"data: {json.dumps({'type': 'snapshot', **snapshot})}\n\n"
            while True:
                try:
                    payload = client_q.get(timeout=15)
                    yield f"data: {payload}\n\n"
                except queue.Empty:
                    yield f"data: {json.dumps({'type': 'keepalive', 'ts': time.time()})}\n\n"
        finally:
            with sse_lock:
                if client_q in sse_clients:
                    sse_clients.remove(client_q)

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'Content-Type': 'text/event-stream; charset=utf-8',
            'X-Accel-Buffering': 'no',
        },
    )


@app.route('/api/panel/bootstrap', methods=['GET'])
def api_panel_bootstrap():
    """Token padrão do agente (mesmo API_TOKEN do .env) para preencher o painel local."""
    token = os.getenv('API_TOKEN', '').strip()
    return jsonify({
        'default_agent_token': token or None,
        'panel_token_required': bool(PANEL_TOKEN),
        'auth_enabled': firebase_auth_enabled(),
        'audit_enabled': audit_logging_available(),
        'audit_collection': audit_collection(),
    }), 200


@app.route('/api/audit/status', methods=['GET'])
def api_audit_status():
    available = audit_logging_available()
    sa_path = service_account_path()
    payload = {
        'available': available,
        'collection': audit_collection(),
        'project_id': env_value('FIREBASE_PROJECT_ID'),
        'service_account_configured': service_account_configured(),
        'service_account_env': env_value('FIREBASE_SERVICE_ACCOUNT_FILE') or None,
        'service_account_resolved': sa_path or None,
    }
    if not available:
        if not service_account_configured():
            payload['reason'] = 'service_account_missing'
            payload['hint'] = (
                'Copie o JSON da service account para o VPS e defina '
                'FIREBASE_SERVICE_ACCOUNT_FILE com caminho absoluto no .env'
            )
        elif firebase_init_error():
            payload['reason'] = firebase_init_error()
        else:
            payload['reason'] = 'firestore_unavailable'
    return jsonify(payload), 200


@app.route('/api/audit/log', methods=['POST', 'OPTIONS'])
def api_audit_log():
    if request.method == 'OPTIONS':
        return '', 204
    if firebase_auth_enabled():
        blocked = require_panel_user()
        if blocked:
            return blocked
    body = request.get_json(silent=True) or {}
    ok, err = log_audit_event(panel_user(), body, request)
    if not ok:
        print(f'Auditoria Firestore: falha ao gravar ({err or "write_failed"})')
        status = 503 if err == 'audit_unavailable' else 500
        return jsonify({'ok': False, 'detail': err or 'write_failed'}), status
    return jsonify({'ok': True, 'collection': audit_collection()}), 201


@app.route('/api/audit/logs', methods=['GET'])
def api_audit_logs():
    if not audit_logging_available():
        return jsonify({
            **audit_unavailable_payload(),
            'items': [],
            'has_more': False,
        }), 200

    store = request.args.get('store', '').strip().lower() or None
    action = request.args.get('action', '').strip() or None
    operator = request.args.get('operator', '').strip().lower() or None
    q = request.args.get('q', '').strip() or None
    success_raw = request.args.get('success', '').strip().lower()
    success = None
    if success_raw in ('1', 'true', 'ok', 'yes'):
        success = True
    elif success_raw in ('0', 'false', 'fail', 'no'):
        success = False

    try:
        limit = int(request.args.get('limit', '20'))
    except ValueError:
        limit = 20

    before_ms = None
    before_raw = request.args.get('before_ms', '').strip()
    if before_raw:
        try:
            before_ms = int(before_raw)
        except ValueError:
            return jsonify({'detail': 'before_ms inválido'}), 400

    items, has_more, err = list_audit_events(
        store=store,
        action=action,
        operator=operator,
        success=success,
        q=q,
        limit=limit,
        before_ms=before_ms,
    )
    if err:
        return jsonify({'detail': err, 'items': []}), 500

    next_before_ms = items[-1].get('ts_ms') if items and has_more else None
    payload = {
        'items': items,
        'has_more': has_more,
        'next_before_ms': next_before_ms,
        'collection': audit_collection(),
        'action_labels': ACTION_LABELS_PT,
        'device_labels': DEVICE_LABELS_PT,
    }

    if before_ms is None:
        skip_total = request.args.get('skip_total', '').strip().lower() in ('1', 'true', 'yes')
        if not skip_total:
            total, truncated, count_err = count_audit_events(
                store=store,
                action=action,
                operator=operator,
                success=success,
                q=q,
            )
            if count_err:
                payload['total_error'] = count_err
            elif total is not None:
                payload['total'] = total
                payload['total_truncated'] = truncated

    return jsonify(payload), 200


@app.route('/api/audit/operators', methods=['GET'])
def api_audit_operators():
    if not audit_logging_available():
        return jsonify({**audit_unavailable_payload(), 'operators': []}), 200
    operators, err = list_audit_operators()
    if err:
        return jsonify({'detail': err, 'operators': []}), 500
    return jsonify({'operators': operators}), 200


@app.route('/api/audit/operator-stats', methods=['GET'])
def api_audit_operator_stats():
    if not audit_logging_available():
        return jsonify({**audit_unavailable_payload(), 'operators': [], 'truncated': False}), 200

    store = request.args.get('store', '').strip().lower() or None
    action = request.args.get('action', '').strip() or None
    q = request.args.get('q', '').strip() or None
    success_raw = request.args.get('success', '').strip().lower()
    success = None
    if success_raw in ('1', 'true', 'ok', 'yes'):
        success = True
    elif success_raw in ('0', 'false', 'fail', 'no'):
        success = False

    try:
        limit = int(request.args.get('limit', '5'))
    except ValueError:
        limit = 5

    operators, truncated, err = list_audit_operator_stats(
        store=store,
        action=action,
        success=success,
        q=q,
        limit=limit,
    )
    if err:
        return jsonify({'detail': err, 'operators': []}), 500

    return jsonify({
        'operators': operators,
        'truncated': truncated,
        'scan_limit': 10000,
    }), 200


@app.route('/api/audit/dashboard-summary', methods=['GET'])
def api_audit_dashboard_summary():
    try:
        hours = int(request.args.get('hours', '24'))
    except ValueError:
        hours = 24

    if not audit_logging_available():
        return jsonify({
            **audit_unavailable_payload(),
            'hours': hours,
            'total': 0,
            'success_rate': None,
            'top_operator': None,
            'top_store': None,
            'truncated': False,
        }), 200

    summary, truncated, err = audit_dashboard_summary(hours=hours)
    if err:
        return jsonify({'detail': err}), 500

    return jsonify({
        **summary,
        'truncated': truncated,
        'available': True,
    }), 200


@app.route('/api/panel/health', methods=['GET'])
def api_panel_health():
    return jsonify({
        'ok': True,
        'service': 'lav60-panel',
        'auth_routes': True,
        'auth_enabled': firebase_auth_enabled(),
    }), 200


@app.route('/')
def index():
    return send_from_directory(FRONTEND, 'index.html')


@app.route('/<path:path>')
def static_or_api(path: str):
    if path.startswith('api/'):
        return jsonify({'detail': 'Not found'}), 404
    target = FRONTEND / path
    if target.is_file() and path != 'stores.json':
        resp = send_from_directory(FRONTEND, path)
        return resp
    if path.endswith('.html'):
        return send_from_directory(FRONTEND, path)
    return send_from_directory(FRONTEND, 'index.html')


def main() -> None:
    catalog = load_catalog()
    timeout = heartbeat_timeout_seconds()
    auth_on = firebase_auth_enabled()
    print(f'Painel LAV60: http://0.0.0.0:{DEFAULT_PORT}')
    print(f'Frontend + heartbeat hub (timeout offline: {timeout}s)')
    if auth_on:
        mode = auth_verify_mode()
        if mode == 'service_account':
            init_firebase_admin()
            print('Login Firebase: ativo (verificação via service account)')
        else:
            print('Login Firebase: ativo (verificação via FIREBASE_API_KEY — ok para uso interno)')
    else:
        print('Login Firebase: desativado (sem FIREBASE_API_KEY no .env)')
    if audit_logging_available():
        print(f'Auditoria Firestore: ativa → coleção "{audit_collection()}"')
        print(f'  Service account: {service_account_path()}')
    else:
        reason = firebase_init_error() or ('service account ausente' if not service_account_configured() else 'indisponível')
        print(f'Auditoria Firestore: desativada ({reason})')
    print('Agentes: executar LAV60_Gateway.exe nas lojas (heartbeat automatico)')
    app.run(host='0.0.0.0', port=DEFAULT_PORT, debug=False, threaded=True)


if __name__ == '__main__':
    main()
