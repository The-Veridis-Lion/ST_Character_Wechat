@echo off
setlocal

cd /d "%~dp0"
title Enable ST Character WeChat Startup
set "STCW_ROOT=%CD%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root=$env:STCW_ROOT; if ($root) { Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.bat','.cmd','.ps1','.html' } | Unblock-File -ErrorAction SilentlyContinue }" >nul 2>nul

set "STCW_TARGET=%~dp001_START_WECHAT.bat"
set "STCW_WORKDIR=%~dp0"
set "STCW_SHORTCUT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ST Character WeChat.lnk"

if not exist "%STCW_TARGET%" (
  echo 01_START_WECHAT.bat was not found in this folder.
  echo Keep 02_ENABLE_STARTUP.bat in the ST_Character_Wechat project root.
  echo.
  pause
  exit /b 1
)

echo This will create a Windows startup shortcut:
echo %STCW_SHORTCUT%
echo.
echo It points to:
echo %STCW_TARGET%
echo.
choice /c YN /m "Enable startup for ST Character WeChat"
if errorlevel 2 (
  echo Canceled.
  pause
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=New-Object -ComObject WScript.Shell; $lnk=$s.CreateShortcut($env:STCW_SHORTCUT); $lnk.TargetPath=$env:STCW_TARGET; $lnk.WorkingDirectory=$env:STCW_WORKDIR; $lnk.WindowStyle=1; $lnk.Description='Start ST Character WeChat'; $lnk.Save()"
if errorlevel 1 (
  echo Failed to create the startup shortcut.
  echo You can manually place a shortcut to 01_START_WECHAT.bat in:
  echo %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
  echo.
  pause
  exit /b 1
)

echo Startup shortcut created.
echo To disable startup later, run 05_DISABLE_STARTUP.bat or delete:
echo %STCW_SHORTCUT%
echo.
pause
