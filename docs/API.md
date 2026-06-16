# LAV60 Gateway — API (referência)

Visão geral das APIs do projeto. Há **dois serviços** distintos:

| Serviço | Arquivo | Porta padrão | Função |
|---------|---------|--------------|--------|
| **Agente (gateway)** | `backend/proxy_server.py` | `8080` | Comandos na loja, status de rede, túnel Cloudflare |
| **Painel** | `backend/panel_server.py` | `3000` | Frontend web, login Firebase, hub de heartbeat, auditoria |

Documentação geral: [API.md](./API.md) · Dosadoras: [DOSADORAS.md](./DOSADORAS.md) · Painel operacional: [PANEL.md](./PANEL.md)

---

## Autenticação

### Agente (`8080`)

Se `API_TOKEN` estiver no `.env`, envie em rotas operacionais:

```http
X-Token: <API_TOKEN>
```

**Sem token:** `/`, `/health`, `/api/health`, `/debug`, `/tunnel*`, `/provision`, `/cleanup`.

### Painel (`3000`)

| Rota | Auth |
|------|------|
| `POST /api/heartbeat` | Header `X-Token` (usa `API_TOKEN` / `PANEL_TOKEN`) |
| `GET /api/audit/status` | Pública |
| `GET /api/auth/config`, `POST /api/auth/session`, `POST /api/auth/logout` | Públicas (login) |
| Demais `/api/*` (incl. `/api/audit/logs`, `/api/panel/bootstrap`) | Sessão Firebase, se auth estiver ativo; livre se Firebase não configurado |

O painel lê o token do agente via `GET /api/panel/bootstrap` (`default_agent_token`).

---

## URLs base

| Ambiente | Agente | Painel |
|----------|--------|--------|
| Local | `http://localhost:8080` | `http://localhost:3000` |
| Produção (túnel) | `https://{loja}.powpay.com.br` | Servidor onde roda `panel_server.py` |

Substitua `{store}` pelo ID da loja em minúsculas (ex.: `pb05`, `pb100`).

---

## Painel — `panel_server.py`

### Saúde e bootstrap

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/api/panel/health` | Health check do painel |
| `GET` | `/api/panel/bootstrap` | Token padrão do agente e flags de auth |

**Resposta bootstrap (exemplo):**

```json
{
  "default_agent_token": "...",
  "auth_enabled": true,
  "audit_available": true
}
```

### Autenticação (Firebase)

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/api/auth/config` | Config pública do Firebase |
| `GET` | `/api/auth/me` | Usuário logado |
| `POST` | `/api/auth/session` | Body: `{ "idToken": "..." }` — cria sessão |
| `DELETE` | `/api/auth/session` | Encerra sessão |
| `POST` | `/api/auth/logout` | Logout |

### Heartbeat (agente → painel)

O agente envia status a cada ~15 s (`heartbeat_interval_seconds` em `stores.json`). O dashboard usa isso para saber se a loja está conectada.

| Método | Rota | Descrição |
|--------|------|-----------|
| `POST` | `/api/heartbeat` | Agente registra presença + payload de rede |
| `GET` | `/api/heartbeats` | Snapshot de todos os heartbeats |
| `GET` | `/api/heartbeats/stream` | SSE — atualizações em tempo real |

**Exemplo — heartbeat (agente):**

```bash
curl -X POST "http://localhost:3000/api/heartbeat" \
  -H "Content-Type: application/json" \
  -H "X-Token: SEU_API_TOKEN" \
  -d '{
    "store": "pb05",
    "agent_url": "https://pb05.powpay.com.br",
    "timestamp": "2026-06-12T16:00:00",
    "network": { "washers": {}, "dryers": {}, "dosers": {}, "ac": true, "summary": {} },
    "machines": []
  }'
```

**Resposta:** `{ "ok": true, "store": "pb05", "received_at": 1718208000.0 }`

### Auditoria — Firestore

