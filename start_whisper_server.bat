@echo off
REM bilidown whisper server launcher
REM Double-click this file to start the local Whisper server.
REM Keep the window open. The server listens on http://127.0.0.1:7860.

set PYTHON_EXE=C:\Users\username\miniconda3\python.exe
set SERVER_SCRIPT=C:\Users\username\bilidown\whisper_server.py

if not exist "%PYTHON_EXE%" (
  echo [ERROR] Python not found at %PYTHON_EXE%
  echo Edit this file and set PYTHON_EXE to your Python interpreter.
  pause
  exit /b 1
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
REM extension tree).
"%PYTHON_EXE%" -B "%SERVER_SCRIPT%"

if errorlevel 1 (
  echo.
  echo [ERROR] Server exited with code %errorlevel%
  pause
)
