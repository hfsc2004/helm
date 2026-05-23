@echo off
REM PSF Helm - launch the desktop app (helm-ui).
REM
REM For the CLI surface, run `npm run helm -- <args>` instead.

setlocal

cd /d "%~dp0"

if not exist "node_modules" (
  echo node_modules not found. Run install\RUN_ONCE_WINDOWS.bat first.
  exit /b 1
)

call npm run helm-ui

endlocal
