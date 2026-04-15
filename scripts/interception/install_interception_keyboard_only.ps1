# Interception install (keyboard only) - prevents Bluetooth mouse issues
# Run as Administrator
#
# Flow:
# 1. Download + install Interception driver
# 2. Remove "mouse" from Mouse class UpperFilters registry (prevents mouse interception)
# 3. Disable mouse_interception services
# 4. Reboot -> keyboard interception only, mouse unaffected

$installer = Get-ChildItem -Path "$env:TEMP\Interception" -Recurse -Filter "install-interception.exe" -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not $installer) {
    Write-Host "Downloading Interception..."
    Invoke-WebRequest -Uri "https://github.com/oblitum/Interception/releases/download/v1.0.1/Interception.zip" -OutFile "$env:TEMP\Interception.zip"
    Expand-Archive -Path "$env:TEMP\Interception.zip" -DestinationPath "$env:TEMP\Interception" -Force
    $installer = Get-ChildItem -Path "$env:TEMP\Interception" -Recurse -Filter "install-interception.exe" | Select-Object -First 1
}

if (-not $installer) {
    Write-Host "ERROR: install-interception.exe not found"
    exit 1
}

# 1. Install Interception
Write-Host "Installing Interception..."
& $installer.FullName /install
Write-Host "Install done"

# 2. Remove mouse filter from registry (KEY FIX for Bluetooth mouse)
Write-Host "Removing mouse interception from registry..."
$regPath = "HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4D36E96F-E325-11CE-BFC1-08002BE10318}"
$current = (Get-ItemProperty -Path $regPath -Name UpperFilters).UpperFilters
Write-Host "  Before: $($current -join ', ')"
$newFilters = $current | Where-Object { $_ -ne "mouse" }
Set-ItemProperty -Path $regPath -Name UpperFilters -Value $newFilters
Write-Host "  After: $($newFilters -join ', ')"

# 3. Disable mouse services
Write-Host "Disabling mouse interception services..."
for ($i = 0; $i -lt 20; $i++) {
    $name = "mouse_interception_{0:D2}" -f $i
    sc.exe config $name start=disabled 2>$null | Out-Null
}
Write-Host "Mouse services disabled"

# 4. Verify keyboard services
Write-Host ""
Write-Host "Keyboard services:"
for ($i = 0; $i -lt 5; $i++) {
    $name = "keyboard_interception_{0:D2}" -f $i
    $svc = sc.exe query $name 2>&1
    if ($svc -match "STATE") {
        Write-Host "  $name : OK"
    }
}

Write-Host ""
Write-Host "Done! Reboot to activate keyboard-only interception."
Write-Host "Mouse will NOT be affected (registry filter removed)."
$answer = Read-Host "Reboot now? (Y/N)"
if ($answer -eq 'Y' -or $answer -eq 'y') {
    Restart-Computer
}
