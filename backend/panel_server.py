"""Produção (VPS) — frontend estático + API FastAPI.

Compatível com:
  gunicorn -w 1 --worker-class uvicorn.workers.UvicornWorker \\
    -b 127.0.0.1:3000 backend.panel_server:app
"""

from __future__ import annotations

import sys
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse

BACKEND = Path(__file__).resolve().parent
ROOT = BACKEND.parent
FRONTEND = ROOT / "frontend"

if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from server.app import app  # noqa: E402


def _frontend_file(rel: str) -> Path | None:
    rel = rel.replace("\\", "/").lstrip("/")
    if not rel or rel.endswith("/"):
        return None
    if ".." in rel.split("/"):
        return None
    target = (FRONTEND / rel).resolve()
    try:
        target.relative_to(FRONTEND.resolve())
    except ValueError:
        return None
    return target if target.is_file() else None


@app.get("/fac/img/Icons/{name}.png")
async def serve_icon_png(name: str) -> FileResponse:
    if not name or "/" in name or "\\" in name:
        raise HTTPException(status_code=404)
    svg = FRONTEND / "fac" / "img" / "Icons" / f"{name}.svg"
    if svg.is_file():
        return FileResponse(svg, media_type="image/svg+xml")
    raise HTTPException(status_code=404)


@app.get("/")
async def serve_index() -> FileResponse:
    return FileResponse(FRONTEND / "index.html")


@app.get("/{path:path}")
async def serve_frontend(path: str) -> FileResponse:
    if path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found")
    file_path = _frontend_file(path)
    if file_path:
        return FileResponse(file_path)
    if path.endswith(".html"):
        html = _frontend_file(path)
        if html:
            return FileResponse(html)
    return FileResponse(FRONTEND / "index.html")


__all__ = ["app"]
