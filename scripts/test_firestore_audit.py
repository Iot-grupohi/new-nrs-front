#!/usr/bin/env python3
"""Testa gravação no Cloud Firestore (mesma config do painel LAV60).

Requisitos:
  1. pip install -r requirements.txt
  2. FIREBASE_* no .env (mesmo projeto do login)
  3. FIREBASE_SERVICE_ACCOUNT_FILE apontando para o JSON da service account
     (Firebase Console → Configurações → Contas de serviço → Gerar nova chave privada)

Uso:
  python scripts/test_firestore_audit.py
  python scripts/test_firestore_audit.py --store pb05 --list 3
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'backend'))

from lav60_env import env_value, load_local_env  # noqa: E402
from panel_audit import (  # noqa: E402
    audit_collection,
    audit_logging_available,
    log_audit_event,
)

load_local_env()


def fail(message: str, code: int = 1) -> None:
    print(f'ERRO: {message}', file=sys.stderr)
    sys.exit(code)


def check_config() -> None:
    if not env_value('FIREBASE_PROJECT_ID'):
        fail('FIREBASE_PROJECT_ID ausente no .env')
    service_file = env_value('FIREBASE_SERVICE_ACCOUNT_FILE')
    if not service_file:
        fail(
            'Defina FIREBASE_SERVICE_ACCOUNT_FILE no .env\n'
            'Ex.: FIREBASE_SERVICE_ACCOUNT_FILE=C:\\caminho\\hipag-02-firebase-adminsdk.json'
        )
    if not Path(service_file).is_file():
        fail(f'Arquivo da service account não encontrado: {service_file}')
    if not audit_logging_available():
        fail('Firebase Admin não inicializou — verifique o JSON da service account')


def write_test_event(store: str, note: str) -> str:
    ok, err = log_audit_event(
        {'uid': 'test-script', 'email': 'firestore-test@local'},
        {
            'store': store,
            'action': 'test_write',
            'label': note,
            'method': 'POST',
            'path': '/scripts/test_firestore_audit.py',
            'success': True,
            'payload': {'source': 'test_firestore_audit.py', 'note': note},
            'meta': {'kind': 'connectivity_test'},
        },
    )
    if not ok:
        fail(err or 'Falha ao gravar no Firestore')
    return audit_collection()


def list_recent(collection: str, limit: int) -> list[dict]:
    from firebase_admin import firestore

    client = firestore.client()
    query = (
        client.collection(collection)
        .order_by('ts_ms', direction=firestore.Query.DESCENDING)
        .limit(limit)
    )
    rows: list[dict] = []
    for doc in query.stream():
        data = doc.to_dict() or {}
        data['_id'] = doc.id
        rows.append(data)
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description='Testa gravação no Firestore do painel LAV60')
    parser.add_argument(
        '--store',
        default=env_value('STORE_ID', 'pb05').lower(),
        help='ID da loja no registro de teste (padrão: STORE_ID do .env)',
    )
    parser.add_argument(
        '--note',
        default='Teste de conectividade Firestore',
        help='Texto gravado no campo label',
    )
    parser.add_argument(
        '--list',
        type=int,
        default=3,
        metavar='N',
        help='Lista os N registros mais recentes após gravar (0 = não listar)',
    )
    args = parser.parse_args()

    print(f'Projeto Firebase: {env_value("FIREBASE_PROJECT_ID")}')
    check_config()
    collection = audit_collection()
    print(f'Coleção: {collection}')

    write_test_event(args.store.lower(), args.note)
    print('OK — documento gravado no Firestore')

    if args.list > 0:
        docs = list_recent(collection, args.list)
        print(f'\nÚltimos {len(docs)} registro(s):')
        print(json.dumps(docs, ensure_ascii=False, indent=2, default=str))


if __name__ == '__main__':
    main()
