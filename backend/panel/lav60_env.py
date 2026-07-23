"""Utilitários de ambiente compartilhados pelo painel."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent.parent
FRONTEND_DIR = ROOT / "frontend"
DATA_DIR = Path(__file__).resolve().parent / "data"

_env_loaded = False


def load_local_env() -> None:
    global _env_loaded
    if not _env_loaded:
        load_dotenv(ROOT / ".env")
        _env_loaded = True


def env_value(key: str, default: str = "") -> str:
    load_local_env()
    return (os.getenv(key) or default).strip()


def env_bool(key: str, default: bool = False) -> bool:
    raw = env_value(key).lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def read_json_file(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default
