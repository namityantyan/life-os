@echo off
rem Life OS FX connector: install / update. Double-click this file after extracting the zip.
chcp 65001 >nul
cd /d "%~dp0"
if not exist "%~dp0installer\setup.ps1" (
  echo.
  echo  [!] installer\setup.ps1 was not found.
  echo      Extract the whole zip first ^(right-click the zip - Extract All^), then run
  echo      LifeOS-FX-Setup.bat from the extracted folder.
  echo.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\setup.ps1"
if errorlevel 1 (
  echo.
  echo  Setup failed. Log: %LOCALAPPDATA%\LifeOS\fx-setup.log
)
echo.
pause
