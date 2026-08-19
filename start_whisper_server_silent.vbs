' bilidown whisper server — silent launcher (no console window)
' Used by the optional Startup shortcut. Double-clicking it has the same
' effect: starts the server with no visible window.
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c C:\Users\username\bilidown\start_whisper_server.bat", 0, False
Set WshShell = Nothing
