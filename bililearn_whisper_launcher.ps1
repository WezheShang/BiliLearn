# BiliLearn native messaging host (com.bililearn.launcher).
#
# Chrome spawns this via the host manifest registered at
#   HKCU\Software\Google\Chrome\NativeMessagingHosts\com.bililearn.launcher
# The manifest path points at bililearn_whisper_launcher.bat in the
# extension folder; that bat calls this ps1 (self-locating, %~dp0).
#
# Why this exists (2026-10-10): MV3 service workers cannot spawn local
# processes, and the old "download the .vbs then downloads.open" path was
# dead on arrival twice over - chrome.runtime.getURL() always returns
# chrome-extension:// URLs so the file:// guard in the old handler could
# never pass, and .vbs/.bat are on Chrome's dangerous-file list so
# downloads.open() refuses them anyway. Native messaging is the one
# Chrome-sanctioned channel for an extension to start a local program.
#
# Protocol: read one length-prefixed JSON frame from stdin (4-byte
# little-endian length + UTF-8 payload), act on it, write one
# length-prefixed JSON frame to stdout, exit 0. Supported commands:
#   {cmd:"launch"}                          -> hidden-start the whisper server
#   {cmd:"restart", port:7861}              -> start a SECOND instance on `port`
#                                              (used when the SYSTEM-owned 7860
#                                              instance runs stale code and
#                                              cannot be killed without admin)
#   {cmd:"autostart", action:"install"  }   -> elevated setup ps1 (UAC prompt)
#   {cmd:"autostart", action:"uninstall"}   -> elevated setup ps1 (UAC prompt)
#
# The response is emitted binary-safe via [Console] streams; never use
# Write-Output here - PowerShell formatting would corrupt the frame.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $here 'start_whisper_server_silent.vbs'

# ---- 1. Read the incoming frame (best effort; a closed pipe is fine). ----
$cmd = $null
$action = $null
$msg = $null
try {
  $sin = [Console]::OpenStandardInput()
  $hdr = New-Object byte[] 4
  $got = 0
  while ($got -lt 4) {
    $n = $sin.Read($hdr, $got, 4 - $got)
    if ($n -le 0) { break }
    $got += $n
  }
  if ($got -eq 4) {
    $len = [BitConverter]::ToInt32($hdr, 0)
    if ($len -gt 0 -and $len -lt 1048576) {
      $payload = New-Object byte[] $len
      $got = 0
      while ($got -lt $len) {
        $n = $sin.Read($payload, $got, $len - $got)
        if ($n -le 0) { break }
        $got += $n
      }
      $msg = [Text.Encoding]::UTF8.GetString($payload) | ConvertFrom-Json
      $cmd = $msg.cmd
      $action = $msg.action
    }
  }
} catch { }

