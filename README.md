# LAV60 Gateway + Painel

Sistema para operação remota de lavanderias self-service: um **agente** roda na loja (comandos na rede local + túnel Cloudflare) e um **painel web** centraliza status, operação e auditoria.

## Arquitetura

```
Operador (browser)
       │
       ▼
┌──────────────────┐     heartbeat (~15 s)     ┌──────────────────┐
│  Painel :3000    │ ◄──────────────────────── │  Agente :8080    │
│  panel_server.py │                           │  proxy_server.py │
│  frontend/       │     comandos REST         │  ESP8266 / rede  │
└────────┬─────────┘ ────────────────────────► └──────────────────┘
         │
         ▼
   Cloud Firestore (audit_logs)
   Firebase Auth (login opcional)
```

| Componente | Arquivo principal | Porta padrão |
|------------|-------------------|--------------|
| Painel | `backend/panel_server.py` | `3000` |
| Agente | `backend/proxy_server.py` | `8080` |

O painel serve o frontend estático (`frontend/`), recebe heartbeats dos agentes e grava auditoria no Firestore. O agente expõe a API REST que fala com lavadoras, secadoras, dosadoras e ar-condicionado na rede local.

## Pré-requisitos

- Python 3.10+
- Dependências: `pip install -r requirements.txt`
- Arquivo `.env` na raiz do projeto (copie variáveis do exemplo em [docs/API.md](./docs/API.md#variáveis-env-principais))
- `frontend/stores.json` — catálogo de lojas do painel
- Firebase (opcional): login de operadores + auditoria Firestore

## Subir localmente

### Painel (frontend + hub de heartbeat)

```powershell
.\scripts\serve.ps1
```

O script valida se a porta `3000` (ou `FRONTEND_PORT`) está livre antes de iniciar. Acesse `http://localhost:3000`.

### Agente (gateway da loja)

```powershell
python backend/proxy_server.py
```

Ou `LAV60_Gateway.exe` / `scripts\Iniciar_Gateway.bat` em produção na loja.

> **Importante:** não rode dois `panel_server.py` na mesma porta — o processo antigo pode não ter Firebase configurado e a auditoria falha silenciosamente.

## Páginas do painel

| Página | Arquivo | Função |
|--------|---------|--------|
| Dashboard | `index.html` | Lista de lojas, status online/offline via heartbeat |
| Loja | `store.html?store=pb05` | Operação de equipamentos |
| Registros | `records.html` | Histórico de auditoria (Firestore) |
| Login | `login.html` | Autenticação Firebase (se habilitada) |

Detalhes da interface operacional: **[docs/PANEL.md](./docs/PANEL.md)**.

Endpoints das dosadoras: **[docs/DOSADORAS.md](./docs/DOSADORAS.md)**.

## API

Referência HTTP dos dois serviços: **[docs/API.md](./docs/API.md)**.

## Estrutura do projeto

```
agent_cloudflare/
├── backend/
│   ├── panel_server.py    # Painel Flask
│   ├── panel_auth.py      # Firebase Auth
│   ├── panel_audit.py     # Firestore auditoria
│   ├── proxy_server.py    # Agente gateway
│   └── lav60_env.py       # Leitura do .env
├── frontend/
│   ├── index.html         # Dashboard
│   ├── store.html         # Operação da loja
│   ├── records.html       # Registros
│   ├── api.js             # Cliente HTTP / heartbeat
│   ├── store.js           # Lógica da loja
│   └── stores.json        # Catálogo de lojas
├── config/
│   └── config.yml         # Túnel Cloudflare (agente)
├── docs/
│   ├── API.md
│   ├── DOSADORAS.md
│   └── PANEL.md
├── scripts/
│   ├── serve.ps1          # Sobe o painel
│   └── test_firestore_audit.py
├── .env
└── requirements.txt
```

## Auditoria

Operações no painel (liberar, acionar, consultas, login) podem ser gravadas na coleção Firestore `audit_logs`.

Teste rápido:

```powershell
python scripts/test_firestore_audit.py
python scripts/test_firestore_audit.py --store pb05 --list 5
```

Configure no `.env`:

```env
FIREBASE_SERVICE_ACCOUNT_FILE=caminho/para/service-account.json
FIREBASE_AUDIT_COLLECTION=audit_logs
```

## Build

```powershell
.\scripts\build.ps1
```

Gera `dist\LAV60_Gateway.exe` via PyInstaller. O **`.env` da raiz do projeto é embutido no executável** no momento do build — na loja basta copiar **um único arquivo**.

Para outra loja ou token diferente, edite o `.env` e rode o build de novo.

## Painel em VPS

Para publicar o frontend + API do painel em um servidor Linux: **[docs/DEPLOY_VPS.md](docs/DEPLOY_VPS.md)**.
