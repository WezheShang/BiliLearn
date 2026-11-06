' bililearn whisper server - silent launcher (no console window at all)
' Used by both the per-user setup and the SYSTEM AtStartup setup.
' Double-clicking it has the same effect: starts the server with no
' visible window. WindowStyle=0 hides the cmd window that start_whisper_server.bat
' would otherwise pop up - this is required when run from the SYSTEM account
' (no interactive desktop) and harmless when run from the user account.
' Path is resolved relative to this script's own location so the launcher
' works no matter where the user clones the repo on disk.
Dim fso : Set fso = CreateObject("Scripting.FileSystemObject")
Dim scriptDir : scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Dim batPath : batPath = fso.BuildPath(scriptDir, "start_whisper_server.bat")
Set WshShell = CreateObject("WScript.Shell")
' --log: no console window exists here, so the server's stdout/stderr must go
' to logs\whisper_server_<port>.log - otherwise a server-side traceback disappears
' with the hidden window and the extension only shows "Failed to fetch".
' The port comes from the BILILEARN_WHISPER_PORT env var (default 7860), so
' each instance writes to its own file and they never fight over it.
WshShell.Run "cmd /c """ & batPath & """ --log", 0, False
Set WshShell = Nothing
