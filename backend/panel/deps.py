"""Dependências injetadas pelo servidor principal."""

from __future__ import annotations

from typing import Any, Awaitable, Callable

UpstreamGet = Callable[[str, dict | None], Awaitable[Any]]

upstream_get: UpstreamGet | None = None
gateway_url: str = ""
gateway_token: str = ""
powpay_domain: str = "powpay.com.br"
agent_token: str = ""


def configure(
    *,
    upstream_get_fn: UpstreamGet,
    gateway_url_value: str,
    gateway_token_value: str,
    powpay_domain_value: str,
    agent_token_value: str,
) -> None:
    global upstream_get, gateway_url, gateway_token, powpay_domain, agent_token
    upstream_get = upstream_get_fn
    gateway_url = gateway_url_value
    gateway_token = gateway_token_value
    powpay_domain = powpay_domain_value
    agent_token = agent_token_value
