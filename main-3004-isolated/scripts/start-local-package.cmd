@echo off
setlocal
cd /d "%~dp0"

if not exist "runtime\node.exe" (
  echo Bundled Node runtime is missing.
  echo Please extract the complete ZIP before starting the canvas.
  pause
  exit /b 1
)

"runtime\node.exe" "server.mjs" %*
if errorlevel 1 (
  echo.
  echo X-tapnow failed to start. Keep this window open and send the error text to the maintainer.
  pause
)
