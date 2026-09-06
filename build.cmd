@echo off
cd /d "%~dp0"
if not exist node_modules call npm.cmd install
call npm.cmd run tauri build
echo.
echo Release binary: target\release\envynote.exe
echo Installer:      target\release\bundle\nsis\
