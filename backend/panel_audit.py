"""Auditoria de operações do painel — Cloud Firestore."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from flask import Request

from lav60_env import env_value
from panel_auth import firebase_init_error, init_firebase_admin, service_account_configured

_MAX_FIELD_LEN = 4000
_MAX_RESPONSE_KEYS = 24

_DEVICE_PATH_RE = re.compile(
    r'/(washer|dryer|doser|ac)(?:/([^/?#]+))?',
    re.IGNORECASE,
)

ACTION_LABELS_PT: dict[str, str] = {
    'auth_login': 'Login no painel',
    'auth_logout': 'Logout do painel',
    'auth_login_failed': 'Tentativa de login recusada',
    'washer_release': 'Liberou lavadora',
    'washer_unlock': 'Reativou botões da lavadora',
    'dryer_release': 'Liberou secadora',
    'dryer_unlock': 'Reativou botões da secadora',
    'doser_command': 'Comando na dosadora',
    'doser_consult': 'Consulta na dosadora',
    'doser_settime': 'Ajuste de tempo na dosadora',
    'ac_control': 'Comando no ar-condicionado',
    'operation': 'Operação',
    'test_write': 'Teste de gravação',
}

DEVICE_LABELS_PT: dict[str, str] = {
    'washer': 'lavadora',
    'dryer': 'secadora',
    'doser': 'dosadora',
    'ac': 'ar-condicionado',
}

_AUTH_ACTIONS = frozenset({'auth_login', 'auth_logout', 'auth_login_failed'})


def audit_collection() -> str:
    name = (
        env_value('FIREBASE_AUDIT_COLLECTION')
        or env_value('FIREBASE_AUDIT_ROOT')
        or 'audit_logs'
    ).strip().strip('/')
    return name or 'audit_logs'


def audit_root_path() -> str:
    """Alias mantido para compatibilidade com bootstrap/API."""
    return audit_collection()


def audit_logging_available() -> bool:
    return bool(service_account_configured() and init_firebase_admin())


def audit_unavailable_payload() -> dict[str, Any]:
    reason = 'service_account_missing'
    hint = (
        'Copie o JSON da service account para o VPS e defina '
        'FIREBASE_SERVICE_ACCOUNT_FILE com caminho absoluto no .env'
    )
    if not service_account_configured():
        env_path = (env_value('FIREBASE_SERVICE_ACCOUNT_FILE') or '').strip()
        if env_path:
            hint = (
                f'Arquivo não encontrado: {env_path}. '
                'Use caminho absoluto no Linux (ex.: /root/lav60-panel/service-account.json).'
            )
    elif firebase_init_error():
        reason = firebase_init_error() or 'firestore_unavailable'
        hint = f'Firebase Admin não iniciou: {reason}'
    return {
        'available': False,
        'detail': 'audit_unavailable',
        'reason': reason,
        'hint': hint,
        'collection': audit_collection(),
    }


def _truncate(value: Any, limit: int = _MAX_FIELD_LEN) -> Any:
    if value is None:
        return None
    if isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value if len(value) <= limit else value[: limit - 1] + '…'
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for idx, (key, item) in enumerate(value.items()):
            if idx >= _MAX_RESPONSE_KEYS:
                out['_truncated'] = True
                break
            out[str(key)[:80]] = _truncate(item, limit)
        return out
    if isinstance(value, list):
        return [_truncate(item, limit) for item in value[: _MAX_RESPONSE_KEYS]]
    text = str(value)
    return text if len(text) <= limit else text[: limit - 1] + '…'


def sanitize_audit_payload(data: Any) -> Any:
    if not isinstance(data, dict):
        return _truncate(data)
    blocked = {'token', 'idtoken', 'password', 'api_token', 'x-token', 'authorization'}
    clean: dict[str, Any] = {}
    for key, value in data.items():
        if str(key).lower() in blocked:
            continue
        clean[str(key)] = _truncate(value)
    return clean


def _strip_none_fields(data: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in data.items() if value is not None}


def operator_display_name(user: dict[str, Any] | None) -> str:
    email = str((user or {}).get('email') or '').strip()
    if email:
        local = email.split('@', 1)[0].strip()
        if local:
            return local.replace('.', ' ').replace('_', ' ').title()
        return email
    return 'Operador desconhecido'


def infer_device_from_path(path: str | None) -> tuple[str | None, str | None]:
    text = str(path or '').strip()
    if not text:
        return None, None
    match = _DEVICE_PATH_RE.search(text)
    if not match:
        return None, None
    device_type = match.group(1).lower()
    device_id = match.group(2)
    if device_type == 'ac':
        device_id = device_id or '110'
    return device_type, device_id or None


def resolve_device_fields(body: dict[str, Any]) -> tuple[str | None, str | None]:
    meta = body.get('meta') if isinstance(body.get('meta'), dict) else {}
    device_type = str(body.get('device_type') or meta.get('device_type') or '').strip().lower() or None
    device_id = str(body.get('device_id') or meta.get('device_id') or '').strip() or None
    if device_type and device_id:
        return device_type, device_id
    path_type, path_id = infer_device_from_path(body.get('path'))
    return device_type or path_type, device_id or path_id


def build_operation_summary(
    *,
    operator_name: str,
    action: str,
    label: str | None,
    store: str | None,
    device_type: str | None,
    device_id: str | None,
    payload: Any,
    success: bool,
) -> str:
    verb = ACTION_LABELS_PT.get(action, label or action or 'Operação')
    parts = [operator_name, verb]

    if device_id:
        dtype_label = DEVICE_LABELS_PT.get(device_type or '', device_type or 'equipamento')
        parts.append(f'{dtype_label} {device_id}')

    if isinstance(payload, dict):
        minutes = payload.get('minutes')
        if minutes is not None:
            parts.append(f'{minutes} min')
        am = payload.get('am')
        if am:
            parts.append(f'dosagem {am}')
        temperature = payload.get('temperature')
        if temperature is not None:
            parts.append(f'temp {temperature}')
        cmd_type = payload.get('type')
        if cmd_type:
            parts.append(str(cmd_type))
        seconds = payload.get('seconds')
        if seconds is not None:
            parts.append(f'{seconds}s')

    if store:
        parts.append(store.upper())

    summary = ' · '.join(str(p) for p in parts if p)
    if not success:
        summary = f'{summary} · falhou' if summary else 'Operação falhou'
    return summary[:480]


def build_audit_record(
    user: dict[str, Any] | None,
    body: dict[str, Any],
    req: Request | None = None,
    *,
    client_ip: str | None = None,
    user_agent: str | None = None,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    store = str(body.get('store') or '').strip().lower()
    action = str(body.get('action') or 'operation').strip()[:120] or 'operation'
    label = _truncate(body.get('label') or '', 240) or None
    success = bool(body.get('success'))
    payload = sanitize_audit_payload(body.get('payload'))
    device_type, device_id = resolve_device_fields(body)
    operator_name = operator_display_name(user)
    operator_email = (user or {}).get('email') or None

    record: dict[str, Any] = {
        'ts': now.isoformat(),
        'ts_ms': int(now.timestamp() * 1000),
        'source': 'lav60_panel',
        'page': _truncate(body.get('page') or '', 40) or None,
        'store': store or None,
        'action': action,
        'label': label,
        'operation_summary': build_operation_summary(
            operator_name=operator_name,
            action=action,
            label=label,
            store=store or None,
            device_type=device_type,
            device_id=device_id,
            payload=payload,
            success=success,
        ),
        'operator_name': operator_name,
        'operator_email': operator_email,
        'device_type': device_type,
        'device_id': device_id,
        'method': str(body.get('method') or '').strip().upper()[:12] or None,
        'path': _truncate(body.get('path') or '', 240) or None,
        'success': success,
        'payload': payload,
        'response': sanitize_audit_payload(body.get('response')),
        'error': _truncate(body.get('error') or '', 800) or None,
        'meta': sanitize_audit_payload(body.get('meta')) if isinstance(body.get('meta'), dict) else None,
        'user_uid': (user or {}).get('uid') or None,
        'user_email': operator_email,
    }
    if req:
        record['client_ip'] = (req.headers.get('X-Forwarded-For') or req.remote_addr or '').split(',')[0].strip()
        record['user_agent'] = _truncate(req.headers.get('User-Agent') or '', 400)
    else:
        if client_ip:
            record['client_ip'] = client_ip
        if user_agent:
            record['user_agent'] = _truncate(user_agent, 400)
    return _strip_none_fields(record)


def _request_client_meta(req: Request | None) -> tuple[str | None, str | None]:
    if not req:
        return None, None
    ip = (req.headers.get('X-Forwarded-For') or req.remote_addr or '').split(',')[0].strip()
    ua = _truncate(req.headers.get('User-Agent') or '', 400)
    return ip or None, ua or None


def log_audit_event(
    user: dict[str, Any] | None,
    body: dict[str, Any],
    req: Request | None = None,
    *,
    client_ip: str | None = None,
    user_agent: str | None = None,
) -> tuple[bool, str | None]:
    """Grava evento no Firestore. Retorna (ok, erro)."""
    if not audit_logging_available():
        return False, 'audit_unavailable'
    record = build_audit_record(
        user,
        body,
        req,
        client_ip=client_ip,
        user_agent=user_agent,
    )
    try:
        from firebase_admin import firestore

        firestore.client().collection(audit_collection()).add(record)
        return True, None
    except Exception as exc:
        return False, str(exc)[:400]


def log_audit_event_async(
    user: dict[str, Any] | None,
    body: dict[str, Any],
    req: Request | None = None,
) -> None:
    """Grava auditoria em background — não bloqueia resposta HTTP (login/logout)."""
    if not audit_logging_available():
        return

    import threading

    client_ip, user_agent = _request_client_meta(req)
    user_snapshot = dict(user) if isinstance(user, dict) else user
    body_snapshot = dict(body)

    def _worker() -> None:
        log_audit_event(
            user_snapshot,
            body_snapshot,
            client_ip=client_ip,
            user_agent=user_agent,
        )

    threading.Thread(target=_worker, daemon=True).start()


def _serialize_audit_doc(doc_id: str, data: dict[str, Any]) -> dict[str, Any]:
    row = dict(data)
    row['id'] = doc_id
    return row


def _aggregate_operators_by_scan(
    coll: Any,
    *,
    store_key: str,
    action_key: str,
    success: bool | None,
    query_text: str,
) -> tuple[dict[str, dict[str, Any]], bool]:
    from firebase_admin import firestore

    query = coll.order_by('ts_ms', direction=firestore.Query.DESCENDING)
    if store_key:
        query = query.where('store', '==', store_key)

    counts: dict[str, dict[str, Any]] = {}
    scanned = 0
    truncated = False
    last_doc = None
    batch_size = 500

    while scanned < _MAX_COUNT_SCAN:
        batch = query.limit(batch_size)
        if last_doc is not None:
            batch = batch.start_after(last_doc)
        docs = list(batch.stream())
        if not docs:
            break
        for doc in docs:
            scanned += 1
            data = doc.to_dict() or {}
            if not _audit_row_matches(
                data,
                action_key=action_key,
                operator_key='',
                success=success,
                query_text=query_text,
            ):
                continue
            email = str(data.get('operator_email') or data.get('user_email') or '').strip().lower()
            if not email:
                email = '__unknown__'
            row = counts.get(email)
            if not row:
                name = str(data.get('operator_name') or email).strip()
                if email == '__unknown__':
                    name = 'Operador desconhecido'
                counts[email] = {'email': email, 'name': name, 'count': 0}
            counts[email]['count'] += 1
        if len(docs) < batch_size:
            break
        last_doc = docs[-1]
        if scanned >= _MAX_COUNT_SCAN:
            truncated = True
            break

    return counts, truncated


def list_audit_operator_stats(
    *,
    store: str | None = None,
    action: str | None = None,
    success: bool | None = None,
    q: str | None = None,
    limit: int = 5,
) -> tuple[list[dict[str, Any]], bool, str | None]:
    """Ranking de operadores por volume de registros (respeita filtros exceto operador)."""
    if not audit_logging_available():
        return [], False, 'audit_unavailable'

    store_key = str(store or '').strip().lower()
    action_key = str(action or '').strip()
    query_text = str(q or '').strip().lower()
    top_n = min(max(int(limit or 5), 1), 20)

    try:
        from firebase_admin import firestore

        coll = firestore.client().collection(audit_collection())
        counts, truncated = _aggregate_operators_by_scan(
            coll,
            store_key=store_key,
            action_key=action_key,
            success=success,
            query_text=query_text,
        )
        ranked = sorted(
            counts.values(),
            key=lambda row: (-int(row['count']), row['name'].lower()),
        )
        for row in ranked:
            if row['email'] == '__unknown__':
                row['email'] = ''
        return ranked[:top_n], truncated, None
    except Exception as exc:
        return [], False, str(exc)[:400]


def audit_dashboard_summary(
    *,
    hours: int = 24,
) -> tuple[dict[str, Any], bool, str | None]:
    """Resumo operacional das últimas N horas (exclui login/logout)."""
    if not audit_logging_available():
        return {}, False, 'audit_unavailable'

    window_hours = min(max(int(hours or 24), 1), 168)
    since_ms = int(datetime.now(timezone.utc).timestamp() * 1000) - window_hours * 3600 * 1000

    try:
        from firebase_admin import firestore

        coll = firestore.client().collection(audit_collection())
        query = (
            coll.where('ts_ms', '>=', since_ms)
            .order_by('ts_ms', direction=firestore.Query.DESCENDING)
        )

        total = 0
        success_count = 0
        failed_count = 0
        operators: dict[str, dict[str, Any]] = {}
        stores: dict[str, int] = {}
        scanned = 0
        truncated = False

        for doc in query.stream():
            scanned += 1
            if scanned > _MAX_COUNT_SCAN:
                truncated = True
                break
            data = doc.to_dict() or {}
            action = str(data.get('action') or '')
            if action in _AUTH_ACTIONS:
                continue

            total += 1
            if bool(data.get('success')):
                success_count += 1
            else:
                failed_count += 1

            email = str(data.get('operator_email') or data.get('user_email') or '').strip().lower()
            if email:
                row = operators.get(email)
                if not row:
                    operators[email] = {
                        'email': email,
                        'name': str(data.get('operator_name') or email).strip(),
                        'count': 0,
                    }
                operators[email]['count'] += 1

            store_key = str(data.get('store') or '').strip().lower()
            if store_key:
                stores[store_key] = stores.get(store_key, 0) + 1

        top_operator = None
        if operators:
            top_operator = max(
                operators.values(),
                key=lambda row: (-int(row['count']), row['name'].lower()),
            )

        top_store = None
        if stores:
            store_id = max(stores, key=lambda key: stores[key])
            top_store = {'store': store_id, 'count': stores[store_id]}

        success_rate = round((success_count / total) * 100) if total else None

        return {
            'hours': window_hours,
            'since_ms': since_ms,
            'total': total,
            'success': success_count,
            'failed': failed_count,
            'success_rate': success_rate,
            'top_operator': top_operator,
            'top_store': top_store,
        }, truncated, None
    except Exception as exc:
        return {}, False, str(exc)[:400]


def list_audit_operators(limit_scan: int = 400) -> tuple[list[dict[str, str]], str | None]:
    """Operadores distintos nos registros mais recentes (para filtro do painel)."""
    if not audit_logging_available():
        return [], 'audit_unavailable'

    try:
        from firebase_admin import firestore

        query = (
            firestore.client()
            .collection(audit_collection())
            .order_by('ts_ms', direction=firestore.Query.DESCENDING)
            .limit(min(max(int(limit_scan), 50), 800))
        )
        seen: dict[str, dict[str, str]] = {}
        for doc in query.stream():
            data = doc.to_dict() or {}
            email = str(data.get('operator_email') or data.get('user_email') or '').strip().lower()
            if not email or email in seen:
                continue
            seen[email] = {
                'email': email,
                'name': str(data.get('operator_name') or email).strip(),
            }
        operators = sorted(seen.values(), key=lambda row: row['name'].lower())
        return operators, None
    except Exception as exc:
        return [], str(exc)[:400]


def _audit_row_matches(
    data: dict[str, Any],
    *,
    action_key: str,
    operator_key: str,
    success: bool | None,
    query_text: str,
) -> bool:
    if action_key and data.get('action') != action_key:
        return False
    if operator_key:
        row_email = str(data.get('operator_email') or data.get('user_email') or '').strip().lower()
        if row_email != operator_key:
            return False
    if success is not None and bool(data.get('success')) != success:
        return False
    if query_text:
        haystack = ' '.join(
            str(data.get(key) or '')
            for key in (
                'operation_summary',
                'label',
                'operator_name',
                'operator_email',
                'device_id',
                'action',
                'store',
            )
        ).lower()
        if query_text not in haystack:
            return False
    return True


_MAX_COUNT_SCAN = 10000


def _count_audit_by_scan(
    coll: Any,
    *,
    store_key: str,
    action_key: str,
    operator_key: str,
    success: bool | None,
    query_text: str,
) -> tuple[int, bool]:
    from firebase_admin import firestore

    query = coll.order_by('ts_ms', direction=firestore.Query.DESCENDING)
    if store_key:
        query = query.where('store', '==', store_key)

    total = 0
    scanned = 0
    truncated = False
    last_doc = None
    batch_size = 500

    while scanned < _MAX_COUNT_SCAN:
        batch = query.limit(batch_size)
        if last_doc is not None:
            batch = batch.start_after(last_doc)
        docs = list(batch.stream())
        if not docs:
            break
        for doc in docs:
            scanned += 1
            data = doc.to_dict() or {}
            if _audit_row_matches(
                data,
                action_key=action_key,
                operator_key=operator_key,
                success=success,
                query_text=query_text,
            ):
                total += 1
        if len(docs) < batch_size:
            break
        last_doc = docs[-1]
        if scanned >= _MAX_COUNT_SCAN:
            truncated = True
            break

    return total, truncated


def count_audit_events(
    *,
    store: str | None = None,
    action: str | None = None,
    operator: str | None = None,
    success: bool | None = None,
    q: str | None = None,
) -> tuple[int | None, bool, str | None]:
    """Conta registros que batem com os filtros. truncated=True se atingiu limite de varredura."""
    if not audit_logging_available():
        return None, False, 'audit_unavailable'

    store_key = str(store or '').strip().lower()
    action_key = str(action or '').strip()
    operator_key = str(operator or '').strip().lower()
    query_text = str(q or '').strip().lower()
    needs_scan = bool(action_key or success is not None or query_text or operator_key)

    try:
        from firebase_admin import firestore

        coll = firestore.client().collection(audit_collection())

        if not needs_scan:
            try:
                query = coll
                if store_key:
                    query = coll.where('store', '==', store_key)
                result = query.count().get()
                total = int(result[0][0].value)
                return total, False, None
            except Exception:
                total, truncated = _count_audit_by_scan(
                    coll,
                    store_key=store_key,
                    action_key='',
                    operator_key='',
                    success=None,
                    query_text='',
                )
                return total, truncated, None

        total, truncated = _count_audit_by_scan(
            coll,
            store_key=store_key,
            action_key=action_key,
            operator_key=operator_key,
            success=success,
            query_text=query_text,
        )
        return total, truncated, None
    except Exception as exc:
        return None, False, str(exc)[:400]


def list_audit_events(
    *,
    store: str | None = None,
    action: str | None = None,
    operator: str | None = None,
    success: bool | None = None,
    q: str | None = None,
    limit: int = 50,
    before_ms: int | None = None,
) -> tuple[list[dict[str, Any]], bool, str | None]:
    """Lista eventos do Firestore (mais recentes primeiro)."""
    if not audit_logging_available():
        return [], False, 'audit_unavailable'

    page_size = min(max(int(limit or 50), 1), 100)
    needs_scan = bool(action or success is not None or q or operator)
    fetch_size = min(page_size * 4, 400) if needs_scan else page_size + 1

    store_key = str(store or '').strip().lower()
    action_key = str(action or '').strip()
    operator_key = str(operator or '').strip().lower()
    query_text = str(q or '').strip().lower()

    try:
        from firebase_admin import firestore

        query = (
            firestore.client()
            .collection(audit_collection())
            .order_by('ts_ms', direction=firestore.Query.DESCENDING)
        )
        if store_key:
            query = query.where('store', '==', store_key)
        if before_ms is not None:
            query = query.where('ts_ms', '<', int(before_ms))
        query = query.limit(fetch_size)

        matched: list[dict[str, Any]] = []
        raw_read = 0
        for doc in query.stream():
            raw_read += 1
            data = doc.to_dict() or {}
            if not _audit_row_matches(
                data,
                action_key=action_key,
                operator_key=operator_key,
                success=success,
                query_text=query_text,
            ):
                continue
            matched.append(_serialize_audit_doc(doc.id, data))
            if len(matched) > page_size:
                return matched[:page_size], True, None

        if len(matched) >= page_size and raw_read >= fetch_size:
            return matched[:page_size], True, None
        return matched, False, None
    except Exception as exc:
        return [], False, str(exc)[:400]
