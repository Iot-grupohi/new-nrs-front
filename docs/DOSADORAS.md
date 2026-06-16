# LAV60 — Endpoints das dosadoras

Referência **somente** das rotas de dosadora expostas pelo **agente** (`backend/proxy_server.py`, porta padrão `8080`).

Documentação geral: [API.md](./API.md) · Painel operacional: [PANEL.md](./PANEL.md)

---

## Base e autenticação

| Item | Valor |
|------|--------|
| URL local | `http://localhost:8080` |
| URL produção | `https://{loja}.powpay.com.br` |
| Prefixo da loja | `/{store}` em minúsculas (ex.: `pb05`) |
| ID da máquina | Numérico (ex.: `321`, `432`, `543`, `654`) |

Se `API_TOKEN` estiver no `.env`, inclua em todas as rotas abaixo:

```http
X-Token: <API_TOKEN>
Content-Type: application/json
```

> O mesmo ID pode existir como **lavadora** e **dosadora**. Use sempre o prefixo `/doser/`, nunca `/washer/`.

---

## Resumo dos endpoints

| Método | Rota | Função |
|--------|------|--------|
| `GET` | `/{store}/status/doser/{id}` | Status completo (online, IP, metadados) |
| `GET` | `/{store}/doser/{id}/device-status` | Online/offline simplificado |
| `GET` | `/{store}/doser/{id}/consulta` | Tempos salvos (sabão, floral, sport) |
| `POST` | `/{store}/doser/{id}` | Acionar produto ou comando genérico |
| `POST` | `/{store}/doser/{id}/bomba` | Acionar bomba/relé (1, 2 ou 3) |
| `POST` | `/{store}/doser/{id}/amaciante` | Comando de amaciante (softener) |
| `POST` | `/{store}/doser/{id}/dosagem` | Dosagem por endpoint (`am01-1`, etc.) |
| `POST` | `/{store}/doser/{id}/settime` | Ajuste de tempo por relé |
| `POST` | `/{store}/doser/{id}/settime/sabao` | Ajuste tempo — relé 1 (sabão) |
| `POST` | `/{store}/doser/{id}/settime/floral` | Ajuste tempo — relé 2 (floral) |
| `POST` | `/{store}/doser/{id}/settime/sport` | Ajuste tempo — relé 3 (sport) |

---

## Status

### `GET /{store}/status/doser/{id}`

Retorna ping de rede e metadados da dosadora.

```bash
curl "http://localhost:8080/pb05/status/doser/321" \
  -H "X-Token: SEU_API_TOKEN"
```

**Resposta (exemplo):**

```json
{
  "store": "pb05",
  "device_type": "doser",
  "id": "321",
  "ip": "192.168.50.101",
  "online": true,
  "status": "online"
}
```

HTTP `400` quando offline.

---

### `GET /{store}/doser/{id}/device-status`

Versão reduzida — apenas se a dosadora responde na rede.

```bash
curl "http://localhost:8080/pb05/doser/321/device-status" \
  -H "X-Token: SEU_API_TOKEN"
```

**Resposta:**

```json
{
  "store": "pb05",
  "machine": "321",
  "online": true
}
```

---

## Consulta de tempos

### `GET /{store}/doser/{id}/consulta`

Lê os tempos configurados nos relés (sabão, floral, sport).

```bash
curl "http://localhost:8080/pb05/doser/321/consulta" \
  -H "X-Token: SEU_API_TOKEN"
```

**Resposta:**

```json
{
  "store": "pb05",
  "machine": "321",
  "tempos": {
    "sabao": 5,
    "floral": 4,
    "sport": 3
  }
}
```

Valores em **segundos**. Usado pelo painel em **Consultar tempos salvos**.

---

## Comandos (POST)

### `POST /{store}/doser/{id}`

Aciona a dosadora pelo campo `type`. É a rota usada pelo painel em **Acionar** (Sabão / Floral / Sport).

**Body:**

```json
{ "type": "rele1on" }
```

**Valores `type` aceitos:**

| `type` | Ação | Relé / produto |
|--------|------|----------------|
| `rele1on` | Sabão | Relé 1 |
| `rele2on` | Amaciante floral | Relé 2 |
| `rele3on` | Amaciante sport | Relé 3 |
| `softener0` | Sem cheiro | — |
| `softener1` | Softener 1 | — |
| `softener2` | Softener 2 | — |
| `softener3` | Softener 3 | — |
| `am01-1` | Floral simples | Dosagem |
| `am01-2` | Floral dupla | Dosagem |
| `am02-1` | Sport simples | Dosagem |
| `am02-2` | Sport dupla | Dosagem |

Também aceitos (avançado): `consultasb01`, `consultaam01`, `consultaam02`, `eepromread`, `status`.

**Exemplo — acionar sabão:**

```bash
curl -X POST "http://localhost:8080/pb05/doser/321" \
  -H "Content-Type: application/json" \
  -H "X-Token: SEU_API_TOKEN" \
  -d '{"type": "rele1on"}'
```

**Resposta (sucesso):**

