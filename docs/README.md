# Lav60 — API Clients

Documentação e ferramentas para integrar com a API da **Lavanderia 60 Minutos**.

**Servidor unificado:** `python lav60_api_server.py` → `http://127.0.0.1:3100` — [guia completo](./guides/servidor-unificado.md)

---

## Mapa da documentação

### Infraestrutura

| Documento | Conteúdo |
|-----------|----------|
| [servidor-unificado.md](./guides/servidor-unificado.md) | Domínio único, prefixos, tokens, Postman |
| [servidor-api-portal.md](./guides/servidor-api-portal.md) | Detalhes do proxy Portal + env |
| [totem-via-servidor.md](./guides/totem-via-servidor.md) | Totem pelo prefixo `/totem` |
| [collection-unificada.md](./guides/collection-unificada.md) | Postman Unified API |

### Totem — fluxo do cliente (compra)

| # | Guia | Script |
|---|------|--------|
| 1 | [Acesso à conta](./guides/acesso-conta-cliente.md) | `npm run access` |
| 2 | [Listar lojas](./guides/listar-lojas.md) | `npm run stores` |
| 3 | [Listar produtos](./guides/listar-produtos.md) | `npm run products` |
| 4 | [Validar cupom](./guides/validar-cupom.md) | `npm run coupon` |
| 5 | [Pagamento PIX](./guides/pagamento-pix.md) | `npm run pix` |
| 6 | [Venda no totem](./guides/venda-totem.md) | `npm run sale` |

### Portal — painel / relatórios (`X-Token` → `/api/v1`)

| Guia | Conteúdo |
|------|----------|
| [portal-lojas-maquinas.md](./guides/portal-lojas-maquinas.md) | Lojas, perfil, HiBank, máquinas |
| [relatorio-creditos-portal.md](./guides/relatorio-creditos-portal.md) | Compras de crédito + summary |

### Controle remoto — equipamentos

| Guia | Prefixo | Token |
|------|---------|-------|
| [controle-remoto-gateway.md](./guides/controle-remoto-gateway.md) | `/gateway` | `GATEWAY_API_TOKEN` |
| [controle-remoto-powpay.md](./guides/controle-remoto-powpay.md) | `/powpay/{loja}` | `CLOUDFLARE_API_TOKEN` |
| [gateway-mqtt.md](./guides/gateway-mqtt.md) | Referência técnica MQTT | |
| [powpay-cloudflare.md](./guides/powpay-cloudflare.md) | Referência técnica Powpay | |

### Security API — OAuth2 (`/totem/oauth`)

| Guia | Script |
|------|--------|
| [security-api-oauth.md](./guides/security-api-oauth.md) | — |
| [historico-vendas.md](./guides/historico-vendas.md) | `npm run sales:history` |

### Specs técnicas originais

| Documento | Endpoint |
|-----------|----------|
| [api-customers-auth-login.md](./api/api-customers-auth-login.md) | Login cliente |
| [api-customers-bubble-customer.md](./api/api-customers-bubble-customer.md) | Conta cliente |
| [api-get-stores.md](./api/api-get-stores.md) | Lojas (totem) |
| [api-products.md](./api/api-products.md) | Produtos |
| [api-coupons-code-validate.md](./api/api-coupons-code-validate.md) | Cupom |
| [api-payments-pix-to-hipag.md](./api/api-payments-pix-to-hipag.md) | PIX |
| [api-sales-totem_sales.md](./api/api-sales-totem_sales.md) | Venda |
| [api-report-credit-purchases.md](./api/api-report-credit-purchases.md) | Créditos (spec) |
| [api-clients.md](./api/api-clients.md) | OAuth2 + Next.js |

---

## Início rápido

### 1. Configurar `.env`

```env
LAV60_SERVER_URL=http://127.0.0.1:3100
PORT=3100

# Totem + OAuth
BASE_URL=https://staging.lavanderia60minutos.com.br
X_TOKEN=seu_x_token

# Portal
LAV60_UPSTREAM_URL=https://sistema.lavanderia60minutos.com.br

# Gateway MQTT
GATEWAY_API_TOKEN=seu_token_gateway

# Powpay / Cloudflare
CLOUDFLARE_API_TOKEN=seu_token_agente

# Cliente (scripts)
TAX_ID_NUMBER=
PASSWORD=

# OAuth Security API
CLIENT_ID=
CLIENT_SECRET=
OAUTH_SCOPE=report_read
```

