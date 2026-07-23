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
