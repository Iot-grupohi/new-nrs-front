#!/usr/bin/env python3
"""Apaga todos os registros da coleção de auditoria no Firestore."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from dotenv import load_dotenv

load_dotenv(ROOT / ".env")

from panel.audit_store import audit_status, clear_all_logs  # noqa: E402


def main() -> int:
    status = audit_status()
    if not status.get("available"):
        print("Auditoria indisponível:", status)
        return 1

    collection = status.get("collection") or "audit_logs"
    if "--yes" not in sys.argv:
        print(f"Isso apagará TODOS os registros em '{collection}'.")
        print("Execute novamente com --yes para confirmar.")
        return 2

    result = clear_all_logs()
    print(f"OK — removidos {result.get('deleted', 0)} documentos de '{collection}'.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
