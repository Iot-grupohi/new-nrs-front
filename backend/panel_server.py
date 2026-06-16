"""Painel LAV60 — serve o frontend e recebe heartbeat dos agentes (push)."""
from __future__ import annotations

import json
import os
import queue
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory, session, stream_with_context

from lav60_env import env_value, load_local_env
from panel_audit import (
    ACTION_LABELS_PT,
    DEVICE_LABELS_PT,
    audit_collection,
    audit_logging_available,
    list_audit_events,
    log_audit_event,
)
from panel_auth import (
    auth_verify_mode,
    firebase_auth_enabled,
    firebase_init_error,
    firebase_public_config,
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
    if path in ('/api/heartbeats', '/api/heartbeats/stream') and request.method == 'GET':
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
        log_audit_event(
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
        log_audit_event(
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
    log_audit_event(
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
    log_audit_event(
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
    payload = {
        'available': available,
        'collection': audit_collection(),
        'project_id': env_value('FIREBASE_PROJECT_ID'),
        'service_account_configured': service_account_configured(),
    }
    if not available:
        if not service_account_configured():
            payload['reason'] = 'service_account_missing'
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
        return jsonify({'detail': 'audit_unavailable', 'items': []}), 503

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
        limit = int(request.args.get('limit', '50'))
    except ValueError:
        limit = 50

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
        success=success,
        q=q,
        limit=limit,
        before_ms=before_ms,
    )
    if err:
        return jsonify({'detail': err, 'items': []}), 500

    next_before_ms = items[-1].get('ts_ms') if items and has_more else None
    return jsonify({
        'items': items,
        'has_more': has_more,
        'next_before_ms': next_before_ms,
        'collection': audit_collection(),
        'action_labels': ACTION_LABELS_PT,
        'device_labels': DEVICE_LABELS_PT,
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
    if target.is_file():
        return send_from_directory(FRONTEND, path)
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
