"""Rotas do painel que não exigem X-Token do proxy unificado."""

from __future__ import annotations

PANEL_PREFIXES = (
    "/api/auth",
    "/api/panel",
    "/api/catalog",
    "/api/gateway",
    "/api/stores",
    "/api/reports",
    "/api/heartbeats",
    "/api/heartbeat",
    "/api/audit",
    "/api/infra",
    "/api/support",
    "/api/monitor",
)


def is_panel_path(path: str) -> bool:
    return any(
        path == prefix or path.startswith(f"{prefix}/")
        for prefix in PANEL_PREFIXES
    )


_STATIC_SUFFIXES = (
    ".js",
    ".css",
    ".svg",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".ico",
    ".woff",
    ".woff2",
    ".map",
    ".html",
)

_STATIC_EXACT = frozenset(
    {
        "/stores.json",
        "/config.js",
        "/panel-config.js",
    }
)


def is_frontend_static_path(path: str) -> bool:
    """Arquivos estáticos do painel (VPS: panel_server serve frontend na mesma origem)."""
    if path.startswith("/fac/") or path.startswith("/views/"):
        return True
    if path in _STATIC_EXACT:
        return True
    lower = path.lower()
    return any(lower.endswith(suffix) for suffix in _STATIC_SUFFIXES)
