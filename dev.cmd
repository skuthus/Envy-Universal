@echo off
cd /d "%~dp0"
if not exist node_modules call npm.cmd install
call npm.cmd run tauri dev
