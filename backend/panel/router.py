"""Monta e registra todas as rotas do painel no FastAPI."""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from fastapi import FastAPI

from panel import audit, auth, catalog, gateway, heartbeats, infra, monitor, reports, stores, support
from panel.deps import configure

UpstreamGet = Callable[[str, dict | None], Awaitable[Any]]


def mount_panel(
    app: FastAPI,
    *,
    upstream_get: UpstreamGet,
    gateway_url: str,
    gateway_token: str,
    powpay_domain: str,
    agent_token: str,
) -> None:
    configure(
        upstream_get_fn=upstream_get,
        gateway_url_value=gateway_url,
        gateway_token_value=gateway_token,
        powpay_domain_value=powpay_domain,
        agent_token_value=agent_token,
    )

    app.include_router(auth.router)
    app.include_router(catalog.router)
    app.include_router(heartbeats.router)
    app.include_router(audit.router)
    app.include_router(infra.router)
    app.include_router(support.router)
    app.include_router(monitor.router)
    reports.register_reports(upstream_get)
    app.include_router(reports.router)
    gateway.register_gateway(gateway_url=gateway_url, gateway_token=gateway_token)
    app.include_router(gateway.router)
    stores.register_stores(
        powpay_domain=powpay_domain,
        agent_token=agent_token,
        gateway_url=gateway_url,
        gateway_token=gateway_token,
    )
    app.include_router(stores.router)
