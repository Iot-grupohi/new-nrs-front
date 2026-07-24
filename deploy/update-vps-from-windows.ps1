# Envia JSON do Firebase, sincroniza tokens do .env local e atualiza a VPS.
# Uso (PowerShell na pasta do projeto):
#   .\deploy\update-vps-from-windows.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EnvFile = Join-Path $Root ".env"
$Vps = "root@161.97.110.117"
$RemoteDir = "/root/lav60-panel"
$JsonLocal = Join-Path $Root "portal-franqueado-lav60-firebase-adminsdk-fbsvc-f5d1c03476.json"
$JsonRemote = "$RemoteDir/portal-franqueado-lav60-firebase-adminsdk-fbsvc-f5d1c03476.json"

function Read-DotEnvValue {
  param([string]$Name)
  if (-not (Test-Path $EnvFile)) { return "" }
  foreach ($line in Get-Content $EnvFile -Encoding UTF8) {
    if ($line -match "^\s*$([regex]::Escape($Name))\s*=\s*(.+?)\s*$") {
      return $Matches[1].Trim().Trim('"').Trim("'")
    }
  }
  return ""
}

if (-not (Test-Path $JsonLocal)) {
  Write-Host "Arquivo nao encontrado: $JsonLocal" -ForegroundColor Red
  exit 1
}

$doToken = Read-DotEnvValue "DIGITALOCEAN_TOKEN"
$doDbToken = Read-DotEnvValue "DIGITALOCEAN_DB_TOKEN"
$monitorUrl = Read-DotEnvValue "MONITOR_SITES_API_URL"
$monitorToken = Read-DotEnvValue "MONITOR_SITES_BEARER_TOKEN"
$cloudflareToken = Read-DotEnvValue "CLOUDFLARE_API_TOKEN"
$gatewayToken = Read-DotEnvValue "GATEWAY_API_TOKEN"
$xToken = Read-DotEnvValue "X_TOKEN"

if (-not $doToken) {
  Write-Host "AVISO: DIGITALOCEAN_TOKEN nao encontrado no .env local" -ForegroundColor Yellow
}
if (-not $cloudflareToken) {
  Write-Host "AVISO: CLOUDFLARE_API_TOKEN nao encontrado no .env local" -ForegroundColor Yellow
}

Write-Host "1/2 Enviando service account para VPS..." -ForegroundColor Cyan
scp $JsonLocal "${Vps}:${JsonRemote}"

Write-Host "2/2 Atualizando codigo, Firebase, DigitalOcean e restart..." -ForegroundColor Cyan
$remoteCmd = @"
cd $RemoteDir && \
export DIGITALOCEAN_TOKEN='$doToken' && \
export DIGITALOCEAN_DB_TOKEN='$doDbToken' && \
export MONITOR_SITES_API_URL='$monitorUrl' && \
export MONITOR_SITES_BEARER_TOKEN='$monitorToken' && \
export CLOUDFLARE_API_TOKEN='$cloudflareToken' && \
export GATEWAY_API_TOKEN='$gatewayToken' && \
export X_TOKEN='$xToken' && \
git fetch origin main && git reset --hard origin/main && \
bash deploy/vps-update-all.sh
"@

ssh $Vps $remoteCmd

Write-Host ""
Write-Host "Concluido. Teste:" -ForegroundColor Green
Write-Host "  https://nrs.lav60.com/index.html#/infra/vps"
Write-Host "  https://nrs.lav60.com/index.html#/registros"
