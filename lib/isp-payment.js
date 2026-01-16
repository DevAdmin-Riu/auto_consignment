/**
 * ISP(페이북) 결제 자동화 공통 모듈
 * - VPWalletLauncherC 네이티브 윈도우 자동화
 * - 할부 선택 및 비밀번호 입력 처리
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// 임시 파일 저장 경로
const TEMP_DIR = path.join(__dirname, "../temp");

// PowerShell 실행 헬퍼 (파일로 저장 후 실행)
function runPowerShell(script, silent = false) {
  return new Promise((resolve, reject) => {
    // temp 폴더가 없으면 생성
    if (!fs.existsSync(TEMP_DIR)) {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
    }

    // 임시 스크립트 파일 생성
    const scriptPath = path.join(TEMP_DIR, `isp_${Date.now()}.ps1`);
    fs.writeFileSync(scriptPath, script, "utf8");

    const ps = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
      }
    );

    let stdout = "";
    let stderr = "";

    ps.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    ps.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ps.on("close", (code) => {
      // 임시 파일 삭제
      try {
        fs.unlinkSync(scriptPath);
      } catch (e) {}

      const output = stdout.trim();
      if (output) {
        if (!silent) console.log("[PowerShell]", output);
        resolve(output);
      } else if (code !== 0) {
        if (!silent) console.log("[PowerShell] 실패:", stderr);
        reject(new Error(stderr || `Exit code: ${code}`));
      } else {
        resolve("");
      }
    });

    ps.on("error", (err) => {
      try {
        fs.unlinkSync(scriptPath);
      } catch (e) {}
      reject(err);
    });
  });
}

/**
 * ISP(페이북) 결제 자동화
 * - 창 위치 기반 상대 좌표 사용
 * - 일시불 자동 선택 후 비밀번호 입력
 * @param {string} ispPassword - ISP 결제 비밀번호
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function automateISPPayment(ispPassword) {
  console.log("[ISP] 네이티브 윈도우 자동화 시작...");

  try {
    // 1. VPWalletLauncherC 프로세스 창이 열릴 때까지 대기 (최대 60초)
    console.log("[ISP] 페이북 창 대기 중...");

    // 여러 프로세스 이름 시도 (ISP 관련 프로세스들)
    const processNames = ["VPWalletLauncherC", "ISPCard", "ISPWallet", "VPWallet"];

    // 창 제목으로도 찾기 (FindWindow API 사용)
    const findWindowScript = `
$processNames = @("VPWalletLauncherC", "ISPCard", "ISPWallet", "VPWallet")
$hwnd = $null

# 방법 1: 프로세스 이름으로 찾기
foreach ($name in $processNames) {
    $procs = Get-Process -Name $name -ErrorAction SilentlyContinue
    foreach ($proc in $procs) {
        if ($proc.MainWindowHandle -ne 0) {
            Write-Output $proc.MainWindowHandle.ToInt64()
            exit
        }
    }
}

# 방법 2: 창 제목으로 찾기 (ISP, 페이북 등)
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WindowFinder {
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public static IntPtr foundHwnd = IntPtr.Zero;

    public static bool EnumCallback(IntPtr hWnd, IntPtr lParam) {
        if (!IsWindowVisible(hWnd)) return true;

        StringBuilder sb = new StringBuilder(256);
        GetWindowText(hWnd, sb, 256);
        string title = sb.ToString();

        if (title.Contains("ISP") || title.Contains("페이북") || title.Contains("PayBook") || title.Contains("BC카드")) {
            foundHwnd = hWnd;
            return false;
        }
        return true;
    }

    public static IntPtr FindISPWindow() {
        foundHwnd = IntPtr.Zero;
        EnumWindows(EnumCallback, IntPtr.Zero);
        return foundHwnd;
    }
}
'@

$hwnd = [WindowFinder]::FindISPWindow()
if ($hwnd -ne [IntPtr]::Zero) {
    Write-Output $hwnd.ToInt64()
}
`;

    let hwnd = null;
    for (let i = 0; i < 60; i++) {
      try {
        const result = await runPowerShell(findWindowScript, true);
        if (result && result.length > 0 && result !== "0") {
          const lines = result.trim().split("\n");
          const hwndLine = lines[lines.length - 1].trim();
          if (/^\d+$/.test(hwndLine)) {
            hwnd = hwndLine;
            console.log("[ISP] 페이북 창 발견, HWND:", hwnd);
            break;
          }
        }
      } catch (e) {
        // 무시하고 계속 대기
      }
      await new Promise((r) => setTimeout(r, 1000));
      if (i % 5 === 0) {
        console.log(`[ISP] 창 대기 중... ${i}초`);
        // 10초마다 프로세스 목록 출력 (디버깅용)
        if (i % 10 === 0 && i > 0) {
          try {
            const debugScript = `Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object ProcessName, MainWindowTitle, MainWindowHandle | Format-Table -AutoSize | Out-String`;
            const debugResult = await runPowerShell(debugScript, true);
            console.log("[ISP] 현재 창 목록:\n", debugResult);
          } catch (e) {}
        }
      }
    }

    if (!hwnd) {
      console.log("[ISP] 페이북 창을 찾을 수 없음 - 수동 결제 필요");
      return { success: false, error: "페이북 창을 찾을 수 없음" };
    }

    // 2. 창 활성화 및 위치 가져오기
    console.log("[ISP] 창 활성화 및 위치 확인...");
    const activateAndGetRectScript = `
Add-Type @'
using System;
using System.Runtime.InteropServices;

public class Win32 {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }
}
'@

$hwnd = [IntPtr]::new(${hwnd})
[Win32]::ShowWindow($hwnd, 5)
[Win32]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 500

$rect = New-Object Win32+RECT
[Win32]::GetWindowRect($hwnd, [ref]$rect)
Write-Output "$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)"
    `;

    const rectResult = await runPowerShell(activateAndGetRectScript);
    const lines = rectResult.trim().split("\n");
    const rectLine = lines[lines.length - 1].trim();
    const [winLeft, winTop, winRight, winBottom] = rectLine.split(",").map(Number);
    const winWidth = winRight - winLeft;
    const winHeight = winBottom - winTop;
    console.log(`[ISP] 창 위치: Left=${winLeft}, Top=${winTop}, Size=${winWidth}x${winHeight}`);

    await new Promise((r) => setTimeout(r, 1000));

    // 3. 할부 선택 - 항상 일시불 선택 (창 위치 기반 상대 좌표)
    // 선택 드롭다운: 창 내부 (560, 103)
    // 일시불 항목: 창 내부 (560, 150) - 드롭다운 펼쳐진 후 첫번째 항목
    console.log("[ISP] 일시불 선택...");

    const dropdownX = winLeft + 560;
    const dropdownY = winTop + 103;
    const lumpSumX = winLeft + 560;
    const lumpSumY = winTop + 150;

    const installmentScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;

public class MouseInstallment {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;

    public static void Click(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(50);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(30);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
    }
}
'@

# 선택 드롭다운 클릭
[MouseInstallment]::Click(${dropdownX}, ${dropdownY})
Start-Sleep -Milliseconds 500

# 일시불 선택
[MouseInstallment]::Click(${lumpSumX}, ${lumpSumY})
Write-Output "Installment selected: lump sum at ${lumpSumX}, ${lumpSumY}"
    `;

    await runPowerShell(installmentScript);
    await new Promise((r) => setTimeout(r, 500));

    // 4. 비밀번호 입력 필드 클릭 후 입력 (창 위치 기반 상대 좌표)
    // 비밀번호 필드: 창 내부 (350, 335) - +5px 추가
    if (ispPassword) {
      console.log("[ISP] 비밀번호 필드 클릭 및 입력...");

      const pwdX = winLeft + 350;
      const pwdY = winTop + 335;

      const passwordScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;

public class MouseKeyboard {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint KEYEVENTF_KEYUP = 0x0002;

    public static void Click(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(50);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(30);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
    }

    public static void TypeKey(byte vk) {
        keybd_event(vk, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(30);
        keybd_event(vk, 0, KEYEVENTF_KEYUP, IntPtr.Zero);
        System.Threading.Thread.Sleep(50);
    }
}
'@

$x = ${pwdX}
$y = ${pwdY}

# 클릭 3번
[MouseKeyboard]::Click($x, $y)
Start-Sleep -Milliseconds 300
[MouseKeyboard]::Click($x, $y)
Start-Sleep -Milliseconds 300
[MouseKeyboard]::Click($x, $y)
Start-Sleep -Milliseconds 500

# 숫자 키 입력
$password = '${ispPassword}'
foreach ($char in $password.ToCharArray()) {
    $vk = [byte][char]$char
    [MouseKeyboard]::TypeKey($vk)
}

Write-Output "Done at $x, $y"
      `;

      await runPowerShell(passwordScript);
      await new Promise((r) => setTimeout(r, 1000));
    }

    // 5. 결제진행 버튼 클릭
    // 결제 버튼: 창 내부 (350, 420)
    console.log("[ISP] 결제진행 버튼 클릭...");

    const payX = winLeft + 350;
    const payY = winTop + 420;

    const clickPayScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;

public class MouseHelper2 {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;

    public static void Click(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(50);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(30);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
    }
}
'@

# 클릭 3번
[MouseHelper2]::Click(${payX}, ${payY})
Start-Sleep -Milliseconds 300
[MouseHelper2]::Click(${payX}, ${payY})
Start-Sleep -Milliseconds 300
[MouseHelper2]::Click(${payX}, ${payY})
Write-Output "Pay button clicked at ${payX}, ${payY}"
    `;

    await runPowerShell(clickPayScript);
    await new Promise((r) => setTimeout(r, 3000));

    console.log("[ISP] 네이티브 윈도우 자동화 완료");
    return { success: true };
  } catch (error) {
    console.error("[ISP] 자동화 실패:", error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  automateISPPayment,
  runPowerShell,
};
