<#
.SYNOPSIS
    [DEPRECATED 2026-09-02] Per-user logon autostart for bililearn's
    whisper server. Replaced by setup_whisper_autostart_system.ps1
    (SYSTEM account, AtStartup). Kept for users who explicitly want
    per-user logon behavior. New installs should use the SYSTEM variant.

.DESCRIPTION
    Creates (or removes) a Windows Scheduled Task that runs
    start_whisper_server_silent.vbs on user logon. The vbs launches
    start_whisper_server.bat in a hidden window, which boots the
    whisper server on 127.0.0.1:7860.

    This task is per-user (no UAC prompt) and only runs when the
    current user is logged in. Suitable for desktop / laptop dev
    setups. For headless / always-on setups, use
    setup_whisper_autostart_system.ps1 instead.

.PARAMETER Action
    'install' (default)  - register the task
    'uninstall'           - remove the task
    'status'              - show whether the task is currently registered

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\setup_whisper_autostart.ps1
    powershell -ExecutionPolicy Bypass -File .\setup_whisper_autostart.ps1 -Action status
    powershell -ExecutionPolicy Bypass -File .\setup_whisper_autostart.ps1 -Action uninstall
#>

[CmdletBinding()]
param(
    [ValidateSet("install", "uninstall", "status")]
    [string]$Action = "install"
)

$ErrorActionPreference = "Stop"

# Resolve paths relative to this script so it works no matter where
# the repo is cloned. This is the same pattern as the .vbs launcher.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$VbsPath   = Join-Path $ScriptDir "start_whisper_server_silent.vbs"
$TaskName  = "bililearn-whisper-server-autostart"

function Test-WhisperVbs {
    if (-not (Test-Path $VbsPath)) {
        throw "Cannot find start_whisper_server_silent.vbs at: $VbsPath"
    }
}

if ($Action -eq "status") {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "Task '$TaskName' is REGISTERED."
        Write-Host "  State:    $($existing.State)"
        Write-Host "  Run as:   $($existing.Principal.UserId)"
        Write-Host "  Triggers: $($existing.Triggers | ForEach-Object { $_.CimClass.CimClassName })"
    } else {
        Write-Host "Task '$TaskName' is NOT registered."
        Write-Host "Run with -Action install to register it."
    }
    return
}

if ($Action -eq "uninstall") {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Task '$TaskName' removed (if it existed)."
    return
}

# Action == install
Test-WhisperVbs

# Build the task action: wscript.exe runs the .vbs hidden. Using
# wscript directly (instead of cscript) suppresses the "Open With?"
# prompt if .vbs association ever changes.
$ActionArgs = @(
    New-ScheduledTaskAction `
        -Execute "wscript.exe" `
        -Argument "`"$VbsPath`"" `
        -WorkingDirectory $ScriptDir
)

# Trigger: at user logon. We deliberately use -AtLogOn (not -AtStartup)
# so the task is per-user and doesn't need elevation.
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Principal: run as the current user, logon type Interactive (so the
# hidden window is owned by the user — not SYSTEM).
$Principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

# Settings: don't run on battery check, allow start on demand, allow
# the task to be re-triggered if the previous instance is still alive
# (the .vbs spawns a child python process; we don't need to wait for it).
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $ActionArgs `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description "Starts bililearn's local Whisper server (127.0.0.1:7860) in a hidden window when the current user logs in. Re-run with -Action uninstall to remove." `
    -Force

Write-Host ""
Write-Host "Task '$TaskName' installed."
Write-Host ""
Write-Host "What happens now:"
Write-Host "  - On your next Windows logon, the whisper server starts in the background"
Write-Host "  - It listens on http://127.0.0.1:7860"
Write-Host "  - To start it RIGHT NOW (without waiting for logon), run:"
Write-Host "      wscript `"$VbsPath`""
Write-Host ""
Write-Host "To check status or uninstall later:"
Write-Host "      powershell -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Action status"
Write-Host "      powershell -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Action uninstall"
