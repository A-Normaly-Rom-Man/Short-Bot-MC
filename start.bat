@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js bulunamadi. Once Node.js LTS kurun: https://nodejs.org/
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

if not exist "node_modules\mineflayer" (
  echo Gerekli paketler kuruluyor...
  call npm install
  if errorlevel 1 (
    echo Paket kurulumu basarisiz oldu.
    pause
    exit /b 1
  )
)

node index.js
if errorlevel 1 (
  echo Program hata koduyla kapandi.
  pause
)
endlocal
