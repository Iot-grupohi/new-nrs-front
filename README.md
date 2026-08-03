# Lav60 Unified API Gateway

Servidor unificado local que concentra as APIs Lav60 (Portal, Totem e **MQTT Gateway**). Agentes locais Powpay permanecem desativados; operação remota via `gateway.lav60.com`.

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
| **Backend** | http://127.0.0.1:3100 | API unificada (Portal, Totem, MQTT Gateway) |

Mapa de rotas da API: `GET http://127.0.0.1:3100/api/routes`

## Configuração

Copie `.env.example` para `.env` e preencha os tokens:

| Variável | Uso |
|----------|-----|
| `X_TOKEN` | Portal + Totem |
| `GATEWAY_API_TOKEN` | MQTT Gateway (`gateway.lav60.com`) |
| `LAV60_GATEWAY_URL` | URL base do gateway (default `https://gateway.lav60.com`) |

## Prefixos

| Prefixo | Upstream |
|---------|----------|
| `/api/v1/*` | sistema.lavanderia60minutos.com.br |
| `/totem/*` | staging.lavanderia60minutos.com.br |
| `/gateway/*` | gateway.lav60.com (MQTT) |
| `/api/gateway/*` | Proxy MQTT autenticado (painel) |
| `/api/catalog` | Catálogo de lojas (painel) |

## Estrutura

```
├── backend/             # API Python (FastAPI)
│   ├── main.py          # Entrada: python backend/main.py
│   ├── panel/           # Rotas do painel (/api/auth, /api/catalog, …)
│   └── server/          # Proxy Portal e Totem
├── frontend/            # Painel operacional (HTML/JS estático)
├── deploy/              # systemd, nginx, scripts VPS
├── serve.ps1            # Inicia backend + frontend
├── requirements.txt
└── .env.example
```

## Repositório

https://github.com/Iot-grupohi/api_gateway_lav60
