"""Base de conhecimento / suporte customizável."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from panel.auth import auth_enabled, get_session_user
from panel.support_chat import chat_status, run_support_chat

router = APIRouter(prefix="/api/support", tags=["panel-support"])

_custom_store: dict[str, Any] = {"categories": [], "procedures": []}


@router.get("/chat/status")
async def support_chat_status() -> dict[str, Any]:
    return chat_status()


@router.post("/chat")
async def support_chat(request: Request) -> dict[str, Any]:
    user = get_session_user(request)
    if auth_enabled() and not user:
        raise HTTPException(401, "Login required")

    if not chat_status().get("available"):
        raise HTTPException(503, "Assistente IA indisponível. Configure OPENAI_API_KEY no servidor.")

    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(400, "JSON inválido") from exc
    if not isinstance(body, dict):
        raise HTTPException(400, "JSON inválido")

    message = str(body.get("message") or "").strip()
    history = body.get("history") if isinstance(body.get("history"), list) else []
    context = body.get("context") if isinstance(body.get("context"), list) else []

    try:
        return await run_support_chat(message=message, history=history, context=context)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc


@router.get("/custom")
async def support_custom() -> dict[str, Any]:
    return {
        "store": _custom_store,
        "meta": {"category_ids": [], "procedure_keys": []},
        "can_edit": False,
        "persistence": {"firestore": False},
    }


@router.post("/categories")
async def create_category(body: dict[str, Any]) -> dict[str, Any]:
    raise HTTPException(403, "Edição desabilitada neste ambiente")


@router.put("/categories/{category_id}")
async def update_category(category_id: str, body: dict[str, Any]) -> dict[str, Any]:
    raise HTTPException(403, "Edição desabilitada neste ambiente")


@router.delete("/categories/{category_id}")
async def delete_category(category_id: str) -> dict[str, str]:
    raise HTTPException(403, "Edição desabilitada neste ambiente")


@router.post("/procedures")
async def create_procedure(body: dict[str, Any]) -> dict[str, Any]:
    raise HTTPException(403, "Edição desabilitada neste ambiente")


@router.put("/procedures/{category_id}/{procedure_id}")
async def update_procedure(category_id: str, procedure_id: str, body: dict[str, Any]) -> dict[str, Any]:
    raise HTTPException(403, "Edição desabilitada neste ambiente")


@router.delete("/procedures/{category_id}/{procedure_id}")
async def delete_procedure(category_id: str, procedure_id: str) -> dict[str, str]:
    raise HTTPException(403, "Edição desabilitada neste ambiente")
