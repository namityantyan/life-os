' Starts run-loop.cmd without a console window.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd.exe /c """ & dir & "\run-loop.cmd""", 0, False