# ---- 2. Act. ----
$response = @{ success = $false; error = 'unknown command' }
try {
  if ($cmd -eq 'launch') {
    if (-not (Test-Path -LiteralPath $vbs)) {
      $response = @{ success = $false; error = 'start_whisper_server_silent.vbs not found next to the launcher' }
    } else {
      # 2026-11-06: port awareness.
      # The extension's whisperUrl may point at a SPARE port (7861) -
      # repairWhisperServer switches it there when the default port
      # runs STALE code (no local HF cache resolution -> ConnectTimeout
      # -> HTTP 500 on every transcribe).
      # "Start server" must therefore bind the SAME port the extension
      # is configured for, otherwise the server comes up while the
      # extension keeps talking to a port nobody listens on - the user
      # clicks "start", the server is running, and the panel still
      # says "not running". Dead loop.
      # whisper_server.py reads BILILEARN_WHISPER_PORT to pick the port;
      # the env var is inherited all the way wscript -> cmd -> python.
      if ($null -ne $msg -and $null -ne $msg.port) {
        try { $env:BILILEARN_WHISPER_PORT = [string]([int]$msg.port) } catch { }
      }
      # wscript runs the vbs hidden; the vbs itself hides the cmd/bat it
      # spawns (WindowStyle=0), so no console ever flashes on screen.
      Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"') -WindowStyle Hidden
      $launchPort = 7860
      if ($null -ne $msg -and $null -ne $msg.port) {
        try { $launchPort = [int]$msg.port } catch { $launchPort = 7860 }
      }
      $response = @{ success = $true; port = $launchPort }
    }
  } elseif ($cmd -eq 'restart') {
    # 2026-11-05: start a SECOND instance on a spare port.
    #
    # Why: the boot-time instance runs under SYSTEM (task
    # bililearn-whisper-server-autostart-system) and cannot be killed
    # without admin ("Access is denied"). When that instance runs STALE
    # code the user gets:
    #   500 LocalEntryNotFoundError: ConnectTimeout (model download
    #   because the old code doesn't resolve the local HF cache)
    # plus a 3.1s /local-file (old code reads 1200+ file heads).
    #
    # Starting a fresh instance on a spare port and pointing the
    # extension at it fixes BOTH without ever needing admin. The
    # SYSTEM instance becomes an inert zombie that the user can
    # retire later with the admin restart script.
    $port = 7861
    if ($null -ne $msg -and $null -ne $msg.port) {
      try { $port = [int]$msg.port } catch { $port = 7861 }
    }
    $bat = Join-Path $here 'start_whisper_server.bat'
    if (-not (Test-Path -LiteralPath $bat)) {
      $response = @{ success = $false; error = 'start_whisper_server.bat not found next to the launcher' }
    } else {
      # The bat honours --log; the env var tells whisper_server.py which
      # port to bind. Hidden window (WindowStyle=0) so nothing flashes.
      $env:BILILEARN_WHISPER_PORT = "$port"
      $logDir = Join-Path $here 'logs'
      if (-not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
      }
      $logFile = Join-Path $logDir ("whisper_server_{0}.log" -f $port)
      # Start-Process on the .bat directly (not cmd /c) — the cmd /c
      # form needs careful quote nesting and silently failed to launch
      # (no log file, no listener) the first time round.
      #
      # No -Redirect*: the bat already appends its own output to
      # logs\whisper_server_<port>.log when --log is passed (per-port
      # files since 2026-11-06 - a single shared file made a second
      # instance fail at the ">>" redirect and the server never started),
      # and pointing Start-Process at the same file would truncate it.
      $proc = Start-Process -FilePath $bat -ArgumentList '--log' `
        -WorkingDirectory $here -WindowStyle Hidden -PassThru
      $response = @{ success = $true; port = $port; pid = $proc.Id; log = $logFile }
    }
  } elseif ($cmd -eq 'autostart') {
    $setup = Join-Path $here 'setup_whisper_autostart_system.ps1'
    $act = if ($action -eq 'uninstall') { 'uninstall' } else { 'install' }
    if (-not (Test-Path -LiteralPath $setup)) {
      $response = @{ success = $false; error = 'setup_whisper_autostart_system.ps1 not found next to the launcher' }
    } else {
      # -Verb RunAs raises the UAC prompt on the user's desktop; do NOT
      # wait - the host must answer Chrome promptly. The options page
      # tracks completion via its own storage flag, same as before.
      Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', ('"' + $setup + '"'),
        '-Action', $act
      )
      $response = @{ success = $true; launched = $true; action = $act }
    }
  }
} catch {
  $response = @{ success = $false; error = $_.Exception.Message }
}

# ---- 3. Write the response frame, binary-safe. ----
try {
  $sout = [Console]::OpenStandardOutput()
  $bytes = [Text.Encoding]::UTF8.GetBytes(($response | ConvertTo-Json -Compress))
  $lenBytes = [BitConverter]::GetBytes([Int32]$bytes.Length)
  $sout.Write($lenBytes, 0, 4)
  $sout.Write($bytes, 0, $bytes.Length)
  $sout.Flush()
} catch { }

exit 0
