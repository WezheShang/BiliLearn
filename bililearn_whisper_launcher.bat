@echo off
rem BiliLearn native messaging host wrapper (com.bililearn.launcher).
rem Chrome spawns this .bat via the NativeMessagingHosts registry key; the
rem actual logic lives in bililearn_whisper_launcher.ps1 next to this file
rem (self-locating via %~dp0, so the whole repo can live anywhere on disk).
rem Chrome passes the calling extension origin as %1 - intentionally ignored.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bililearn_whisper_launcher.ps1"
exit /b 0
