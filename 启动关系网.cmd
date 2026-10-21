@echo off
setlocal
cd /d "%~dp0"

set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"

start "character-graph-server" "%NODE%" scripts\serve.mjs
timeout /t 2 >nul
start "" "http://127.0.0.1:19401/"
