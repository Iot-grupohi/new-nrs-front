"""DigitalOcean — registry de VPS/databases e métricas."""

from __future__ import annotations

import asyncio
import base64
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from panel.lav60_env import DATA_DIR, env_value, read_json_file

DO_API_BASE = "https://api.digitalocean.com/v2"
METRICS_INTERVAL_SEC = 300
DB_POLL_INTERVAL_SEC = 60
REGISTRY_PATH = DATA_DIR / "infra_registry.json"
DEPLOY_REGISTRY_PATH = Path(__file__).resolve().parent.parent / "deploy" / "infra_registry.json"
_DB_HISTORY_PATH = DATA_DIR / "db_metrics_history.json"
_VPS_STORE_PATH = DATA_DIR / "vps_metrics_store.json"
_DB_STORE_PATH = DATA_DIR / "db_metrics_store.json"
_CATALOG_STORE_PATH = DATA_DIR / "infra_catalog_store.json"
_INFRA_STORE_REFRESH_SEC = 300
_INFRA_POLL_WINDOWS = (3600, 21600, 86400)
_metrics_cache: dict[str, dict[str, Any]] = {}
CACHE_TTL_SEC = 120
DB_CACHE_TTL_SEC = 300
DB_HISTORY_STALE_SEC = 300
DB_CLUSTER_CACHE_TTL_SEC = 600
DB_CREDENTIALS_CACHE_TTL_SEC = 3600
DB_SCRAPE_TIMEOUT_SEC = 5.0

_db_cluster_cache: dict[str, dict[str, Any]] = {}
_db_credentials_cache: dict[str, Any] = {"data": None, "expires_at": 0.0}
_db_refresh_in_flight: set[str] = set()
_db_entry_refresh_in_flight: set[str] = set()
_vps_refresh_in_flight: set[str] = set()
_db_poller_task: asyncio.Task | None = None
_DB_HISTORY_MAX_SEC = 1209600

_DB_ENGINES = ("mysql", "postgresql", "redis", "kafka", "mongodb", "opensearch")


def infra_configured() -> bool:
    return bool(do_token() or db_token())


def do_token() -> str:
    return env_value("DIGITALOCEAN_TOKEN")


def db_token() -> str:
    return env_value("DIGITALOCEAN_DB_TOKEN") or do_token()


def _default_registry() -> dict[str, list[str]]:
    return {"host_ids": [], "db_ids": []}


def _ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _window_store_key(window: int) -> str:
    return str(max(300, int(window)))


def _load_metrics_store(path: Path) -> dict[str, dict[str, dict[str, Any]]]:
    data = read_json_file(path, {}) or {}
    if not isinstance(data, dict):
        return {}
    return {
        str(item_id): {
            str(win): row
            for win, row in (windows or {}).items()
            if isinstance(row, dict)
        }
        for item_id, windows in data.items()
        if isinstance(windows, dict)
    }


def _save_metrics_store(path: Path, data: dict[str, Any]) -> None:
    _ensure_data_dir()
    path.write_text(json.dumps(data), encoding="utf-8")


def _get_persisted_entry(path: Path, item_id: str, window: int) -> dict[str, Any] | None:
    bucket = _load_metrics_store(path).get(str(item_id)) or {}
    row = bucket.get(_window_store_key(window))
    if not isinstance(row, dict):
        return None
    entry = row.get("entry")
    if not isinstance(entry, dict):
        return None
    return {"saved_at": int(row.get("saved_at") or 0), "entry": entry}


def _sanitize_entry_for_store(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in entry.items()
        if key not in {"from_store", "stored_at", "from_cache"}
    }


def _persist_entry(path: Path, item_id: str, window: int, entry: dict[str, Any]) -> None:
    data = _load_metrics_store(path)
    bucket = dict(data.get(str(item_id)) or {})
    bucket[_window_store_key(window)] = {
        "saved_at": int(time.time()),
        "entry": _sanitize_entry_for_store(entry),
    }
    data[str(item_id)] = bucket
    _save_metrics_store(path, data)


def _stored_entry_response(entry: dict[str, Any], saved_at: int) -> dict[str, Any]:
    payload = dict(entry)
    payload["from_store"] = True
    payload["stored_at"] = datetime.fromtimestamp(saved_at, tz=timezone.utc).isoformat()
    return payload


def _load_catalog_store() -> dict[str, Any]:
    data = read_json_file(_CATALOG_STORE_PATH, {}) or {}
    if not isinstance(data, dict):
        return {"vps": [], "databases": [], "updated_at": 0}
    return {
        "vps": data.get("vps") if isinstance(data.get("vps"), list) else [],
        "databases": data.get("databases") if isinstance(data.get("databases"), list) else [],
        "updated_at": int(data.get("updated_at") or 0),
    }


def _save_catalog_store(vps: list[dict[str, Any]], databases: list[dict[str, Any]]) -> None:
    _ensure_data_dir()
    _CATALOG_STORE_PATH.write_text(
        json.dumps({
            "vps": vps,
            "databases": databases,
            "updated_at": int(time.time()),
        }),
        encoding="utf-8",
    )


def _read_stored_registry() -> dict[str, list[str]]:
    data = read_json_file(REGISTRY_PATH, _default_registry()) or _default_registry()
    return {
        "host_ids": [str(x).strip() for x in data.get("host_ids") or [] if str(x).strip()],
        "db_ids": [str(x).strip() for x in data.get("db_ids") or [] if str(x).strip()],
    }


def _env_id_list(key: str) -> list[str]:
    raw = env_value(key)
    if not raw:
        return []
    return [part.strip() for part in raw.replace(";", ",").split(",") if part.strip()]


def _bootstrap_registry_if_empty(stored: dict[str, list[str]]) -> dict[str, list[str]]:
    if stored["host_ids"] or stored["db_ids"]:
        return stored
    if not DEPLOY_REGISTRY_PATH.is_file():
        return stored
    data = read_json_file(DEPLOY_REGISTRY_PATH, _default_registry()) or _default_registry()
    payload = {
        "host_ids": [str(x).strip() for x in data.get("host_ids") or [] if str(x).strip()],
        "db_ids": [str(x).strip() for x in data.get("db_ids") or [] if str(x).strip()],
    }
    if payload["host_ids"] or payload["db_ids"]:
        save_registry(payload)
        return payload
    return stored


def load_registry() -> dict[str, list[str]]:
    stored = _bootstrap_registry_if_empty(_read_stored_registry())
    host_ids = list(stored["host_ids"])
    db_ids = list(stored["db_ids"])
    env_host = env_value("HOST_ID")
    env_db = env_value("DATABASE_ID")
    if env_host and env_host not in host_ids:
        host_ids.insert(0, env_host)
    if env_db and env_db not in db_ids:
        db_ids.insert(0, env_db)
    for hid in _env_id_list("INFRA_HOST_IDS"):
        if hid not in host_ids:
            host_ids.append(hid)
    for did in _env_id_list("INFRA_DB_IDS"):
        if did not in db_ids:
            db_ids.append(did)
    return {"host_ids": host_ids, "db_ids": db_ids}


