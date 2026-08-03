# Desbloqueia Lav60Agent.exe no Windows (SmartScreen / Mark-of-the-Web).
# Execute na pasta do exe ou passe o caminho: .\unblock-agent.ps1 C:\caminho\Lav60Agent.exe
$ErrorActionPreference = 'Stop'

$exe = $args[0]
if (-not $exe) {
    $exe = Join-Path $PSScriptRoot 'dist\Lav60Agent.exe'
}
$exe = (Resolve-Path -LiteralPath $exe).Path

Write-Host "Desbloqueando: $exe" -ForegroundColor Cyan
Unblock-File -LiteralPath $exe

# Remove Zone.Identifier se existir (arquivo baixado da internet).
$zone = "$exe`:Zone.Identifier"
if (Test-Path -LiteralPath $zone) {
    Remove-Item -LiteralPath $zone -Force
    Write-Host 'Mark-of-the-Web removido.' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Se o Windows SmartScreen ainda bloquear:' -ForegroundColor Yellow
Write-Host '  1. Clique em "Mais informacoes"'
Write-Host '  2. Clique em "Executar assim mesmo"'
Write-Host ''
Write-Host 'Se o Defender apagar o arquivo (falso positivo PyInstaller):' -ForegroundColor Yellow
Write-Host '  Configuracoes > Privacidade e seguranca > Seguranca do Windows >'
Write-Host '  Protecao contra virus > Gerenciar configuracoes > Exclusoes >'
Write-Host "  Adicione a pasta: $(Split-Path $exe -Parent)"
Write-Host ''
Write-Host 'Para confiar permanentemente (requer PowerShell como Administrador):' -ForegroundColor Yellow
Write-Host "  Add-MpPreference -ExclusionPath '$exe'"
Write-Host ''

$run = Read-Host 'Abrir Lav60Agent.exe agora? (S/N)'
if ($run -match '^[sS]') {
    Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe -Parent)
}
