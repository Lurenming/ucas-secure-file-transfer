@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\launch.ps1" -Action Server %*
set "sft_exit=%errorlevel%"
if not "%sft_exit%"=="0" pause
exit /b %sft_exit%
