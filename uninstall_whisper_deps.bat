@echo off
REM bililearn (formerly bilidown) Whisper dependency REMOVER - testing utility (2026-08-31).
REM Exact reverse of the Whisper setup script: pip-uninstalls the two
REM packages that installer adds, so start_whisper_server.bat starts in
REM limited mode again and the options-page first-run / setup flow can be
REM re-tested from scratch.
REM What it deliberately does NOT touch:
REM   - dependencies pip pulled in transitively - ctranslate2, numpy,
REM     onnxruntime, huggingface-hub and friends. Other software on this
REM     machine may need them; removing them blindly is unsafe.
REM   - already-downloaded model weights, so re-testing after a reinstall
REM     does not re-download hundreds of MB.
title bililearn Whisper deps - uninstall (testing)
setlocal

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
  pause
  exit /b 1
)

echo Found Python: %PYTHON_EXE%
echo.
echo This script REMOVES 2 packages from that Python:
echo   faster-whisper  - speech recognition engine
echo   zhconv          - Traditional/Simplified Chinese conversion
echo Everything else installed on this machine stays as it is.
echo.
echo Running:
echo   "%PYTHON_EXE%" -m pip uninstall -y faster-whisper zhconv
echo.

"%PYTHON_EXE%" -m pip uninstall -y faster-whisper zhconv
if errorlevel 1 (
  echo.
  echo [ERROR] pip uninstall failed. Check the messages above.
  pause
  exit /b 1
)

echo.
echo Verifying the imports are gone...
"%PYTHON_EXE%" -c "import faster_whisper" >nul 2>&1
if not errorlevel 1 (
  echo [WARN] faster_whisper is STILL importable - a different Python was
  echo        probably cleaned than the one the server uses. Check the
  echo        Found Python line above.
) else (
  echo OK - faster_whisper is no longer importable.
)
"%PYTHON_EXE%" -c "import zhconv" >nul 2>&1
if not errorlevel 1 (
  echo [WARN] zhconv is STILL importable - see the faster-whisper note above.
) else (
  echo OK - zhconv is no longer importable.
)

echo.
echo Done. To re-test first run:
echo   1. Close the whisper server console window if it is still running.
echo   2. Double-click start_whisper_server.bat - it starts in limited
echo      mode again - then open the options page and click "Check system".
echo Downloaded model weights were kept, so there is no re-download after
echo you re-run the setup script.
pause
