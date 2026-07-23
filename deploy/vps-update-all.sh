#!/usr/bin/env bash
# Atualiza código + valida Firebase + reinicia lav60-panel na VPS.
# Uso (na VPS): cd /root/lav60-panel && bash deploy/vps-update-all.sh

set -euo pipefail

APP_DIR="${APP_DIR:-/root/lav60-panel}"
SA_FILE="${SA_FILE:-$APP_DIR/portal-franqueado-lav60-firebase-adminsdk-fbsvc-f5d1c03476.json}"
ENV_FILE="$APP_DIR/.env"

cd "$APP_DIR"

echo "==> Git pull + dependências + restart"
bash deploy/update-vps.sh

if [[ ! -f "$SA_FILE" ]]; then
  echo ""
  echo "ERRO: JSON da service account não encontrado:"
  echo "  $SA_FILE"
  echo ""
  echo "No seu PC, envie o arquivo:"
  echo "  scp portal-franqueado-lav60-firebase-adminsdk-fbsvc-f5d1c03476.json root@161.97.110.117:$SA_FILE"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERRO: $ENV_FILE não existe"
  exit 1
fi

patch_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

echo "==> Ajustando Firebase no .env"
patch_env "FIREBASE_API_KEY" "AIzaSyBFIjW07ITSg5gHS9USUX3KaSthn4MjDdU"
patch_env "FIREBASE_AUTH_DOMAIN" "portal-franqueado-lav60.firebaseapp.com"
patch_env "FIREBASE_PROJECT_ID" "portal-franqueado-lav60"
patch_env "FIREBASE_STORAGE_BUCKET" "portal-franqueado-lav60.firebasestorage.app"
patch_env "FIREBASE_MESSAGING_SENDER_ID" "233168175568"
patch_env "FIREBASE_APP_ID" "1:233168175568:web:64044f316c1ec7188a39d5"
patch_env "FIREBASE_SERVICE_ACCOUNT_FILE" "$SA_FILE"
patch_env "FIREBASE_AUDIT_COLLECTION" "audit_logs"

if [[ -n "${DIGITALOCEAN_TOKEN:-}" ]]; then
  patch_env "DIGITALOCEAN_TOKEN" "$DIGITALOCEAN_TOKEN"
fi
if [[ -n "${DIGITALOCEAN_DB_TOKEN:-}" ]]; then
  patch_env "DIGITALOCEAN_DB_TOKEN" "$DIGITALOCEAN_DB_TOKEN"
fi
if [[ -n "${MONITOR_SITES_API_URL:-}" ]]; then
  patch_env "MONITOR_SITES_API_URL" "$MONITOR_SITES_API_URL"
fi
if [[ -n "${MONITOR_SITES_BEARER_TOKEN:-}" ]]; then
  patch_env "MONITOR_SITES_BEARER_TOKEN" "$MONITOR_SITES_BEARER_TOKEN"
fi

echo "==> Removendo artefatos do Firebase antigo (hipag-02)"
rm -f "$APP_DIR/hipag-02-firebase-adminsdk-fbsvc-888378701a.json" 2>/dev/null || true
rm -f "$APP_DIR/service-account.json" 2>/dev/null || true

echo "==> Restaurando registry de monitoramento (VPS/Database)"
mkdir -p "$APP_DIR/backend/panel/data"
if [[ -f "$APP_DIR/deploy/infra_registry.json" ]]; then
  cp "$APP_DIR/deploy/infra_registry.json" "$APP_DIR/backend/panel/data/infra_registry.json"
fi

systemctl restart lav60-panel
sleep 2

echo ""
echo "==> Validação (conta portal-franqueado-lav60)"
curl -s "http://127.0.0.1:3000/api/auth/config" | python3 -c "import sys,json; d=json.load(sys.stdin); print('auth project:', (d.get('firebase') or {}).get('projectId'))" || true
curl -s "http://127.0.0.1:3000/api/audit/status" | python3 -m json.tool || true
echo ""
curl -s "http://127.0.0.1:3000/api/audit/logs?limit=3" | python3 -c "import sys,json; d=json.load(sys.stdin); print('logs:', len(d.get('items') or []), 'available:', d.get('available'))" || true
curl -s "http://127.0.0.1:3000/api/infra/metrics?window=3600&include_databases=1" | python3 -c "import sys,json; d=json.load(sys.stdin); print('infra vps:', len(d.get('vps') or []), 'databases:', len(d.get('databases') or []))" || true
echo ""
git log -1 --oneline
systemctl is-active lav60-panel
