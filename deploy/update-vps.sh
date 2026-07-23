#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/root/lav60-panel}"

cd "$APP_DIR"

git fetch origin main
git reset --hard origin/main

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi

.venv/bin/pip install -r requirements.txt

if [[ -f deploy/lav60-panel.service ]]; then
  cp deploy/lav60-panel.service /etc/systemd/system/lav60-panel.service
  systemctl daemon-reload
fi

systemctl restart lav60-panel
systemctl --no-pager --full status lav60-panel
git log -1 --oneline
