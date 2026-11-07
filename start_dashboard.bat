@echo off
setlocal
title Fuel stats dashboard
cd /d "%~dp0"

set "PORT=8000"
set "URL=http://localhost:%PORT%"
set "VENV_PY=.venv\Scripts\python.exe"

rem If the dashboard is already running, just open it.
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
    echo Port %PORT% is already in use, so the dashboard is probably running.
    echo Opening %URL%
    start "" "%URL%"
    timeout /t 3 >nul
    exit /b 0
)

if exist "%VENV_PY%" goto check_packages

where python >nul 2>nul
if errorlevel 1 (
    echo Python was not found. Install it from https://www.python.org/downloads/
    echo and tick "Add python.exe to PATH" during setup, then run this file again.
    goto failed
)
echo First run: creating the Python environment...
python -m venv .venv
if errorlevel 1 goto failed

:check_packages
"%VENV_PY%" -c "import fastapi, uvicorn, pandas, numpy" >nul 2>nul
if not errorlevel 1 goto launch

echo Installing dependencies. This can take a minute...
"%VENV_PY%" -m pip install -r backend\requirements.txt
if errorlevel 1 goto failed

:launch
echo.
echo Starting the dashboard at %URL%
echo Keep this window open while you use it. Close it to stop the server.
echo.

rem Wait in the background until the server answers, then open the browser.
start "" /b powershell -NoProfile -Command "for ($i = 0; $i -lt 240; $i++) { try { (New-Object Net.Sockets.TcpClient '127.0.0.1', %PORT%).Close(); Start-Process '%URL%'; break } catch { Start-Sleep -Milliseconds 500 } }"

"%VENV_PY%" -m uvicorn backend.app:app --port %PORT%
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo The dashboard could not start. See the message above.
pause
exit /b 1
