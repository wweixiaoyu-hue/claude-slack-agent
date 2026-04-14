Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
logPath = scriptDir & "\logs\auto-enter-vbs.log"
If Not fso.FolderExists(scriptDir & "\logs") Then fso.CreateFolder(scriptDir & "\logs")
Set logFile = fso.OpenTextFile(logPath, 8, True)
logFile.WriteLine Now & " vbs started, scriptDir=" & scriptDir
ps1Path = scriptDir & "\auto-enter.ps1"
logFile.WriteLine Now & " launching ps1: " & ps1Path
cmd = "powershell -NoProfile -ExecutionPolicy Bypass -File """ & ps1Path & """"
logFile.WriteLine Now & " cmd: " & cmd
ret = CreateObject("WScript.Shell").Run(cmd, 0, False)
logFile.WriteLine Now & " Run returned: " & ret
logFile.Close
