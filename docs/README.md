# API MQTT Gateway — LAV60

Controle remoto de lavadoras, secadoras, ar condicionado e dosadores via MQTT.

**Versão:** `2.1.0`  
**Base URL:** `https://gateway.lav60.com`  
**Swagger:** `https://gateway.lav60.com/docs`  
**OpenAPI:** `https://gateway.lav60.com/openapi.json`

---

## Autenticação

Todos os endpoints (exceto `GET /`) exigem o header:

```
X-Token: seu_token
```

Requisições `POST` com body exigem também:

```
Content-Type: application/json
```

---

## Variáveis de ambiente (`.env`)

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `MQTT_BROKER` | IP/host do broker MQTT | `localhost` |
| `MQTT_PORT` | Porta MQTT | `1883` |
| `MQTT_USER` | Usuário MQTT | — |
| `MQTT_PASSWORD` | Senha MQTT | — |
| `API_TOKEN` | Token do header `X-Token` | — |
| `CONFIRM_TIMEOUT` | Timeout de confirmação (s) | `5` |
| `PING_TIMEOUT` | Timeout do status geral (s) | `20` |
| `DOSER_CONSULTA_TIMEOUT` | Timeout da consulta de tempos (s) | `15` |

---

## Parâmetros

| Parâmetro | Descrição | Exemplo |
|-----------|-----------|---------|
| `{store}` | Código da loja no ESP8266 | `pb05` |
| `{machine}` | ID da máquina | `321`, `432`, `765`… |

### Máquinas válidas

| Tipo | IDs |
|------|-----|
| Lavadora / Dosador | `321`, `432`, `543`, `654` |
| Secadora | `765`, `876`, `987`, `210` |

---

## Lista completa de endpoints

Substitua `pb05` pelo código da sua loja e `{machine}` pelo ID da máquina.

### Geral

| Método | URL completa | Auth | Descrição |
|--------|--------------|------|-----------|
| `GET` | `https://gateway.lav60.com/` | Não | Verifica se a API está online |

**Resposta:**

```json
{
  "message": "MQTT Gateway API LAV60 online",
  "broker": "161.97.172.86"
}
```

---

### Status / Ping (equipamento online?)

| Método | URL completa | Auth | Descrição |
|--------|--------------|------|-----------|
| `GET` | `https://gateway.lav60.com/pb05/status` | Sim | Status de todos os equipamentos |
| `GET` | `https://gateway.lav60.com/pb05/status/washer/{machine}` | Sim | Lavadora online? |
| `GET` | `https://gateway.lav60.com/pb05/status/dryer/{machine}` | Sim | Secadora online? |
| `GET` | `https://gateway.lav60.com/pb05/status/ac` | Sim | Ar condicionado online? |
| `GET` | `https://gateway.lav60.com/pb05/status/doser/{machine}` | Sim | Dosador online? (via gateway ESP8266) |

> **Diferença:** `GET /status/doser/{machine}` verifica pela rede (ping).  
> `GET /doser/{machine}/device-status` testa o HTTP `/status` direto na dosadora.

**Exemplos:**

```
GET https://gateway.lav60.com/pb05/status
GET https://gateway.lav60.com/pb05/status/washer/321
GET https://gateway.lav60.com/pb05/status/dryer/765
GET https://gateway.lav60.com/pb05/status/ac
GET https://gateway.lav60.com/pb05/status/doser/432
```

**Resposta — lavadora 321:**

```json
{ "id": "321", "online": true }
```

**Resposta — todos os equipamentos:**

```json
{
  "washers": { "321": true, "432": false, "543": true, "654": true },
  "dryers":  { "765": true, "876": true, "987": false, "210": true },
  "ac": true,
  "dosers":  { "321": true, "432": true, "543": false, "654": true }
}
```

---

### LED

