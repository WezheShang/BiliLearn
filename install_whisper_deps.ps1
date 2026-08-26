<#
.SYNOPSIS
    Install Python dependencies for bilidown's local Whisper server.

.DESCRIPTION
    Detects any installed Python 3.10+ interpreter, then runs
    `pip install faster-whisper zhconv`. Reports which interpreter
    was used and where the packages landed.

    Why this script exists: Chrome MV3 extensions cannot start
    arbitrary processes, so the extension can't pip-install for
    you. Run this once after cloning the repo (or whenever you
    want to refresh dependencies).

.PARAMETER PythonPath
    Optional. Absolute path to a specific python.exe to use.
    If omitted, the script tries `where python` first, then
    common install locations (miniconda, anaconda, Python.org).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install_whisper_deps.ps1
    powershell -ExecutionPolicy Bypass -File .\install_whisper_deps.ps1 -PythonPath C:\Python312\python.exe
#>

[CmdletBinding()]
param(
    [string]$PythonPath
)

$ErrorActionPreference = "Stop"

function Resolve-Python {
    if ($PythonPath -and (Test-Path $PythonPath)) {
        return (Resolve-Path $PythonPath).Path
    }
    try {
        $found = (Get-Command python -ErrorAction Stop).Source
        if ($found) { return $found }
    } catch {
    }
    $candidates = @(
        "$env:USERPROFILE\miniconda3\python.exe",
        "$env:USERPROFILE\anaconda3\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python310\python.exe",
        "C:\Python313\python.exe",
        "C:\Python312\python.exe",
        "C:\Python311\python.exe",
        "C:\Python310\python.exe"
    )
    foreach ($p in $candidates) {
        if (Test-Path $p) { return (Resolve-Path $p).Path }
    }
    return $null
}

function Get-PythonVersion {
    param([string]$Exe)
    try {
        $out = & $Exe -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')" 2>&1
        return ($out | Out-String).Trim()
    } catch {
        return "?"
    }
}

function Test-Dep {
    param([string]$Exe, [string]$Module)
    try {
        $out = & $Exe -c "import $Module; print('ok')" 2>&1
        return ($out | Select-String -SimpleMatch "ok") -ne $null
    } catch {
        return $false
    }
}

Write-Host "=== bilidown whisper dependencies installer ==="
Write-Host ""

$py = Resolve-Python
if (-not $py) {
    Write-Host "[ERROR] No Python 3.10+ interpreter found on this machine." -ForegroundColor Red
    Write-Host ""
    Write-Host "Install one of:"
    Write-Host "  - Python 3.10+ from https://www.python.org/downloads/"
    Write-Host "    (make sure to check 'Add Python to PATH' during install)"
    Write-Host "  - Miniconda from https://docs.conda.io/en/latest/miniconda.html"
    Write-Host ""
    Write-Host "Then re-run this script, or pass -PythonPath to point at a specific interpreter."
    exit 1
}

$ver = Get-PythonVersion $py
Write-Host "Found Python: $py"
Write-Host "Version:     $ver"
Write-Host ""

# Make sure pip is usable
Write-Host "Checking pip..."
try {
    & $py -m pip --version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "pip --version failed" }
} catch {
    Write-Host "[WARN] pip not available on $py. Trying to bootstrap pip..." -ForegroundColor Yellow
    & $py -m ensurepip --upgrade
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Could not bootstrap pip. Install pip manually and re-run." -ForegroundColor Red
        exit 1
    }
}

# Install required packages
$packages = @("faster-whisper", "zhconv")
Write-Host ""
Write-Host "Installing: $($packages -join ', ')"
Write-Host "  (this can take a minute or two depending on network)"
Write-Host ""

& $py -m pip install --upgrade $packages
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "[ERROR] pip install failed. See output above." -ForegroundColor Red
    exit 1
}

# Verify
Write-Host ""
Write-Host "Verifying installation..."
$allOk = $true
foreach ($pkg in $packages) {
    $ok = Test-Dep $py $pkg.Replace("-", "_").Replace("zhconv", "zhconv")
    # zhconv imports fine; faster-whisper is the package name
    if ($pkg -eq "faster-whisper") {
        $ok = Test-Dep $py "faster_whisper"
    } else {
        $ok = Test-Dep $py $pkg
    }
    if ($ok) {
        Write-Host "  [OK] $pkg"
    } else {
        Write-Host "  [FAIL] $pkg not importable" -ForegroundColor Red
        $allOk = $false
    }
}

Write-Host ""
if ($allOk) {
    Write-Host "All dependencies installed successfully." -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:"
    Write-Host "  1. Start the whisper server:  double-click start_whisper_server.bat"
    Write-Host "  2. In the extension settings, choose '本地 Whisper' as the ASR provider"
    Write-Host "  3. Click '测试连接' to verify the server is reachable"
    Write-Host ""
    Write-Host "Optional: register the server to start on Windows logon:"
    Write-Host "  powershell -ExecutionPolicy Bypass -File .\setup_whisper_autostart.ps1 -Action install"
} else {
    Write-Host "Some packages failed to install. Check the pip output above for details." -ForegroundColor Red
    exit 1
}
