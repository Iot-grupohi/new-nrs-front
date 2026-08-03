"""Cliente httpx compartilhado (pool de conexões no lifespan)."""

from __future__ import annotations

import httpx

_client: httpx.AsyncClient | None = None

_DEFAULT_TIMEOUT = httpx.Timeout(60.0, connect=15.0)
_DEFAULT_LIMITS = httpx.Limits(max_connections=100, max_keepalive_connections=20)


async def startup() -> None:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=_DEFAULT_TIMEOUT,
            limits=_DEFAULT_LIMITS,
            follow_redirects=True,
        )


async def shutdown() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def client() -> httpx.AsyncClient:
    """Retorna o client compartilhado (lazy-init se o lifespan ainda não rodou)."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=_DEFAULT_TIMEOUT,
            limits=_DEFAULT_LIMITS,
            follow_redirects=True,
        )
    return _client
