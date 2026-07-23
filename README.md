# Lav60 Unified API Gateway

Servidor unificado local que concentra todas as APIs Lav60 (Portal, Totem, MQTT Gateway e Powpay Cloudflare) em um único domínio.

## Início rápido

```powershell
pip install -r requirements.txt

# Backend (API) — porta 3100
python backend/main.py

# Frontend (painel) — porta 8080, proxy /api → backend
python frontend/dev_server.py

# Ou ambos de uma vez:
.\serve.ps1
```

| Serviço | URL | Descrição |
|---------|-----|-----------|
| **Frontend** | http://127.0.0.1:8080 | Painel operacional (HTML/JS) |
| **Backend** | http://127.0.0.1:3100 | API unificada (Portal, Totem, Gateway, Powpay) |

Mapa de rotas da API: `GET http://127.0.0.1:3100/api/routes`

## Documentação

- [docs/README.md](docs/README.md) — índice completo
- [docs/guides/servidor-unificado.md](docs/guides/servidor-unificado.md) — arquitetura e prefixos
- [docs/guides/collection-unificada.md](docs/guides/collection-unificada.md) — Postman Unified API

## Postman

Importe:

- `postman/Lav60-Unified-API.postman_collection.json`
- `postman/Lav60-Unified.postman_environment.json`

## Configuração

Copie `.env.example` para `.env` e preencha os tokens:

| Variável | Uso |
|----------|-----|
| `X_TOKEN` | Portal + Totem |
| `GATEWAY_API_TOKEN` | MQTT Gateway |
| `CLOUDFLARE_API_TOKEN` | Powpay / Cloudflare |

## Prefixos

| Prefixo | Upstream |
|---------|----------|
| `/api/v1/*` | sistema.lavanderia60minutos.com.br |
| `/totem/*` | staging.lavanderia60minutos.com.br |
| `/gateway/*` | gateway.lav60.com |
| `/powpay/{loja}/*` | {loja}.powpay.com.br |

## Scripts Node (totem)

```powershell
npm install
npm run access
```

## Estrutura

```
├── backend/             # API Python (FastAPI)
│   ├── main.py          # Entrada: python backend/main.py
│   ├── panel/           # Rotas do painel (/api/auth, /api/catalog, …)
│   └── server/          # Proxy Portal, Totem, Gateway, Powpay
├── frontend/            # Painel operacional (HTML/JS estático)
│   ├── dev_server.py    # Entrada: python frontend/dev_server.py
│   ├── config.js        # apiBase para deploy separado
│   └── *.html, *.js     # UI do painel
├── scripts/totem/       # CLI Node (fluxo cliente)
├── scripts/postman/     # Geradores Postman
├── docs/guides/         # Guias práticos
├── docs/api/            # Specs técnicas
├── postman/             # Collections
└── serve.ps1            # Inicia backend + frontend
```

## Repositório

https://github.com/Iot-grupohi/api_gateway_lav60
