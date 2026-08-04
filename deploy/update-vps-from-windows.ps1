# Envia JSON do Firebase, sincroniza tokens do .env local e atualiza a VPS.
# Uso (PowerShell na pasta do projeto):
#   .\deploy\update-vps-from-windows.ps1          # exige origin/main atualizado
#   .\deploy\update-vps-from-windows.ps1 -Push    # git push + deploy

param(
  [switch]$Push
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

function Invoke-Git {
  param(
    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
    [string[]]$GitArgs
  )
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & git @GitArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
      if ($output) { Write-Host ($output | Out-String).Trim() -ForegroundColor Red }
      throw "git $($GitArgs -join ' ') falhou (exit $LASTEXITCODE)"
    }
    return $output
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Invoke-GitQuiet {
  param(
    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
    [string[]]$GitArgs
  )
  Invoke-Git @GitArgs | Out-Null
}

function Get-GitOutput {
  param(
    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
    [string[]]$GitArgs
  )
  $text = Invoke-Git @GitArgs
  if ($null -eq $text) { return "" }
  if ($text -is [System.Array]) { return ($text | Out-String).Trim() }
  return [string]$text
}
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
$openAiKey = Read-DotEnvValue "OPENAI_API_KEY"
$openAiModel = Read-DotEnvValue "OPENAI_MODEL"

if (-not $doToken) {
  Write-Host "AVISO: DIGITALOCEAN_TOKEN nao encontrado no .env local" -ForegroundColor Yellow
}
if (-not $cloudflareToken) {
  Write-Host "AVISO: CLOUDFLARE_API_TOKEN nao encontrado no .env local" -ForegroundColor Yellow
}
if (-not $openAiKey) {
  Write-Host "AVISO: OPENAI_API_KEY nao encontrado no .env local (assistente IA desativado)" -ForegroundColor Yellow
}

Write-Host "==> Verificando Git (a VPS usa origin/main, nao o codigo local)" -ForegroundColor Cyan
Invoke-GitQuiet fetch origin main
$localHead = Get-GitOutput rev-parse HEAD
$remoteHead = Get-GitOutput rev-parse origin/main
$ahead = [int](Get-GitOutput rev-list --count "origin/main..HEAD")
if ($ahead -gt 0) {
  Write-Host ""
  Write-Host "ERRO: $ahead commit(s) local(is) ainda nao enviado(s) para origin/main." -ForegroundColor Red
  Write-Host "  Local:  $(Get-GitOutput log -1 --oneline HEAD)"
  Write-Host "  Remoto: $(Get-GitOutput log -1 --oneline origin/main)"
  Write-Host ""
  if ($Push) {
    Write-Host "Enviando commits para origin/main (-Push)..." -ForegroundColor Yellow
    Invoke-GitQuiet push origin main
    Invoke-GitQuiet fetch origin main
    $remoteHead = Get-GitOutput rev-parse origin/main
    $ahead = [int](Get-GitOutput rev-list --count "origin/main..HEAD")
    if ($ahead -gt 0) {
      Write-Host "ERRO: push concluido mas origin/main ainda difere do HEAD local." -ForegroundColor Red
      exit 1
    }
  } else {
    Write-Host "Execute: git push origin main" -ForegroundColor Yellow
    Write-Host "   ou:  .\deploy\update-vps-from-windows.ps1 -Push" -ForegroundColor Yellow
    exit 1
  }
}
Write-Host "  OK: origin/main = $(Get-GitOutput log -1 --oneline origin/main)"

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
export OPENAI_API_KEY='$openAiKey' && \
export OPENAI_MODEL='$openAiModel' && \
git fetch origin main && git reset --hard origin/main && \
bash deploy/vps-update-all.sh
"@

ssh $Vps $remoteCmd

Write-Host ""
Write-Host "==> Versao em producao (store.html)" -ForegroundColor Cyan
try {
  $prod = (curl.exe -s -m 20 "https://nrs.lav60.com/store.html" 2>$null) -join "`n"
  $apiVer = if ($prod -match 'api\.js\?v=(\d+)') { $Matches[1] } else { "?" }
  $storeVer = if ($prod -match 'store\.js\?v=(\d+)') { $Matches[1] } else { "?" }
  Write-Host "  nrs.lav60.com -> api.js?v=$apiVer store.js?v=$storeVer"
} catch {
  Write-Host "  AVISO: nao foi possivel verificar store.html em producao" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Concluido. Teste:" -ForegroundColor Green
Write-Host "  https://nrs.lav60.com/index.html#/infra/vps"
Write-Host "  https://nrs.lav60.com/index.html#/registros"
Write-Host ""
Write-Host "Lembrete: alteracoes em agent_cloudflare/ exigem update do agente na loja (nao vai pela VPS)." -ForegroundColor DarkGray
