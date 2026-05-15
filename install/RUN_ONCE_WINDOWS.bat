@echo off
REM PSF Helm - one-time dependency installer (Windows)
REM
REM Run this once after cloning the repo, or any time package.json changes.
REM Re-running is safe; npm will reconcile.

setlocal

set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."

echo.
echo ==============================================
echo   PSF Helm - one-time setup (Windows)
echo ==============================================
echo.

REM ---- Node check ----
where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js is not installed or not on PATH.
  echo   Install Node.js LTS from https://nodejs.org/ and re-run this script.
  exit /b 1
)

for /f "delims=" %%v in ('node --version') do set "NODE_VERSION=%%v"
echo Node.js: %NODE_VERSION%

REM ---- npm check ----
where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm is not installed or not on PATH.
  echo   npm normally ships with Node.js; check your Node.js install.
  exit /b 1
)

for /f "delims=" %%v in ('npm --version') do set "NPM_VERSION=%%v"
echo npm:     %NPM_VERSION%
echo Repo:    %REPO_ROOT%
echo.

REM ---- Install ----
cd /d "%REPO_ROOT%"

echo Installing dependencies (this may take several minutes on the first run)...
echo.
call npm install
if errorlevel 1 (
  echo.
  echo ERROR: npm install failed.
  exit /b 1
)

echo.
echo ==============================================
echo   Setup complete.
echo.
echo   Start the app in dev mode with:
echo     npm run dev
echo ==============================================
echo.

endlocal
