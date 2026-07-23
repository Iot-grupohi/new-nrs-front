"""Compatibilidade — prefira `python backend/main.py`."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from server.app import app  # noqa: E402

__all__ = ["app"]

if __name__ == "__main__":
    import runpy

    runpy.run_path(str(BACKEND / "main.py"), run_name="__main__")
