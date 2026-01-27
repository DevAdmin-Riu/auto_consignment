/**
 * ISP(페이북) 결제 자동화 공통 모듈
 * - VPWalletLauncherC 네이티브 윈도우 자동화
 * - 할부 선택 및 비밀번호 입력 처리
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { getEnv } = require("../vendors/config");

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
 * @param {string} [ispPassword] - ISP 결제 비밀번호 (미전달 시 BC_ISP_PASSWORD 환경변수 사용)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function automateISPPayment(ispPassword = null) {
  // 비밀번호가 전달되지 않으면 환경변수에서 가져옴
  const password = ispPassword || getEnv("BC_ISP_PASSWORD") || "";
  if (!password) {
    console.log("[ISP] ISP 비밀번호 미설정 - 수동 결제 필요");
    return { success: false, error: "ISP 비밀번호 미설정" };
  }
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
    if (password) {
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
$password = '${password}'
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

    // 6. 결제 후 팝업 처리 (스크립트 확인 창, 광고 팝업)
    console.log("[ISP] 결제 후 팝업 처리 중...");
    await handlePostPaymentPopups();

    console.log("[ISP] 네이티브 윈도우 자동화 완료");
    return { success: true };
  } catch (error) {
    console.error("[ISP] 자동화 실패:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * ISP 결제 후 팝업 처리
 * - 스크립트 확인 창 ("예" 버튼 클릭)
 * - 광고성 팝업 (창 닫기)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function handlePostPaymentPopups() {
  console.log("[ISP] 결제 후 팝업 처리 시작...");

  // 팝업 찾기 및 처리 PowerShell 스크립트
  // Unicode API 사용 (GetWindowTextW) 및 Unicode escape sequence로 한글 키워드 처리
  const handlePopupsScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class PopupHandler {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindowExW(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public const uint WM_CLOSE = 0x0010;
    public const uint BM_CLICK = 0x00F5;

    public static List<IntPtr> scriptPopups = new List<IntPtr>();
    public static List<IntPtr> adPopups = new List<IntPtr>();
    public static List<string> allWindows = new List<string>();

    public static bool EnumCallback(IntPtr hWnd, IntPtr lParam) {
        if (!IsWindowVisible(hWnd)) return true;

        StringBuilder sb = new StringBuilder(256);
        GetWindowTextW(hWnd, sb, 256);
        string title = sb.ToString();

        if (!string.IsNullOrEmpty(title)) {
            allWindows.Add(hWnd.ToInt64() + ": " + title);

            // 스크립트 오류/확인 창 (Unicode escape: 스크립트=\uC2A4\uD06C\uB9BD\uD2B8, 오류=\uC624\uB958)
            if (title.Contains("Script") || title.Contains("Error") ||
                title.Contains("\uC2A4\uD06C\uB9BD\uD2B8") || title.Contains("\uC624\uB958") ||
                title.Contains("VBScript") || title.Contains("Windows Script Host") ||
                title.Contains("Windows Internet Explorer")) {
                scriptPopups.Add(hWnd);
            }
            // 페이북 ISP 결제 완료 창 (Unicode escape: 페이북=\uD398\uC774\uBD81, 결제=\uACB0\uC81C, ISP)
            else if (title.Contains("ISP") || title.Contains("PayBook") ||
                     title.Contains("\uD398\uC774\uBD81") || title.Contains("\uACB0\uC81C")) {
                adPopups.Add(hWnd);
            }
        }

        return true;
    }

    public static void FindPopups() {
        scriptPopups.Clear();
        adPopups.Clear();
        allWindows.Clear();
        EnumWindows(EnumCallback, IntPtr.Zero);
    }

    public static bool ClickYesButton(IntPtr hwnd) {
        // "예(Y)" 또는 "예" 또는 "Yes" 버튼 찾기 (Unicode: 예=\uC608)
        IntPtr yesBtn = FindWindowExW(hwnd, IntPtr.Zero, "Button", "\uC608(Y)");
        if (yesBtn == IntPtr.Zero) {
            yesBtn = FindWindowExW(hwnd, IntPtr.Zero, "Button", "\uC608");
        }
        if (yesBtn == IntPtr.Zero) {
            yesBtn = FindWindowExW(hwnd, IntPtr.Zero, "Button", "Yes");
        }
        if (yesBtn == IntPtr.Zero) {
            // 확인=\uD655\uC778
            yesBtn = FindWindowExW(hwnd, IntPtr.Zero, "Button", "\uD655\uC778");
        }
        if (yesBtn == IntPtr.Zero) {
            yesBtn = FindWindowExW(hwnd, IntPtr.Zero, "Button", "OK");
        }

        if (yesBtn != IntPtr.Zero) {
            SendMessage(yesBtn, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
            return true;
        }

        // 버튼을 찾지 못하면 Enter 키로 기본 버튼 클릭 시도
        SetForegroundWindow(hwnd);
        return false;
    }

    public static void CloseWindow(IntPtr hwnd) {
        PostMessage(hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
    }
}
'@

$handledScript = 0
$handledAd = 0
$foundAny = $false

# 디버깅: 시작 시 모든 창 목록 출력
Write-Output "=== All visible windows at start ==="
[PopupHandler]::FindPopups()
foreach ($w in [PopupHandler]::allWindows) {
    Write-Output "  $w"
}
Write-Output "=== End window list ==="

# 최대 15초 동안 팝업 대기 및 처리
for ($i = 0; $i -lt 15; $i++) {
    [PopupHandler]::FindPopups()

    $currentScriptCount = [PopupHandler]::scriptPopups.Count
    $currentAdCount = [PopupHandler]::adPopups.Count

    # 1. 스크립트 확인 창 처리
    foreach ($hwnd in [PopupHandler]::scriptPopups) {
        $title = New-Object System.Text.StringBuilder 256
        [PopupHandler]::GetWindowTextW($hwnd, $title, 256)
        Write-Output "Found script popup: $($title.ToString()) (hwnd: $($hwnd.ToInt64()))"

        # "예" 버튼 클릭 시도
        $clicked = [PopupHandler]::ClickYesButton($hwnd)
        if ($clicked) {
            Write-Output "Clicked Yes button"
        } else {
            # Enter 키로 기본 버튼 클릭
            [PopupHandler]::SetForegroundWindow($hwnd)
            Start-Sleep -Milliseconds 300
            [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
            Write-Output "Sent Enter key"
        }
        $handledScript++
        $foundAny = $true
        Start-Sleep -Milliseconds 500
    }

    # 2. ISP/페이북 팝업 닫기
    foreach ($hwnd in [PopupHandler]::adPopups) {
        $title = New-Object System.Text.StringBuilder 256
        [PopupHandler]::GetWindowTextW($hwnd, $title, 256)
        Write-Output "Found ISP/ad popup: $($title.ToString()) (hwnd: $($hwnd.ToInt64()))"

        [PopupHandler]::CloseWindow($hwnd)
        Write-Output "Closed ISP/ad popup"
        $handledAd++
        $foundAny = $true
        Start-Sleep -Milliseconds 300
    }

    # 팝업을 처리했으면 잠시 대기 후 추가 팝업 확인
    if ($currentScriptCount -gt 0 -or $currentAdCount -gt 0) {
        Start-Sleep -Milliseconds 1000
        # 추가 팝업 확인을 위해 한번 더 루프
        continue
    }

    # 이미 팝업을 처리한 적이 있고, 더 이상 팝업이 없으면 종료
    if ($foundAny) {
        Write-Output "All popups handled, exiting"
        break
    }

    Start-Sleep -Milliseconds 1000
}

# 3. payEndDlg 프로세스 종료 (결제 완료 다이얼로그)
$payEndProc = Get-Process -Name "payEndDlg" -ErrorAction SilentlyContinue
if ($payEndProc) {
    Write-Output "Found payEndDlg process (PID: $($payEndProc.Id)), stopping..."
    Stop-Process -Id $payEndProc.Id -Force
    Write-Output "payEndDlg process stopped"
    $handledAd++
}

Write-Output "Handled: script=$handledScript, ad=$handledAd"
`;

  try {
    const result = await runPowerShell(handlePopupsScript);
    console.log("[ISP] 팝업 처리 결과:", result);
    return { success: true };
  } catch (error) {
    console.error("[ISP] 팝업 처리 실패:", error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  automateISPPayment,
  handlePostPaymentPopups,
  runPowerShell,
};
