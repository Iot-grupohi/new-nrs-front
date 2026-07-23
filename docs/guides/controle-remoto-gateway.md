# Controle remoto — MQTT Gateway

Libera lavadoras, secadoras, ar-condicionado e dosadoras via **MQTT Gateway** central (`gateway.lav60.com`).

---

## Visão geral

```
GET  /{loja}/status           → status de todos os dispositivos
POST /{loja}/washer/{id}      → liberar lavadora
POST /{loja}/dryer/{id}       → liberar secadora (15/30/45 min)
POST /{loja}/ac               → ar-condicionado
POST /{loja}/doser/{id}/...   → dosadora
```

Via servidor local, prefixo `/gateway`:

```
http://127.0.0.1:3100/gateway/pb05/status
```

---

## Pré-requisitos

```env
GATEWAY_API_TOKEN=seu_token_gateway
LAV60_GATEWAY_URL=https://gateway.lav60.com
```

Header: `X-Token: {GATEWAY_API_TOKEN}`

> Token **diferente** do totem (`X_TOKEN`) e do Powpay (`CLOUDFLARE_API_TOKEN`).

---

## Fluxo recomendado

```
1. GET /gateway/                    → broker online?
2. GET /gateway/{loja}/status       → máquinas disponíveis
3. POST /gateway/{loja}/washer/{id} → liberar equipamento
4. GET /gateway/{loja}/status/washer/{id} → confirmar
```

Código da loja em **minúsculas** (`pb05`, não `PB05`).

---

## Status

```powershell
curl -H "X-Token: %GATEWAY_API_TOKEN%" http://127.0.0.1:3100/gateway/pb05/status
```

Endpoints por tipo: `/status/washer/{id}`, `/status/dryer/{id}`, `/status/doser/{id}`, `/status/ac`.

---

## Comandos

### Lavadora (com dosagem)

```powershell
curl -X POST -H "X-Token: %GATEWAY_API_TOKEN%" -H "Content-Type: application/json" ^
  -d "{\"am\":\"am01-1\"}" ^
  http://127.0.0.1:3100/gateway/pb05/washer/321
```

### Secadora (30 min)

```powershell
curl -X POST -H "X-Token: %GATEWAY_API_TOKEN%" -H "Content-Type: application/json" ^
  -d "{\"minutes\":30}" ^
  http://127.0.0.1:3100/gateway/pb05/dryer/765
```

### Ar-condicionado

```powershell
curl -X POST -H "X-Token: %GATEWAY_API_TOKEN%" -H "Content-Type: application/json" ^
  -d "{\"temperature\":\"22\"}" ^
  http://127.0.0.1:3100/gateway/pb05/ac
```

Valores: `"18"`, `"22"`, `"off"`.

### LED

```powershell
curl -X POST -H "X-Token: %GATEWAY_API_TOKEN%" http://127.0.0.1:3100/gateway/pb05/led/on
```

---

## Dosadora

| Ação | Endpoint |
|------|----------|
| Tipo softener | `POST .../doser/{id}` body `{"type":"softener1"}` |
| Bomba | `POST .../doser/{id}/bomba` body `{"pump":1}` |
| Amaciante | `POST .../doser/{id}/amaciante` |
| Consulta tempos | `GET .../doser/{id}/consulta` |
| Ajuste tempo | `POST .../doser/{id}/settime/sabao` body `{"seconds":11}` |

Swagger upstream: https://gateway.lav60.com/docs

---

## Erros comuns

| Erro | Causa |
|------|-------|
| **401** | `GATEWAY_API_TOKEN` errado ou ausente |
| **400** ESP timeout | Dispositivo offline na loja |
| **500** token não no `.env` | Reinicie o servidor após configurar |

---

## Gateway vs Powpay

| | MQTT Gateway | Powpay (Cloudflare) |
|--|--------------|---------------------|
| URL | `/gateway/{loja}/...` | `/powpay/{loja}/...` |
| Upstream | `gateway.lav60.com` | `{loja}.powpay.com.br` |
| Token | `GATEWAY_API_TOKEN` | `CLOUDFLARE_API_TOKEN` |
| Uso | Controle MQTT central | Agente local na loja |

Ver [controle-remoto-powpay.md](./controle-remoto-powpay.md).

---

## Postman

Collection: **Lav60 Gateway - MQTT**

| Variável | Valor |
|----------|-------|
| `serverUrl` | `http://127.0.0.1:3100` |
| `storeCode` | `pb05` |
| `token` | `GATEWAY_API_TOKEN` |

URLs: `{{serverUrl}}/gateway/{{storeCode}}/...`

Referência técnica: [gateway-mqtt.md](./gateway-mqtt.md)
