<#
.SYNOPSIS
    Register bilidown's whisper server to start automatically at Windows
    boot under the SYSTEM account (no UAC prompt, runs before any user
    logs in). For headless / always-on setups.

.DESCRIPTION
    This is the SYSTEM-tier counterpart of setup_whisper_autostart.ps1
    (which is per-user and runs only on user logon). Use this one when
    you want the server up even when nobody is logged in, or when you
    don't want a UAC prompt at boot.

    What it does:
      1. setx /M BILIDOWN_PYTHON=<resolved python.exe>
         (machine-level env var so the SYSTEM process can find Python
         without depending on SYSTEM's PATH or conda activation).
      2. Register (or remove) a scheduled task "bilidown-whisper-server-autostart-system"
         that runs at system startup, as SYSTEM, hidden window.
         The task calls wscript.exe against start_whisper_server_silent.vbs
         which in turn launches start_whisper_server.bat hidden.

    The Python path is resolved from the same probe order as
    start_whisper_server.bat (BILIDOWN_PYTHON > miniconda3 > anaconda3 >
    python.org 3.10-3.13) so this script and the bat stay in sync.

.PARAMETER Action
    'install' (default)  - resolve Python, setx /M, register SYSTEM task
    'uninstall'           - remove the SYSTEM task (leaves env var alone)
    'status'              - show whether the task is currently registered

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\setup_whisper_autostart_system.ps1
    powershell -ExecutionPolicy Bypass -File .\setup_whisper_autostart_system.ps1 -Action status
    powershell -ExecutionPolicy Bypass -File .\setup_whisper_autostart_system.ps1 -Action uninstall
#>

[CmdletBinding()]
param(
    [ValidateSet("install", "uninstall", "status")]
    [string]$Action = "install"
)

$ErrorActionPreference = "Stop"

$ScriptDir       = Split-Path -Parent $MyInvocation.MyCommand.Path
$VbsPath         = Join-Path $ScriptDir "start_whisper_server_silent.vbs"
$TaskName        = "bilidown-whisper-server-autostart-system"
$EnvVar          = "BILIDOWN_PYTHON"

function Resolve-PythonPath {
    # Mirror the probe order in start_whisper_server.bat so the env var
    # we set here is the same one the bat would have picked.
    $override = [Environment]::GetEnvironmentVariable($EnvVar, "User")
    if ($override -and (Test-Path $override)) { return $override }

    $candidates = @(
        (Join-Path $env:USERPROFILE "miniconda3\python.exe"),
        (Join-Path $env:USERPROFILE "anaconda3\python.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python313\python.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python310\python.exe"),
        "C:\Python313\python.exe",
        "C:\Python312\python.exe",
        "C:\Python311\python.exe",
        "C:\Python310\python.exe"
    )
    foreach ($p in $candidates) {
        if ($p -and (Test-Path $p)) { return $p }
    }

    # Last-ditch: ask PATH. SYSTEM's PATH is sparse; this is informational.
    $whereOut = (where.exe python 2>$null | Select-Object -First 1)
    if ($whereOut -and (Test-Path $whereOut)) { return $whereOut }

    throw "Python not found. Install Python 3.10+ or set BILIDOWN_PYTHON first, then re-run."
}

if ($Action -eq "status") {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $envNow    = [Environment]::GetEnvironmentVariable($EnvVar, "Machine")
    Write-Host ""
    Write-Host "Task '$TaskName':"
    if ($existing) {
        Write-Host "  State:    $($existing.State)"
        Write-Host "  Run as:   $($existing.Principal.UserId)"
        Write-Host "  Logon:    $($existing.Principal.LogonType)"
        Write-Host "  Triggers: $($existing.Triggers | ForEach-Object { $_.CimClass.CimClassName })"
    } else {
        Write-Host "  NOT registered."
    }
    Write-Host ""
    Write-Host "Machine-level $EnvVar : $envNow"
    return
}

if ($Action -eq "uninstall") {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Task '$TaskName' removed (if it existed)."
    Write-Host "Note: machine-level $EnvVar env var was NOT removed (manual cleanup if needed)."
    return
}

# Action == install
if (-not (Test-Path $VbsPath)) {
    throw "Cannot find start_whisper_server_silent.vbs at: $VbsPath"
}

$PythonExe = Resolve-PythonPath
Write-Host "Resolved Python: $PythonExe"

# Machine-level env var. setx /M writes to HKLM\SYSTEM\CurrentControlSet\
# Control\Session Manager\Environment, which SYSTEM processes inherit.
# setx does NOT update the current process's env, but that's fine — the
# next task trigger will read it fresh.
Write-Host "Setting machine-level env $EnvVar = $PythonExe ..."
[Environment]::SetEnvironmentVariable($EnvVar, $PythonExe, "Machine")
# Also setx for the user's sanity (visible in System Properties).
$setxOut = cmd /c "setx $EnvVar `"$PythonExe`" /M" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Warning "setx /M reported non-zero exit: $setxOut"
}

# The action: run wscript.exe against the vbs. The vbs itself is hidden
# (WindowStyle=0 in the .Run call), so no console window appears even
# though wscript is a GUI subsystem binary.
$TaskAction = New-ScheduledTaskAction `
    -Execute "wscript.exe" `
    -Argument "`"$VbsPath`"" `
    -WorkingDirectory $ScriptDir

# Trigger: at system startup. SYSTEM is already there at boot, so this
# is the natural point and runs whether or not anyone is logged in.
$Trigger = New-ScheduledTaskTrigger -AtStartup

# Principal: SYSTEM, highest privileges, no password (machine account).
$Principal = New-ScheduledTaskPrincipal `
    -UserId "SYSTEM" `
    -LogonType ServiceAccount `
    -RunLevel Highest

# Settings: hidden window (so the task's own window never flashes),
# allow start on demand, restart on failure (up to 3x with 1m delay),
# don't run on battery check, allow start even on battery, never expire.
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $TaskAction `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description "Starts bilidown's local Whisper server (127.0.0.1:7860) at Windows boot under SYSTEM, in a hidden window. Re-run with -Action uninstall to remove." `
    -Force

Write-Host ""
Write-Host "Task '$TaskName' installed."
Write-Host ""
Write-Host "What happens now:"
Write-Host "  - On your next reboot, the whisper server starts under SYSTEM"
Write-Host "  - It listens on http://127.0.0.1:7860"
Write-Host "  - It runs whether or not any user is logged in"
Write-Host "  - Logs go to Task Scheduler event log + the user-account log"
Write-Host "    file (C:\Users\...\bilidown\whisper_server.log) if writable"
Write-Host ""
Write-Host "To start it RIGHT NOW (without waiting for boot):"
Write-Host "      wscript `"$VbsPath`""
Write-Host ""
Write-Host "Manage / check / uninstall:"
Write-Host "      manage_whisper_server.bat     (interactive menu)"
Write-Host "      powershell -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Action status"
Write-Host "      powershell -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Action uninstall"
