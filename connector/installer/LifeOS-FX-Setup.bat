@echo off
rem Life OS FX connector: install / update. Double-click this file.
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\setup.ps1"
if errorlevel 1 (
  echo.
  echo Setup failed. See the message above.
)
echo.
pause
