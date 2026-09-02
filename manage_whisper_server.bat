@echo off
REM bilidown whisper server — manager menu
REM Four actions: status / log / stop / start.
REM Double-click this file to open the menu. Pick 1-4 or press 0 to exit.
REM
REM The server lives at http://127.0.0.1:7860. It can be started two ways:
REM   (a) by the SYSTEM scheduled task "bilidown-whisper-server-autostart-system"
REM       which fires AtStartup and runs start_whisper_server_silent.vbs;
REM   (b) manually via option [3] below (same vbs, on demand).
REM
REM The system account's task writes logs to:
REM   %WINDIR%\System32\winevt\Logs\... (Task Scheduler event log; the
REM   vbs itself has no stdout). For the user-account log path see below.

setlocal EnableExtensions
set "SCRIPT_DIR=%~dp0"
set "VBS_PATH=%SCRIPT_DIR%start_whisper_server_silent.vbs"
set "HEALTH_URL=http://127.0.0.1:7860/health"
set "TASK_NAME_SYSTEM=bilidown-whisper-server-autostart-system"
set "LOG_GUESS=%SCRIPT_DIR%whisper_server.log"

:menu
cls
echo ====================================================
echo  bilidown whisper server manager
echo ====================================================
echo   Server URL : %HEALTH_URL%
echo   vbs path   : %VBS_PATH%
echo   System task: %TASK_NAME_SYSTEM%
echo   User log   : %LOG_GUESS% (only if started from a user account)
echo ====================================================
echo   [1] View status  (health + scheduled task state)
echo   [2] View log     (tail of whisper_server.log)
echo   [3] Start server (run the silent vbs launcher now)
echo   [4] Stop server  (kill python.exe serving 127.0.0.1:7860)
echo   [0] Exit
echo ====================================================
echo.
set "CHOICE="
set /p "CHOICE=Pick [0-4]: "
if "%CHOICE%"=="1" goto :action_status
if "%CHOICE%"=="2" goto :action_log
if "%CHOICE%"=="3" goto :action_start
if "%CHOICE%"=="4" goto :action_stop
if "%CHOICE%"=="0" goto :action_exit
echo Invalid choice: %CHOICE%
timeout /t 2 >nul
goto :menu

:action_status
echo.
echo --- Server health (%HEALTH_URL%) ---
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri '%HEALTH_URL%' -UseBasicParsing -TimeoutSec 3; Write-Host ('HTTP ' + $r.StatusCode); Write-Host $r.Content } catch { Write-Host ('[UNREACHABLE] ' + $_.Exception.Message) }"
echo.
echo --- Scheduled task '%TASK_NAME_SYSTEM%' ---
schtasks /Query /TN "%TASK_NAME_SYSTEM%" /V /FO LIST 2>nul | findstr /R "^[ ]*Status: ^[ ]*Next Run Time: ^[ ]*Last Run Time: ^[ ]*Run As User:"
if errorlevel 1 echo (task not registered. Run setup_whisper_autostart_system.ps1 -Action install)
echo.
pause
goto :menu

:action_log
echo.
if not exist "%LOG_GUESS%" (
  echo [INFO] %LOG_GUESS% does not exist.
  echo.
  echo Note: if the server was started by the SYSTEM scheduled task, this file
  echo will be empty or missing. Check Task Scheduler event viewer for logs:
  echo   Event Viewer ^&gt; Applications and Services Logs ^&gt; Microsoft ^&gt; Windows ^&gt; TaskScheduler
  echo.
  pause
  goto :menu
)
echo --- Last 60 lines of %LOG_GUESS% ---
powershell -NoProfile -Command "Get-Content -LiteralPath '%LOG_GUESS%' -Tail 60 -Encoding UTF8"
echo.
pause
goto :menu

:action_start
echo.
if exist "%VBS_PATH%" (
  echo Starting via wscript "%VBS_PATH%" ...
  start "" wscript.exe "%VBS_PATH%"
  echo Launched. Wait a few seconds then run [1] View status to confirm.
) else (
  echo [ERROR] vbs not found at: %VBS_PATH%
)
echo.
pause
goto :menu

:action_stop
echo.
echo Stopping any python.exe that owns port 7860 ...
powershell -NoProfile -Command "$pids = Get-NetTCPConnection -LocalPort 7860 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if ($pids) { foreach ($pid in $pids) { try { Stop-Process -Id $pid -Force -ErrorAction Stop; Write-Host ('Stopped PID ' + $pid) } catch { Write-Host ('[WARN] PID ' + $pid + ': ' + $_.Exception.Message) } } } else { Write-Host '[INFO] No process is bound to port 7860.' }"
echo.
pause
goto :menu

:action_exit
endlocal
exit /b 0
