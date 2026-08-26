' bilidown whisper server — silent launcher (no console window)
' Used by the optional Startup shortcut. Double-clicking it has the same
' effect: starts the server with no visible window.
' Path is resolved relative to this script's own location so the launcher
' works no matter where the user clones the repo on disk.
Dim fso : Set fso = CreateObject("Scripting.FileSystemObject")
Dim scriptDir : scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Dim batPath : batPath = fso.BuildPath(scriptDir, "start_whisper_server.bat")
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c """ & batPath & """", 0, False
Set WshShell = Nothing
