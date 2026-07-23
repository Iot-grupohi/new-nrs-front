# Inicia backend (API) e frontend (painel) em processos separados.
# Uso: .\serve.ps1

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$EnvFile = Join-Path $Root ".env"

function Read-DotEnvValue {
    param([string]$Name)
    if (-not (Test-Path $EnvFile)) { return $null }
    foreach ($line in Get-Content $EnvFile -Encoding UTF8) {
        if ($line -match "^\s*$Name\s*=\s*(.+?)\s*$") {
            return $Matches[1].Trim().Trim('"').Trim("'")
        }
    }
    return $null
}

function Test-PortListening {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return [bool]$conn
}

function Start-ServerWindow {
    param(
        [string]$Title,
        [string]$Command
    )
    $psCommand = "Set-Location -LiteralPath '$Root'; `$Host.UI.RawUI.WindowTitle = '$Title'; Write-Host '$Title' -ForegroundColor Cyan; $Command"
    return Start-Process powershell `
        -ArgumentList @("-NoExit", "-Command", $psCommand) `
        -PassThru `
        -WindowStyle Normal
}

$backendPortRaw = $env:PORT
if (-not $backendPortRaw) { $backendPortRaw = Read-DotEnvValue "PORT" }
if (-not $backendPortRaw) { $backendPortRaw = "3100" }
$backendPort = [int]$backendPortRaw

$frontendPortRaw = $env:FRONTEND_PORT
if (-not $frontendPortRaw) { $frontendPortRaw = Read-DotEnvValue "FRONTEND_PORT" }
if (-not $frontendPortRaw) { $frontendPortRaw = "8080" }
$frontendPort = [int]$frontendPortRaw

if (Test-PortListening -Port $backendPort) {
    Write-Host "Backend ja esta rodando na porta $backendPort." -ForegroundColor Yellow
} else {
    Write-Host "LAV60 - iniciando backend..." -ForegroundColor Cyan
    $backend = Start-ServerWindow -Title "LAV60 Backend :$backendPort" -Command "python backend\main.py"
}

Start-Sleep -Seconds 2

if (Test-PortListening -Port $frontendPort) {
    Write-Host "Frontend ja esta rodando na porta $frontendPort." -ForegroundColor Yellow
} else {
    Write-Host "LAV60 - iniciando frontend..." -ForegroundColor Cyan
    $frontend = Start-ServerWindow -Title "LAV60 Frontend :$frontendPort" -Command "python frontend\dev_server.py"
}

Start-Sleep -Seconds 2

$backendUp = Test-PortListening -Port $backendPort
$frontendUp = Test-PortListening -Port $frontendPort

Write-Host ""
if ($backendUp) {
    Write-Host "Backend API : http://127.0.0.1:$backendPort" -ForegroundColor Green
} else {
    Write-Host "Backend NAO subiu - veja a janela LAV60 Backend." -ForegroundColor Red
}

if ($frontendUp) {
    Write-Host "Frontend    : http://127.0.0.1:$frontendPort" -ForegroundColor Green
} else {
    Write-Host "Frontend NAO subiu - veja a janela LAV60 Frontend." -ForegroundColor Red
}

if ($backend -and $frontend) {
    Write-Host ""
    Write-Host "PIDs: backend=$($backend.Id) frontend=$($frontend.Id)" -ForegroundColor DarkGray
}

Write-Host "Mantenha as janelas abertas. Feche-as para parar os servidores." -ForegroundColor DarkGray

if ($frontendUp) {
    Start-Process "http://127.0.0.1:$frontendPort/"
}
