"""Backend LAV60 — painel, agente e utilitários compartilhados."""
import sys
from pathlib import Path

# Gunicorn importa backend.panel_server como pacote; garante imports locais (lav60_env, etc.).
_backend_dir = Path(__file__).resolve().parent
_path = str(_backend_dir)
if _path not in sys.path:
    sys.path.insert(0, _path)
