"""Ponto de entrada do executável — captura erros de import e startup."""
from __future__ import annotations

import sys
import traceback
from pathlib import Path


def _bootstrap_backend_path() -> None:
    """Garante import de proxy_server/lav60_env ao rodar fonte ou frozen."""
    if getattr(sys, 'frozen', False):
        base = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parent))
    else:
        base = Path(__file__).resolve().parent
    path = str(base)
    if path not in sys.path:
        sys.path.insert(0, path)


_bootstrap_backend_path()

from proxy_server import run_server  # noqa: E402


def _app_data_dir() -> Path:
    d = Path.home() / '.lav60'
    d.mkdir(parents=True, exist_ok=True)
    return d


def _write_crash(text: str) -> Path:
    path = _app_data_dir() / 'lav60_crash.log'
    try:
        path.write_text(text, encoding='utf-8')
    except Exception:
        pass
    return path


def _pause(message: str = '') -> None:
    if message:
        print(message, file=sys.stderr)
    try:
        input('\nPressione Enter para fechar...')
    except (EOFError, KeyboardInterrupt):
        pass


def main() -> None:
    run_server()


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        tb = traceback.format_exc()
        crash_path = _write_crash(tb)
        print('\n' + '=' * 60, file=sys.stderr)
        print('LAV60 Gateway — ERRO FATAL', file=sys.stderr)
        print('=' * 60, file=sys.stderr)
        print(tb, file=sys.stderr)
        print('=' * 60, file=sys.stderr)
        print(f'Log: {crash_path}', file=sys.stderr)
        _pause()
        sys.exit(1)
