Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

strDesktop = WshShell.SpecialFolders("Desktop")
strScriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
strElectron = strScriptDir & "\node_modules\electron\dist\electron.exe"

' Korean name: 포장보스 자동화
strName = ChrW(54252) & ChrW(51109) & ChrW(48372) & ChrW(49828) & " " & ChrW(51088) & ChrW(46041) & ChrW(54868)
strShortcut = strDesktop & "\" & strName & ".lnk"

' Delete old shortcuts if exist
If fso.FileExists(strDesktop & "\PojangBoss.lnk") Then
    fso.DeleteFile strDesktop & "\PojangBoss.lnk"
End If
If fso.FileExists(strShortcut) Then
    fso.DeleteFile strShortcut
End If

Set oShortcut = WshShell.CreateShortcut(strShortcut)
oShortcut.TargetPath = strElectron
oShortcut.Arguments = "."
oShortcut.WorkingDirectory = strScriptDir
oShortcut.Description = strName
oShortcut.IconLocation = strScriptDir & "\assets\icon.ico,0"
oShortcut.Save

WScript.Echo "Desktop shortcut created: " & strShortcut
