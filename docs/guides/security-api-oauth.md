# Security API — OAuth2 e relatórios

Integração backend com **OAuth2 Client Credentials** (escopo `report_read`) para relatórios de vendas, clientes e compras de crédito.

---

## Visão geral

```
1. POST /oauth/token              → access_token (~2h)
2. GET  /api/v1/reports/sales     → vendas
3. GET  /api/v1/reports/customers → clientes
4. GET  /api/v1/reports/credit_purchases → compras (OAuth)
```

Via servidor unificado:

```
POST http://127.0.0.1:3100/totem/oauth/token
GET  http://127.0.0.1:3100/totem/api/v1/reports/sales
```

---

## Credenciais

No `.env` — **diferentes** do totem:

```env
CLIENT_ID=seu_client_id
CLIENT_SECRET=seu_client_secret
OAUTH_SCOPE=report_read
```

O `X_TOKEN` do totem **não substitui** OAuth.

---

## Passo 1 — Obter token

```powershell
curl -X POST http://127.0.0.1:3100/totem/oauth/token ^
  -H "Content-Type: application/x-www-form-urlencoded" ^
  -d "grant_type=client_credentials" ^
  -d "client_id=%CLIENT_ID%" ^
  -d "client_secret=%CLIENT_SECRET%" ^
  -d "scope=report_read"
```

Resposta:

```json
{
  "access_token": "...",
  "token_type": "Bearer",
  "expires_in": 7200,
  "scope": "report_read"
}
```

> Rota `/oauth/token` **não exige** `X-Token` no proxy local.

---

## Passo 2 — Relatórios

```powershell
curl -H "Authorization: Bearer %ACCESS_TOKEN%" ^
  "http://127.0.0.1:3100/totem/api/v1/reports/sales?store_code=PB05"
```

O proxy repassa o header `Authorization` ao staging.

---

## Endpoints

| Endpoint | Descrição |
|----------|-----------|
| `GET /api/v1/reports/sales` | Vendas por loja/período |
| `GET /api/v1/reports/customers` | Clientes |
| `GET /api/v1/reports/credit_purchases` | Compras (via OAuth) |
| `GET /api/v1/integrations/health` | Saúde da integração |

---

## Status em staging (testado)

| Endpoint | Resultado |
|----------|-----------|
| `POST /oauth/token` | Funciona com credenciais válidas |
| `GET /reports/sales` | **404** — pode não estar habilitado |
| `401 invalid_client` | Credenciais OAuth incorretas ou não liberadas |

Se **404**, solicite habilitação ao suporte Lav60.

---

## Script Node

```powershell
npm run oauth:test
npm run sales:history
```

Ver [historico-vendas.md](./historico-vendas.md) para histórico de vendas.

---

## Alternativa com X-Token (Portal)

Relatório de compras de crédito **sem OAuth**:

```
GET http://127.0.0.1:3100/api/v1/report_credit_purchases?store_code=PB05
Header: X-Token
```

Ver [relatorio-creditos-portal.md](./relatorio-creditos-portal.md).

---

## Postman

Collections: **Lav60-Security-API**, **Lav60-API-Clients**

`base_url` = `http://127.0.0.1:3100/totem`

---

## Referências

- [api-clients.md](../api/api-clients.md) — spec completa + Next.js
- [totem-via-servidor.md](./totem-via-servidor.md)
- [servidor-unificado.md](./servidor-unificado.md)