def save_registry(data: dict[str, list[str]]) -> None:
    _ensure_data_dir()
    payload = {
        "host_ids": [str(x).strip() for x in data.get("host_ids") or [] if str(x).strip()],
        "db_ids": [str(x).strip() for x in data.get("db_ids") or [] if str(x).strip()],
    }
    REGISTRY_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def add_host_id(host_id: str) -> list[str]:
    hid = str(host_id or "").strip()
    if not hid:
        raise ValueError("host_id obrigatório")
    stored = _read_stored_registry()
    if hid not in stored["host_ids"]:
        stored["host_ids"].append(hid)
    save_registry(stored)
    return load_registry()["host_ids"]


def remove_host_id(host_id: str) -> list[str]:
    hid = str(host_id or "").strip()
    stored = _read_stored_registry()
    stored["host_ids"] = [x for x in stored["host_ids"] if x != hid]
    save_registry(stored)
    return load_registry()["host_ids"]


def add_db_id(db_id: str) -> list[str]:
    did = str(db_id or "").strip()
    if not did:
        raise ValueError("db_id obrigatório")
    stored = _read_stored_registry()
    if did not in stored["db_ids"]:
        stored["db_ids"].append(did)
    save_registry(stored)
    return load_registry()["db_ids"]


def remove_db_id(db_id: str) -> list[str]:
    did = str(db_id or "").strip()
    stored = _read_stored_registry()
    stored["db_ids"] = [x for x in stored["db_ids"] if x != did]
    save_registry(stored)
    return load_registry()["db_ids"]


def _do_error_message(status: int, body: Any) -> str:
    if isinstance(body, dict):
        msg = body.get("message") or body.get("id") or body.get("error")
        if msg:
            return str(msg)
    if status == 401:
        return "Token DigitalOcean inválido ou expirado"
    if status == 404:
        return "Recurso não encontrado na DigitalOcean"
    return f"DigitalOcean HTTP {status}"


async def _do_get(path: str, token: str, params: dict[str, Any] | None = None) -> Any:
    if not token:
        raise RuntimeError("DIGITALOCEAN_TOKEN não configurado")
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    url = f"{DO_API_BASE}{path}"
    async with httpx.AsyncClient(timeout=30.0) as client:
        res = await client.get(url, headers=headers, params=params or {})
    try:
        body = res.json() if res.content else {}
    except Exception:
        body = {"message": res.text}
    if res.status_code >= 400:
        raise RuntimeError(_do_error_message(res.status_code, body))
    return body


async def _do_put(path: str, token: str, body: dict[str, Any]) -> Any:
    if not token:
        raise RuntimeError("DIGITALOCEAN_TOKEN não configurado")
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    url = f"{DO_API_BASE}{path}"
    async with httpx.AsyncClient(timeout=30.0) as client:
        res = await client.put(url, headers=headers, json=body)
    try:
        payload = res.json() if res.content else {}
    except Exception:
        payload = {"message": res.text}
    if res.status_code >= 400:
        raise RuntimeError(_do_error_message(res.status_code, payload))
    return payload


async def detect_public_ip() -> str | None:
    async with httpx.AsyncClient(timeout=6.0) as client:
        for url in ("https://api.ipify.org", "https://ifconfig.me/ip"):
            try:
                res = await client.get(url, headers={"Accept": "text/plain"})
                if res.status_code < 400:
                    ip = res.text.strip()
                    if ip:
                        return ip
            except httpx.RequestError:
                continue
    return None


def _firewall_rule_payload(rule: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "type": rule.get("type"),
        "value": rule.get("value"),
    }
    if rule.get("description"):
        payload["description"] = rule["description"]
    return payload


async def ensure_database_trusted_source(db_id: str, ip: str | None = None) -> dict[str, Any]:
    public_ip = (ip or await detect_public_ip() or "").strip()
    if not public_ip:
        raise RuntimeError("Não foi possível detectar o IP público desta máquina")

    body = await _do_get(f"/databases/{db_id}/firewall", db_token())
    rules = [_firewall_rule_payload(rule) for rule in (body.get("rules") or [])]
    if any(rule.get("type") == "ip_addr" and rule.get("value") == public_ip for rule in rules):
        return {
            "trusted_source_added": True,
            "trusted_source_ip": public_ip,
            "already_present": True,
        }

    rules.append({
        "type": "ip_addr",
        "value": public_ip,
        "description": "Painel LAV60",
    })
    await _do_put(f"/databases/{db_id}/firewall", db_token(), {"rules": rules})
    return {
        "trusted_source_added": True,
        "trusted_source_ip": public_ip,
        "already_present": False,
    }


def _timeout_metrics_message(public_ip: str | None = None) -> str:
    ip_part = f" Seu IP público atual: {public_ip}." if public_ip else ""
    return (
        "Timeout ao coletar métricas do cluster — a porta 9273 não respondeu."
        f"{ip_part} Em desenvolvimento local, cadastre esse IP em DigitalOcean → Database → "
        "Settings → Trusted Sources, ou remova e adicione o database no painel para tentar "
        "incluir o IP automaticamente."
    )


def _do_get_sync(path: str, token: str, params: dict[str, Any] | None = None) -> Any:
    if not token:
        raise RuntimeError("DIGITALOCEAN_TOKEN não configurado")
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    url = f"{DO_API_BASE}{path}"
    with httpx.Client(timeout=30.0) as client:
        res = client.get(url, headers=headers, params=params or {})
    try:
        body = res.json() if res.content else {}
    except Exception:
        body = {"message": res.text}
    if res.status_code >= 400:
        raise RuntimeError(_do_error_message(res.status_code, body))
    return body

    if not token:
        raise RuntimeError("DIGITALOCEAN_TOKEN não configurado")
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    url = f"{DO_API_BASE}{path}"
    with httpx.Client(timeout=30.0) as client:
        res = client.get(url, headers=headers, params=params or {})
    try:
        body = res.json() if res.content else {}
    except Exception:
        body = {"message": res.text}
    if res.status_code >= 400:
        raise RuntimeError(_do_error_message(res.status_code, body))
    return body


def _matrix_series(data: dict[str, Any]) -> list[dict[str, Any]]:
    return ((data or {}).get("data") or {}).get("result") or []


def _values_by_timestamp(series: list[dict[str, Any]], key: str = "value") -> dict[int, float]:
    out: dict[int, float] = {}
    for block in series:
        label = key
        if key == "value":
            label = block.get("metric", {}).get("mode") or block.get("metric", {}).get(key) or "value"
        for ts_raw, val_raw in block.get("values") or []:
            ts = int(float(ts_raw))
            val = float(val_raw)
            if key == "value" and len(series) > 1:
                out.setdefault(ts, {})[str(label)] = val  # type: ignore[assignment]
            else:
                out[ts] = val  # type: ignore[assignment]
    return out