Operações do painel (liberar, acionar, consultas, login) podem ser gravadas no **Cloud Firestore**.

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/api/audit/status` | Verifica se a gravação está disponível |
| `POST` | `/api/audit/log` | Grava evento (requer login Firebase, se ativo) |
| `GET` | `/api/audit/logs` | Lista eventos (paginação, filtros) |

#### `GET /api/audit/logs`

**Query params:**

| Param | Descrição |
|-------|-----------|
| `store` | Filtrar por loja (ex.: `pb05`) |
| `action` | Filtrar por ação (ex.: `washer_release`, `doser_command`) |
| `success` | `true` / `false` |
| `q` | Busca textual (e-mail, label, device_id, etc.) |
| `limit` | Tamanho da página (1–100, padrão 50) |
| `before_ms` | Cursor para página seguinte (timestamp ms) |

**Resposta:**

```json
{
  "items": [ { "id": "...", "ts": "...", "ts_ms": 1718208000000, "action": "dryer_release", "store": "pb05", "..." } ],
  "has_more": true,
  "next_before_ms": 1718207000000,
  "collection": "audit_logs",
  "action_labels": { "washer_release": "Liberou lavadora", "..." : "..." },
  "device_labels": { "washer": "lavadora", "..." : "..." }
}
```

**Configuração no `.env`:**

```env
FIREBASE_SERVICE_ACCOUNT_FILE=C:\caminho\service-account.json
FIREBASE_AUDIT_COLLECTION=audit_logs
FIREBASE_API_KEY=...
FIREBASE_AUTH_DOMAIN=...
FIREBASE_PROJECT_ID=...
```

A service account é obtida no Firebase Console → Configurações do projeto → Contas de serviço → Gerar nova chave privada.

**Teste:**

```powershell
python scripts/test_firestore_audit.py
python scripts/test_firestore_audit.py --store pb05 --list 5
```

**Campos gravados (principais):**

| Campo | Descrição |
|-------|-----------|
| `ts`, `ts_ms` | Data/hora UTC |
| `operator_name`, `operator_email` | Operador |
| `store` | ID da loja |
| `action` | Código (`washer_release`, `doser_command`, `auth_login`, …) |
| `label` | Descrição curta |
| `operation_summary` | Resumo legível |
| `device_type`, `device_id` | Equipamento |
| `method`, `path` | Chamada HTTP ao agente |
| `success`, `payload`, `response`, `error` | Resultado |
| `user_uid`, `user_email` | Firebase |

**Ações registradas (`action`):**

| Código | Descrição |
|--------|-----------|
| `auth_login` | Login no painel |
| `auth_logout` | Logout |
| `washer_release` | Liberou lavadora |
| `washer_unlock` | Reativou botões da lavadora |
| `dryer_release` | Liberou secadora |
| `dryer_unlock` | Reativou botões da secadora |
| `doser_command` | Comando na dosadora |
| `doser_consult` | Consulta de tempos |
| `doser_settime` | Ajuste de tempo |
| `ac_control` | Comando no ar-condicionado |

### Frontend estático

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/`, `/index.html` | Dashboard de lojas |
| `GET` | `/store.html` | Operação (`?store=pb05`) |
| `GET` | `/records.html` | Registros de auditoria |
| `GET` | `/login.html` | Login |
| `GET` | `/app.css`, `/api.js`, … | Assets em `frontend/` |

---

## Agente — `proxy_server.py`

Gateway REST que traduz chamadas HTTP em comandos na rede local (ESP8266).

### Saúde e metadados

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/health` | Health check |
| `GET` | `/api/health` | Health check (alias) |
| `GET` | `/api/agent/config` | Config da loja, máquinas, intervalos |
| `GET` | `/` | Info do serviço e links úteis |

### Status de rede

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/{store}/status` | Status completo (ping + máquinas API) |
| `GET` | `/{store}/status/washer/{id}` | Status de uma lavadora |
| `GET` | `/{store}/status/dryer/{id}` | Status de uma secadora |
| `GET` | `/{store}/status/doser/{id}` | Status de uma dosadora |
| `GET` | `/{store}/status/ac` | Status do ar-condicionado |
| `GET` | `/{store}/devices` | Mapa de IPs e catálogo |
| `GET` | `/api/network-status` | Ping de todos os dispositivos |
| `GET` | `/api/network-status?machine=321&type=washer` | Ping de um equipamento |

**Exemplo — status da loja:**

```bash
curl "http://localhost:8080/pb05/status" -H "X-Token: SEU_API_TOKEN"
```

**Resposta (resumida):**

```json
{
  "store": "pb05",
  "washers": { "321": true, "432": false },
  "dryers": { "765": true },
  "dosers": { "321": true },
  "ac": true,
  "summary": { "total": 11, "online": 10, "offline": 1 },
  "machines": []
}
```

O array `machines` pode incluir metadados por equipamento: `status` (`available`, `occupied`, `suspended`), `address`, `liter_capacity`, `waiting_minutes`, etc. O painel usa isso nos cards da loja.

### Comandos operacionais (POST)

