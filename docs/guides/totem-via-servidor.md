# Totem via servidor unificado

Os guias práticos do totem (`acesso-conta-cliente`, `listar-lojas`, etc.) foram escritos com a URL direta do staging. Pelo **servidor unificado**, use o mesmo path com o prefixo `/totem`.

## URL base

| Modo | URL |
|------|-----|
| Direto (scripts Node) | `https://staging.lavanderia60minutos.com.br` |
| Via servidor local | `http://127.0.0.1:3100/totem` |

## Equivalência de endpoints

| Guia | Endpoint direto | Via servidor |
|------|-----------------|--------------|
| [Acesso à conta](./acesso-conta-cliente.md) | `POST /api/v1/customers/auth/login` | `POST /totem/api/v1/customers/auth/login` |
| [Listar lojas](./listar-lojas.md) | `GET /api/v1/stores` | `GET /totem/api/v1/stores` |
| [Listar produtos](./listar-produtos.md) | `GET /api/v1/products` | `GET /totem/api/v1/products` |
| [Validar cupom](./validar-cupom.md) | `POST /api/v1/coupons/{code}/validate` | `POST /totem/api/v1/coupons/{code}/validate` |
| [Pagamento PIX](./pagamento-pix.md) | `POST /api/v1/payments/pix_to_hipag` | `POST /totem/api/v1/payments/pix_to_hipag` |
| [Venda totem](./venda-totem.md) | `POST /api/v1/sales/totem_sales` | `POST /totem/api/v1/sales/totem_sales` |
| [Histórico vendas / OAuth](./historico-vendas.md) | `POST /oauth/token` | `POST /totem/oauth/token` |

## Autenticação

| Header | Quando |
|--------|--------|
| `X-Token` | Igual ao totem direto — valor do `.env` (`X_TOKEN`) |
| `Authorization: Bearer {jwt}` | Login do cliente, PIX, venda, conta |

O servidor valida o `X-Token` recebido e repassa ao staging. O JWT do cliente continua sendo enviado pelo Postman/script.

## Postman

Collection totem: `base_url` = `http://127.0.0.1:3100/totem`

Environment unificado: `postman/Lav60-Unified.postman_environment.json`

## Exemplo

```powershell
# Listar lojas via servidor
curl -H "X-Token: %X_TOKEN%" http://127.0.0.1:3100/totem/api/v1/stores

# OAuth via servidor
curl -X POST http://127.0.0.1:3100/totem/oauth/token ^
  -H "Content-Type: application/x-www-form-urlencoded" ^
  -d "grant_type=client_credentials" ^
  -d "client_id=%CLIENT_ID%" ^
  -d "client_secret=%CLIENT_SECRET%" ^
  -d "scope=report_read"
```

## Scripts Node

Os scripts (`npm run access`, `npm run stores`, etc.) usam `BASE_URL` do `.env` diretamente no staging. Para passá-los pelo servidor, altere temporariamente:

```env
BASE_URL=http://127.0.0.1:3100/totem
```

> O servidor adiciona `/totem` no proxy — `BASE_URL` deve ser `http://127.0.0.1:3100/totem`, **não** `http://127.0.0.1:3100`.

Ver [servidor-unificado.md](./servidor-unificado.md).
