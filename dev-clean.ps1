<#
.SYNOPSIS
  Pre-flight cleanup for the bililearn Chrome extension directory.

.DESCRIPTION
  Chrome refuses to load an extension when ANY file or subdirectory
  under the extension root starts with an underscore:

    "Cannot load extension with file or directory name _xxx. Filenames
     starting with "_" are reserved for use by the system."

  (Corrected 2026-11-22: this script used to match only TWO leading
  underscores, because the only case we had hit back then was
  __pycache__. The real user-facing failure was a SINGLE leading
  underscore (_preview_gen.js) -- single underscores are rejected too.)

  The one exception is Chrome's own _metadata/ directory: the manifest
  declares a declarative_net_request static ruleset, so Chrome writes the
  compiled ruleset into <extension root>/_metadata/generated_indexed_rulesets/.
  Measured on 2026-11-22: while it was present the extension loaded and
  ran normally, so we leave it alone.

  This bites us three ways:
    1. Python auto-generates __pycache__/ next to any .py file when it
       runs (e.g. python whisper_server.py -> __pycache__/whisper_server.cpython-313.pyc)
    2. We sometimes drop debug scratch files like _preview_gen.js in
       the extension tree while iterating (on 2026-11-22 exactly that
       made the whole extension fail to load)
    3. A one-off preview generator leaves its output behind

  This script moves any such entries from the extension root to a
  sibling directory outside the extension (bililearn-tests/_stray/) so
  Chrome will load the extension. The moves are recoverable — nothing
  is deleted.

.PARAMETER ExtDir
  Path to the bililearn extension root. Defaults to the script's own
  parent directory (so it can be double-clicked from File Explorer).

.PARAMETER StashDir
  Where to put recovered entries. Defaults to
  ..\bililearn-tests\_stray\ relative to ExtDir.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\dev-clean.ps1
  # Cleans the extension dir next to this script.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\dev-clean.ps1 -ExtDir C:\path\to\bililearn

.NOTES
  - Idempotent: safe to re-run. Skips anything that's already been moved.
  - Skips .git/ and node_modules/ by design.
  - Pair this with `python -B whisper_server.py` to suppress
    __pycache__ generation at the source (recommended; this script is
    a safety net for the cases where -B is forgotten).
#>
[CmdletBinding()]
param(
  # Resolved inside the script body so it works whether the script is
  # invoked via -File (where $MyInvocation is empty in the param block)
  # or via & { ... } (where the script block needs an explicit path).
  [string]$ExtDir,
  [string]$StashDir
)

$ErrorActionPreference = 'Stop'

if (-not $ExtDir) {
  $scriptPath = $PSCommandPath
  if (-not $scriptPath) {
    # Fallback for `& { .\dev-clean.ps1 }` style invocation
    $scriptPath = $MyInvocation.MyCommand.Path
  }
  if (-not $scriptPath) {
    Write-Error "Could not determine script path. Pass -ExtDir explicitly."
    exit 2
  }
  $ExtDir = Split-Path -Parent $scriptPath
}

Set-Location $ExtDir

if (-not $StashDir) {
  $StashDir = Join-Path (Join-Path $ExtDir '..') 'bililearn-tests\_stray'
}
if (-not (Test-Path $StashDir)) {
  New-Item -ItemType Directory -Force -Path $StashDir | Out-Null
}

# Chrome rejects ANY entry under the extension root whose name starts with
# "_" (__pycache__ from Python, _preview_gen.js from a scratch file, ...).
# Exception: Chrome's own _metadata/ -- that is the compiled DNR static
# ruleset directory Chrome itself writes (the manifest declares
# declarative_net_request). Measured 2026-11-22: the extension loads and
# runs normally while it is present, so we leave it alone.
$pattern = '^_[^\\\/]'

function Test-IsStray {
  param([string]$Name)
  if ($Name -eq '_metadata') { return $false }   # managed by Chrome
  return ($Name -match $pattern)
}

$skipDirs = @('.git', 'node_modules')
$moved = New-Object System.Collections.Generic.List[object]

# Walk the extension tree (excluding .git / node_modules) and collect
# matching entries. We do breadth-first by depth so the parent directory
# __pycache__ is moved before we recurse into it.
$queue = New-Object System.Collections.Generic.Queue[object]
$queue.Enqueue(@{ Path = $ExtDir; Depth = 0 })

while ($queue.Count -gt 0) {
  $item = $queue.Dequeue()
  $dir = $item.Path
  $entries = Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue
  foreach ($e in $entries) {
    if ($e.PSIsContainer -and ($skipDirs -contains $e.Name)) { continue }
    if (Test-IsStray $e.Name) {
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      $leaf = $e.Name
      # Avoid name collisions across multiple runs.
      $dest = Join-Path $StashDir "${stamp}__${leaf}"
      # If source is a directory, the destination should mirror that —
      # Move-Item will create the leaf as a directory when given -Path to one.
      Move-Item -LiteralPath $e.FullName -Destination $dest -Force
      $moved.Add([pscustomobject]@{
        Moved = $e.FullName
        To    = $dest
        Kind  = if ($e.PSIsContainer) { 'directory' } else { 'file' }
      })
    } elseif ($e.Name -eq '_metadata') {
      # Chrome's own compiled DNR ruleset directory -- keep it, but say what
      # it is, so if Chrome ever complains about it the user knows it is
      # safe to delete (Chrome recompiles it).
      Write-Output ("  [keep] {0} -- Chrome's own DNR ruleset cache, left in place" -f $e.FullName)
    } elseif ($e.PSIsContainer) {
      $queue.Enqueue(@{ Path = $e.FullName; Depth = $item.Depth + 1 })
    }
  }
}

if ($moved.Count -eq 0) {
  Write-Output "OK: no _-prefixed entries under $ExtDir (extension load should succeed)"
  exit 0
}

Write-Output ("Moved {0} entr{1} to {2}:" -f $moved.Count, $(if ($moved.Count -eq 1) { 'y' } else { 'ies' }), $StashDir)
foreach ($m in $moved) {
  Write-Output ("  [{0}] {1}" -f $m.Kind, $m.Moved)
}
Write-Output ""
Write-Output "Stash contents (recoverable — Move-Item, not delete):"
Get-ChildItem -LiteralPath $StashDir -Force | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize
exit 0
