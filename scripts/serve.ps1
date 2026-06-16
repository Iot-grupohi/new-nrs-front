# Servir painel LAV60 (frontend + hub de heartbeat dos agentes)
# Uso: .\scripts\serve.ps1   ou   .\serve.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$port = if ($env:FRONTEND_PORT) { $env:FRONTEND_PORT } else { 3000 }

$portListeners = @(
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
) | Where-Object { $_.OwningProcess -gt 0 }

if ($portListeners.Count -gt 0) {
    $pids = $portListeners.OwningProcess | Sort-Object -Unique
    Write-Host "ERRO: a porta $port já está em uso (PID: $($pids -join ', '))." -ForegroundColor Red
    Write-Host "Encerre o painel antigo antes de subir outro:" -ForegroundColor Yellow
    Write-Host "  Stop-Process -Id $($pids[0]) -Force" -ForegroundColor Yellow
    exit 1
}

$lanIp = $null
try {
    $lanIp = (
        Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -notlike '127.*' -and
            $_.PrefixOrigin -ne 'WellKnown'
        } |
        Select-Object -First 1
    ).IPAddress
} catch {
    $lanIp = $null
}

Write-Host "Painel LAV60: http://localhost:$port" -ForegroundColor Cyan
if ($lanIp) {
    Write-Host "Na rede local: http://${lanIp}:$port" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Agentes nas lojas: executar LAV60_Gateway.exe ou python backend/proxy_server.py" -ForegroundColor Gray
Write-Host "Ctrl+C para parar" -ForegroundColor Gray

Set-Location $Root
$env:FRONTEND_PORT = $port
python backend/panel_server.py
