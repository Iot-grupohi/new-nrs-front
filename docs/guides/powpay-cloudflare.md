# Powpay / Cloudflare Tunnel (proxy local)

Proxy das rotas da collection **Lav60 Powpay - Cloudflare** via `lav60_api_server.py`.

Cada loja expõe um agente em `https://{loja}.powpay.com.br` (túnel Cloudflare). O servidor local repassa para esse host conforme o `{loja}` na URL.

## Configuração

No `.env`:

```env
POWPAY_DOMAIN_SUFFIX=powpay.com.br
CLOUDFLARE_API_TOKEN=seu_token_agente
PORT=3100
```

## Postman

Importe `postman/Lav60 Powpay - Cloudflare.postman_collection.json` e ajuste:

| `serverUrl` | `http://127.0.0.1:3100` |
| `storeCode` | ex.: `pb05` |
| `token` | mesmo valor de `CLOUDFLARE_API_TOKEN` |

URLs: `{{serverUrl}}/powpay/{{storeCode}}/health`

## Autenticação

| Rota local | Auth |
|------------|------|
| `GET /powpay/{loja}/`, `/health`, `/api/health`, `/api/agent/config`, `/debug` | não |
| `GET /powpay/{loja}/tunnel-status`, `/api/tunnel-status`, `/tunnel-test`, `/tunnel-monitoring` | não |
| Demais `/powpay/{loja}/*` | header `X-Token` = `CLOUDFLARE_API_TOKEN` |

Metadados: `GET /api/v1/powpay?store_code=pb05` (sem auth).

## Mapeamento

| Local | Upstream |
|-------|----------|
| `GET /powpay/pb05/health` | `GET https://pb05.powpay.com.br/health` |
| `GET /powpay/pb05/pb05/status` | `GET https://pb05.powpay.com.br/pb05/status` |
| `POST /powpay/pb05/pb05/washer/321` | `POST https://pb05.powpay.com.br/pb05/washer/321` |

## Exemplo

```powershell
curl http://127.0.0.1:3100/powpay/pb05/health
curl -H "X-Token: %CLOUDFLARE_API_TOKEN%" http://127.0.0.1:3100/powpay/pb05/pb05/status
```

> Use sempre o proxy local com **HTTP** — o túnel upstream é **HTTPS**. Evite chamar `http://` direto no domínio Powpay (POST pode perder o body no redirect).
