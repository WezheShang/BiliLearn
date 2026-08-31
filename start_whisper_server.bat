@echo off
REM bilidown whisper server launcher
REM Double-click this file to start the local Whisper server.
REM Keep the window open. The server listens on http://127.0.0.1:7860.
REM Missing dependencies are REPORTED, never auto-installed (2026-08-30).

REM Resolve the script's own directory so SERVER_SCRIPT is correct no
REM matter where the repo was cloned (matches the .vbs launcher behavior).
set "SCRIPT_DIR=%~dp0"
set "SERVER_SCRIPT=%SCRIPT_DIR%whisper_server.py"

REM Find a Python interpreter. Order:
REM   1) %BILIDOWN_PYTHON% (user override, optional)
REM   2) `where python` (whatever is on PATH)
REM   3) common install locations (miniconda / anaconda / official Python.org)
REM If none found, prompt the user to install one — don't hard-fail.
set "PYTHON_EXE="

if defined BILIDOWN_PYTHON (
  if exist "%BILIDOWN_PYTHON%" set "PYTHON_EXE=%BILIDOWN_PYTHON%"
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
  echo   - Set BILIDOWN_PYTHON to your python.exe absolute path before running.
  echo.
  echo Example:
  echo   set BILIDOWN_PYTHON=C:\Python312\python.exe
  echo   %~nx0
  pause
  exit /b 1
)

REM Pre-flight (2026-08-30 transparency rework): CHECK ONLY.
REM bilidown never silently pip-installs into your Python. If a dependency
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

echo Starting bilidown Whisper server...
echo   python : %PYTHON_EXE%
echo   script : %SERVER_SCRIPT%
echo   url    : http://127.0.0.1:7860
echo.
echo Keep this window open. Close it to stop the server.
echo.

REM -B disables .pyc generation so the server never creates a
REM __pycache__/ next to whisper_server.py (Chrome would refuse
REM to load the extension if that directory appeared in the
REM extension tree). -I is isolated mode (no .pyc, no user-site,
REM no PYTHONPATH) — same goal, slightly stronger.
"%PYTHON_EXE%" -B -I "%SERVER_SCRIPT%"

if errorlevel 1 (
  echo.
  echo [ERROR] Server exited with code %errorlevel%
  echo Hint: "%PYTHON_EXE%" -m pip install faster-whisper zhconv
  pause
)
