"""Testes dos helpers ETag / 304."""

from __future__ import annotations

import sys
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from panel.http_cache import (  # noqa: E402
    conditional_json,
    etag_matches,
    payload_etag,
    weak_etag,
)


def test_weak_etag_stable():
    assert weak_etag("a", 1, True) == weak_etag("a", 1, True)
    assert weak_etag("a", 1) != weak_etag("a", 2)


def test_etag_matches_weak_and_strong():
    tag = weak_etag("x", 1)
    assert etag_matches(tag, tag)
    assert etag_matches(tag.replace("W/", ""), tag)
    assert etag_matches(f"{tag}, other", tag)
    assert not etag_matches('W/"other"', tag)


def test_conditional_json_304_and_200():
    app = FastAPI()
    payload = {"ok": True, "n": 1}
    etag = payload_etag(payload)

    @app.get("/item")
    async def item(request: Request):
        return conditional_json(
            request,
            payload,
            etag=etag,
            cache_control="private, max-age=60",
        )

    client = TestClient(app)
    first = client.get("/item")
    assert first.status_code == 200
    assert first.headers["ETag"] == etag
    assert first.json() == payload

    second = client.get("/item", headers={"If-None-Match": etag})
    assert second.status_code == 304
    assert second.headers["ETag"] == etag
    assert second.content == b""
