"""Produção (VPS) — frontend estático + API FastAPI.

Compatível com:
  gunicorn -w 1 --worker-class uvicorn.workers.UvicornWorker \\
    -b 127.0.0.1:3000 backend.panel_server:app
"""

from __future__ import annotations

import sys
from pathlib import Path
from urllib.parse import urlencode

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse

BACKEND = Path(__file__).resolve().parent
ROOT = BACKEND.parent
FRONTEND = ROOT / "frontend"

_HTML_NO_CACHE = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
}

LOGIN_HTML_VERSION = "3"

if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from server.app import app  # noqa: E402


def _drop_api_root_route() -> None:
    """Em produção o `/` serve o painel HTML, não o JSON de discovery da API."""
    kept = []
    for route in app.router.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", None) or set()
        if path == "/" and "GET" in methods:
            continue
        kept.append(route)
    app.router.routes = kept


_drop_api_root_route()


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


def _file_response(path: Path) -> FileResponse:
    headers = _HTML_NO_CACHE if path.suffix.lower() == ".html" else None
    return FileResponse(path, headers=headers)


@app.get("/")
async def serve_index() -> FileResponse:
    return _file_response(FRONTEND / "index.html")


@app.get("/login.html")
async def serve_login_html(request: Request) -> FileResponse | RedirectResponse:
    if request.query_params.get("v") != LOGIN_HTML_VERSION:
        params = dict(request.query_params)
        params["v"] = LOGIN_HTML_VERSION
        return RedirectResponse(
            url=f"/login.html?{urlencode(params)}",
            status_code=302,
            headers=_HTML_NO_CACHE,
        )
    return _file_response(FRONTEND / "login.html")


@app.get("/{path:path}")
async def serve_frontend(path: str) -> FileResponse:
    if path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found")
    file_path = _frontend_file(path)
    if file_path:
        return _file_response(file_path)
    if path.endswith(".html"):
        html = _frontend_file(path)
        if html:
            return _file_response(html)
    return _file_response(FRONTEND / "index.html")


__all__ = ["app"]
