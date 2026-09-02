' bilidown whisper server — silent launcher (no console window at all)
' Used by both the per-user setup and the SYSTEM AtStartup setup.
' Double-clicking it has the same effect: starts the server with no
' visible window. WindowStyle=0 hides the cmd window that start_whisper_server.bat
' would otherwise pop up — this is required when run from the SYSTEM account
' (no interactive desktop) and harmless when run from the user account.
' Path is resolved relative to this script's own location so the launcher
' works no matter where the user clones the repo on disk.
Dim fso : Set fso = CreateObject("Scripting.FileSystemObject")
Dim scriptDir : scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Dim batPath : batPath = fso.BuildPath(scriptDir, "start_whisper_server.bat")
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c """ & batPath & """", 0, False
Set WshShell = Nothing