### 2. Servidor unificado (Postman / integrações)

```powershell
pip install -r requirements.txt
python lav60_api_server.py
```

### 3. Scripts Node (totem direto ou via `/totem`)

```powershell
npm install
npm run access
```

---

## Fluxo do totem

```
Login + Conta → Lojas → Produtos → Cupom (opc.) → PIX ou Venda
```

Detalhes na tabela **Totem** acima.

---

## Collections Postman

### Collection unificada (recomendada)

| Arquivo | Descrição |
|---------|-----------|
| [Lav60-Unified-API](../postman/Lav60-Unified-API.postman_collection.json) | **Todas** as APIs em uma collection |
| [Lav60-Unified Environment](../postman/Lav60-Unified.postman_environment.json) | Variáveis de ambiente |

Guia: [collection-unificada.md](./guides/collection-unificada.md)

Regenerar:

```powershell
npm run postman:generate
npm run postman:simplify
```

### Collections individuais (12 arquivos)

Importe em **Postman → Import** se preferir collections separadas por contexto.

---

## Autenticação — resumo

| Contexto | Header | Variável `.env` |
|----------|--------|-----------------|
| Totem / Portal | `X-Token` | `X_TOKEN` |
| Cliente logado | `Authorization: Bearer {jwt}` | JWT do login |
| Gateway MQTT | `X-Token` | `GATEWAY_API_TOKEN` |
| Powpay agente | `X-Token` | `CLOUDFLARE_API_TOKEN` |
| OAuth relatórios | `Authorization: Bearer {access_token}` | `CLIENT_ID` + `CLIENT_SECRET` |

---

## Erros comuns

| Problema | Solução |
|----------|---------|
| `ENOTFOUND` / URL errada | Domínio: `lavanderia` (com **a**) |
| **401** totem/portal | `X-Token` inválido |
| **401** gateway | Use `GATEWAY_API_TOKEN`, não `X_TOKEN` |
| **401** powpay | Use `CLOUDFLARE_API_TOKEN` |
| **401** OAuth | `invalid_client` — credenciais Security API |
| **404** reports/sales | Rota não habilitada no staging |
| **400** PIX | Loja sem HiBank/HiPag |
| **400** venda | Código de máquina inválido — ver [portal-lojas-maquinas.md](./guides/portal-lojas-maquinas.md) |
| Porta 3100 ocupada | `taskkill` no PID ou mude `PORT` |

---

## Estrutura do projeto

```
Lav60-Api-clients/
├── server/                   # Python — gateway unificado
│   ├── app.py                # FastAPI principal
│   ├── gateway.py            # Proxy MQTT
│   ├── powpay.py             # Proxy Powpay
│   ├── totem.py              # Proxy totem/OAuth
│   └── routes.py             # Mapa de rotas
├── scripts/
│   ├── totem/                # CLI Node (fluxo cliente)
│   └── postman/              # Geradores de collection
├── docs/
│   ├── README.md             # Este índice
│   ├── guides/               # Guias práticos
│   └── api/                  # Specs técnicas
├── postman/                  # Collections + environment
├── lav60_api_server.py       # Entry point (compat.)
├── requirements.txt
├── package.json
└── .env
```

---

## Checklist de homologação

- [ ] `.env` com todos os tokens (`X_TOKEN`, `GATEWAY_API_TOKEN`, `CLOUDFLARE_API_TOKEN`)
- [ ] `python lav60_api_server.py` — `GET /api/routes` retorna 200
- [ ] `npm run access` — login e saldo OK
- [ ] Postman: environment **Lav60 Unified** importado
- [ ] Portal: `GET /api/v1/stores/PB05/profile`
- [ ] Totem: `GET /totem/api/v1/stores`
- [ ] Gateway: `GET /gateway/pb05/status`
- [ ] Powpay: `GET /powpay/pb05/health`
- [ ] Fluxo totem completo na loja alvo

---

## Ambientes upstream

| Nome | URL | Prefixo local |
|------|-----|---------------|
| Totem staging | `staging.lavanderia60minutos.com.br` | `/totem` |
| Portal sistema | `sistema.lavanderia60minutos.com.br` | `/api/v1` |
| MQTT Gateway | `gateway.lav60.com` | `/gateway` |
| Powpay loja | `{loja}.powpay.com.br` | `/powpay/{loja}` |
