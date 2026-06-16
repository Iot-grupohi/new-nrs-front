@echo off
chcp 65001 >nul
cd /d "%~dp0\.."

if exist "dist\LAV60_Gateway.exe" (
  start "" "dist\LAV60_Gateway.exe"
  exit /b 0
)

if exist "LAV60_Gateway.exe" (
  start "" "LAV60_Gateway.exe"
  exit /b 0
)

echo.
echo  LAV60_Gateway.exe nao encontrado.
echo  Execute scripts\build.ps1 nesta pasta ou copie o .exe para ca.
echo.
pause
