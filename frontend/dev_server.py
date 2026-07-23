"""Servidor do frontend — arquivos estáticos + proxy /api → backend."""

from __future__ import annotations

import os
from pathlib import Path

import httpx
from dotenv import load_dotenv
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = Path(__file__).resolve().parent

load_dotenv(ROOT / ".env")

BACKEND_URL = os.getenv(
    "LAV60_BACKEND_URL",
    os.getenv("LAV60_SERVER_URL", "http://127.0.0.1:3100"),
).rstrip("/")
PORT = int(os.getenv("FRONTEND_PORT", "8080"))
HOST = os.getenv("FRONTEND_HOST", "127.0.0.1")

HOP_BY_HOP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
        "content-encoding",
        "content-length",
    }
)


async def proxy_to_backend(request: Request) -> Response:
    path = request.url.path
    if request.url.query:
        path = f"{path}?{request.url.query}"
    url = f"{BACKEND_URL}{path}"

    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in {"host", "content-length"}
    }

    body = await request.body()
    is_sse = path.startswith("/api/heartbeats/stream")

    if is_sse:
        return await _proxy_sse(request.method, url, headers, body)

    timeout = httpx.Timeout(120.0, connect=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            upstream = await client.request(
                request.method,
                url,
                headers=headers,
                content=body if body else None,
            )
        except httpx.RequestError as exc:
            return Response(
                content=f'{{"detail":"Backend indisponível ({BACKEND_URL}): {exc}"}}',
                status_code=502,
                media_type="application/json",
            )

    out_headers = {
        key: value
        for key, value in upstream.headers.items()
        if key.lower() not in HOP_BY_HOP
    }

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=out_headers,
        media_type=upstream.headers.get("content-type"),
    )


async def _proxy_sse(
    method: str,
    url: str,
    headers: dict[str, str],
    body: bytes,
) -> Response:
    from starlette.responses import StreamingResponse

    async def stream():
        timeout = httpx.Timeout(None, connect=10.0)
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream(
                    method,
                    url,
                    headers=headers,
                    content=body if body else None,
                ) as upstream:
                    async for chunk in upstream.aiter_bytes():
                        yield chunk
        except httpx.RequestError:
            yield b'data: {"type":"error","detail":"Backend indisponivel"}\n\n'

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


async def serve_icon_png_fallback(request: Request) -> Response:
    name = request.path_params.get("name", "").strip()
    if not name or "/" in name or "\\" in name:
        return Response(status_code=404)
    svg_path = FRONTEND_DIR / "fac" / "img" / "Icons" / f"{name}.svg"
    if svg_path.is_file():
        return FileResponse(svg_path, media_type="image/svg+xml")
    return Response(status_code=404)


def create_app() -> Starlette:
    return Starlette(
        routes=[
            Route(
                "/api",
                proxy_to_backend,
                methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
            ),
            Route(
                "/api/{path:path}",
                proxy_to_backend,
                methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
            ),
            Route("/fac/img/Icons/{name}.png", serve_icon_png_fallback, methods=["GET", "HEAD"]),
            Mount(
                "/",
                StaticFiles(directory=str(FRONTEND_DIR), html=True),
                name="frontend",
            ),
        ]
    )


app = create_app()

if __name__ == "__main__":
    import uvicorn

    print(f"Frontend: http://{HOST}:{PORT}")
    print(f"Backend (proxy /api): {BACKEND_URL}")
    uvicorn.run(app, host=HOST, port=PORT)
