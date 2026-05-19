@echo off
setlocal EnableExtensions

cd /d "%~dp0"
title Update and Start ST Character WeChat
set "STCW_ROOT=%CD%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root=$env:STCW_ROOT; if ($root) { Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.bat','.cmd','.ps1','.html' } | Unblock-File -ErrorAction SilentlyContinue }" >nul 2>nul
set "STCW_REMOTE=https://github.com/The-Veridis-Lion/ST_Character_Wechat.git"
set "STCW_BRANCH=main"

echo [ST Character WeChat] Updating from:
echo %CD%
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo Git was not found. Install Git first, or start normally with 01_START_WECHAT.bat.
  echo.
  pause
  exit /b 1
)

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

echo GitHub source:
echo %STCW_REMOTE%
echo.
echo This updates app/program files from GitHub, then runs npm install and starts WeChat.
echo It does not clean local data folders or local settings.
echo.
echo Preserved local data:
echo   .env
echo   character-cards\
echo   node_modules\  (npm install will refresh it from package.json)
echo   tmp\
echo   user-memory\
echo   report-cards\
echo   st-character-wechat-state\
echo.
echo If you manually edited app source files, those program-file edits may be replaced.
echo.
choice /c YN /m "Continue update and start"
if errorlevel 2 (
  echo Canceled.
  pause
  exit /b 0
)
echo.

echo Step 1/4: stopping any running ST Character WeChat process.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$targets=Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*st-character-wechat.js*start*') }; foreach ($p in $targets) { Write-Host ('Stopping PID ' + $p.ProcessId + ' ' + $p.Name); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }"
echo.

echo Step 2/4: updating program files from GitHub.
if not exist ".git" (
  echo This looks like a GitHub ZIP download. It will be converted into a Git checkout
  echo so future updates can run from this same folder.
  echo.
  git init
  if errorlevel 1 goto update_failed
)

git remote get-url origin >nul 2>nul
if errorlevel 1 (
  git remote add origin "%STCW_REMOTE%"
) else (
  git remote set-url origin "%STCW_REMOTE%"
)
if errorlevel 1 goto update_failed

git fetch --depth 1 origin %STCW_BRANCH%
if errorlevel 1 (
  goto update_failed
)
git reset --hard FETCH_HEAD
if errorlevel 1 goto update_failed
git branch -M %STCW_BRANCH%
git branch --set-upstream-to=origin/%STCW_BRANCH% %STCW_BRANCH% >nul 2>nul
echo.

echo Step 3/4: installing or refreshing dependencies.
npm install
if errorlevel 1 (
  echo.
  echo npm install failed. Check the network and npm output above.
  echo.
  pause
  exit /b 1
)
echo.

echo Step 4/4: running project check.
npm run check
if errorlevel 1 (
  echo.
  echo Project check failed. The app was not started.
  echo.
  pause
  exit /b 1
)
echo.

call "%~dp001_START_WECHAT.bat"
exit /b %ERRORLEVEL%

:update_failed
echo.
echo Update failed.
echo Your local data was not intentionally deleted. The update only targets program files.
echo If this keeps failing, start the current copy with 01_START_WECHAT.bat.
echo.
pause
exit /b 1
