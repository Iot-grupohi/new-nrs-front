"""Autenticação Firebase + sessão por cookie (opcional)."""

from __future__ import annotations

import json
import secrets
import time
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request, Response

from panel.lav60_env import env_bool, env_value

router = APIRouter(prefix="/api/auth", tags=["panel-auth"])

_sessions: dict[str, dict[str, Any]] = {}
_SESSION_COOKIE = "lav60_session"
_SESSION_MAX_AGE = 30 * 24 * 3600


def _firebase_config() -> dict[str, Any] | None:
    raw = env_value("FIREBASE_WEB_CONFIG_JSON")
    if raw:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass
    api_key = env_value("FIREBASE_API_KEY")
    project_id = env_value("FIREBASE_PROJECT_ID")
    if not api_key or not project_id:
        return None
    return {
        "apiKey": api_key,
        "authDomain": env_value("FIREBASE_AUTH_DOMAIN") or f"{project_id}.firebaseapp.com",
        "projectId": project_id,
        "storageBucket": env_value("FIREBASE_STORAGE_BUCKET") or f"{project_id}.appspot.com",
        "messagingSenderId": env_value("FIREBASE_MESSAGING_SENDER_ID"),
        "appId": env_value("FIREBASE_APP_ID"),
    }


def auth_enabled() -> bool:
    if env_bool("PANEL_AUTH_DISABLED"):
        return False
    if env_bool("PANEL_AUTH_ENABLED"):
        return _firebase_config() is not None
    return _firebase_config() is not None


def _session_idle_seconds() -> int:
    minutes = int(env_value("PANEL_SESSION_IDLE_MINUTES", "30") or "30")
    return max(60, minutes * 60)


def _read_session_id(request: Request) -> str | None:
    return request.cookies.get(_SESSION_COOKIE)


def _session_user(session_id: str | None) -> dict[str, Any] | None:
    if not session_id:
        return None
    row = _sessions.get(session_id)
    if not row:
        return None
    idle_limit = _session_idle_seconds()
    if time.time() - row.get("touched_at", 0) > idle_limit:
        _sessions.pop(session_id, None)
        return None
    return row.get("user")


def get_session_user(request: Request) -> dict[str, Any] | None:
    session_id = _read_session_id(request)
    user = _session_user(session_id)
    if session_id and session_id in _sessions and user:
        _sessions[session_id]["touched_at"] = time.time()
    return user


def _log_auth_audit(user: dict[str, Any] | None, body: dict[str, Any], request: Request) -> None:
    try:
        from panel import audit_store

        if not audit_store.audit_status().get("available"):
            return
        client_ip = (request.headers.get("X-Forwarded-For") or request.client.host or "").split(",")[0].strip()
        user_agent = (request.headers.get("User-Agent") or "")[:400]
        audit_store.write_log(
            body,
            user=user,
            client_ip=client_ip or None,
            user_agent=user_agent or None,
        )
    except Exception:
        pass


@router.get("/config")
async def auth_config() -> dict[str, Any]:
    firebase = _firebase_config()
    enabled = auth_enabled()
    return {
        "enabled": enabled,
        "firebase": firebase if enabled else None,
        "session_idle_minutes": int(env_value("PANEL_SESSION_IDLE_MINUTES", "30") or "30"),
    }


@router.get("/me")
async def auth_me(request: Request) -> dict[str, Any]:
    if not auth_enabled():
        return {"authenticated": True, "auth_disabled": True, "user": None}
    user = _session_user(_read_session_id(request))
    if not user:
        return {"authenticated": False, "user": None}
    return {"authenticated": True, "user": user}


@router.post("/session")
async def auth_session(request: Request, response: Response) -> dict[str, Any]:
    if not auth_enabled():
        return {"user": None, "auth_disabled": True}
    body = await request.json()
    id_token = str(body.get("idToken") or "").strip()
    if not id_token:
        raise HTTPException(400, "idToken obrigatório")

    try:
        user = await _verify_firebase_token(id_token)
    except HTTPException as exc:
        if exc.status_code == 401:
            _log_auth_audit(
                None,
                {
                    "action": "auth_login_failed",
                    "label": "Tentativa de login recusada",
                    "success": False,
                    "page": "login",
                    "error": str(exc.detail),
                },
                request,
            )
        raise
    session_id = secrets.token_urlsafe(32)
    now = time.time()
    _sessions[session_id] = {"user": user, "created_at": now, "touched_at": now}
    response.set_cookie(
        _SESSION_COOKIE,
        session_id,
        httponly=True,
        samesite="lax",
        max_age=_SESSION_MAX_AGE,
        path="/",
    )
    _log_auth_audit(
        user,
        {
            "action": "auth_login",
            "label": f"Login · {user.get('email', '')}",
            "success": True,
            "page": "login",
        },
        request,
    )
    return {"user": user}


async def _verify_firebase_token(id_token: str) -> dict[str, str]:
    api_key = env_value("FIREBASE_API_KEY")
    if api_key:
        url = f"https://identitytoolkit.googleapis.com/v1/accounts:lookup?key={api_key}"
        async with httpx.AsyncClient(timeout=15.0) as client:
            try:
                res = await client.post(url, json={"idToken": id_token})
            except httpx.RequestError as exc:
                raise HTTPException(502, f"Firebase indisponível: {exc}") from exc
        if res.status_code != 200:
            raise HTTPException(401, "Token Firebase inválido ou expirado")
        users = (res.json() or {}).get("users") or []
        if not users:
            raise HTTPException(401, "Token Firebase inválido ou expirado")
        email = str(users[0].get("email") or "").strip()
        if not email:
            raise HTTPException(401, "Usuário sem e-mail no Firebase")
        return {"email": email}

    email = env_value("PANEL_DEV_EMAIL")
    if email:
        return {"email": email}
    raise HTTPException(
        500,
        "Configure FIREBASE_API_KEY no .env para validar login",
    )


@router.post("/touch")
async def auth_touch(request: Request) -> dict[str, str]:
    session_id = _read_session_id(request)
    if session_id and session_id in _sessions:
        _sessions[session_id]["touched_at"] = time.time()
    return {"status": "ok"}


@router.post("/logout")
async def auth_logout(request: Request, response: Response) -> dict[str, str]:
    session_id = _read_session_id(request)
    user = _session_user(session_id)
    body: dict[str, Any] = {}
    try:
        body = await request.json()
    except Exception:
        body = {}
    if session_id:
        _sessions.pop(session_id, None)
    response.delete_cookie(_SESSION_COOKIE, path="/")
    email = (user or {}).get("email") or str(body.get("email") or "").strip()
    if email or user:
        _log_auth_audit(
            user or {"email": email},
            {
                "action": "auth_logout",
                "label": f"Logout · {email}" if email else "Logout do painel",
                "success": True,
                "page": "panel",
            },
            request,
        )
    return {"status": "ok"}