def _cpu_timeseries_from_matrix(data: dict[str, Any]) -> tuple[list[dict[str, Any]], float | None, float | None, int | None, int | None]:
    by_ts: dict[int, dict[str, float]] = {}
    for block in _matrix_series(data):
        mode = str(block.get("metric", {}).get("mode") or "value")
        for ts_raw, val_raw in block.get("values") or []:
            ts = int(float(ts_raw))
            by_ts.setdefault(ts, {})[mode] = float(val_raw)

    timeseries: list[dict[str, Any]] = []
    percents: list[float] = []
    for ts in sorted(by_ts):
        modes = by_ts[ts]
        total = sum(modes.values())
        if total <= 0:
            continue
        idle = modes.get("idle", 0.0)
        pct = max(0.0, min(100.0, (total - idle) / total * 100.0))
        timeseries.append({"timestamp": ts, "percent": round(pct, 2)})
        percents.append(pct)

    latest = round(percents[-1], 2) if percents else None
    avg = round(sum(percents) / len(percents), 2) if percents else None
    start = timeseries[0]["timestamp"] if timeseries else None
    end = timeseries[-1]["timestamp"] if timeseries else None
    return timeseries, latest, avg, start, end


def _percent_timeseries_from_totals(
    total_data: dict[str, Any],
    free_data: dict[str, Any] | None = None,
    *,
    available_data: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], float | None, float | None, float | None]:
    totals = _values_by_timestamp(_matrix_series(total_data))
    frees = _values_by_timestamp(_matrix_series(free_data or {}))
    available = _values_by_timestamp(_matrix_series(available_data or {}))

    timeseries: list[dict[str, Any]] = []
    latest_pct = None
    latest_used = None
    latest_total = None
    for ts in sorted(totals):
        total = float(totals[ts])
        if total <= 0:
            continue
        free = float(frees.get(ts, available.get(ts, 0.0)))
        used = total - free if frees or available else total - free
        pct = max(0.0, min(100.0, used / total * 100.0))
        point = {
            "timestamp": ts,
            "percent": round(pct, 2),
            "used_gb": round(used / (1024 ** 3), 2),
            "total_gb": round(total / (1024 ** 3), 2),
        }
        timeseries.append(point)
        latest_pct = point["percent"]
        latest_used = point["used_gb"]
        latest_total = point["total_gb"]

    return timeseries, latest_pct, latest_used, latest_total


def _scalar_timeseries(data: dict[str, Any], field: str = "value") -> list[dict[str, Any]]:
    series = _matrix_series(data)
    if not series:
        return []
    out: list[dict[str, Any]] = []
    for ts_raw, val_raw in series[0].get("values") or []:
        out.append({"timestamp": int(float(ts_raw)), field: round(float(val_raw), 3)})
    return out


def _metric_window(window: int) -> tuple[int, int]:
    end = int(time.time())
    start = end - max(300, int(window))
    return start, end


async def fetch_droplet_info(host_id: str) -> dict[str, Any]:
    token = do_token()
    body = await _do_get(f"/droplets/{host_id}", token)
    droplet = body.get("droplet") or {}
    size = droplet.get("size") or {}
    return {
        "id": str(droplet.get("id") or host_id),
        "name": droplet.get("name") or str(host_id),
        "status": droplet.get("status") or "unknown",
        "vcpus": size.get("vcpus"),
        "memory_mb": size.get("memory"),
        "disk_gb": size.get("disk"),
        "region": (droplet.get("region") or {}).get("slug"),
    }


async def _fetch_metric(path: str, token: str, host_id: str, window: int) -> dict[str, Any]:
    start, end = _metric_window(window)
    return await _do_get(
        path,
        token,
        {"host_id": host_id, "start": str(start), "end": str(end)},
    )


async def fetch_vps_metrics(host_id: str, window: int) -> dict[str, Any]:
    token = do_token()
    start, end = _metric_window(window)

    (
        cpu_raw,
        mem_total_raw,
        mem_avail_raw,
        disk_size_raw,
        disk_free_raw,
        load1_raw,
        load5_raw,
        load15_raw,
    ) = await asyncio.gather(
        _fetch_metric("/monitoring/metrics/droplet/cpu", token, host_id, window),
        _fetch_metric("/monitoring/metrics/droplet/memory_total", token, host_id, window),
        _fetch_metric("/monitoring/metrics/droplet/memory_available", token, host_id, window),
        _fetch_metric("/monitoring/metrics/droplet/filesystem_size", token, host_id, window),
        _fetch_metric("/monitoring/metrics/droplet/filesystem_free", token, host_id, window),
        _fetch_metric("/monitoring/metrics/droplet/load_1", token, host_id, window),
        _fetch_metric("/monitoring/metrics/droplet/load_5", token, host_id, window),
        _fetch_metric("/monitoring/metrics/droplet/load_15", token, host_id, window),
    )
    cpu_ts, cpu_latest, cpu_avg, cpu_start, cpu_end = _cpu_timeseries_from_matrix(cpu_raw)

    mem_ts, mem_pct, mem_used, mem_total = _percent_timeseries_from_totals(mem_total_raw, available_data=mem_avail_raw)

    disk_ts, disk_pct, disk_used, disk_total = _percent_timeseries_from_totals(disk_size_raw, free_data=disk_free_raw)
    disk_free_gb = round(disk_total - disk_used, 2) if disk_total is not None and disk_used is not None else None

    load1 = _scalar_timeseries(load1_raw, "value")
    load5 = _scalar_timeseries(load5_raw, "value")
    load15 = _scalar_timeseries(load15_raw, "value")

    return {
        "cpu": {
            "latest_percent": cpu_latest,
            "average_percent": cpu_avg,
            "period_start": cpu_start or start,
            "period_end": cpu_end or end,
            "timeseries": cpu_ts,
        },
        "memory_percent": mem_pct,
        "memory_used_gb": mem_used,
        "memory_total_gb": mem_total,
        "memory_timeseries": mem_ts,
        "disk_percent": disk_pct,
        "disk_free_gb": disk_free_gb,
        "disk_total_gb": disk_total,
        "disk_timeseries": [{"timestamp": p["timestamp"], "percent": p["percent"]} for p in disk_ts],
        "load_1": load1[-1]["value"] if load1 else None,
        "load_5": load5[-1]["value"] if load5 else None,
        "load_15": load15[-1]["value"] if load15 else None,
        "load_timeseries": {
            "load_1": load1,
            "load_5": load5,
            "load_15": load15,
        },
    }


