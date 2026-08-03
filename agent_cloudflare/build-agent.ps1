# Gera dist\Lav60Agent.exe (PyInstaller onefile — .env e dependencias embarcados)
$ErrorActionPreference = 'Stop'

$AgentDir = $PSScriptRoot
Set-Location $AgentDir

Write-Host '==> Lav60 Agent - build PyInstaller (onefile)' -ForegroundColor Cyan

python --version | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Python nao encontrado. Instale Python 3.11+ e adicione ao PATH.'
}

Write-Host '==> Instalando dependencias...' -ForegroundColor Cyan
python -m pip install --upgrade pip
python -m pip install -r requirements.txt pyinstaller

$buildDir = Join-Path $AgentDir 'build'
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

$embeddedEnv = Join-Path $buildDir '.env'
$envSrc = Join-Path $AgentDir '.env'
$envExample = Join-Path $AgentDir '.env.example'

Write-Host '==> Preparando .env embarcado...' -ForegroundColor Cyan
if (Test-Path $envSrc) {
    Copy-Item $envSrc $embeddedEnv -Force
} elseif (Test-Path $envExample) {
    Copy-Item $envExample $embeddedEnv -Force
    Write-Host '==> Aviso: .env local ausente — usando .env.example' -ForegroundColor Yellow
} else {
    throw 'Crie agent_cloudflare\.env antes do build (ou .env.example).'
}

$repoRoot = Split-Path $AgentDir -Parent
$firebaseJson = Get-ChildItem -Path $repoRoot -Filter 'portal-franqueado-*-firebase-adminsdk-*.json' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($firebaseJson) {
    python (Join-Path $AgentDir 'merge_env_firebase.py') $embeddedEnv $firebaseJson.FullName
    if ($LASTEXITCODE -ne 0) {
        Write-Host '==> Aviso: nao foi possivel incorporar Firebase no .env embarcado' -ForegroundColor Yellow
    } else {
        Write-Host '==> Firebase incorporado no .env embarcado' -ForegroundColor Green
    }
} else {
    Write-Host '==> Aviso: JSON Firebase nao encontrado — build sem credencial RTDB' -ForegroundColor Yellow
}

$distExe = Join-Path $AgentDir 'dist\Lav60Agent.exe'
if (Test-Path $distExe) {
    try {
        Remove-Item $distExe -Force
    } catch {
        Write-Host '==> Aviso: feche Lav60Agent.exe antes de rebuildar' -ForegroundColor Yellow
        throw 'dist\Lav60Agent.exe em uso.'
    }
}

Write-Host '==> Compilando executavel unico (pode levar alguns minutos)...' -ForegroundColor Cyan
python -m PyInstaller lav60-agent.spec --noconfirm --clean
if ($LASTEXITCODE -ne 0) {
    throw 'PyInstaller falhou.'
}

if (-not (Test-Path $distExe)) {
    throw "Executavel nao encontrado: $distExe"
}

# Remove bloqueio local (Mark-of-the-Web) apos build.
Unblock-File -LiteralPath $distExe -ErrorAction SilentlyContinue

# Assinatura opcional (evita SmartScreen em producao): certificado .pfx
$pfx = $env:LAV60_CODESIGN_PFX
$pfxPass = $env:LAV60_CODESIGN_PASSWORD
if ($pfx -and (Test-Path $pfx)) {
    Write-Host '==> Assinando executavel...' -ForegroundColor Cyan
    if ($pfxPass) {
        & signtool sign /fd SHA256 /f $pfx /p $pfxPass /tr http://timestamp.digicert.com /td SHA256 $distExe
    } else {
        & signtool sign /fd SHA256 /f $pfx /tr http://timestamp.digicert.com /td SHA256 $distExe
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host '==> Aviso: assinatura falhou — exe gerado sem certificado' -ForegroundColor Yellow
    } else {
        Write-Host '==> Executavel assinado' -ForegroundColor Green
    }
}

$sizeMb = [math]::Round((Get-Item $distExe).Length / 1MB, 1)
Write-Host ''
Write-Host 'Build concluido:' -ForegroundColor Green
Write-Host "  $distExe  ($sizeMb MB)"
Write-Host ''
Write-Host 'Deploy na loja:' -ForegroundColor Yellow
Write-Host '  1. Copie apenas dist\Lav60Agent.exe para o PC da loja'
Write-Host '  2. Defina STORE_ID no Windows (variaveis de ambiente do PC)'
Write-Host '  3. Execute Lav60Agent.exe (nao precisa de .env, _internal nem pasta extra)'
Write-Host '  4. Config e logs em %USERPROFILE%\.lav60\'
Write-Host ''
Write-Host 'Windows bloqueou o exe?' -ForegroundColor Yellow
Write-Host '  .\unblock-agent.ps1 dist\Lav60Agent.exe'
Write-Host '  SmartScreen: "Mais informacoes" -> "Executar assim mesmo"'
Write-Host '  Producao: assine com certificado (LAV60_CODESIGN_PFX no build)'
Write-Host ''