Todas exigem `Content-Type: application/json` e `X-Token` (se configurado).

| Ação | Rota | Body principal |
|------|------|----------------|
| Liberar lavadora | `POST /{store}/washer/{id}` | `{}` ou `{ "am": "am01-1" }` |
| Liberar secadora | `POST /{store}/dryer/{id}` | `{ "minutes": 15 \| 30 \| 45 }` |
| Ar-condicionado | `POST /{store}/ac` | `{ "temperature": "18" \| "22" \| "off" }` |
| Dosadora (genérico) | `POST /{store}/doser/{id}` | `{ "type": "rele1on" \| "rele2on" \| "rele3on" }` |

Referência completa das rotas de dosadora: **[DOSADORAS.md](./DOSADORAS.md)**.
| Amaciante | `POST /{store}/doser/{id}/amaciante` | `{ "number": 1 }` |
| Bomba / relé | `POST /{store}/doser/{id}/bomba` | `{ "pump": 1 \| 2 \| 3 }` |
| Ajustar tempo | `POST /{store}/doser/{id}/settime/sabao` | `{ "seconds": 1.5 }` |
| LED | `POST /{store}/led/on` ou `/led/off` | — |

**Valores `am` (lavadoras):**

| Valor | Dosagem |
|-------|---------|
| `""` | Sem cheiro |
| `am01-1` | Floral simples |
| `am01-2` | Floral dupla |
| `am02-1` | Sport simples |
| `am02-2` | Sport dupla |

**Consultas (GET):**

| Rota | Descrição |
|------|-----------|
| `GET /{store}/doser/{id}/consulta` | Tempos sabão / floral / sport |
| `GET /{store}/doser/{id}/device-status` | Online/offline da dosadora |

**Exemplo — liberar lavadora:**

```bash
curl -X POST "http://localhost:8080/pb05/washer/321" \
  -H "Content-Type: application/json" \
  -H "X-Token: SEU_API_TOKEN" \
  -d '{"am": "am01-1"}'
```

**Exemplo — liberar secadora:**

```bash
curl -X POST "http://localhost:8080/pb05/dryer/765" \
  -H "Content-Type: application/json" \
  -H "X-Token: SEU_API_TOKEN" \
  -d '{"minutes": 30}'
```

### Túnel e manutenção

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/api/tunnel-status` | Estado do Cloudflare Tunnel |
| `GET` | `/tunnel-test` | Teste de conectividade |
| `POST` | `/provision` | Provisionamento do túnel |
| `POST` | `/cleanup` | Limpeza de processos/portas |

---

## IDs de equipamentos

IDs numéricos. Alguns IDs existem em lavadora **e** dosadora (`321`, `432`, `543`, `654`) — use a rota correta (`/washer/` vs `/doser/`).

| Tipo | IDs comuns |
|------|------------|
| Lavadora | `321`, `432`, `543`, `654` |
| Secadora | `210`, `765`, `876`, `987` |
| Dosadora | `321`, `432`, `543`, `654` |
| Ar-condicionado | `110` |

IPs padrão na rede `192.168.50.x` — configuráveis via `.env` (`NETWORK_BASE_IP`).

---

## Variáveis `.env` principais

```env
# Loja e tokens
STORE_ID=PB05
API_TOKEN=...              # X-Token agente + heartbeat + painel
LAV60_API_TOKEN=...        # API Lav60 (listagem de máquinas)

# Painel
FRONTEND_PORT=3000
PANEL_HEARTBEAT_URL=...    # URL do painel para o agente (opcional)

# Firebase — login + auditoria
FIREBASE_API_KEY=...
FIREBASE_AUTH_DOMAIN=...
FIREBASE_PROJECT_ID=...
FIREBASE_SERVICE_ACCOUNT_FILE=service-account.json
FIREBASE_AUDIT_COLLECTION=audit_logs

# Agente (rede / túnel)
NETWORK_BASE_IP=192.168.50
```

O arquivo `.env` é resolvido a partir da raiz do projeto (`lav60_env.resolve_env_path`).

---

## Como subir localmente

```powershell
# Painel (frontend + heartbeat hub) — valida porta livre
.\scripts\serve.ps1

# Agente da loja
python backend/proxy_server.py
```

---

## Documentação relacionada

- **[README.md](../README.md)** — visão geral e estrutura do projeto
- **[PANEL.md](./PANEL.md)** — interface operacional, modais, registros
- **[DOSADORAS.md](./DOSADORAS.md)** — endpoints exclusivos das dosadoras
