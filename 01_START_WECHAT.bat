@echo off
setlocal

cd /d "%~dp0"
title ST Character WeChat
set "STCW_ROOT=%CD%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root=$env:STCW_ROOT; if ($root) { Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.bat','.cmd','.ps1','.html' } | Unblock-File -ErrorAction SilentlyContinue }" >nul 2>nul

echo [ST Character WeChat] Starting from:
echo %CD%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js 22 or newer first.
  echo.
  pause
  exit /b 1
)

if not exist "package.json" (
  echo package.json was not found. Keep this file in the ST_Character_Wechat project root.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo node_modules was not found. Run npm install in this folder first.
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo .env was not found. Configure the project first with 00_START_HERE.html or the install prompt.
  echo.
  pause
  exit /b 1
)

if exist "scripts\prepare-windows-start.js" (
  node "scripts\prepare-windows-start.js"
  if errorlevel 1 (
    echo.
    echo Windows startup preparation failed. The app was not started.
    echo.
    pause
    exit /b 1
  )
)

npm run start
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo [ST Character WeChat] Process exited with code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
