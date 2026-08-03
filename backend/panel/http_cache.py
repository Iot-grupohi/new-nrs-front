"""Helpers HTTP para ETag / 304 / Cache-Control (alinhados ao SWR do frontend)."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse, Response

from panel import cache_metrics


def weak_etag(*parts: Any) -> str:
    """Gera ETag fraco a partir de partes estáveis (versão, contagem, hashes)."""
    raw = "|".join("" if p is None else str(p) for p in parts)
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]
    return f'W/"{digest}"'


def payload_etag(payload: Any) -> str:
    """ETag fraco do corpo JSON (ordenado). Usar só em payloads pequenos/médios."""
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str, ensure_ascii=False)
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]
    return f'W/"{digest}"'


def etag_matches(if_none_match: str | None, etag: str) -> bool:
    if not if_none_match or not etag:
        return False
    candidates = [part.strip() for part in if_none_match.split(",") if part.strip()]
    if "*" in candidates:
        return True
    for cand in candidates:
        if cand.replace("W/", "") == etag.replace("W/", ""):
            return True
    return False


def not_modified(
    *,
    etag: str,
    cache_control: str,
    extra_headers: dict[str, str] | None = None,
) -> Response:
    headers = {
        "ETag": etag,
        "Cache-Control": cache_control,
        "Vary": "Cookie, Authorization",
    }
    if extra_headers:
        headers.update(extra_headers)
    return Response(status_code=304, headers=headers)


def conditional_json(
    request: Request,
    payload: Any,
    *,
    etag: str,
    cache_control: str,
    extra_headers: dict[str, str] | None = None,
    metric_name: str | None = None,
    latency_ms: float | None = None,
    memory_hit: bool | None = None,
) -> Response:
    """
    Retorna 304 Not Modified quando If-None-Match bate com o ETag;
    caso contrário, JSON com ETag + Cache-Control.
    """
    headers = {
        "ETag": etag,
        "Cache-Control": cache_control,
        "Vary": "Cookie, Authorization",
    }
    if extra_headers:
        headers.update(extra_headers)

    if etag_matches(request.headers.get("if-none-match"), etag):
        headers.setdefault("X-Cache", "HIT")
        if latency_ms is not None:
            headers["X-Response-Time-Ms"] = f"{latency_ms:.1f}"
        if metric_name:
            cache_metrics.record(
                metric_name,
                hit=True,
                not_modified=True,
                latency_ms=latency_ms,
            )
        return Response(status_code=304, headers=headers)

    if memory_hit is True:
        headers.setdefault("X-Cache", "HIT")
    elif memory_hit is False:
        headers.setdefault("X-Cache", "MISS")
    if latency_ms is not None:
        headers["X-Response-Time-Ms"] = f"{latency_ms:.1f}"
    if metric_name:
        cache_metrics.record(
            metric_name,
            hit=bool(memory_hit) if memory_hit is not None else False,
            latency_ms=latency_ms,
        )
    return JSONResponse(content=payload, headers=headers)
