@echo off
setlocal

cd /d "%~dp0"
title Disable ST Character WeChat Startup
set "STCW_ROOT=%CD%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root=$env:STCW_ROOT; if ($root) { Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.bat','.cmd','.ps1','.html' } | Unblock-File -ErrorAction SilentlyContinue }" >nul 2>nul

set "STCW_SHORTCUT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ST Character WeChat.lnk"

echo This will remove the Windows startup shortcut for ST Character WeChat:
echo %STCW_SHORTCUT%
echo.

if not exist "%STCW_SHORTCUT%" (
  echo No startup shortcut was found. Startup is already disabled for this Windows user.
  echo.
  pause
  exit /b 0
)

choice /c YN /m "Disable startup for ST Character WeChat"
if errorlevel 2 (
  echo Canceled.
  pause
  exit /b 0
)

del "%STCW_SHORTCUT%"
if errorlevel 1 (
  echo Failed to delete the startup shortcut.
  echo You can delete it manually from:
  echo %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
  echo.
  pause
  exit /b 1
)

echo Startup has been disabled for ST Character WeChat.
echo.
pause
