# Servidor API Portal + MQTT Gateway (Python)

Proxy local que expõe:

1. **API Portal** — collection **Lav60 Api Portal - Python** → `sistema.lavanderia60minutos.com.br`
2. **MQTT Gateway** — collection **Lav60 Gateway - MQTT** → `gateway.lav60.com` (prefixo `/gateway`)
3. **Powpay / Cloudflare** — collection **Lav60 Powpay - Cloudflare** → `{loja}.powpay.com.br` (prefixo `/powpay/{loja}`)
4. **Totem / OAuth** — collections totem + Security → `staging` (prefixo `/totem`)

Ver [servidor-unificado.md](./servidor-unificado.md) como ponto de entrada principal.

Guias práticos: [portal-lojas-maquinas.md](./portal-lojas-maquinas.md), [relatorio-creditos-portal.md](./relatorio-creditos-portal.md), [totem-via-servidor.md](./totem-via-servidor.md).

## Pré-requisitos

- Python 3.10+
- Token `X-Token` válido para o sistema (portal)

## Configuração

No `.env` da raiz do projeto:

```env
# Upstream do portal (para onde o proxy repassa)
LAV60_UPSTREAM_URL=https://sistema.lavanderia60minutos.com.br

# Token enviado ao upstream e exigido nas requisições locais (header X-Token)
# Ordem de leitura: LAV60_API_TOKEN → X_TOKEN → X_TOKEN_API
# LAV60_API_TOKEN=seu_token_portal

# Onde o servidor Python escuta localmente
PORT=3100

# MQTT Gateway (prefixo /gateway)
LAV60_GATEWAY_URL=https://gateway.lav60.com
GATEWAY_API_TOKEN=seu_token_gateway

# Powpay / Cloudflare (prefixo /powpay/{loja})
POWPAY_DOMAIN_SUFFIX=powpay.com.br
CLOUDFLARE_API_TOKEN=seu_token_agente
```

### Quatro upstreams

| Variável | Destino | Prefixo local |
|----------|---------|---------------|
| `BASE_URL` | `staging.lavanderia60minutos.com.br` | `/totem/*` |
| `LAV60_UPSTREAM_URL` | `sistema.lavanderia60minutos.com.br` | `/api/v1/*` |
| `LAV60_GATEWAY_URL` | `gateway.lav60.com` | `/gateway/*` |
| `POWPAY_DOMAIN_SUFFIX` | `https://{loja}.powpay.com.br` | `/powpay/{loja}/*` |

> O domínio correto é `lavanderia` (com **a**), não `lavenderia`.

Veja também `.env.example` na raiz do projeto.

## Instalação e execução

```powershell
pip install -r requirements.txt
python lav60_api_server.py
```

Servidor disponível em `http://127.0.0.1:3100`.

## Postman

Importe `postman/Lav60 Api Portal - Python.postman_collection.json`. Variáveis:

| Variável | Valor |
|----------|-------|
| `baseUrl` | `http://127.0.0.1:3100` |
| `token` | mesmo valor de `X_TOKEN` |
| `storeCode` | ex.: `PB05` |

## Endpoints

| Rota | Auth | Descrição |
|------|------|-----------|
| `GET /health` | não | Status do servidor |
| `GET /api/v1/upstream` | não | URLs do upstream |
| `GET /api/v1/stores/codes` | sim | Códigos de loja (`?force=1`, `?parsed=0`) |
| `GET /api/v1/stores/{code}` | sim | Detalhe da loja |
| `GET /api/v1/stores/{code}/profile` | sim | Loja + HiBank (composto localmente) |
| `GET /api/v1/hi-banks/account` | sim | Status HiBank da loja |
| `GET /api/v1/machines` | sim | Máquinas da loja |
| `GET /api/v1/report_credit_purchases` | sim | Compras de crédito (`?all=1`, `?raw=1`) |
| `GET /api/v1/report_credit_purchases/summary` | sim | Resumo com comparação (`?compare=0\|1`) |

Todas as rotas protegidas exigem header `X-Token`.

## Exemplo cURL

```powershell
curl -H "X-Token: %X_TOKEN%" "http://127.0.0.1:3100/api/v1/stores/PB05/profile"
```
