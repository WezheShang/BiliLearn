@echo off
REM bililearn whisper server launcher
REM Double-click this file to start the local Whisper server.
REM Keep the window open. The server listens on http://127.0.0.1:7860.
REM Missing dependencies are REPORTED, never auto-installed (2026-08-30).

REM Resolve the script's own directory so SERVER_SCRIPT is correct no
REM matter where the repo was cloned (matches the .vbs launcher behavior).
set "SCRIPT_DIR=%~dp0"
set "SERVER_SCRIPT=%SCRIPT_DIR%whisper_server.py"

REM Which port to bind. whisper_server.py reads BILILEARN_WHISPER_PORT
REM (default 7860). The extension's native launcher sets it when it has
REM to start an instance on a spare port (7861) because the default one
REM is occupied by a stale SYSTEM instance.
set "WHISPER_PORT=%BILILEARN_WHISPER_PORT%"
if "%WHISPER_PORT%"=="" set "WHISPER_PORT=7860"

REM Find a Python interpreter. Order:
REM   1) %BILILEARN_PYTHON% (user override, optional;
REM      legacy %BILIDOWN_PYTHON% from before the rename still honored)
REM   2) `where python` (whatever is on PATH)
REM   3) common install locations (miniconda / anaconda / official Python.org)
REM If none found, prompt the user to install one - don't hard-fail.
set "PYTHON_EXE="

if defined BILILEARN_PYTHON (
  if exist "%BILILEARN_PYTHON%" set "PYTHON_EXE=%BILILEARN_PYTHON%"
)

if not defined PYTHON_EXE (
  if defined BILIDOWN_PYTHON (
    if exist "%BILIDOWN_PYTHON%" set "PYTHON_EXE=%BILIDOWN_PYTHON%"
  )
)

if not defined PYTHON_EXE (
  for /f "delims=" %%i in ('where python 2^>nul') do (
    if not defined PYTHON_EXE set "PYTHON_EXE=%%i"
  )
)

if not defined PYTHON_EXE (
  for %%P in (
    "%USERPROFILE%\miniconda3\python.exe"
    "%USERPROFILE%\anaconda3\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
    "C:\Python313\python.exe"
    "C:\Python312\python.exe"
    "C:\Python311\python.exe"
    "C:\Python310\python.exe"
  ) do (
    if not defined PYTHON_EXE if exist %%~P set "PYTHON_EXE=%%~P"
  )
)

if not defined PYTHON_EXE (
  echo [ERROR] Python not found on this machine.
  echo.
  echo Install one of:
  echo   - Python 3.10+ from https://www.python.org/downloads/
  echo   - Miniconda from https://docs.conda.io/en/latest/miniconda.html
  echo.
  echo Then either:
  echo   - Re-run this bat after Python is on PATH, or
  echo   - Set BILILEARN_PYTHON to your python.exe absolute path before running.
  echo     Legacy BILIDOWN_PYTHON from before the rename still works.
  echo.
  echo Example:
  echo   set BILILEARN_PYTHON=C:\Python312\python.exe
  echo   %~nx0
  pause
  exit /b 1
)

REM Pre-flight (2026-08-30 transparency rework): CHECK ONLY.
REM bililearn never silently pip-installs into your Python. If a dependency
REM is missing we print exactly what is missing and the exact command to
REM fix it, then still start the server in LIMITED mode (/health reports
REM ok:false + what is missing; /transcribe answers 503). The extension
REM options page ("check system" button) reads the same info from /health.
set "MISSING_FW=0"
set "MISSING_ZHCONV=0"
"%PYTHON_EXE%" -c "import faster_whisper" >nul 2>&1
if errorlevel 1 set "MISSING_FW=1"
"%PYTHON_EXE%" -c "import zhconv" >nul 2>&1
if errorlevel 1 set "MISSING_ZHCONV=1"

