"""Ponto de entrada do backend — `python backend/main.py`."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = Path(__file__).resolve().parent
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from server.app import app  # noqa: E402

__all__ = ["app"]

if __name__ == "__main__":
    import os

    import uvicorn
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
    port = int(os.getenv("PORT", os.getenv("BACKEND_PORT", "3100")))
    uvicorn.run(
        "server.app:app",
        host=os.getenv("HOST", os.getenv("BACKEND_HOST", "127.0.0.1")),
        port=port,
        reload=os.getenv("RELOAD", "0") == "1",
    )
