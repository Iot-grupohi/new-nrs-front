# Servidor unificado Lav60

Um único endereço local (`http://127.0.0.1:3100`) concentra **todas** as APIs. O servidor repassa cada chamada ao upstream correto.

## Início

```powershell
pip install -r requirements.txt
python lav60_api_server.py
```

Descoberta de rotas:

```powershell
curl http://127.0.0.1:3100/
curl http://127.0.0.1:3100/api/routes
```

## Mapa de prefixos

| Prefixo local | Upstream | Token (`.env`) | Collections Postman |
|---------------|----------|----------------|---------------------|
| `/api/v1/*` | `sistema.lavanderia60minutos.com.br` | `X_TOKEN` | Lav60 Api Portal - Python |
| `/totem/*` | `staging.lavanderia60minutos.com.br` | `X_TOKEN` | Acesso, Lojas, Produtos, Cupom, PIX, Venda, Security, API-Clients |
| `/gateway/*` | `gateway.lav60.com` | `GATEWAY_API_TOKEN` | Lav60 Gateway - MQTT |
| `/powpay/{loja}/*` | `{loja}.powpay.com.br` | `CLOUDFLARE_API_TOKEN` | Lav60 Powpay - Cloudflare |

## Postman — variáveis (simplificado)

Importe `postman/Lav60-Unified.postman_environment.json`.

| Variável | Exemplo | Uso |
|----------|---------|-----|
| `serverUrl` | `http://127.0.0.1:3100` | Base única |
| `storeCode` | `pb05` | Loja (minúsculas) |
| `x_token` | `.env` | Portal + Totem |
| `gateway_token` | `.env` | MQTT |
| `cloudflare_token` | `.env` | Powpay |

Trocar de loja = alterar só **`storeCode`**.

## Exemplos

```powershell
# Portal
curl -H "X-Token: %X_TOKEN%" http://127.0.0.1:3100/api/v1/stores/PB05

# Totem
curl -H "X-Token: %X_TOKEN%" http://127.0.0.1:3100/totem/api/v1/stores

# Gateway
curl -H "X-Token: %GATEWAY_API_TOKEN%" http://127.0.0.1:3100/gateway/pb05/status

# Powpay
curl -H "X-Token: %CLOUDFLARE_API_TOKEN%" http://127.0.0.1:3100/powpay/pb05/pb05/status
```

## `.env`

```env
LAV60_SERVER_URL=http://127.0.0.1:3100
X_TOKEN=...
GATEWAY_API_TOKEN=...
CLOUDFLARE_API_TOKEN=...
BASE_URL=https://staging.lavanderia60minutos.com.br
LAV60_UPSTREAM_URL=https://sistema.lavanderia60minutos.com.br
```

Veja também: [servidor-api-portal.md](./servidor-api-portal.md), [portal-lojas-maquinas.md](./portal-lojas-maquinas.md), [relatorio-creditos-portal.md](./relatorio-creditos-portal.md), [totem-via-servidor.md](./totem-via-servidor.md), [controle-remoto-gateway.md](./controle-remoto-gateway.md), [controle-remoto-powpay.md](./controle-remoto-powpay.md), [security-api-oauth.md](./security-api-oauth.md).
