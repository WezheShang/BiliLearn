@echo off
REM ===================================================================
REM bililearn whisper server — 管理员重启脚本（2026-11-04）
REM
REM 为什么需要它：
REM   1) 服务器是 SYSTEM 账户通过开机自启任务拉起的，普通用户权限
REM      杀不掉（taskkill 会报 "拒绝访问"），所以必须以管理员运行。
REM   2) Windows 的 SO_REUSEADDR 允许两个进程绑定同一个 7860 端口！
REM      如果不先杀掉旧的，新实例会"也"绑上去，两个 server 抢同一个
REM      端口，Windows 随机分发连接 —— 于是出现"有时能转录、有时
REM      Failed to fetch"的玄学现象。
REM   3) 重启后会加载这些修复：
REM        - 2026-11-04: 补全 CORS 预检（X-* 头 + Access-Control-Allow-Private-Network）
REM        - 2026-11-04: 日志写入 logs\whisper_server.log（以前全丢进隐藏窗口）
REM        - 2026-11-05: 本地模型解析 —— 模型已下载时**离线加载**，绝不联网。
REM          这一条修的是用户报的 500：
REM            LocalEntryNotFoundError: Got: ConnectTimeout: [WinError 10060]
REM          根因：server 以 SYSTEM 跑（HF 缓存是空的）+ 本机直连
REM          huggingface.co 不通 → 每次都去下载 → 每次都超时。
REM          修完模型加载走本地 snapshot，实测 26.4s → 0.6s。
REM
REM 用法：右键本文件 →「以管理员身份运行」
REM
REM 重启后自检：
REM   浏览器打开 http://127.0.0.1:7860/health
REM   看 "model_resolution" 字段 —— 有这个字段说明跑的是新代码，
REM   且 "local_models.tiny" 应该是一个真实路径（不是 null）。
REM ===================================================================

setlocal

set "REPO=C:\Users\shangweizhe\bilidown"
set "PORT=7860"

echo.
echo === 1/3 查找占用 %PORT% 的旧 whisper server ===
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
  echo    PID=%%P 正在停止...
  taskkill /PID %%P /F >nul 2>&1
  if errorlevel 1 (
    echo    [失败] 无法停止 PID=%%P —— 请确认本窗口是"管理员身份运行"。
    echo.
    pause
    exit /b 1
  )
)
timeout /t 2 /nobreak >nul

echo === 2/3 确认端口已释放 ===
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
  echo    [警告] 端口仍被 PID=%%P 占用，中止。
  pause
  exit /b 1
)
echo    OK

echo === 3/3 以隐藏窗口 + 日志模式启动新实例 ===
if not exist "%REPO%\logs" mkdir "%REPO%\logs" >nul 2>&1
start "" wscript.exe "%REPO%\start_whisper_server_silent.vbs"

echo    等待服务就绪...
for /l %%I in (1,1,20) do (
  timeout /t 1 /nobreak >nul
  powershell -NoProfile -Command "try { $r=Invoke-WebRequest 'http://127.0.0.1:%PORT%/health' -TimeoutSec 3 -UseBasicParsing; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
  if not errorlevel 1 goto :ready
)
echo    [失败] 20 秒内未就绪，请查看 %REPO%\logs\whisper_server.log
pause
exit /b 1

:ready
echo.
echo    [OK] whisper server 已在 http://127.0.0.1:%PORT% 就绪（新代码 + 日志落盘）
echo    日志: %REPO%\logs\whisper_server.log
echo.
pause
endlocal
