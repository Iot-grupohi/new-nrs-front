"""Raiz do app em desenvolvimento e no executável PyInstaller."""

from __future__ import annotations

import sys
from pathlib import Path


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def app_root() -> Path:
    """Pasta do .exe (ou raiz do repositório) — .env, JSON Firebase, data/."""
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent.parent


def bundle_root() -> Path:
    """Recursos embarcados (frontend, deploy) dentro do bundle PyInstaller."""
    if is_frozen():
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass)
        return app_root()
    return app_root()


def backend_dir() -> Path:
    if is_frozen():
        candidate = bundle_root() / "backend"
        if candidate.is_dir():
            return candidate
        return app_root() / "backend"
    return Path(__file__).resolve().parent.parent


def data_dir() -> Path:
    if is_frozen():
        path = app_root() / "data"
    else:
        path = Path(__file__).resolve().parent / "data"
    path.mkdir(parents=True, exist_ok=True)
    return path
