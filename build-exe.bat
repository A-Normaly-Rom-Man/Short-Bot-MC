@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 veya ustu bulunamadi. Node.js LTS kurun: https://nodejs.org/
  pause
  exit /b 1
)

for /f "delims=" %%V in ('node -p "Number(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR (
  echo Node.js surumu okunamadi.
  pause
  exit /b 1
)
if %NODE_MAJOR% LSS 22 (
  echo Bu proje Node.js 22 veya ustu gerektirir. Bulunan surum: %NODE_MAJOR%
  pause
  exit /b 1
)

echo Gerekli paketler kuruluyor...
call npm.cmd install
if errorlevel 1 (
  echo Paket kurulumu basarisiz oldu. Node.js ve npm kurulumunu kontrol edin.
  pause
  exit /b 1
)

echo Minecraft AFK Bot EXE derleniyor...
call npm.cmd run build:exe
if errorlevel 1 (
  echo.
  echo Derleme basarisiz oldu. Node.js ve npm kurulumunu kontrol edin.
  pause
  exit /b 1
)

echo.
echo Hazir: %~dp0mc-afk-bot.exe
pause
