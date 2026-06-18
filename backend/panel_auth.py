"""Autenticação Firebase para o painel LAV60."""
from __future__ import annotations

from typing import Any

import requests

from lav60_env import env_value, resolve_env_path

_firebase_admin_ready = False
_firebase_init_error: str | None = None


def firebase_public_config() -> dict[str, str] | None:
    api_key = env_value('FIREBASE_API_KEY')
    project_id = env_value('FIREBASE_PROJECT_ID')
    if not api_key or not project_id:
        return None
    return {
        'apiKey': api_key,
        'authDomain': env_value('FIREBASE_AUTH_DOMAIN'),
        'databaseURL': env_value('FIREBASE_DATABASE_URL'),
        'projectId': project_id,
        'storageBucket': env_value('FIREBASE_STORAGE_BUCKET'),
        'messagingSenderId': env_value('FIREBASE_MESSAGING_SENDER_ID'),
        'appId': env_value('FIREBASE_APP_ID'),
    }


def firebase_auth_enabled() -> bool:
    flag = env_value('PANEL_AUTH_DISABLED').lower()
    if flag in ('1', 'true', 'yes', 'on'):
        return False
    return firebase_public_config() is not None


def service_account_path() -> str:
    resolved = resolve_env_path(env_value('FIREBASE_SERVICE_ACCOUNT_FILE'))
    return str(resolved) if resolved else ''


def service_account_configured() -> bool:
    return bool(service_account_path())


def firebase_init_error() -> str | None:
    return _firebase_init_error


def auth_verify_mode() -> str:
    if service_account_configured():
        return 'service_account'
    if env_value('FIREBASE_API_KEY'):
        return 'api_key'
    return 'none'


def init_firebase_admin() -> bool:
    global _firebase_admin_ready, _firebase_init_error
    if _firebase_admin_ready:
        return True
    if not service_account_configured():
        _firebase_init_error = 'service_account_missing'
        return False
    try:
        import firebase_admin
        from firebase_admin import credentials

        service_file = service_account_path()
        if not firebase_admin._apps:
            firebase_admin.initialize_app(credentials.Certificate(service_file))
        _firebase_admin_ready = True
        _firebase_init_error = None
        return True
    except Exception as exc:
        _firebase_init_error = str(exc)[:240]
        return False


def _verify_with_service_account(token: str) -> tuple[dict[str, Any] | None, str | None]:
    if not init_firebase_admin():
        return None, firebase_init_error() or 'service_account_unavailable'
    try:
        from firebase_admin import auth

        decoded = auth.verify_id_token(token, check_revoked=False)
        return {
            'uid': decoded.get('uid') or decoded.get('sub'),
            'email': decoded.get('email') or '',
        }, None
    except Exception as exc:
        return None, f'{type(exc).__name__}: {str(exc)[:180]}'


def _verify_with_api_key(token: str) -> tuple[dict[str, Any] | None, str | None]:
    api_key = env_value('FIREBASE_API_KEY')
    if not api_key:
        return None, 'FIREBASE_API_KEY ausente'
    try:
        response = requests.post(
            'https://identitytoolkit.googleapis.com/v1/accounts:lookup',
            params={'key': api_key},
            json={'idToken': token},
            timeout=12,
        )
        if response.status_code >= 400:
            message = ''
            try:
                message = str(response.json().get('error', {}).get('message') or '')
            except Exception:
                message = ''
            return None, message or f'Identity Toolkit HTTP {response.status_code}'
        payload = response.json()
        users = payload.get('users') or []
        if not users:
            return None, 'Usuário não encontrado para este token'
        user = users[0]
        uid = user.get('localId') or user.get('uid') or ''
        if not uid:
            return None, 'Resposta Identity Toolkit sem UID'
        return {
            'uid': uid,
            'email': user.get('email') or '',
        }, None
    except Exception as exc:
        return None, f'{type(exc).__name__}: {str(exc)[:180]}'


def verify_firebase_id_token(id_token: str) -> tuple[dict[str, Any] | None, str | None]:
    """Retorna (usuário, erro). Tenta service account e depois API key."""
    token = (id_token or '').strip()
    if not token:
        return None, 'Token ausente'

    errors: list[str] = []

    if service_account_configured():
        user, err = _verify_with_service_account(token)
        if user:
            return user, None
        return None, err or 'Token inválido ou expirado'

    user, err = _verify_with_api_key(token)
    if user:
        return user, None
    if err:
        errors.append(err)

    if errors:
        return None, errors[-1]
    return None, 'Token inválido ou expirado'
