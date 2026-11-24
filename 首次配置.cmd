@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\launch.ps1" -Action Setup %*
set "sft_exit=%errorlevel%"
pause
exit /b %sft_exit%
