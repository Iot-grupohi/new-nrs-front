# Envia JSON do Firebase e roda atualização completa na VPS.
# Uso (PowerShell na pasta do projeto):
#   .\deploy\update-vps-from-windows.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Vps = "root@161.97.110.117"
$RemoteDir = "/root/lav60-panel"
$JsonLocal = Join-Path $Root "portal-franqueado-lav60-firebase-adminsdk-fbsvc-f5d1c03476.json"
$JsonRemote = "$RemoteDir/portal-franqueado-lav60-firebase-adminsdk-fbsvc-f5d1c03476.json"

if (-not (Test-Path $JsonLocal)) {
  Write-Host "Arquivo nao encontrado: $JsonLocal" -ForegroundColor Red
  exit 1
}

Write-Host "1/2 Enviando service account para VPS..." -ForegroundColor Cyan
scp $JsonLocal "${Vps}:${JsonRemote}"

Write-Host "2/2 Atualizando codigo + Firebase + restart..." -ForegroundColor Cyan
ssh $Vps "cd $RemoteDir && git fetch origin main && git reset --hard origin/main && bash deploy/vps-update-all.sh"

Write-Host ""
Write-Host "Concluido. Teste: https://nrs.lav60.com/index.html#/registros" -ForegroundColor Green
