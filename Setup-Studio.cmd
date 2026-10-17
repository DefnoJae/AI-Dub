@echo off
cd /d "%~dp0"
if not exist ".venv-quality\Scripts\python.exe" (
  py -3.11 -m venv .venv-quality
  if errorlevel 1 goto failed
)
".venv-quality\Scripts\python.exe" -m pip install -r companion\requirements-quality.txt
if errorlevel 1 goto failed
".venv-quality\Scripts\python.exe" companion\prepare_quality.py
if errorlevel 1 goto failed
".venv-quality\Scripts\python.exe" studio\prepare.py
if errorlevel 1 goto failed
echo Ready. Open Start-Studio.cmd.
pause
exit /b 0
:failed
echo Setup failed. See the error above. Python 3.11 with tkinter is required.
pause
exit /b 1
