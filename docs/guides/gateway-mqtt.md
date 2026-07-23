# MQTT Gateway (proxy local)

Proxy das rotas da collection **Lav60 Gateway - MQTT** via `lav60_api_server.py`.

## Configuração

No `.env`:

```env
LAV60_GATEWAY_URL=https://gateway.lav60.com
GATEWAY_API_TOKEN=seu_token_gateway
PORT=3100
```

O servidor expõe o gateway em **`http://127.0.0.1:3100/gateway`**.

## Postman

Importe `postman/Lav60 Gateway - MQTT.postman_collection.json` e ajuste:

| `serverUrl` | `http://127.0.0.1:3100` |
| `storeCode` | ex.: `pb05` |
| `token` | `GATEWAY_API_TOKEN` |

## Autenticação

| Rota | Auth |
|------|------|
| `GET /gateway/` | não |
| Demais `/gateway/*` | header `X-Token` = `GATEWAY_API_TOKEN` |

O token do **portal** (`X_TOKEN`) e o do **gateway** (`GATEWAY_API_TOKEN`) são **independentes**.

## Endpoints (via proxy)

Todos os paths da collection funcionam trocando `https://gateway.lav60.com` por `http://127.0.0.1:3100/gateway`:

| Grupo | Exemplos |
|-------|----------|
| Saúde | `GET /gateway/` |
| Status | `GET /gateway/{store}/status`, `.../washer/{id}`, `.../dryer/{id}`, `.../doser/{id}`, `.../ac` |
| LED | `POST /gateway/{store}/led/on`, `/off`, body `{ "command": "ON" }` |
| Comandos | `POST /gateway/{store}/washer/{id}`, `/dryer/{id}`, `/ac` |
| Dosadora | `POST /gateway/{store}/doser/{id}`, `/amaciante`, `/dosagem`, `/bomba`, `/settime/*` |
| Consultas | `GET /gateway/{store}/doser/{id}/consulta`, `/device-status` |

Metadados: `GET /api/v1/gateway` (sem auth).

Swagger upstream: https://gateway.lav60.com/docs

## Exemplo

```powershell
curl http://127.0.0.1:3100/gateway/
curl -H "X-Token: %GATEWAY_API_TOKEN%" http://127.0.0.1:3100/gateway/pb05/status
```