def fetch_cpu_metrics(host_id: str, window: int) -> dict[str, Any]:
    token = do_token()
    start, end = _metric_window(window)
    cpu_raw = _do_get_sync(
        "/monitoring/metrics/droplet/cpu",
        token,
        {"host_id": host_id, "start": str(start), "end": str(end)},
    )
    series = _matrix_series(cpu_raw)
    by_ts: dict[int, dict[str, float]] = {}
    for block in series:
        mode = str(block.get("metric", {}).get("mode") or "value")
        for ts_raw, val_raw in block.get("values") or []:
            ts = int(float(ts_raw))
            by_ts.setdefault(ts, {})[mode] = float(val_raw)

    samples = 0
    percents: list[float] = []
    breakdown: dict[str, float] = {}
    last_ts = None
    for ts in sorted(by_ts):
        modes = by_ts[ts]
        total = sum(modes.values())
        if total <= 0:
            continue
        idle = modes.get("idle", 0.0)
        pct = max(0.0, min(100.0, (total - idle) / total * 100.0))
        percents.append(pct)
        samples += 1
        last_ts = ts
        if ts == max(by_ts):
            for mode, val in modes.items():
                breakdown[mode] = round(val / total * 100.0, 2)

    return {
        "host_id": host_id,
        "period_start": min(by_ts) if by_ts else start,
        "period_end": last_ts or end,
        "interval_seconds": METRICS_INTERVAL_SEC,
        "samples": samples,
        "intervals": max(0, samples - 1),
        "latest_percent": round(percents[-1], 2) if percents else None,
        "average_percent": round(sum(percents) / len(percents), 2) if percents else None,
        "breakdown_pct": breakdown,
    }


def _normalize_db_engine(engine: str) -> str:
    value = str(engine or "").strip().lower()
    aliases = {
        "pg": "postgresql",
        "postgres": "postgresql",
        "mongo": "mongodb",
    }
    if value in aliases:
        return aliases[value]
    if value in _DB_ENGINES:
        return value
    if "postgres" in value:
        return "postgresql"
    if "mongo" in value:
        return "mongodb"
    return value or "postgresql"


async def fetch_database_cluster(db_id: str) -> dict[str, Any]:
    body = await _do_get(f"/databases/{db_id}", db_token())
    return body.get("database") or {}


async def _cached_fetch_database_cluster(db_id: str) -> dict[str, Any]:
    now = time.time()
    hit = _db_cluster_cache.get(db_id)
    if hit and hit.get("expires_at", 0) > now:
        return hit.get("data") or {}
    cluster = await fetch_database_cluster(db_id)
    _db_cluster_cache[db_id] = {"data": cluster, "expires_at": now + DB_CLUSTER_CACHE_TTL_SEC}
    return cluster


async def fetch_database_info(db_id: str) -> dict[str, Any]:
    cluster = await fetch_database_cluster(db_id)
    return {
        "id": str(cluster.get("id") or db_id),
        "name": cluster.get("name") or db_id,
        "engine": cluster.get("engine"),
        "version": cluster.get("version"),
        "num_nodes": cluster.get("num_nodes"),
        "size": cluster.get("size"),
        "region": cluster.get("region"),
        "status": cluster.get("status") or "unknown",
    }


def _avg_percent_timeseries(samples: list[dict[str, Any]]) -> float | None:
    values = [
        float(row.get("percent") if row.get("percent") is not None else row.get("value"))
        for row in samples
        if row.get("percent") is not None or row.get("value") is not None
    ]
    if not values:
        return None
    return round(sum(values) / len(values), 2)


