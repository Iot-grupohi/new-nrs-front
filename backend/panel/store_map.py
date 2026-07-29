"""Coordenadas aproximadas das lojas para o mapa do dashboard."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

STATE_CENTROIDS: dict[str, tuple[float, float]] = {
    "AC": (-9.9749, -67.8243),
    "AL": (-9.6658, -35.735),
    "AP": (0.0349, -51.0694),
    "AM": (-3.119, -60.0217),
    "BA": (-12.9777, -38.5016),
    "CE": (-3.7319, -38.5267),
    "DF": (-15.7939, -47.8828),
    "ES": (-20.3155, -40.3128),
    "GO": (-16.6869, -49.2648),
    "MA": (-2.5387, -44.2825),
    "MT": (-15.601, -56.0974),
    "MS": (-20.4697, -54.6201),
    "MG": (-19.9167, -43.9345),
    "PA": (-1.4558, -48.5039),
    "PB": (-7.1195, -34.845),
    "PR": (-25.4284, -51.1676),
    "PE": (-8.0476, -34.877),
    "PI": (-5.0892, -42.8019),
    "RJ": (-22.9068, -43.1729),
    "RN": (-5.7945, -35.211),
    "RS": (-30.0346, -51.2177),
    "RO": (-8.7612, -63.9039),
    "RR": (2.8235, -60.6758),
    "SC": (-27.5954, -48.548),
    "SP": (-23.5505, -46.6333),
    "SE": (-10.9472, -37.0731),
    "TO": (-10.184, -48.3336),
}

CAPITAL_CITIES: dict[str, tuple[float, float]] = {
    "rio branco|ac": STATE_CENTROIDS["AC"],
    "maceio|al": STATE_CENTROIDS["AL"],
    "macapa|ap": STATE_CENTROIDS["AP"],
    "manaus|am": STATE_CENTROIDS["AM"],
    "salvador|ba": STATE_CENTROIDS["BA"],
    "fortaleza|ce": STATE_CENTROIDS["CE"],
    "brasilia|df": STATE_CENTROIDS["DF"],
    "vitoria|es": STATE_CENTROIDS["ES"],
    "goiania|go": STATE_CENTROIDS["GO"],
    "sao luis|ma": STATE_CENTROIDS["MA"],
    "cuiaba|mt": STATE_CENTROIDS["MT"],
    "campo grande|ms": STATE_CENTROIDS["MS"],
    "belo horizonte|mg": STATE_CENTROIDS["MG"],
    "belem|pa": STATE_CENTROIDS["PA"],
    "joao pessoa|pb": STATE_CENTROIDS["PB"],
    "curitiba|pr": STATE_CENTROIDS["PR"],
    "recife|pe": STATE_CENTROIDS["PE"],
    "teresina|pi": STATE_CENTROIDS["PI"],
    "rio de janeiro|rj": STATE_CENTROIDS["RJ"],
    "natal|rn": STATE_CENTROIDS["RN"],
    "porto alegre|rs": STATE_CENTROIDS["RS"],
    "porto velho|ro": STATE_CENTROIDS["RO"],
    "boa vista|rr": STATE_CENTROIDS["RR"],
    "florianopolis|sc": STATE_CENTROIDS["SC"],
    "sao paulo|sp": STATE_CENTROIDS["SP"],
    "aracaju|se": STATE_CENTROIDS["SE"],
    "palmas|to": STATE_CENTROIDS["TO"],
}


def _normalize_text(value: str) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = re.sub(r"\s+", " ", text.strip().lower())
    return text


def _normalize_uf(value: str) -> str:
    uf = str(value or "").strip().upper()
    if len(uf) == 2 and uf in STATE_CENTROIDS:
        return uf
    match = re.search(r"\b([A-Z]{2})\b", str(value or "").upper())
    if match and match.group(1) in STATE_CENTROIDS:
        return match.group(1)
    return ""


def _infer_uf(store_id: str, row: dict[str, Any]) -> str:
    for key in ("state", "cnpj_uf"):
        uf = _normalize_uf(str(row.get(key) or ""))
        if uf:
            return uf

    address = str(row.get("address") or row.get("cnpj_address") or "")
    parts = [part.strip() for part in re.split(r"[,\-—/|]", address) if part.strip()]
    for part in reversed(parts[-3:]):
        uf = _normalize_uf(part)
        if uf:
            return uf

    prefix = str(store_id or "").strip().upper()[:2]
    if prefix in STATE_CENTROIDS:
        return prefix
    return ""


def _city_name(row: dict[str, Any]) -> str:
    for key in ("city", "cnpj_municipio", "neighborhood"):
        value = str(row.get(key) or "").strip()
        if value:
            return value
    address = str(row.get("address") or "")
    match = re.search(r",\s*([^,]+),\s*([A-Z]{2})\b", address)
    if match:
        return match.group(1).strip()
    return ""


def _coords_for_store(store_id: str, uf: str, city: str) -> tuple[float, float]:
    city_key = f"{_normalize_text(city)}|{uf.lower()}" if city and uf else ""
    if city_key and city_key in CAPITAL_CITIES:
        lat, lng = CAPITAL_CITIES[city_key]
    elif uf in STATE_CENTROIDS:
        lat, lng = STATE_CENTROIDS[uf]
    else:
        lat, lng = (-14.235, -51.9253)

    digest = abs(hash(f"{store_id}|{city_key}|{uf}"))
    lat += ((digest % 200) - 100) / 900.0
    lng += (((digest // 200) % 200) - 100) / 900.0
    return round(lat, 6), round(lng, 6)


def build_map_locations(
    catalog_stores: list[dict[str, Any]],
    details_by_id: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    details = details_by_id or {}
    rows: list[dict[str, Any]] = []

    for meta in catalog_stores:
        sid = str(meta.get("id") or "").strip().lower()
        if not sid:
            continue
        detail = details.get(sid) or {}
        uf = _infer_uf(sid, detail)
        city = _city_name(detail)
        lat, lng = _coords_for_store(sid, uf, city)
        rows.append(
            {
                "id": sid,
                "name": str(meta.get("name") or sid.upper()).strip() or sid.upper(),
                "lat": lat,
                "lng": lng,
                "city": city,
                "state": uf,
            }
        )

    rows.sort(key=lambda item: item["id"])
    return rows
