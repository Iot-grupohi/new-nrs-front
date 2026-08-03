"""Incorpora service account Firebase no .env (JSON em uma linha)."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def _strip_firebase_file_lines(lines: list[str]) -> list[str]:
    out: list[str] = []
    for line in lines:
        key = line.split('=', 1)[0].strip()
        if key in {'FIREBASE_SERVICE_ACCOUNT_FILE', 'FIREBASE_SERVICE_ACCOUNT_JSON'}:
            continue
        out.append(line)
    return out


def merge_firebase_into_env(env_path: Path, json_path: Path | None) -> bool:
    lines = env_path.read_text(encoding='utf-8-sig').splitlines() if env_path.is_file() else []
    lines = _strip_firebase_file_lines(lines)
    if not json_path or not json_path.is_file():
        env_path.write_text('\n'.join(lines).rstrip() + '\n', encoding='utf-8')
        return False
    compact = json.dumps(
        json.loads(json_path.read_text(encoding='utf-8')),
        separators=(',', ':'),
        ensure_ascii=True,
    )
    if lines and lines[-1].strip():
        lines.append('')
    lines.append('# Firebase service account (incorporado no build — nao use arquivo .json separado)')
    lines.append(f'FIREBASE_SERVICE_ACCOUNT_JSON={compact}')
    env_path.write_text('\n'.join(lines).rstrip() + '\n', encoding='utf-8')
    return True


def find_repo_firebase_json(repo_root: Path) -> Path | None:
    for candidate in sorted(repo_root.glob('portal-franqueado-*-firebase-adminsdk-*.json')):
        if candidate.is_file():
            return candidate
    return None


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print('Uso: merge_env_firebase.py <env> [firebase.json]', file=sys.stderr)
        return 2
    env_path = Path(argv[1])
    json_path = Path(argv[2]) if len(argv) > 2 and argv[2] else None
    if json_path is None:
        json_path = find_repo_firebase_json(env_path.resolve().parents[1])
    ok = merge_firebase_into_env(env_path, json_path)
    if not ok:
        print('Aviso: JSON Firebase nao encontrado — .env sem FIREBASE_SERVICE_ACCOUNT_JSON', file=sys.stderr)
        return 1
    print(f'Firebase incorporado em {env_path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
