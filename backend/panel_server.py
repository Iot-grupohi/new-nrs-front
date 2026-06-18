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
from panel_audit import (
    ACTION_LABELS_PT,
    DEVICE_LABELS_PT,
    audit_dashboard_summary,
    audit_collection,
    audit_logging_available,
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


def catalog_stores_from_heartbeats() -> list[dict]:
    with heartbeats_lock:
        items = list(heartbeats.items())
    stores = []
    for store_id, entry in items:
        payload = entry.get('payload') or {}
        name = str(payload.get('store_name') or payload.get('name') or store_id.upper()).strip()
        stores.append({'id': store_id, 'name': name or store_id.upper()})
    stores.sort(key=lambda s: s['id'])
    return stores


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

    received_at = time.time()
    entry = {
        'store': store_id,
        'received_at': received_at,
        'received_at_iso': datetime.utcnow().isoformat() + 'Z',
        'payload': body,
    }
    with heartbeats_lock:
        heartbeats[store_id] = entry

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


@app.route('/api/stores/<store_id>/agent/config', methods=['GET', 'OPTIONS'])
def api_store_agent_config(store_id: str):
    if request.method == 'OPTIONS':
        return '', 204
    sid = normalize_store_id(store_id)
    if not sid:
        return jsonify({'detail': 'Invalid store id'}), 400
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
    sid = normalize_store_id(store_id)
    if not sid:
        return jsonify({'detail': 'Invalid store id'}), 400
    if not is_store_heartbeat_alive(sid):
        return jsonify({'detail': 'Loja offline ou sem heartbeat recente'}), 503
    agent_path = f'/{sid}/{subpath.lstrip("/")}'
    try:
        resp = forward_agent_request(sid, request.method, agent_path, timeout=60)
        return agent_proxy_response(resp)
    except ConnectionError as exc:
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
        reason = 'service_account_missing'
        hint = None
        if not service_account_configured():
            hint = (
                'Arquivo da service account não encontrado. '
                'No VPS: copie o JSON e use caminho absoluto em FIREBASE_SERVICE_ACCOUNT_FILE'
            )
        elif firebase_init_error():
            reason = firebase_init_error() or 'firestore_unavailable'
        return jsonify({
            'detail': 'audit_unavailable',
            'reason': reason,
            'hint': hint,
            'items': [],
        }), 503

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
        return jsonify({'detail': 'audit_unavailable', 'operators': []}), 503
    operators, err = list_audit_operators()
    if err:
        return jsonify({'detail': err, 'operators': []}), 500
    return jsonify({'operators': operators}), 200


@app.route('/api/audit/operator-stats', methods=['GET'])
def api_audit_operator_stats():
    if not audit_logging_available():
        return jsonify({'detail': 'audit_unavailable', 'operators': []}), 503

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
    if not audit_logging_available():
        return jsonify({'detail': 'audit_unavailable'}), 503

    try:
        hours = int(request.args.get('hours', '24'))
    except ValueError:
        hours = 24

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
