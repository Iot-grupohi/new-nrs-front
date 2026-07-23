"""CLI — CPU do droplet via DigitalOcean (usa backend/panel_infra.py)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'backend'))

from lav60_env import env_value, load_local_env
from panel_infra import do_token, fetch_cpu_metrics, infra_configured

load_local_env()


def format_ts(epoch: int) -> str:
    import time

    return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(epoch))


def print_report(metrics: dict) -> None:
    cpu = metrics.get('cpu') or metrics
    latest = cpu.get('latest_percent')
    avg = cpu.get('average_percent')

    print(f"Host ID: {cpu.get('host_id') or env_value('HOST_ID')}")
    print(
        f"Periodo (ultimo intervalo): {format_ts(cpu['period_start'])} -> "
        f"{format_ts(cpu['period_end'])} ({cpu['interval_seconds']} s)"
    )
    print(f"Amostras na janela: {cpu['samples']} ({cpu['intervals']} intervalos)")

    if latest is None:
        print('CPU utilizada (ultimo intervalo): indisponivel')
    else:
        print(f'CPU utilizada (ultimo intervalo): {latest:.2f}%')

    if avg is not None:
        print(f'CPU media (janela): {avg:.2f}%')

    breakdown = cpu.get('breakdown_pct') or {}
    if breakdown:
        print('\nDistribuicao no ultimo intervalo:')
        for mode, value in breakdown.items():
            print(f'  {mode:8s}: {value:5.2f}%')


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='CPU do droplet via DigitalOcean Monitoring API')
    parser.add_argument('--window', type=int, default=900, help='Janela em segundos (padrao: 900)')
    parser.add_argument('--json', action='store_true', help='Saida JSON')
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not infra_configured():
        print('DIGITALOCEAN_TOKEN nao configurado', file=sys.stderr)
        return 1

    host_id = (env_value('HOST_ID') or '').strip()
    if not host_id:
        print('HOST_ID nao configurado', file=sys.stderr)
        return 1

    try:
        metrics = fetch_cpu_metrics(host_id, max(300, args.window))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps({'cpu': metrics, 'host_id': host_id, 'token_set': bool(do_token())}, indent=2))
    else:
        print_report({'cpu': metrics})

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
