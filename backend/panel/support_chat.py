"""Assistente de suporte com IA (RAG sobre runbooks)."""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from typing import Any

import httpx

from panel.lav60_env import env_value

_MAX_HISTORY = 12
_MAX_CONTEXT_CHARS = 22000
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
        return (
            "Índice de runbooks carregado pelo painel. "
            "Consulte equipamentos (maquineta, lavadoras, noteiro, totem, ar-condicionado), "
            "SAC (pagamento, roupas, cupom, cadastro, nota fiscal) e localização de lojas (mapa por região)."
        )
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
        "Use os runbooks abaixo como fonte principal. Eles cobrem equipamentos, SAC, pagamentos e localização de lojas.\n"
        "Priorize runbooks com maior relação com a pergunta, mas você pode combinar informações de mais de um.\n"
        "Para localização de lojas: use o runbook de mapa/regiões, identifique a UF do código (ex.: PB05 = Paraíba/Nordeste) "
        "e oriente abrir o Mapa de lojas no painel Suporte ou a ficha da loja no menu Lojas.\n"
        "Para erros de lavadoras/secadoras: cite os códigos DE1, OE, UE, FE, LE e IE quando aplicável.\n"
        "Não invente comandos, caminhos ou procedimentos que não estejam nos runbooks.\n"
        "Se algo específico não estiver nos runbooks, diga o que falta e oriente escalar ou consultar o mapa/cadastro.\n"
        "Quando fizer sentido, use passos numerados curtos.\n"
        "Não mencione que você é uma IA.\n\n"
        "Runbooks disponíveis:\n\n"
        f"{context_block}"
    )


def _build_sources(context: list[dict[str, Any]] | None, *, limit: int = 6) -> list[dict[str, str]]:
    rows = list(context or [])
    rows.sort(key=lambda item: int(item.get("score") or 0), reverse=True)
    sources: list[dict[str, str]] = []
    for item in rows:
        category_id = str(item.get("category_id") or "").strip()
        procedure_id = str(item.get("procedure_id") or "").strip()
        title = str(item.get("title") or "").strip()
        if not category_id or not procedure_id:
            continue
        key = f"{category_id}:{procedure_id}"
        if any(s.get("category_id") == category_id and s.get("procedure_id") == procedure_id for s in sources):
            continue
        sources.append(
            {
                "category_id": category_id,
                "procedure_id": procedure_id,
                "title": title,
                "category_title": str(item.get("category_title") or "").strip(),
            }
        )
        if len(sources) >= limit:
            break
    return sources


def _prepare_chat_request(
    *,
    message: str,
    history: list[Any] | None,
    context: list[dict[str, Any]] | None,
) -> tuple[str, list[dict[str, str]], str]:
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
    return model, messages, api_key


def _sse_event(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def run_support_chat(
    *,
    message: str,
    history: list[Any] | None = None,
    context: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    model, messages, api_key = _prepare_chat_request(
        message=message,
        history=history,
        context=context,
    )

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

    return {
        "reply": reply or "Não foi possível gerar uma resposta.",
        "model": model,
        "sources": _build_sources(context),
    }


async def iter_support_chat_stream(
    *,
    message: str,
    history: list[Any] | None = None,
    context: list[dict[str, Any]] | None = None,
) -> AsyncIterator[str]:
    model, messages, api_key = _prepare_chat_request(
        message=message,
        history=history,
        context=context,
    )
    sources = _build_sources(context)

    yield _sse_event({"type": "start", "model": model})

    reply_parts: list[str] = []
    try:
        async with httpx.AsyncClient(timeout=90.0) as client:
            async with client.stream(
                "POST",
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model,
                    "temperature": 0.25,
                    "max_tokens": 1200,
                    "stream": True,
                    "messages": messages,
                },
            ) as response:
                if response.status_code >= 400:
                    detail = (await response.aread())[:400].decode("utf-8", errors="replace")
                    try:
                        payload = json.loads(detail)
                        detail = str(payload.get("error", {}).get("message") or detail)
                    except Exception:
                        pass
                    yield _sse_event({"type": "error", "message": detail or "Erro ao consultar OpenAI"})
                    return

                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:].strip()
                    if not data or data == "[DONE]":
                        continue
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = str((choices[0].get("delta") or {}).get("content") or "")
                    if not delta:
                        continue
                    reply_parts.append(delta)
                    yield _sse_event({"type": "token", "content": delta})
    except httpx.HTTPError as exc:
        yield _sse_event({"type": "error", "message": f"Falha de rede: {exc}"})
        return

    reply = "".join(reply_parts).strip() or "Não foi possível gerar uma resposta."
    yield _sse_event(
        {
            "type": "done",
            "reply": reply,
            "model": model,
            "sources": sources,
        }
    )
