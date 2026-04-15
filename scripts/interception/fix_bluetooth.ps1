# Interception mouse filter removal + Bluetooth mouse fix
# Run as Administrator
#
# When: After Interception install causes Bluetooth mouse to stop working
# What: Removes "mouse" from Mouse class UpperFilters registry, keeping only "mouclass"
# Reboot required after running

$regPath = "HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4D36E96F-E325-11CE-BFC1-08002BE10318}"
$current = (Get-ItemProperty -Path $regPath -Name UpperFilters).UpperFilters

Write-Host "Current Mouse UpperFilters: $($current -join ', ')"

if ($current -contains "mouse") {
    $newFilters = $current | Where-Object { $_ -ne "mouse" }
    Set-ItemProperty -Path $regPath -Name UpperFilters -Value $newFilters
    Write-Host "Removed 'mouse' (Interception) from UpperFilters"
    Write-Host "New UpperFilters: $($newFilters -join ', ')"
    Write-Host ""
    Write-Host "REBOOT REQUIRED to apply changes"
    $answer = Read-Host "Reboot now? (Y/N)"
    if ($answer -eq 'Y' -or $answer -eq 'y') {
        Restart-Computer
    }
} else {
    Write-Host "No Interception mouse filter found. UpperFilters is clean."
}
