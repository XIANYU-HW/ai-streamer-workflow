@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22.12 or newer with npm: https://nodejs.org/en/download
  pause
  exit /b 1
)
node scripts\setup.mjs %*
set "setup_result=%errorlevel%"
pause
exit /b %setup_result%
