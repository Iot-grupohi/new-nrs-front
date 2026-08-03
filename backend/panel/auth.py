"""Autenticação Firebase + sessão por cookie (opcional)."""

from __future__ import annotations

import base64
import json
import secrets
import time
from typing import Any

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response

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


def is_panel_auth_public(path: str) -> bool:
    """Rotas do painel que não exigem cookie de sessão."""
    if path.startswith("/api/auth/"):
        return True
    # Só indica se o token existe no servidor — sem vazar o segredo.
    if path == "/api/panel/bootstrap":
        return True
    return False


def require_panel_session(request: Request) -> None:
    """Exige sessão quando PANEL auth está habilitado."""
    if not auth_enabled():
        return
    if is_panel_auth_public(request.url.path):
        return
    if get_session_user(request) is None:
        raise HTTPException(401, "Login required")


def _cookie_secure(request: Request) -> bool:
    forwarded = str(request.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
    if forwarded == "https":
        return True
    return str(request.url.scheme).lower() == "https"


def _set_session_cookie(response: Response, session_id: str, request: Request) -> None:
    response.set_cookie(
        _SESSION_COOKIE,
        session_id,
        httponly=True,
        samesite="lax",
        secure=_cookie_secure(request),
        max_age=_SESSION_MAX_AGE,
        path="/",
    )


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


def _queue_auth_audit(
    background_tasks: BackgroundTasks,
    user: dict[str, Any] | None,
    body: dict[str, Any],
    request: Request,
) -> None:
    background_tasks.add_task(_log_auth_audit, user, body, request)


@router.get("/config")
async def auth_config() -> dict[str, Any]:
    firebase = _firebase_config()
    enabled = auth_enabled()
    verify_mode = "none"
    if enabled:
        from panel.firebase_client import service_account_path

        if _jwt_fallback_enabled():
            verify_mode = "jwt_local"
        elif service_account_path() or env_value("FIREBASE_API_KEY"):
            verify_mode = "firebase"
        elif env_value("PANEL_DEV_EMAIL"):
            verify_mode = "dev"
    return {
        "enabled": enabled,
        "firebase": firebase if enabled else None,
        "verify_mode": verify_mode,
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
async def auth_session(
    request: Request,
    response: Response,
    background_tasks: BackgroundTasks,
) -> dict[str, Any]:
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
            _queue_auth_audit(
                background_tasks,
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
    _set_session_cookie(response, session_id, request)
    _queue_auth_audit(
        background_tasks,
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


def _is_network_unavailable(exc: BaseException) -> bool:
    msg = str(exc).lower()
    needles = (
        "getaddrinfo",
        "name resolution",
        "11001",
        "failed to resolve",
        "max retries exceeded",
        "connection refused",
        "network is unreachable",
        "nodename nor servname",
        "name or service not known",
    )
    return any(n in msg for n in needles)


def _is_clock_skew_error(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return "too early" in msg or "clock" in msg


def _firebase_clock_skew_seconds() -> int:
    raw = env_value("FIREBASE_TOKEN_CLOCK_SKEW_SECONDS", "60")
    try:
        return max(0, min(300, int(raw or 60)))
    except (TypeError, ValueError):
        return 60


def _jwt_fallback_enabled() -> bool:
    return env_bool("PANEL_AUTH_OFFLINE") or env_bool("PANEL_AUTH_JWT_FALLBACK")


def _jwt_fallback_on_dns() -> bool:
    return env_bool("PANEL_AUTH_JWT_FALLBACK_ON_DNS", default=True)


def _decode_jwt_payload(id_token: str) -> dict[str, Any]:
    parts = str(id_token or "").strip().split(".")
    if len(parts) != 3:
        raise ValueError("JWT malformado")
    segment = parts[1]
    pad = "=" * (-len(segment) % 4)
    raw = base64.urlsafe_b64decode(segment + pad)
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError("JWT payload inválido")
    return data


def _verify_firebase_token_jwt_local(id_token: str) -> dict[str, str]:
    """Fallback sem chamar Google — exp/aud/iss (login já ocorreu no browser)."""
    try:
        payload = _decode_jwt_payload(id_token)
    except Exception as exc:
        raise HTTPException(401, "Token Firebase inválido") from exc

    skew = _firebase_clock_skew_seconds()
    now = time.time()

    iat = payload.get("iat")
    if isinstance(iat, (int, float)) and now + skew < float(iat):
        raise HTTPException(401, "Token Firebase inválido")

    nbf = payload.get("nbf")
    if isinstance(nbf, (int, float)) and now + skew < float(nbf):
        raise HTTPException(401, "Token Firebase inválido")

    exp = payload.get("exp")
    if isinstance(exp, (int, float)) and now - skew > float(exp):
        raise HTTPException(401, "Token Firebase expirado")

    iss = str(payload.get("iss") or "")
    if iss and "securetoken@system.gserviceaccount.com" not in iss:
        raise HTTPException(401, "Token Firebase inválido")

    project_id = env_value("FIREBASE_PROJECT_ID")
    aud = payload.get("aud")
    if project_id and aud and str(aud) != project_id:
        raise HTTPException(401, "Token Firebase inválido (projeto)")

    email = str(payload.get("email") or "").strip()
    if not email:
        raise HTTPException(401, "Token sem e-mail")

    if not payload.get("sub") and not payload.get("user_id"):
        raise HTTPException(401, "Token Firebase inválido")

    return {"email": email}


async def _verify_firebase_token(id_token: str) -> dict[str, str]:
    """Valida idToken Firebase — admin, REST ou JWT local (DNS/offline)."""
    import asyncio

    from panel.firebase_client import service_account_path

    if _jwt_fallback_enabled():
        return _verify_firebase_token_jwt_local(id_token)

    network_error: Exception | None = None

    if service_account_path():
        try:
            return await asyncio.to_thread(_verify_firebase_token_admin, id_token)
        except HTTPException:
            raise
        except Exception as exc:
            msg = str(exc).lower()
            if any(k in msg for k in ("expired", "invalid", "decode", "revoked", "segments")):
                raise HTTPException(401, "Token Firebase inválido ou expirado") from exc
            if _is_clock_skew_error(exc):
                return _verify_firebase_token_jwt_local(id_token)
            if _is_network_unavailable(exc):
                network_error = exc
            else:
                raise HTTPException(
                    502,
                    f"Firebase indisponível (verificação local): {exc}",
                ) from exc

    api_key = env_value("FIREBASE_API_KEY")
    if api_key and network_error is None:
        try:
            return await _verify_firebase_token_rest(id_token, api_key)
        except HTTPException as exc:
            if exc.status_code != 502:
                raise
            network_error = exc
        except httpx.RequestError as exc:
            network_error = exc

    if network_error and _jwt_fallback_on_dns():
        return _verify_firebase_token_jwt_local(id_token)

    if network_error:
        raise HTTPException(
            502,
            "Sem acesso a googleapis.com — defina PANEL_AUTH_OFFLINE=1 ou "
            "PANEL_AUTH_DISABLED=1 no .env (dev local)",
        ) from network_error

    email = env_value("PANEL_DEV_EMAIL")
    if email:
        return {"email": email}
    raise HTTPException(
        500,
        "Configure FIREBASE_SERVICE_ACCOUNT_FILE ou FIREBASE_API_KEY no .env",
    )


def _verify_firebase_token_admin(id_token: str) -> dict[str, str]:
    from firebase_admin import auth as firebase_auth

    from panel.firebase_client import _ensure_app

    _ensure_app()
    decoded = firebase_auth.verify_id_token(
        id_token,
        check_revoked=False,
        clock_skew_seconds=_firebase_clock_skew_seconds(),
    )
    email = str(decoded.get("email") or "").strip()
    if not email:
        raise ValueError("Usuário sem e-mail no token Firebase")
    return {"email": email}


async def _verify_firebase_token_rest(id_token: str, api_key: str) -> dict[str, str]:
    from panel import http_client

    url = f"https://identitytoolkit.googleapis.com/v1/accounts:lookup?key={api_key}"
    last_exc: Exception | None = None
    for attempt in range(2):
        try:
            res = await http_client.client().post(
                url, json={"idToken": id_token}, timeout=15.0
            )
            if res.status_code != 200:
                raise HTTPException(401, "Token Firebase inválido ou expirado")
            users = (res.json() or {}).get("users") or []
            if not users:
                raise HTTPException(401, "Token Firebase inválido ou expirado")
            email = str(users[0].get("email") or "").strip()
            if not email:
                raise HTTPException(401, "Usuário sem e-mail no Firebase")
            return {"email": email}
        except HTTPException:
            raise
        except httpx.RequestError as exc:
            last_exc = exc
            if attempt == 0:
                continue
            raise HTTPException(
                502,
                "Firebase indisponível — verifique internet/DNS e tente de novo",
            ) from exc
    raise HTTPException(502, f"Firebase indisponível: {last_exc}") from last_exc


@router.post("/touch")
async def auth_touch(request: Request) -> dict[str, str]:
    session_id = _read_session_id(request)
    if session_id and session_id in _sessions:
        _sessions[session_id]["touched_at"] = time.time()
    return {"status": "ok"}


@router.post("/logout")
async def auth_logout(
    request: Request,
    response: Response,
    background_tasks: BackgroundTasks,
) -> dict[str, str]:
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
        _queue_auth_audit(
            background_tasks,
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
