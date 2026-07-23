# Controle remoto — Powpay (Cloudflare)

Controle de equipamentos na **rede local da loja** via agente exposto por túnel Cloudflare (`{loja}.powpay.com.br`).

---

## Visão geral

Cada loja tem seu subdomínio HTTPS. O servidor unificado normaliza tudo em:

```
http://127.0.0.1:3100/powpay/{loja}/...
```

Exemplo loja PB05:

```
http://127.0.0.1:3100/powpay/pb05/pb05/status
```

---

## Pré-requisitos

```env
POWPAY_DOMAIN_SUFFIX=powpay.com.br
CLOUDFLARE_API_TOKEN=seu_token_agente
```

Header nas rotas operacionais: `X-Token: {CLOUDFLARE_API_TOKEN}`

---

## Fluxo recomendado

```
1. GET /powpay/{loja}/health           → agente online?
2. GET /powpay/{loja}/tunnel-status    → túnel Cloudflare OK?
3. GET /powpay/{loja}/{loja}/status    → equipamentos
4. POST /powpay/{loja}/{loja}/washer/{id} → liberar
```

---

## Saúde e túnel (sem token)

```powershell
curl http://127.0.0.1:3100/powpay/pb05/health
curl http://127.0.0.1:3100/powpay/pb05/tunnel-status
curl http://127.0.0.1:3100/powpay/pb05/api/agent/config
```

---

## Status e rede

| Endpoint | Descrição |
|----------|-----------|
| `GET /{loja}/status` | Status completo |
| `GET /{loja}/devices` | IPs dos dispositivos |
| `GET /api/devices` | Lista API |
| `GET /api/network-status` | Conectividade |
| `GET /ping-status` | Ping interno |
| `GET /{loja}/doser/{id}/device-status` | HTTP da dosadora |

Prefixo local: `/powpay/pb05/...`

---

## Comandos (com token)

### Lavadora

```powershell
curl -X POST -H "X-Token: %CLOUDFLARE_API_TOKEN%" -H "Content-Type: application/json" ^
  -d "{\"am\":\"am01-1\"}" ^
  http://127.0.0.1:3100/powpay/pb05/pb05/washer/321
```

### Secadora

```powershell
curl -X POST -H "X-Token: %CLOUDFLARE_API_TOKEN%" -H "Content-Type: application/json" ^
  -d "{\"minutes\":30}" ^
  http://127.0.0.1:3100/powpay/pb05/pb05/dryer/765
```

### Dosadora

```powershell
curl -X POST -H "X-Token: %CLOUDFLARE_API_TOKEN%" -H "Content-Type: application/json" ^
  -d "{\"pump\":1}" ^
  http://127.0.0.1:3100/powpay/pb05/pb05/doser/321/bomba
```

Consulta tempos: `GET .../doser/321/consulta`

---

## Trocar de loja

Altere **dois** lugares no Postman:

| Variável | PB05 | RN01 |
|----------|------|------|
| `storeCode` | `pb05` | `rn01` |

---

## Importante

- Use **HTTPS** no upstream ou o proxy local — nunca `http://pb05.powpay.com.br` direto (POST pode perder body no redirect).
- Loja em **minúsculas** na URL.
- Token do agente ≠ token do totem ≠ token do gateway MQTT.

---

## Postman

Collection: **Lav60 Powpay - Cloudflare**

| Variável | Valor |
|----------|-------|
| `serverUrl` | `http://127.0.0.1:3100` |
| `storeCode` | `pb05` |
| `token` | `CLOUDFLARE_API_TOKEN` |

URLs: `{{serverUrl}}/powpay/{{storeCode}}/...`

Comparar com MQTT: [controle-remoto-gateway.md](./controle-remoto-gateway.md)
