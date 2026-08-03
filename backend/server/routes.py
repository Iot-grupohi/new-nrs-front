"""Mapa de rotas do servidor unificado Lav60."""

from __future__ import annotations

from typing import Any


def build_routes_map(
    *,
    server_url: str,
    portal_url: str,
    totem_url: str,
    gateway_url: str,
    powpay_domain: str,
    tokens: dict[str, bool],
) -> dict[str, Any]:
    base = server_url.rstrip("/")
    return {
        "service": "Lav60 Unified API Proxy",
        "server_url": base,
        "backends": {
            "portal": {
                "prefix": f"{base}/api/v1",
                "upstream": portal_url,
                "auth_header": "X-Token",
                "auth_env": "X_TOKEN ou LAV60_API_TOKEN",
                "configured": tokens.get("portal", False),
                "postman": "Lav60 Unified API → 1 — Portal",
            },
            "totem": {
                "prefix": f"{base}/totem",
                "upstream": totem_url,
                "auth_header": "X-Token (+ Authorization Bearer para cliente)",
                "auth_env": "X_TOKEN",
                "configured": tokens.get("totem", False),
                "postman": "Lav60 Unified API → 2 — Totem, 3 — OAuth",
            },
            "gateway": {
                "prefix": f"{base}/gateway",
                "upstream": gateway_url,
                "auth_header": "X-Token",
                "auth_env": "GATEWAY_API_TOKEN",
                "configured": tokens.get("gateway", False),
                "postman": "Lav60 Unified API → 4 — Gateway",
            },
            "powpay": {
                "prefix": f"{base}/powpay/{{loja}}",
                "upstream": f"https://{{loja}}.{powpay_domain}",
                "auth_header": "X-Token",
                "auth_env": "CLOUDFLARE_API_TOKEN",
                "configured": tokens.get("powpay", False),
                "postman": "Lav60 Unified API → 5 — Powpay",
                "example": f"{base}/powpay/pb05",
            },
        },
        "discovery": {
            "health": f"{base}/health",
            "routes": f"{base}/api/routes",
            "portal_meta": f"{base}/api/v1/upstream",
            "gateway_meta": f"{base}/api/v1/gateway",
            "powpay_meta": f"{base}/api/v1/powpay?store_code=pb05",
            "totem_meta": f"{base}/api/v1/totem",
        },
    }
