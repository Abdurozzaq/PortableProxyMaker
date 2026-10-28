@echo off
rem Double-click launcher for install.ps1 (bypasses the PowerShell execution policy for this run only).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
