"""Assistente de suporte com IA (RAG sobre runbooks)."""

from __future__ import annotations

import re
from typing import Any

import httpx

from panel.lav60_env import env_value

_MAX_HISTORY = 12
_MAX_CONTEXT_CHARS = 14000
_MAX_MESSAGE_CHARS = 4000


def _strip_html(text: str) -> str:
    plain = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", plain).strip()


def chat_configured() -> bool:
    return bool(env_value("OPENAI_API_KEY"))


def chat_status() -> dict[str, Any]:
    model = env_value("OPENAI_MODEL") or "gpt-4o-mini"
    return {
        "available": chat_configured(),
        "model": model,
    }


def _build_context_block(context: list[dict[str, Any]]) -> str:
    chunks: list[str] = []
    used = 0
    for item in context:
        category = str(item.get("category_title") or item.get("category_id") or "").strip()
        title = str(item.get("title") or "").strip()
        body = _strip_html(str(item.get("body") or ""))
        if not title and not body:
            continue
        block = f"[{category}] {title}\n{body}".strip()
        if used + len(block) + 8 > _MAX_CONTEXT_CHARS:
            remaining = _MAX_CONTEXT_CHARS - used - 8
            if remaining > 120:
                chunks.append(block[:remaining] + "…")
            break
        chunks.append(block)
        used += len(block) + 8
    if not chunks:
        return "Nenhum runbook relevante foi encontrado para esta pergunta."
    return "\n\n---\n\n".join(chunks)


def _normalize_history(history: list[Any]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for item in history[-_MAX_HISTORY :]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip().lower()
        content = str(item.get("content") or "").strip()
        if role not in {"user", "assistant"} or not content:
            continue
        rows.append({"role": role, "content": content[:_MAX_MESSAGE_CHARS]})
    return rows


def _system_prompt(context_block: str) -> str:
    return (
        "Você é o assistente de suporte operacional da Lavanderia 60 Minutos (LAV60).\n"
        "Responda em português do Brasil, de forma clara e objetiva para operadores do painel central.\n"
        "Use APENAS as informações dos runbooks abaixo. Não invente comandos, caminhos ou procedimentos.\n"
        "Se a resposta não estiver nos runbooks, diga claramente que não encontrou e oriente a buscar "
        "outro procedimento na base ou escalar para o time técnico.\n"
        "Quando fizer sentido, use passos numerados curtos.\n"
        "Não mencione que você é uma IA.\n\n"
        "Runbooks relevantes:\n\n"
        f"{context_block}"
    )


async def run_support_chat(
    *,
    message: str,
    history: list[Any] | None = None,
    context: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    api_key = env_value("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY não configurada no servidor")

    text = str(message or "").strip()
    if not text:
        raise ValueError("Mensagem vazia")
    if len(text) > _MAX_MESSAGE_CHARS:
        raise ValueError("Mensagem muito longa")

    model = env_value("OPENAI_MODEL") or "gpt-4o-mini"
    context_block = _build_context_block(list(context or []))
    messages: list[dict[str, str]] = [{"role": "system", "content": _system_prompt(context_block)}]
    messages.extend(_normalize_history(history or []))
    messages.append({"role": "user", "content": text})

    async with httpx.AsyncClient(timeout=90.0) as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "temperature": 0.25,
                "max_tokens": 1200,
                "messages": messages,
            },
        )

    if response.status_code >= 400:
        detail = response.text[:400]
        try:
            payload = response.json()
            detail = str(payload.get("error", {}).get("message") or detail)
        except Exception:
            pass
        raise RuntimeError(detail or "Erro ao consultar OpenAI")

    payload = response.json()
    choices = payload.get("choices") or []
    reply = ""
    if choices:
        reply = str((choices[0].get("message") or {}).get("content") or "").strip()

    sources = []
    for item in context or []:
        category_id = str(item.get("category_id") or "").strip()
        procedure_id = str(item.get("procedure_id") or "").strip()
        title = str(item.get("title") or "").strip()
        if not category_id or not procedure_id:
            continue
        sources.append(
            {
                "category_id": category_id,
                "procedure_id": procedure_id,
                "title": title,
                "category_title": str(item.get("category_title") or "").strip(),
            }
        )

    return {
        "reply": reply or "Não foi possível gerar uma resposta.",
        "model": model,
        "sources": sources,
    }
