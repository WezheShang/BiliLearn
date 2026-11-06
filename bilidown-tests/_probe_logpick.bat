@echo off
REM Temporary probe: verify the "newest log file" picking logic used by
REM manage_whisper_server.bat (cmd for-loop with a runtime `if not defined`).
setlocal
set "LOG_DIR=logs"
set "LOG_GUESS="
set "LOG_GUEST="
for /f "delims=" %%f in ('dir /b /o-d "%LOG_DIR%\whisper_server*.log" 2^>nul') do if not defined LOG_GUEST set "LOG_GUEST=%LOG_DIR%\%%f"
if defined LOG_GUEST set "LOG_GUESS=%LOG_GUEST%"
echo NEWEST=%LOG_GUESS%
