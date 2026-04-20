$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')

# Remove old shortcut if exists
foreach ($n in @('Arisan.lnk', 'Arisan Manager.lnk')) {
    $p = "$desktop\$n"
    if (Test-Path $p) { Remove-Item $p -Force }
}

# Create new shortcut with icon
$sc = $ws.CreateShortcut("$desktop\Arisan.lnk")
$sc.TargetPath = "C:\Users\CulluL\arisan\START.bat"
$sc.WorkingDirectory = "C:\Users\CulluL\arisan"
$sc.Description = "Arisan Manager"
$sc.IconLocation = "C:\Users\CulluL\arisan\icon.ico"
$sc.Save()
Write-Host "Shortcut 'Arisan' created on Desktop with icon!"
