@echo off
cd /d "%~dp0"
if not exist ".venv-quality\Scripts\python.exe" (
  echo Run Setup-Studio.cmd first.
  pause
  exit /b 1
)
".venv-quality\Scripts\python.exe" -m studio.app
if errorlevel 1 pause
