@echo off
setlocal
set "HERE=%~dp0"
set "HTML=%HERE%out\character-graph.html"

if not exist "%HTML%" (
  echo The viewer page has not been generated yet.
  echo Ask the agent to run extract_characters once, or run:
  echo   node scripts\build-viewer.mjs
  pause
  exit /b 1
)

rem file:/// URL with forward slashes and encoded spaces, plus a cache-busting stamp so a
rem regenerated page is never served from the browser cache.
set "URL=file:///%HTML:\=/%"
set "URL=%URL: =%%20%"
set /a STAMP=%RANDOM%*32767+%RANDOM%

start "" "%URL%?v=%STAMP%"
