@echo off
setlocal

title Disable ST Character WeChat Startup

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