| Método | URL completa | Body | Descrição |
|--------|--------------|------|-----------|
| `POST` | `https://gateway.lav60.com/pb05/led/on` | — | Liga o LED do gateway |
| `POST` | `https://gateway.lav60.com/pb05/led/off` | — | Desliga o LED do gateway |
| `POST` | `https://gateway.lav60.com/pb05/led` | `{ "command": "ON" }` ou `{ "command": "OFF" }` | Liga ou desliga o LED |

---

### Lavadoras

| Método | URL completa | Body | Descrição |
|--------|--------------|------|-----------|
| `POST` | `https://gateway.lav60.com/pb05/washer/{machine}` | — | Libera a lavadora |
| `POST` | `https://gateway.lav60.com/pb05/washer/{machine}` | `{ "am": "am01-1" }` | Dosador AM + libera lavadora |

**Máquinas:** `321`, `432`, `543`, `654`  
**Valores de `am`:** `am01-1`, `am01-2`, `am02-1`, `am02-2`

**Resposta — com dosador AM:**

```json
{
  "store": "pb05",
  "machine": "432",
  "doser": "am01-1",
  "washer": "released",
  "message": "Doser am01-1 + Washer 432 — confirmed by ESP8266"
}
```

**Exemplos:**

```
POST https://gateway.lav60.com/pb05/washer/321
POST https://gateway.lav60.com/pb05/washer/432
```

---

### Secadoras

| Método | URL completa | Body | Descrição |
|--------|--------------|------|-----------|
| `POST` | `https://gateway.lav60.com/pb05/dryer/{machine}` | `{ "minutes": 15 }` | Inicia secadora |

**Máquinas:** `765`, `876`, `987`, `210`  
**Minutos:** `15`, `30` ou `45`

**Exemplos:**

```
POST https://gateway.lav60.com/pb05/dryer/765   { "minutes": 15 }
POST https://gateway.lav60.com/pb05/dryer/876   { "minutes": 30 }
POST https://gateway.lav60.com/pb05/dryer/987   { "minutes": 45 }
```

---

### Ar condicionado

| Método | URL completa | Body | Descrição |
|--------|--------------|------|-----------|
| `POST` | `https://gateway.lav60.com/pb05/ac` | `{ "temperature": "18" }` | Liga a 18°C |
| `POST` | `https://gateway.lav60.com/pb05/ac` | `{ "temperature": "22" }` | Liga a 22°C |
| `POST` | `https://gateway.lav60.com/pb05/ac` | `{ "temperature": "off" }` | Desliga |

---

### Dosadores — comando direto

| Método | URL completa | Body | Descrição |
|--------|--------------|------|-----------|
| `POST` | `https://gateway.lav60.com/pb05/doser/{machine}` | `{ "type": "softener1" }` | Aciona endpoint HTTP direto na dosadora |

**Máquinas:** `321`, `432`, `543`, `654`

**Tipos (`type`):** `softener0`, `softener1`, `softener2`, `softener3`, `am01-1`, `am01-2`, `am02-1`, `am02-2`, `rele1on`, `rele2on`, `rele3on`, `consultasb01`, `consultaam01`, `consultaam02`, `eepromread`, `status`

**Exemplos:**

```
POST https://gateway.lav60.com/pb05/doser/432   { "type": "am01-1" }
POST https://gateway.lav60.com/pb05/doser/432   { "type": "softener2" }
POST https://gateway.lav60.com/pb05/doser/654   { "type": "rele1on" }
```

---

### Dosadores — ações específicas (firmware ESP8266 v1.5.1+)

