# Deploy do painel LAV60 em VPS

Este guia cobre apenas o **painel** (`panel_server.py` + `frontend/`). O **agente** (`LAV60_Gateway.exe`) continua rodando **no PC de cada loja**.

```
Lojas (agente :8080)  ──heartbeat──►  VPS (painel :443)
Operadores (browser)  ──HTTPS──────►  VPS (painel :443)
```

---

## O que sobe no VPS

| Componente | Necessário no VPS? |
|------------|-------------------|
| `frontend/` | Sim |
| `backend/panel_server.py`, `panel_auth.py`, `panel_audit.py`, `lav60_env.py` | Sim |
| `frontend/stores.json` | Sim |
| `.env` (Firebase, tokens) | Sim |
| Service account Firebase (`.json`) | Sim (auditoria + login) |
| `backend/proxy_server.py` / agente | **Não** |

---

## 1. Preparar o VPS (Ubuntu/Debian)

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip nginx certbot python3-certbot-nginx git
```

Crie usuário dedicado (opcional):

```bash
sudo useradd -m -s /bin/bash lav60
sudo su - lav60
```

---

## 2. Enviar o projeto

**Opção A — Git**

```bash
git clone <seu-repositorio> ~/lav60-panel
cd ~/lav60-panel
```

**Opção B — ZIP** (copie só o necessário)

```
lav60-panel/
├── backend/panel_server.py
├── backend/panel_auth.py
├── backend/panel_audit.py
├── backend/lav60_env.py
├── backend/__init__.py
├── frontend/          (pasta inteira)
├── requirements.txt
└── .env
```

---

## 3. Ambiente Python

```bash
cd ~/lav60-panel
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install gunicorn
```

---

## 4. Arquivo `.env` no VPS

Exemplo mínimo para o **painel**:

```env
FRONTEND_PORT=3000
API_TOKEN=seu_token_compartilhado_com_os_agentes

# Sessão estável (obrigatório em produção — senão logout a cada restart)
FLASK_SECRET_KEY=uma_string_longa_aleatoria_aqui

# Firebase — login e auditoria
FIREBASE_API_KEY=...
FIREBASE_AUTH_DOMAIN=...
FIREBASE_PROJECT_ID=...
FIREBASE_SERVICE_ACCOUNT_FILE=/home/lav60/lav60-panel/hipag-02-firebase-adminsdk-xxxxx.json
FIREBASE_AUDIT_COLLECTION=audit_logs
```

Regras:

- **`API_TOKEN`** deve ser **o mesmo** nos agentes das lojas (header `X-Token` no heartbeat).
- Envie o JSON da service account para o VPS (nunca commite no Git).
- Ajuste `frontend/stores.json` com as lojas reais (`id`, `name`).

---

## 5. Testar manualmente

```bash
source .venv/bin/activate
cd ~/lav60-panel
gunicorn -w 2 -b 127.0.0.1:3000 'backend.panel_server:app'
```

Abra no navegador (via túnel SSH ou IP): `http://IP_DO_VPS:3000`

> Para Gunicorn importar o app Flask, o working directory deve ser a **raiz do projeto** e o módulo é `backend.panel_server:app`.

Pare com `Ctrl+C` e configure o serviço permanente.

---

## 6. Systemd (serviço permanente)

Copie o template do repositório e ajuste caminhos:

```bash
sudo cp deploy/lav60-panel.service /etc/systemd/system/
sudo nano /etc/systemd/system/lav60-panel.service
# Altere User=, WorkingDirectory=, EnvironmentFile= se necessário

sudo systemctl daemon-reload
sudo systemctl enable lav60-panel
sudo systemctl start lav60-panel
sudo systemctl status lav60-panel
```

Logs:

```bash
journalctl -u lav60-panel -f
```

---

## 7. Nginx + HTTPS

Substitua `panel.seudominio.com.br` pelo seu domínio.

```bash
sudo cp deploy/nginx-lav60-panel.conf /etc/nginx/sites-available/lav60-panel
sudo nano /etc/nginx/sites-available/lav60-panel
sudo ln -s /etc/nginx/sites-available/lav60-panel /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d panel.seudominio.com.br
```

O painel ficará em `https://panel.seudominio.com.br`.

---

## 8. Apontar os agentes das lojas

Cada loja precisa enviar heartbeat para o VPS. No `.env` do agente (ou rebuild do `.exe`):

```env
PANEL_HEARTBEAT_URL=https://panel.seudominio.com.br/api/heartbeat
API_TOKEN=mesmo_token_do_painel
STORE_ID=PB05
```

Alternativas:

- Arquivo `panel_url.txt` ao lado do `.exe`:
  ```
  https://panel.seudominio.com.br
  ```
- Variável Windows `PANEL_HEARTBEAT_URL`

Teste no VPS:

```bash
curl -X POST "https://panel.seudominio.com.br/api/heartbeat" \
  -H "Content-Type: application/json" \
  -H "X-Token: SEU_API_TOKEN" \
  -d '{"store":"pb05","agent_url":"https://pb05.powpay.com.br","timestamp":"2026-06-08T12:00:00","network":{},"machines":[]}'
```

Resposta esperada: `{"ok":true,"store":"pb05",...}`

---

## 9. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

A porta **3000** fica só em `127.0.0.1` (Nginx faz proxy). Não exponha 3000 na internet.

---

## 10. Atualizar o painel

```bash
cd ~/lav60-panel
git pull   # ou substitua arquivos
source .venv/bin/activate
pip install -r requirements.txt
sudo systemctl restart lav60-panel
```

---

## Checklist rápido

- [ ] `stores.json` com lojas corretas  
- [ ] `.env` com `API_TOKEN` e `FLASK_SECRET_KEY`  
- [ ] Service account Firebase no caminho do `.env`  
- [ ] Gunicorn/systemd rodando  
- [ ] Nginx + HTTPS  
- [ ] Agentes com `PANEL_HEARTBEAT_URL` apontando para o VPS  
- [ ] Dashboard mostra lojas online após ~15 s  

---

## Problemas comuns

| Sintoma | Causa provável |
|---------|----------------|
| Loja offline no dashboard | Agente sem `PANEL_HEARTBEAT_URL` ou `API_TOKEN` diferente |
| Login não funciona | `FIREBASE_*` incorreto ou domínio não autorizado no Firebase Console |
| Registros vazios | `FIREBASE_SERVICE_ACCOUNT_FILE` inválido no VPS |
| 502 Bad Gateway | Serviço `lav60-panel` parado — `systemctl status lav60-panel` |

---

## Documentação relacionada

- [README.md](../README.md)
- [API.md](./API.md) — rotas `/api/heartbeat`, auth, auditoria
- [PANEL.md](./PANEL.md) — interface operacional
