Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Run "cmd.exe /c """ & scriptDir & "\launch-desktop-aethon.cmd""", 0, False
