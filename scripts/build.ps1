# Build LAV60 Gateway — Windows (executavel unico)
# Uso: .\scripts\build.ps1   ou   .\build.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

Write-Host "==> Instalando dependencias..." -ForegroundColor Cyan
python -m pip install -r requirements.txt
python -m pip install pyinstaller

Write-Host "==> Verificando .env (sera embutido no executavel)..." -ForegroundColor Cyan
$envFile = Join-Path $Root ".env"
if (-not (Test-Path $envFile)) {
    Write-Host "ERRO: .env nao encontrado em $envFile" -ForegroundColor Red
    Write-Host "Crie o .env na raiz do projeto antes do build (STORE_ID, API_TOKEN, LAV60_API_TOKEN)." -ForegroundColor Yellow
    exit 1
}

Write-Host "==> Gerando executavel unico..." -ForegroundColor Cyan
python -m PyInstaller lav60_gateway.spec --noconfirm --clean

$exePath = Join-Path $Root "dist\LAV60_Gateway.exe"

if (-not (Test-Path $exePath)) {
    Write-Host "ERRO: $exePath nao encontrado" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "OK: $exePath" -ForegroundColor Green
Write-Host ""
Write-Host "Deploy:" -ForegroundColor Yellow
Write-Host "  Copie apenas LAV60_Gateway.exe para o PC da loja e execute (duplo clique)" -ForegroundColor Yellow
Write-Host "  Configuracao (.env) ja embutida no build — um unico arquivo" -ForegroundColor Yellow
Write-Host "  Para trocar loja/token: edite .env e rode o build novamente" -ForegroundColor Yellow
Write-Host "  Logs e config runtime: %USERPROFILE%\.lav60\" -ForegroundColor Yellow
Write-Host ""
Write-Host "Agente: http://localhost:8080" -ForegroundColor Cyan
