@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Stop-ScheduledTask -TaskName 'Life OS FX Connector' -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'lifeos_connector\.py|run-loop\.cmd' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Write-Host 'stopped. It starts again at next logon (or run the setup again).'"
pause