| Método | URL completa | Body | Descrição |
|--------|--------------|------|-----------|
| `POST` | `https://gateway.lav60.com/pb05/doser/{machine}/amaciante` | — | Amaciante padrão (`softener1`) |
| `POST` | `https://gateway.lav60.com/pb05/doser/{machine}/amaciante` | `{ "number": 2 }` | Amaciante tipo 2 (`/softener2`) |
| `POST` | `https://gateway.lav60.com/pb05/doser/{machine}/amaciante` | `{ "endpoint": "softener2" }` | Endpoint customizado |
| `POST` | `https://gateway.lav60.com/pb05/doser/{machine}/dosagem` | — | Dosagem padrão (`am01-1`) |
| `POST` | `https://gateway.lav60.com/pb05/doser/{machine}/dosagem` | `{ "endpoint": "am02-1" }` | Dosagem customizada |
| `POST` | `https://gateway.lav60.com/pb05/doser/{machine}/bomba` | `{ "pump": 1 }` | Liga bomba/relé 1 |
| `POST` | `https://gateway.lav60.com/pb05/doser/{machine}/bomba` | `{ "pump": 2 }` | Liga bomba/relé 2 |
| `POST` | `https://gateway.lav60.com/pb05/doser/{machine}/bomba` | `{ "pump": 3 }` | Liga bomba/relé 3 |
| `GET` | `https://gateway.lav60.com/pb05/doser/{machine}/consulta` | — | Consulta tempos (sabão, floral, sport) |
| `GET` | `https://gateway.lav60.com/pb05/doser/{machine}/device-status` | — | Conectividade HTTP da dosadora |
| `POST` | `https://gateway.lav60.com/pb05/doser/{machine}/settime` | `{ "rele": 1, "seconds": 11 }` | Ajusta tempo (relé + segundos) |
| `POST` | `https://gateway.lav60.com/pb05/doser/{machine}/settime` | `{ "rele": 2, "seconds": 2.5 }` | Ajusta tempo com decimal |
| `POST` | `https://gateway.lav60.com/pb05/doser/{machine}/settime/sabao` | `{ "seconds": 11 }` | Tempo do sabão (relé 1) |
| `POST` | `https://gateway.lav60.com/pb05/doser/{machine}/settime/floral` | `{ "seconds": 13 }` | Tempo floral (relé 2) |
| `POST` | `https://gateway.lav60.com/pb05/doser/{machine}/settime/sport` | `{ "seconds": 12 }` | Tempo sport (relé 3) |

**Resposta — consulta de tempos (em segundos):**

```json
{
  "store": "pb05",
  "machine": "432",
  "tempos": {
    "sabao": 11,
    "floral": 13,
    "sport": 12
  }
}
```

> O dispositivo retorna milissegundos internamente; a API converte para **segundos**. Decimais são suportados (`2.5` = 2,5 segundos).

**Limites de `seconds`:** maior que `0`, até `3600` (1 hora).  
**Limites de `rele` / `pump`:** `1`, `2` ou `3`.

**Resposta padrão — comandos POST (ok):**

```json
{
  "store": "pb05",
  "topic": "pb05/doser/654/settime",
  "payload": "1:11",
  "response": "ok",
  "message": "Doser 654 — settime rele 1 (11s) — confirmed by ESP8266"
}
```

**Resposta — device-status:**

```json
{
  "store": "pb05",
  "machine": "432",
  "online": true
}
```

---

## Resumo rápido (22 endpoints)

```
GET    https://gateway.lav60.com/

GET    https://gateway.lav60.com/{store}/status
GET    https://gateway.lav60.com/{store}/status/washer/{machine}
GET    https://gateway.lav60.com/{store}/status/dryer/{machine}
GET    https://gateway.lav60.com/{store}/status/ac
GET    https://gateway.lav60.com/{store}/status/doser/{machine}

POST   https://gateway.lav60.com/{store}/led/on
POST   https://gateway.lav60.com/{store}/led/off
POST   https://gateway.lav60.com/{store}/led

POST   https://gateway.lav60.com/{store}/washer/{machine}
POST   https://gateway.lav60.com/{store}/dryer/{machine}
POST   https://gateway.lav60.com/{store}/ac

POST   https://gateway.lav60.com/{store}/doser/{machine}
POST   https://gateway.lav60.com/{store}/doser/{machine}/amaciante
POST   https://gateway.lav60.com/{store}/doser/{machine}/dosagem
POST   https://gateway.lav60.com/{store}/doser/{machine}/bomba
GET    https://gateway.lav60.com/{store}/doser/{machine}/consulta
GET    https://gateway.lav60.com/{store}/doser/{machine}/device-status
POST   https://gateway.lav60.com/{store}/doser/{machine}/settime
POST   https://gateway.lav60.com/{store}/doser/{machine}/settime/sabao
POST   https://gateway.lav60.com/{store}/doser/{machine}/settime/floral
POST   https://gateway.lav60.com/{store}/doser/{machine}/settime/sport
```

