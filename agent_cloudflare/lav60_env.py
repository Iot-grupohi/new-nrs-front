"""Carrega .env embarcado no executável (ou ao lado do agente em dev)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

_env_loaded = False
_tls_configured = False

# Identidade da loja vem do registro Windows — nunca do arquivo .env.
ENV_FILE_IGNORE_KEYS = frozenset({'STORE_ID', 'TUNNEL_NAME'})


def _agent_root() -> Path:
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def _bundled_env_path() -> Path | None:
    meipass = getattr(sys, '_MEIPASS', None)
    if not meipass:
        return None
    for name in ('.env', 'bundled.env'):
        candidate = Path(meipass) / name
        if candidate.is_file():
            return candidate
    return None


def _read_env_file(path: Path) -> None:
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        key = key.strip().lstrip('\ufeff')
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ and key not in ENV_FILE_IGNORE_KEYS:
            os.environ[key] = value


def _resolve_ca_bundle_path() -> Path | None:
    meipass = getattr(sys, '_MEIPASS', None)
    if meipass:
        for rel in ('certifi/cacert.pem', 'cacert.pem'):
            candidate = Path(meipass) / rel
            if candidate.is_file():
                return candidate
    root = _agent_root()
    for candidate in (
        root / '_internal' / 'certifi' / 'cacert.pem',
        root / 'certifi' / 'cacert.pem',
    ):
        if candidate.is_file():
            return candidate
    try:
        import certifi

        path = Path(certifi.where())
        if path.is_file():
            return path
    except ImportError:
        pass
    return None


def configure_frozen_tls() -> Path | None:
    """PyInstaller: aponta requests/urllib3/grpc para o cacert.pem embarcado."""
    global _tls_configured
    if _tls_configured:
        return _resolve_ca_bundle_path()
    _tls_configured = True
    if not getattr(sys, 'frozen', False):
        return None
    ca = _resolve_ca_bundle_path()
    if not ca:
        return None
    ca_str = str(ca)
    os.environ['SSL_CERT_FILE'] = ca_str
    os.environ['REQUESTS_CA_BUNDLE'] = ca_str
    os.environ['CURL_CA_BUNDLE'] = ca_str
    return ca


def load_local_env() -> Path | None:
    global _env_loaded
    if _env_loaded:
        bundled = _bundled_env_path()
        if bundled:
            return bundled
        external = _agent_root() / '.env'
        return external if external.is_file() else None

    loaded: Path | None = None
    candidates: list[Path] = []
    if getattr(sys, 'frozen', False):
        bundled = _bundled_env_path()
        if bundled:
            candidates.append(bundled)
    candidates.append(_agent_root() / '.env')

    for path in candidates:
        if not path.is_file():
            continue
        try:
            _read_env_file(path)
            loaded = path
            break
        except OSError:
            continue

    _env_loaded = True
    return loaded


def env_file_path() -> Path:
    bundled = _bundled_env_path()
    if bundled:
        return bundled
    return _agent_root() / '.env'
