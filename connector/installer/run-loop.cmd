@echo off
rem Keeps the Life OS FX connector running; restarts it 15 seconds after any exit.
setlocal
cd /d "%~dp0.."
set PYTHONIOENCODING=utf-8
if not exist "state\logs" mkdir "state\logs"
:loop
echo ==== %date% %time% start >> "state\logs\connector.log"
".venv\Scripts\python.exe" lifeos_connector.py >> "state\logs\connector.log" 2>&1
echo ==== %date% %time% exit %errorlevel% >> "state\logs\connector.log"
for %%A in ("state\logs\connector.log") do if %%~zA GTR 20000000 move /y "state\logs\connector.log" "state\logs\connector.old.log" >nul
timeout /t 15 /nobreak >nul
goto loop