---

## Erros comuns

| Código | Significado |
|--------|-------------|
| `401` | Token inválido ou ausente |
| `400` | Parâmetro inválido, ESP8266 offline, timeout ou dispositivo retornou erro |
| `422` | Body JSON inválido ou fora dos limites (ex.: `seconds` > 3600) |
| `503` | API não conectou ao broker MQTT |

Mensagens `400` comuns:
- `ESP8266 at store 'pb05' did not respond within 5s` — gateway offline ou MQTT indisponível
- `Doser consulta failed for machine '432'` — dosadora não respondeu à consulta de tempos
- `Doser 654 — settime rele 1 (11s) failed at store 'pb05'` — comando chegou ao gateway, mas o HTTP na dosadora falhou

---

## Requisitos de firmware

| Recurso | Firmware mínimo |
|---------|-----------------|
| Endpoints básicos (lavadoras, secadoras, AC, LED) | v1.4.0 |
| Dosadoras (`/amaciante`, `/consulta`, `/settime`, etc.) | **v1.5.1+** |

---

## Exemplos curl

```bash
# API online
curl https://gateway.lav60.com/

# Status da lavadora 321
curl -H "X-Token: seu_token" https://gateway.lav60.com/pb05/status/washer/321

# Status de todos os equipamentos
curl -H "X-Token: seu_token" https://gateway.lav60.com/pb05/status

# Liberar lavadora 321
curl -X POST -H "X-Token: seu_token" https://gateway.lav60.com/pb05/washer/321

# Lavadora 432 com dosador AM
curl -X POST -H "X-Token: seu_token" \
  -H "Content-Type: application/json" \
  -d '{"am": "am01-1"}' \
  https://gateway.lav60.com/pb05/washer/432

# Secadora 765 por 30 min
curl -X POST -H "X-Token: seu_token" \
  -H "Content-Type: application/json" \
  -d '{"minutes": 30}' \
  https://gateway.lav60.com/pb05/dryer/765

# Ar condicionado 22°C
curl -X POST -H "X-Token: seu_token" \
  -H "Content-Type: application/json" \
  -d '{"temperature": "22"}' \
  https://gateway.lav60.com/pb05/ac

# Consultar tempos da dosadora 654
curl -H "X-Token: seu_token" https://gateway.lav60.com/pb05/doser/654/consulta

# Acionar bomba 2 na dosadora 432
curl -X POST -H "X-Token: seu_token" \
  -H "Content-Type: application/json" \
  -d '{"pump": 2}' \
  https://gateway.lav60.com/pb05/doser/432/bomba

# Ajustar tempo do sabão para 11 segundos
curl -X POST -H "X-Token: seu_token" \
  -H "Content-Type: application/json" \
  -d '{"seconds": 11}' \
  https://gateway.lav60.com/pb05/doser/654/settime/sabao

# Ajustar tempo com decimal (2,5 segundos no relé 1)
curl -X POST -H "X-Token: seu_token" \
  -H "Content-Type: application/json" \
  -d '{"rele": 1, "seconds": 2.5}' \
  https://gateway.lav60.com/pb05/doser/654/settime

# Status HTTP da dosadora 432
curl -H "X-Token: seu_token" https://gateway.lav60.com/pb05/doser/432/device-status
```