def _densify_percent_timeseries(
    samples: list[dict[str, Any]],
    window: int,
    interval: int = METRICS_INTERVAL_SEC,
) -> list[dict[str, Any]]:
    """Preenche o período com pontos a cada intervalo (hold-last-value + backfill)."""
    now = int(time.time())
    start = now - max(interval, int(window))
    points = sorted(
        [
            {
                "timestamp": int(row["timestamp"]),
                "percent": float(
                    row.get("percent") if row.get("percent") is not None else row.get("value")
                ),
            }
            for row in samples
            if row.get("timestamp") is not None
            and (row.get("percent") is not None or row.get("value") is not None)
        ],
        key=lambda item: item["timestamp"],
    )
    if not points:
        return []

    grid_start = ((start + interval - 1) // interval) * interval
    out: list[dict[str, Any]] = []
    idx = 0
    carry = points[0]["percent"]

    t = grid_start
    while t <= now:
        while idx < len(points) and points[idx]["timestamp"] <= t:
            carry = points[idx]["percent"]
            idx += 1
        pct = round(float(carry), 2)
        out.append({"timestamp": t, "percent": pct, "value": pct})
        t += interval

    last = points[-1]
    if last["timestamp"] > (out[-1]["timestamp"] if out else 0) and last["timestamp"] <= now:
        pct = round(float(last["percent"]), 2)
        if not out or out[-1]["timestamp"] != last["timestamp"]:
            out.append({"timestamp": last["timestamp"], "percent": pct, "value": pct})
    return out


def _db_percent_series(data: dict[str, Any]) -> list[dict[str, Any]]:
    series = _matrix_series(data)
    out: list[dict[str, Any]] = []
    for block in series:
        for ts_raw, val_raw in block.get("values") or []:
            out.append({
                "timestamp": int(float(ts_raw)),
                "percent": round(float(val_raw), 2),
                "value": round(float(val_raw), 2),
            })
    return out


def _db_metrics_from_series(
    cpu_ts: list[dict[str, Any]],
    mem_ts: list[dict[str, Any]],
    disk_ts: list[dict[str, Any]],
) -> dict[str, Any]:
    sampled_at = cpu_ts[-1]["timestamp"] if cpu_ts else int(time.time())
    return {
        "cpu_percent": cpu_ts[-1]["percent"] if cpu_ts else None,
        "memory_percent": mem_ts[-1]["percent"] if mem_ts else None,
        "disk_percent": disk_ts[-1]["percent"] if disk_ts else None,
        "cpu_percent_pending": not cpu_ts,
        "sampled_at": sampled_at,
        "cpu_percent_timeseries": cpu_ts,
        "memory_percent_timeseries": mem_ts,
        "disk_percent_timeseries": disk_ts,
    }


def _load_db_metrics_history() -> dict[str, list[dict[str, Any]]]:
    data = read_json_file(_DB_HISTORY_PATH, {}) or {}
    if not isinstance(data, dict):
        return {}
    return {
        str(db_id): [row for row in rows if isinstance(row, dict)]
        for db_id, rows in data.items()
        if isinstance(rows, list)
    }


def _save_db_metrics_history(data: dict[str, list[dict[str, Any]]]) -> None:
    _ensure_data_dir()
    _DB_HISTORY_PATH.write_text(json.dumps(data), encoding="utf-8")


def _history_last_timestamp(db_id: str) -> int:
    rows = _load_db_metrics_history().get(db_id) or []
    if not rows:
        return 0
    return int(rows[-1].get("timestamp") or 0)


def _last_history_detail(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    for row in reversed(rows):
        if any(row.get(key) is not None for key in ("memory_used_gb", "disk_free_gb")):
            return row
    return rows[-1] if rows else None


def _attach_history_detail_fields(metrics: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    detail = _last_history_detail(rows)
    if not detail:
        return metrics
    merged = dict(metrics)
    for key in ("memory_used_gb", "memory_total_gb", "disk_free_gb", "disk_total_gb"):
        if detail.get(key) is not None:
            merged[key] = detail[key]
    return merged


def _metrics_from_history_window(db_id: str, window: int) -> dict[str, Any] | None:
    rows = _load_db_metrics_history().get(db_id) or []
    if not rows:
        return None
    cpu_raw = _history_field_timeseries(rows, window, "cpu_percent")
    mem_raw = _history_field_timeseries(rows, window, "memory_percent")
    disk_raw = _history_field_timeseries(rows, window, "disk_percent")
    if not cpu_raw and not mem_raw and not disk_raw:
        return None
    cpu_ts = _densify_percent_timeseries(cpu_raw, window)
    mem_ts = _densify_percent_timeseries(mem_raw, window)
    disk_ts = _densify_percent_timeseries(disk_raw, window)
    metrics = _db_metrics_from_series(cpu_ts, mem_ts, disk_ts)
    metrics = _attach_history_detail_fields(metrics, rows)
    metrics["history_samples_collected"] = max(len(cpu_raw), len(mem_raw), len(disk_raw))
    if cpu_raw:
        avg = _avg_percent_timeseries(cpu_raw)
        if avg is not None:
            metrics["cpu_percent_avg"] = avg
    if mem_raw:
        avg = _avg_percent_timeseries(mem_raw)
        if avg is not None:
            metrics["memory_percent_avg"] = avg
    if disk_raw:
        avg = _avg_percent_timeseries(disk_raw)
        if avg is not None:
            metrics["disk_percent_avg"] = avg
    if metrics.get("cpu_percent_timeseries"):
        metrics["sampled_at"] = metrics["cpu_percent_timeseries"][-1]["timestamp"]
    return metrics


def _record_db_metrics_snapshot(db_id: str, metrics: dict[str, Any]) -> None:
    now = int(time.time())
    point = {
        "timestamp": now,
        "cpu_percent": metrics.get("cpu_percent"),
        "memory_percent": metrics.get("memory_percent"),
        "disk_percent": metrics.get("disk_percent"),
        "memory_used_gb": metrics.get("memory_used_gb"),
        "memory_total_gb": metrics.get("memory_total_gb"),
        "disk_free_gb": metrics.get("disk_free_gb"),
        "disk_total_gb": metrics.get("disk_total_gb"),
    }
    if all(point.get(key) is None for key in ("cpu_percent", "memory_percent", "disk_percent")):
        return

    history = _load_db_metrics_history()
    rows = list(history.get(db_id) or [])
    if rows and rows[-1].get("timestamp") == now:
        rows[-1] = point
    else:
        rows.append(point)
    cutoff = now - _DB_HISTORY_MAX_SEC
    history[db_id] = [row for row in rows if int(row.get("timestamp") or 0) >= cutoff][-5000:]
    _save_db_metrics_history(history)


def _history_field_timeseries(
    rows: list[dict[str, Any]],
    window: int,
    field: str,
) -> list[dict[str, Any]]:
    now = int(time.time())
    start = now - max(300, int(window))
    out: list[dict[str, Any]] = []
    for row in rows:
        ts = int(row.get("timestamp") or 0)
        value = row.get(field)
        if ts < start or ts > now or value is None:
            continue
        out.append({
            "timestamp": ts,
            "percent": round(float(value), 2),
            "value": round(float(value), 2),
        })
    return out


def _apply_db_history_to_metrics(
    db_id: str,
    metrics: dict[str, Any],
    window: int,
) -> dict[str, Any]:
    rows = _load_db_metrics_history().get(db_id) or []
    if not rows:
        return metrics

    merged = dict(metrics)
    for field, key in (
        ("cpu_percent", "cpu_percent_timeseries"),
        ("memory_percent", "memory_percent_timeseries"),
        ("disk_percent", "disk_percent_timeseries"),
    ):
        raw = _history_field_timeseries(rows, window, field)
        series = _densify_percent_timeseries(raw, window)
        if series:
            merged[key] = series
            merged[field] = series[-1]["percent"]
            avg = _avg_percent_timeseries(raw)
            if avg is not None:
                merged[f"{field}_avg"] = avg

    if merged.get("cpu_percent_timeseries"):
        merged["sampled_at"] = merged["cpu_percent_timeseries"][-1]["timestamp"]
    merged["history_samples_collected"] = len(rows)
    return merged


async def _try_fetch_db_metric_with_token(
    engine: str,
    metric: str,
    db_id: str,
    window: int,
    token: str,
) -> dict[str, Any]:
    if not token:
        return {}
    try:
        start, end = _metric_window(window)
        path = f"/monitoring/metrics/database/{engine}/{metric}"
        return await _do_get(
            path,
            token,
            {"db_id": db_id, "aggregate": "avg", "start": str(start), "end": str(end)},
        )
    except Exception:
        return {}


async def _try_fetch_db_metric(engine: str, metric: str, db_id: str, window: int) -> dict[str, Any]:
    for token in (db_token(), do_token()):
        raw = await _try_fetch_db_metric_with_token(engine, metric, db_id, window, token)
        if raw:
            return raw
    return {}


async def _fetch_db_metrics_via_api(db_id: str, engine: str, window: int) -> dict[str, Any] | None:
    eng = _normalize_db_engine(engine)
    if eng not in _DB_ENGINES:
        return None

    cpu_raw, mem_raw, disk_raw = await asyncio.gather(
        _try_fetch_db_metric(eng, "cpu_usage", db_id, window),
        _try_fetch_db_metric(eng, "memory_usage", db_id, window),
        _try_fetch_db_metric(eng, "disk_usage", db_id, window),
    )
    cpu_ts = _db_percent_series(cpu_raw)
    mem_ts = _db_percent_series(mem_raw)
    disk_ts = _db_percent_series(disk_raw)
    if not cpu_ts and not mem_ts and not disk_ts:
        return None

    return _db_metrics_from_series(cpu_ts, mem_ts, disk_ts)


def _scraped_metrics_from_history_row(row: dict[str, Any]) -> dict[str, Any]:
    ts = int(row.get("timestamp") or time.time())
    metrics = _db_metrics_from_series(
        _metric_point(row.get("cpu_percent"), ts),
        _metric_point(row.get("memory_percent"), ts),
        _metric_point(row.get("disk_percent"), ts),
    )
    return metrics


async def _fetch_database_metrics_scrape_and_history(
    db_id: str,
    cluster: dict[str, Any],
    window: int,
) -> dict[str, Any]:
    scraped = await asyncio.wait_for(
        _fetch_database_metrics_scrapable(db_id, cluster),
        timeout=DB_SCRAPE_TIMEOUT_SEC + 2,
    )
    _record_db_metrics_snapshot(db_id, scraped)
    return _apply_db_history_to_metrics(db_id, scraped, window)


async def _refresh_db_snapshot_bg(db_id: str, cluster: dict[str, Any] | None = None) -> None:
    if db_id in _db_refresh_in_flight:
        return
    _db_refresh_in_flight.add(db_id)
    try:
        cluster_data = cluster or await _cached_fetch_database_cluster(db_id)
        if not cluster_data.get("metrics_endpoints"):
            return
        scraped = await asyncio.wait_for(
            _fetch_database_metrics_scrapable(db_id, cluster_data),
            timeout=DB_SCRAPE_TIMEOUT_SEC + 2,
        )
        _record_db_metrics_snapshot(db_id, scraped)
    except Exception:
        pass
    finally:
        _db_refresh_in_flight.discard(db_id)


async def poll_all_database_metrics() -> None:
    if not db_token():
        return
    for db_id in load_registry()["db_ids"]:
        await _refresh_db_snapshot_bg(db_id)
        await asyncio.sleep(0.25)


async def _fetch_vps_entry_live(host_id: str, window: int) -> dict[str, Any]:
    entry: dict[str, Any] = {"id": host_id, "name": host_id}
    if not do_token():
        entry["metrics_error"] = "DIGITALOCEAN_TOKEN não configurado"
        return entry

    try:
        info, metrics = await asyncio.gather(
            fetch_droplet_info(host_id),
            fetch_vps_metrics(host_id, window),
        )
        entry.update(info)
        entry["metrics"] = metrics
    except Exception as exc:
        entry["metrics_error"] = str(exc)
    return entry


async def _refresh_vps_entry_bg(host_id: str, window: int) -> None:
    key = f"{host_id}:{window}"
    if key in _vps_refresh_in_flight:
        return
    _vps_refresh_in_flight.add(key)
    try:
        entry = await _fetch_vps_entry_live(host_id, window)
        _persist_entry(_VPS_STORE_PATH, host_id, window, entry)
        _cache_set(f"vps:{host_id}:{window}", entry)
    except Exception:
        pass
    finally:
        _vps_refresh_in_flight.discard(key)


async def poll_all_vps_metrics() -> None:
    if not do_token():
        return
    for host_id in load_registry()["host_ids"]:
        for window in _INFRA_POLL_WINDOWS:
            await _refresh_vps_entry_bg(host_id, window)
            await asyncio.sleep(0.15)


async def _fetch_database_entry_live(db_id: str, window: int) -> dict[str, Any]:
    entry: dict[str, Any] = {"id": db_id, "name": db_id}
    if not db_token():
        entry["metrics_error"] = "DIGITALOCEAN_DB_TOKEN não configurado"
        return entry

    try:
        cluster = await _cached_fetch_database_cluster(db_id)
        entry.update({
            "id": str(cluster.get("id") or db_id),
            "name": cluster.get("name") or db_id,
            "engine": cluster.get("engine"),
            "version": cluster.get("version"),
            "num_nodes": cluster.get("num_nodes"),
            "size": cluster.get("size"),
            "region": cluster.get("region"),
            "status": cluster.get("status") or "unknown",
        })
        entry["metrics"] = await fetch_database_metrics(
            db_id,
            cluster.get("engine") or "pg",
            window,
            cluster=cluster,
            force=False,
        )
    except Exception as exc:
        entry["metrics_error"] = str(exc)
    return entry


async def _refresh_db_entry_bg(db_id: str, window: int) -> None:
    key = f"{db_id}:{window}"
    if key in _db_entry_refresh_in_flight:
        return
    _db_entry_refresh_in_flight.add(key)
    try:
        entry = await _fetch_database_entry_live(db_id, window)
        _persist_entry(_DB_STORE_PATH, db_id, window, entry)
        _cache_set(f"db:{db_id}:{window}", entry)
    except Exception:
        pass
    finally:
        _db_entry_refresh_in_flight.discard(key)


async def poll_all_database_entries() -> None:
    if not db_token():
        return
    for db_id in load_registry()["db_ids"]:
        for window in _INFRA_POLL_WINDOWS:
            await _refresh_db_entry_bg(db_id, window)
            await asyncio.sleep(0.15)


async def _refresh_infra_catalog_store() -> None:
    vps_items: list[dict[str, Any]] = []
    for host_id in load_registry()["host_ids"]:
        item = {"id": host_id, "name": host_id}
        if do_token():
            try:
                info = await fetch_droplet_info(host_id)
                item.update(info)
            except Exception as exc:
                item["error"] = str(exc)
        vps_items.append(item)

    db_items: list[dict[str, Any]] = []
    for db_id in load_registry()["db_ids"]:
        item = {"id": db_id, "name": db_id}
        if db_token():
            try:
                info = await fetch_database_info(db_id)
                item.update(info)
            except Exception as exc:
                item["error"] = str(exc)
        db_items.append(item)

    _save_catalog_store(vps_items, db_items)


async def _db_metrics_poller_loop() -> None:
    await asyncio.sleep(10)
    while True:
        await poll_all_database_metrics()
        await poll_all_database_entries()
        await poll_all_vps_metrics()
        try:
            await _refresh_infra_catalog_store()
        except Exception:
            pass
        await asyncio.sleep(DB_POLL_INTERVAL_SEC)


def start_db_metrics_poller() -> None:
    global _db_poller_task
    if _db_poller_task and not _db_poller_task.done():
        return
    _db_poller_task = asyncio.create_task(_db_metrics_poller_loop())


def stop_db_metrics_poller() -> None:
    global _db_poller_task
    if _db_poller_task and not _db_poller_task.done():
        _db_poller_task.cancel()
    _db_poller_task = None


async def fetch_database_metrics(
    db_id: str,
    engine: str,
    window: int,
    *,
    cluster: dict[str, Any] | None = None,
    force: bool = False,
) -> dict[str, Any]:
    history_metrics = _metrics_from_history_window(db_id, window)

    if history_metrics and not force:
        if time.time() - _history_last_timestamp(db_id) > DB_HISTORY_STALE_SEC:
            asyncio.create_task(_refresh_db_snapshot_bg(db_id, cluster))
        return history_metrics

    if history_metrics and force:
        asyncio.create_task(_refresh_db_snapshot_bg(db_id, cluster))
        return history_metrics

    cluster_data = cluster or await _cached_fetch_database_cluster(db_id)
    eng = _normalize_db_engine(engine)

    api_metrics = await _fetch_db_metrics_via_api(db_id, eng, window)
    if api_metrics:
        if history_metrics:
            for key in ("memory_used_gb", "memory_total_gb", "disk_free_gb", "disk_total_gb"):
                if history_metrics.get(key) is not None:
                    api_metrics[key] = history_metrics[key]
        asyncio.create_task(_refresh_db_snapshot_bg(db_id, cluster_data))
        return api_metrics

    endpoints = cluster_data.get("metrics_endpoints") or []
    if not endpoints:
        if history_metrics:
            return history_metrics
        raise RuntimeError("Sem fonte de métricas para este cluster")

    try:
        return await _fetch_database_metrics_scrape_and_history(db_id, cluster_data, window)
    except Exception:
        if history_metrics:
            return history_metrics
        raise


async def _fetch_db_metrics_credentials() -> tuple[str, str]:
    now = time.time()
    if (
        _db_credentials_cache.get("data")
        and _db_credentials_cache.get("expires_at", 0) > now
    ):
        user, pwd = _db_credentials_cache["data"]
        return user, pwd

    body = await _do_get("/databases/metrics/credentials", db_token())
    creds = body.get("credentials") or {}
    user = str(creds.get("basic_auth_username") or "").strip()
    pwd = str(creds.get("basic_auth_password") or "").strip()
    if not user or not pwd:
        raise RuntimeError(
            "Credenciais de métricas indisponíveis — use um token DigitalOcean com permissão Read/Write"
        )
    _db_credentials_cache["data"] = (user, pwd)
    _db_credentials_cache["expires_at"] = now + DB_CREDENTIALS_CACHE_TTL_SEC
    return user, pwd


def _parse_prometheus_line(line: str) -> tuple[str, dict[str, str], float] | None:
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    try:
        name_part, value_raw = line.rsplit(" ", 1)
        value = float(value_raw)
    except ValueError:
        return None

    metric = name_part.split("{", 1)[0].strip().lower()
    labels: dict[str, str] = {}
    if "{" in name_part:
        labels_raw = name_part.split("{", 1)[1].rsplit("}", 1)[0]
        for chunk in labels_raw.split(","):
            chunk = chunk.strip()
            if "=" not in chunk:
                continue
            key, raw_val = chunk.split("=", 1)
            labels[key.strip()] = raw_val.strip().strip('"')
    return metric, labels, value


def _bytes_to_gb(value: float) -> float:
    return round(value / (1024 ** 3), 2)


def _pick_main_volume_value(candidates: list[tuple[str, float]]) -> float | None:
    if not candidates:
        return None
    main_volumes = [value for device, value in candidates if device.startswith("mapper/")]
    chosen = main_volumes or [value for _, value in candidates]
    return max(chosen)


def _telegraf_metrics_from_scrape(text: str) -> dict[str, float | None]:
    """Extrai CPU%, memória e disco (percentuais e totais) do scrape Telegraf."""
    cpu_idle: float | None = None
    memory_percent: float | None = None
    disk_percent_candidates: list[tuple[str, float]] = []
    mem_total_bytes: float | None = None
    mem_used_bytes: float | None = None
    disk_total_candidates: list[tuple[str, float]] = []
    disk_used_candidates: list[tuple[str, float]] = []
    disk_free_candidates: list[tuple[str, float]] = []

    for raw_line in text.splitlines():
        parsed = _parse_prometheus_line(raw_line)
        if not parsed:
            continue
        metric, labels, value = parsed
        device = labels.get("device") or ""

        if metric == "cpu_usage_idle" and labels.get("cpu") == "cpu-total":
            cpu_idle = value
        elif metric == "mem_used_percent":
            memory_percent = value
        elif metric == "mem_total":
            mem_total_bytes = value
        elif metric == "mem_used":
            mem_used_bytes = value
        elif metric == "disk_used_percent":
            disk_percent_candidates.append((device, value))
        elif metric == "disk_total":
            disk_total_candidates.append((device, value))
        elif metric == "disk_used":
            disk_used_candidates.append((device, value))
        elif metric == "disk_free":
            disk_free_candidates.append((device, value))

    cpu_percent = (
        round(max(0.0, min(100.0, 100.0 - cpu_idle)), 2)
        if cpu_idle is not None
        else None
    )

    disk_percent_raw = _pick_main_volume_value(disk_percent_candidates)
    disk_percent = (
        round(max(0.0, min(100.0, disk_percent_raw)), 2)
        if disk_percent_raw is not None
        else None
    )

    if memory_percent is not None:
        memory_percent = round(max(0.0, min(100.0, memory_percent)), 2)

    memory_used_gb = _bytes_to_gb(mem_used_bytes) if mem_used_bytes is not None else None
    memory_total_gb = _bytes_to_gb(mem_total_bytes) if mem_total_bytes is not None else None

    disk_total_raw = _pick_main_volume_value(disk_total_candidates)
    disk_used_raw = _pick_main_volume_value(disk_used_candidates)
    disk_free_raw = _pick_main_volume_value(disk_free_candidates)
    disk_total_gb = _bytes_to_gb(disk_total_raw) if disk_total_raw is not None else None
    disk_used_gb = _bytes_to_gb(disk_used_raw) if disk_used_raw is not None else None
    disk_free_gb = _bytes_to_gb(disk_free_raw) if disk_free_raw is not None else None
    if disk_free_gb is None and disk_total_gb is not None and disk_used_gb is not None:
        disk_free_gb = round(max(0.0, disk_total_gb - disk_used_gb), 2)

    return {
        "cpu_percent": cpu_percent,
        "memory_percent": memory_percent,
        "disk_percent": disk_percent,
        "memory_used_gb": memory_used_gb,
        "memory_total_gb": memory_total_gb,
        "disk_free_gb": disk_free_gb,
        "disk_total_gb": disk_total_gb,
    }


def _metric_point(percent: float | None, ts: int) -> list[dict[str, Any]]:
    if percent is None:
        return []
    return [{"timestamp": ts, "percent": percent, "value": percent}]


async def _database_ca_verify_path(db_id: str) -> str:
    _ensure_data_dir()
    ca_path = DATA_DIR / f"db-ca-{db_id}.pem"
    if ca_path.is_file() and ca_path.stat().st_size > 0:
        return str(ca_path)

    body = await _do_get(f"/databases/{db_id}/ca", db_token())
    ca_b64 = (body.get("ca") or {}).get("certificate") or ""
    if not ca_b64:
        raise RuntimeError("Certificado CA do cluster indisponível na DigitalOcean")

    pem = base64.b64decode(ca_b64).decode("utf-8")
    ca_path.write_text(pem, encoding="utf-8")
    return str(ca_path)


async def _scrape_database_metrics_text(url: str, user: str, pwd: str, db_id: str) -> str:
    ca_verify = await _database_ca_verify_path(db_id)
    try:
        async with httpx.AsyncClient(timeout=DB_SCRAPE_TIMEOUT_SEC, verify=ca_verify) as client:
            res = await client.get(url, auth=(user, pwd), headers={"Accept": "text/plain"})
    except httpx.TimeoutException as exc:
        raise RuntimeError("timeout") from exc
    except httpx.RequestError as exc:
        raise RuntimeError(f"Falha de rede ao coletar métricas do cluster: {exc}") from exc
    if res.status_code >= 400:
        detail = res.text.strip() or _do_error_message(res.status_code, {})
        raise RuntimeError(detail)
    return res.text


async def _fetch_database_metrics_scrapable(db_id: str, cluster: dict[str, Any]) -> dict[str, Any]:
    endpoints = cluster.get("metrics_endpoints") or []
    if not endpoints:
        raise RuntimeError(
            "Cluster sem endpoint de métricas — habilite scrapable metrics na DigitalOcean"
        )
    host = endpoints[0].get("host")
    port = endpoints[0].get("port") or 9273
    if not host:
        raise RuntimeError("Host de métricas indisponível no cluster")

    user, pwd = await _fetch_db_metrics_credentials()
    url = f"https://{host}:{port}/metrics"
    public_ip = await detect_public_ip()

    try:
        text = await _scrape_database_metrics_text(url, user, pwd, db_id)
    except RuntimeError as exc:
        if str(exc) != "timeout":
            raise
        history_rows = _load_db_metrics_history().get(db_id) or []
        if history_rows:
            row = history_rows[-1]
            metrics = _scraped_metrics_from_history_row(row)
            return _attach_history_detail_fields(metrics, history_rows)
        try:
            await ensure_database_trusted_source(db_id, public_ip)
            await asyncio.sleep(1)
            text = await _scrape_database_metrics_text(url, user, pwd, db_id)
        except RuntimeError as retry_exc:
            if str(retry_exc) == "timeout":
                raise RuntimeError(_timeout_metrics_message(public_ip)) from retry_exc
            raise RuntimeError(
                f"{retry_exc}. {_timeout_metrics_message(public_ip)}"
            ) from retry_exc
        except Exception as retry_exc:
            raise RuntimeError(
                f"{retry_exc}. {_timeout_metrics_message(public_ip)}"
            ) from retry_exc

    scraped = _telegraf_metrics_from_scrape(text)
    now = int(time.time())

    metrics = _db_metrics_from_series(
        _metric_point(scraped.get("cpu_percent"), now),
        _metric_point(scraped.get("memory_percent"), now),
        _metric_point(scraped.get("disk_percent"), now),
    )
    for key in ("memory_used_gb", "memory_total_gb", "disk_free_gb", "disk_total_gb"):
        value = scraped.get(key)
        if value is not None:
            metrics[key] = value
    return metrics


async def list_vps_items() -> list[dict[str, Any]]:
    store = _load_catalog_store()
    items = store.get("vps") or []
    if items:
        if time.time() - int(store.get("updated_at") or 0) > _INFRA_STORE_REFRESH_SEC:
            asyncio.create_task(_refresh_infra_catalog_store())
        return items
    await _refresh_infra_catalog_store()
    return _load_catalog_store().get("vps") or []


async def list_database_items() -> list[dict[str, Any]]:
    store = _load_catalog_store()
    items = store.get("databases") or []
    if items:
        if time.time() - int(store.get("updated_at") or 0) > _INFRA_STORE_REFRESH_SEC:
            asyncio.create_task(_refresh_infra_catalog_store())
        return items
    await _refresh_infra_catalog_store()
    return _load_catalog_store().get("databases") or []


def _cache_get(key: str, force: bool, *, ttl_sec: int = CACHE_TTL_SEC) -> dict[str, Any] | None:
    if force:
        return None
    hit = _metrics_cache.get(key)
    if not hit:
        return None
    if time.time() - hit.get("ts", 0) > ttl_sec:
        return None
    return hit.get("payload")


def _cache_set(key: str, payload: dict[str, Any]) -> None:
    _metrics_cache[key] = {"ts": time.time(), "payload": payload}


async def _build_vps_entry(host_id: str, window: int, force: bool) -> dict[str, Any]:
    cache_key = f"vps:{host_id}:{window}"
    cached = _cache_get(cache_key, force)
    if cached:
        return {**cached, "from_cache": True}

    if not force:
        persisted = _get_persisted_entry(_VPS_STORE_PATH, host_id, window)
        if persisted:
            entry = _stored_entry_response(persisted["entry"], persisted["saved_at"])
            _cache_set(cache_key, entry)
            if time.time() - persisted["saved_at"] > _INFRA_STORE_REFRESH_SEC:
                asyncio.create_task(_refresh_vps_entry_bg(host_id, window))
            return entry

    entry = await _fetch_vps_entry_live(host_id, window)
    _persist_entry(_VPS_STORE_PATH, host_id, window, entry)
    _cache_set(cache_key, entry)
    return {**entry, "from_store": False}


async def _build_database_entry(db_id: str, window: int, force: bool) -> dict[str, Any]:
    cache_key = f"db:{db_id}:{window}"
    cached = _cache_get(cache_key, force, ttl_sec=DB_CACHE_TTL_SEC)
    if cached:
        return {**cached, "from_cache": True}

    if not force:
        persisted = _get_persisted_entry(_DB_STORE_PATH, db_id, window)
        if persisted:
            entry = _stored_entry_response(persisted["entry"], persisted["saved_at"])
            _cache_set(cache_key, entry)
            if time.time() - persisted["saved_at"] > _INFRA_STORE_REFRESH_SEC:
                asyncio.create_task(_refresh_db_entry_bg(db_id, window))
            return {**entry, "from_cache": True}

    entry = await _fetch_database_entry_live(db_id, window)
    _persist_entry(_DB_STORE_PATH, db_id, window, entry)
    _cache_set(cache_key, entry)
    return {**entry, "from_store": False, "from_cache": False}


async def build_metrics_payload(
    *,
    window: int = 900,
    host_id: str | None = None,
    db_id: str | None = None,
    include_databases: bool = False,
    force: bool = False,
) -> dict[str, Any]:
    reg = load_registry()
    if db_id:
        db_ids = [db_id]
        host_ids = [host_id] if host_id else []
    elif host_id:
        host_ids = [host_id]
        db_ids = reg["db_ids"] if include_databases else []
    else:
        host_ids = reg["host_ids"]
        db_ids = reg["db_ids"] if include_databases else []

    vps = [await _build_vps_entry(hid, window, force) for hid in host_ids if hid]
    databases = [await _build_database_entry(did, window, force) for did in db_ids if did]

    detail = None
    if not infra_configured():
        detail = "DIGITALOCEAN_TOKEN não configurado"

    return {
        "configured": infra_configured(),
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "from_cache": False,
        "window_seconds": window,
        "interval_seconds": METRICS_INTERVAL_SEC,
        "detail": detail,
        "vps": vps,
        "databases": databases,
    }
