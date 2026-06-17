"""Carregamento de .env compartilhado entre agente e painel."""
from __future__ import annotations

import os
import sys
from pathlib import Path

_LOADED_ENV_FILE: Path | None = None
_ENV_LOAD_DONE = False

BACKEND_DIR = Path(__file__).resolve().parent


def is_frozen() -> bool:
    return bool(getattr(sys, 'frozen', False))


def project_root() -> Path:
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return BACKEND_DIR.parent


PROJECT_ROOT = project_root()


def bundled_env_path() -> Path | None:
    """`.env` empacotado dentro do executavel (PyInstaller _MEIPASS)."""
    if not is_frozen():
        return None
    meipass = getattr(sys, '_MEIPASS', None)
    if not meipass:
        return None
    path = Path(meipass) / '.env'
    return path if path.is_file() else None


def env_file_candidates() -> list[Path]:
    """Ordem: embutido no .exe → pasta do .exe → projeto (dev) → %USERPROFILE%\\.lav60 → cwd."""
    candidates: list[Path] = []
    bundled = bundled_env_path()
    if bundled:
        candidates.append(bundled)
    if is_frozen():
        candidates.append(Path(sys.executable).resolve().parent / '.env')
    else:
        candidates.append(PROJECT_ROOT / '.env')
        candidates.append(BACKEND_DIR / '.env')
    candidates.append(Path.home() / '.lav60' / '.env')
    candidates.append(Path.cwd() / '.env')
    seen: set[str] = set()
    unique: list[Path] = []
    for path in candidates:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        unique.append(path)
    return unique


def load_local_env() -> Path | None:
    """Carrega .env (não sobrescreve variáveis já definidas no processo)."""
    global _LOADED_ENV_FILE, _ENV_LOAD_DONE
    if _ENV_LOAD_DONE:
        return _LOADED_ENV_FILE
    _ENV_LOAD_DONE = True
    try:
        from dotenv import load_dotenv
    except ImportError:
        return None
    for path in env_file_candidates():
        if path.is_file():
            load_dotenv(path, override=False)
            _LOADED_ENV_FILE = path
            return path
    return None


def env_value(name: str, default: str = '') -> str:
    """Variável do processo (inclui .env carregado)."""
    load_local_env()
    return (os.getenv(name) or default).strip()


def resolve_env_path(raw_path: str) -> Path | None:
    """Resolve caminho de arquivo relativo ao projeto, backend ou cwd."""
    raw = (raw_path or '').strip()
    if not raw:
        return None
    path = Path(raw)
    if path.is_file():
        return path.resolve()
    bases = [PROJECT_ROOT, BACKEND_DIR, Path.home() / '.lav60', Path.cwd()]
    bundled = bundled_env_path()
    if bundled:
        bases.insert(0, bundled.parent)
    if is_frozen():
        bases.insert(0, Path(sys.executable).resolve().parent)
    for base in bases:
        candidate = (base / raw).resolve()
        if candidate.is_file():
            return candidate
    return None