if "%MISSING_FW%"=="1" (
  echo.
  echo [MISSING] faster-whisper is NOT installed in this Python:
  echo   %PYTHON_EXE%
  echo   Install it yourself with:
  echo   "%PYTHON_EXE%" -m pip install faster-whisper zhconv
  echo   Then close this window and double-click this file again.
)
if "%MISSING_ZHCONV%"=="1" (
  if "%MISSING_FW%"=="0" (
    echo.
    echo [OPTIONAL] zhconv is not installed in this Python.
    echo   Traditional Chinese in transcripts will NOT be normalized.
    echo   Optional fix:
    echo   "%PYTHON_EXE%" -m pip install zhconv
  )
)
if "%MISSING_FW%"=="1" (
  echo.
  echo Starting in LIMITED mode - /health will report what is missing.
  echo Nothing is installed automatically; the choice is yours.
  echo.
)

echo Starting bililearn Whisper server...
echo   python : %PYTHON_EXE%
echo   script : %SERVER_SCRIPT%
echo   url    : http://127.0.0.1:%WHISPER_PORT%
echo.
echo Keep this window open. Close it to stop the server.
echo.

REM -B disables .pyc generation so the server never creates a
REM __pycache__/ next to whisper_server.py (Chrome would refuse
REM to load the extension if that directory appeared in the
REM extension tree). -I is isolated mode (no .pyc, no user-site,
REM no PYTHONPATH) - same goal, slightly stronger.
REM
REM 2026-11-04: --log mode redirects stdout+stderr into
REM logs\whisper_server.log. The silent .vbs launcher (used by the
REM native-messaging launcher and the AtStartup task) hides the console
REM window entirely, so a server-side exception used to vanish with the
REM window - the extension only saw the client-side symptom
REM ("TypeError: Failed to fetch" with no server traceback anywhere).
REM The log file is the only place that traceback can live now.
REM
REM 2026-11-06: per-port log files.
REM   All instances used to append to ONE file (logs\whisper_server.log).
REM   The first instance keeps that handle open for its whole life, so a
REM   SECOND instance failed at the ">>" redirect with
REM   "The process cannot access the file because it is being used by
REM   another process" - python never started, no server, and the silent
REM   .vbs swallowed the error completely. That is why the "start server"
REM   button looked like it did nothing.
REM   Now every non-default port gets its own file
REM   (logs\whisper_server_<port>.log) so instances never fight over it.
REM   Port 7860 keeps the historical logs\whisper_server.log name.
set "LOG_DIR=%SCRIPT_DIR%logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
if "%WHISPER_PORT%"=="7860" (
  set "LOG_FILE=%LOG_DIR%\whisper_server.log"
) else (
  set "LOG_FILE=%LOG_DIR%\whisper_server_%WHISPER_PORT%.log"
)

if /i "%~1"=="--log" (
  echo Log file: %LOG_FILE%
  "%PYTHON_EXE%" -B -I "%SERVER_SCRIPT%" >> "%LOG_FILE%" 2>&1
  goto :after_run
)

"%PYTHON_EXE%" -B -I "%SERVER_SCRIPT%"

:after_run
if errorlevel 1 goto :failed
goto :done

REM 2026-11-06: this used to be an "if errorlevel 1 ( ... )" block.
REM The python one-liner inside it contained parentheses
REM ("(no log file)"), and cmd.exe counts parentheses even inside
REM quotes when it parses a block - so the block was terminated early
REM and cmd died with ": was unexpected at this time.". The real
REM error (e.g. the log file being locked by another instance) was
REM swallowed. Flat labels + goto sidestep cmd's block parsing.
:failed
echo.
echo [ERROR] Server exited with code %errorlevel%
echo Hint: "%PYTHON_EXE%" -m pip install faster-whisper zhconv
echo.
echo Server log (last 30 lines):
powershell -NoProfile -Command "Get-Content -LiteralPath '%LOG_FILE%' -Tail 30 -ErrorAction SilentlyContinue"
pause
exit /b 1

:done
exit /b 0