```json
{
  "store": "pb05",
  "topic": "pb05/doser/321",
  "payload": "rele1on",
  "response": 200,
  "message": "Doser 321 — rele1on",
  "machine": "321",
  "type": "rele1on",
  "url": "http://192.168.50.101/rele1on"
}
```

---

### `POST /{store}/doser/{id}/bomba`

Atalho para acionar relé 1, 2 ou 3.

**Body:**

```json
{ "pump": 1 }
```

| `pump` | Equivalente |
|--------|-------------|
| `1` | `/rele1on` (sabão) |
| `2` | `/rele2on` (floral) |
| `3` | `/rele3on` (sport) |

---

### `POST /{store}/doser/{id}/amaciante`

Comando de amaciante por número ou path explícito.

**Opção A — por número:**

```json
{ "number": 1 }
```

| `number` | Path no equipamento |
|----------|---------------------|
| `1` | `/softener1` |
| `2` | `/softener2` |
| `3` | `/softener3` |

**Opção B — path direto:**

```json
{ "endpoint": "/softener2" }
```

---

### `POST /{store}/doser/{id}/dosagem`

Mesmo efeito de `POST /doser/{id}`, usando o nome do endpoint de dosagem no body.

**Body:**

```json
{ "endpoint": "am01-1" }
```

Valores: `am01-1`, `am01-2`, `am02-1`, `am02-2`, `softener0`, etc. (qualquer chave válida em `type`).

---

## Ajuste de tempo

Define quanto tempo cada relé permanece acionado. `seconds` deve ser maior que 0 e no máximo 3600.

### `POST /{store}/doser/{id}/settime`

**Body:**

```json
{
  "rele": 1,
  "seconds": 5
}
```

| `rele` | Produto |
|--------|---------|
| `1` | Sabão |
| `2` | Floral |
| `3` | Sport |

---

### Atalhos por produto

| Rota | Relé | Body |
|------|------|------|
| `POST /{store}/doser/{id}/settime/sabao` | 1 | `{ "seconds": 5 }` |
| `POST /{store}/doser/{id}/settime/floral` | 2 | `{ "seconds": 5 }` |
| `POST /{store}/doser/{id}/settime/sport` | 3 | `{ "seconds": 5 }` |

**Exemplo:**

```bash
curl -X POST "http://localhost:8080/pb05/doser/321/settime/floral" \
  -H "Content-Type: application/json" \
  -H "X-Token: SEU_API_TOKEN" \
  -d '{"seconds": 4.5}'
```

**Resposta (sucesso):**

```json
{
  "store": "pb05",
  "topic": "pb05/doser/321/settime",
  "payload": "2:4.5",
  "response": 200,
  "message": "Doser 321 — settime rele 2 (4.5s)",
  "machine": "321",
  "rele": 2,
  "seconds": 4.5,
  "device_path": "/settime?rele=2&time=4500"
}
```

---

## Endpoints agregados (incluem dosadoras)

Estas rotas não são exclusivas de dosadora, mas retornam dados delas:

| Método | Rota | Uso |
|--------|------|-----|
| `GET` | `/{store}/status` | Mapa `dosers: { "321": true, ... }` + `machines[]` |
| `GET` | `/api/network-status?machine={id}&type=doser` | Ping de uma dosadora |
| `GET` | `/{store}/devices` | Mapa de IPs (`doser_map`) |

**Exemplo — status geral da loja:**

```bash
curl "http://localhost:8080/pb05/status" -H "X-Token: SEU_API_TOKEN"
```

Trecho relevante:

```json
{
  "dosers": {
    "321": true,
    "432": false
  },
  "summary": {
    "total": 11,
    "online": 9,
    "offline": 2
  }
}
```

---

## IDs comuns

| Dosadora | IP típico (rede `192.168.50.x`) |
|----------|-----------------------------------|
| `321` | `.101` |
| `432` | `.102` |
| `543` | `.103` |
| `654` | `.104` |

IPs reais vêm da API Lav60 ou do `.env` (`NETWORK_BASE_IP`). Confirme com `GET /{store}/devices`.

---

## Erros comuns

| HTTP | Significado |
|------|-------------|
| `400` | ID inválido, parâmetro ausente ou equipamento offline |
| `401` | `X-Token` ausente ou incorreto |
| `500` | Falha ao falar com a dosadora na rede local |

Corpo de erro (exemplo):

```json
{
  "error": "Equipamento inválido ou não cadastrado."
}
```

---

## Uso no painel

Na página da loja (`store.html`), a seção **Dosadoras** usa:

| Ação no painel | Endpoint |
|----------------|----------|
| Acionar Sabão / Floral / Sport | `POST /doser/{id}` com `type`: `rele1on`, `rele2on`, `rele3on` |
| Consultar tempos salvos | `GET /doser/{id}/consulta` |
| Ajuste de tempo (Sabão / Floral / Sport) | `POST /doser/{id}/settime/sabao` (ou `/floral`, `/sport`) |

Todas passam pelo agente da loja com o token retornado em `GET /api/panel/bootstrap`.
