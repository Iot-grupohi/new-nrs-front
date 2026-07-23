# Histórico de vendas (Security API)

Consulta vendas **já realizadas** via OAuth2 — endpoint de integração backend, **não** é o catálogo do totem.

---

## Diferença importante

| O que você viu no `npm run sale` | Este documento |
|----------------------------------|----------------|
| Catálogo de produtos (o que **pode** comprar) | Vendas **já feitas** |
| `GET /products` | `GET /reports/sales` |
| `X-Token` + JWT do cliente | OAuth2 `CLIENT_ID` + `CLIENT_SECRET` |

---

## Pré-requisitos

Credenciais **diferentes** do totem:

| Variável | Descrição |
|----------|-----------|
| `CLIENT_ID` | Security API no painel Lav60 |
| `CLIENT_SECRET` | Secret da Security API |
| `OAUTH_SCOPE` | `report_read` (padrão) |

No `.env`:

```env
BASE_URL=https://staging.lavanderia60minutos.com.br
CLIENT_ID=seu_client_id
CLIENT_SECRET=seu_client_secret
OAUTH_SCOPE=report_read
STORE_CODE=PB05
```

> O `X-Token` do totem **não serve** para este relatório.

---

## Fluxo

```
1. POST /oauth/token     → access_token (2h)
2. GET /reports/sales    → vendas filtradas
```

---

## Script

```powershell
npm run sales:history
npm run sales:history -- --store PB05 --start 01/01/2026 --end 31/03/2026
npm run sales:history -- --customer UUID_DO_CLIENTE --store PB05
```

### Filtros opcionais

| Parâmetro | Formato | Descrição |
|-----------|---------|-----------|
| `--store` | `PB05` | Código da loja |
| `--customer` | UUID | Cliente (se o backend suportar) |
| `--start` | `DD/MM/YYYY` | Data inicial |
| `--end` | `DD/MM/YYYY` | Data final |
| `--page` | número | Paginação |
| `--per-page` | número | Itens por página |

---

## Status em staging (testado)

| Endpoint | Resultado |
|----------|-----------|
| `POST /oauth/token` | Funciona (exige credenciais válidas) |
| `GET /api/v1/reports/sales` | **404** — rota não disponível neste staging |
| `GET /api/v1/integrations/health` | Existe (401 sem token válido) |

Se receber **404**, a rota de vendas ainda não está habilitada no ambiente — solicite ao suporte Lav60.

---

## Exemplo cURL

```bash
# 1. Token OAuth (via servidor unificado)
curl -X POST "http://127.0.0.1:3100/totem/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=SEU_CLIENT_ID" \
  -d "client_secret=SEU_CLIENT_SECRET" \
  -d "scope=report_read"

# 2. Relatório de vendas
curl -X GET "http://127.0.0.1:3100/totem/api/v1/reports/sales?store_code=PB05" \
  -H "Authorization: Bearer SEU_ACCESS_TOKEN" \
  -H "Accept: application/json"
```

URL direta staging (sem proxy): troque `http://127.0.0.1:3100/totem` por `https://staging.lavanderia60minutos.com.br`.

Ver [security-api-oauth.md](./security-api-oauth.md) e [totem-via-servidor.md](./totem-via-servidor.md).

---

## Postman

Collection: `postman/Lav60-Security-API.postman_collection.json`

1. **OAuth2 - Obter Access Token**
2. **Sales**

---

## Alternativa com X-Token (compras de crédito, não vendas)

Relatório de **compras de crédito** (PIX, cartão etc.), não lavagens:

```
GET /api/v1/report_credit_purchases?store_code=PB05
Header: X-Token
```

Documentação: [relatorio-creditos-portal.md](./relatorio-creditos-portal.md) (guia prático) · [api-report-credit-purchases.md](../api/api-report-credit-purchases.md) (spec)

---

## Referências

- [Security API (OAuth2)](../api/api-clients.md)
- [Venda no totem](./venda-totem.md) — criar venda nova
- [Listar produtos](./listar-produtos.md) — catálogo (não é histórico)
