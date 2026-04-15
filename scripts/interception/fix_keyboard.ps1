# Interception 드라이버 중지 + 키보드/마우스 복구
# 관리자 권한 자동 승격

# 관리자 권한 확인 및 승격
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs -Wait
    exit
}

# 1단계: Interception 커널 필터 드라이버 중지
Write-Host "Stopping Interception filter drivers..."
sc.exe stop keyboard 2>$null
sc.exe stop mouse 2>$null
Start-Sleep -Milliseconds 500

# 2단계: 키보드 디바이스 껐다 켜기 (리셋)
$kbDevices = Get-PnpDevice | Where-Object { $_.Class -eq 'Keyboard' -and $_.Status -eq 'OK' }
foreach ($device in $kbDevices) {
    Write-Host "Resetting keyboard: $($device.FriendlyName)"
    Disable-PnpDevice -InstanceId $device.InstanceId -Confirm:$false -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Enable-PnpDevice -InstanceId $device.InstanceId -Confirm:$false -ErrorAction SilentlyContinue
}

# 3단계: 마우스 디바이스 껐다 켜기 (리셋)
$mouseDevices = Get-PnpDevice | Where-Object { $_.Class -eq 'Mouse' -and $_.Status -eq 'OK' }
foreach ($device in $mouseDevices) {
    Write-Host "Resetting mouse: $($device.FriendlyName)"
    Disable-PnpDevice -InstanceId $device.InstanceId -Confirm:$false -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Enable-PnpDevice -InstanceId $device.InstanceId -Confirm:$false -ErrorAction SilentlyContinue
}

Write-Host "Keyboard + Mouse reset done!"
