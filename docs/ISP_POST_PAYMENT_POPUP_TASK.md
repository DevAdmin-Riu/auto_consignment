# ISP 결제 후 팝업 처리 작업 설명서

## 배경
ISP(페이북) 결제 완료 후 네이티브 Windows 팝업이 2개 뜨는데, 이를 자동으로 처리해야 함.

## 현재 상태
- `lib/isp-payment.js` - ISP 결제 자동화 공통 모듈
- `automateISPPayment()` 함수에서 결제 버튼 클릭 후 종료
- 결제 버튼 클릭 후 **10초 대기** 후 다음 단계로 넘어감 (각 vendor order.js)

## 처리해야 할 팝업 (2개)

### 팝업 1: 스크립트 확인 창
- **형태**: "예" / "아니오" 버튼이 있는 스크립트 확인 창
- **처리**: "예" 버튼 클릭

### 팝업 2: 광고/스팸성 창
- **형태**: 뭔가 신청하라는 광고성 팝업
- **처리**: 창 닫기 (X 버튼 또는 닫기)

## 구현 위치

### 옵션 A: `lib/isp-payment.js` 내부에 추가 (권장)
`automateISPPayment()` 함수의 결제 버튼 클릭 후 부분에 추가

```javascript
// 현재 코드 (약 line 385-395)
await runPowerShell(clickPayScript);
await new Promise((r) => setTimeout(r, 3000));

console.log("[ISP] 네이티브 윈도우 자동화 완료");
return { success: true };
```

여기에 팝업 처리 로직 추가 필요

### 옵션 B: 별도 함수로 분리
`handlePostPaymentPopups()` 함수를 만들어서 각 vendor에서 호출

## 구현 방법

### 1. 팝업 창 찾기
```powershell
# 창 제목이나 클래스명으로 찾기
# 예: "스크립트", "확인", "알림" 등의 키워드로 찾기

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class PopupFinder {
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

        // 스크립트 확인 창 찾기 (키워드 조정 필요)
        if (title.Contains("스크립트") || title.Contains("Script") ||
            title.Contains("확인") || title.Contains("알림")) {
            foundHwnd = hWnd;
            return false;
        }
        return true;
    }
}
'@
```

### 2. "예" 버튼 클릭
```powershell
# 방법 1: 창 내부 버튼 찾아서 클릭
[DllImport("user32.dll")]
public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter,
    string lpszClass, string lpszWindow);

# 방법 2: 키보드로 Enter 또는 Alt+Y
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
# 또는
[System.Windows.Forms.SendKeys]::SendWait("%Y")  # Alt+Y
```

### 3. 창 닫기
```powershell
[DllImport("user32.dll")]
public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

const uint WM_CLOSE = 0x0010;

# 창 닫기
PostMessage($hwnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero);
```

## 주의사항

1. **창 제목/키워드 확인 필요**
   - 실제 팝업이 어떤 제목으로 뜨는지 Windows에서 확인 필요
   - `Get-Process | Where-Object { $_.MainWindowTitle -ne '' }` 로 확인 가능

2. **순서 주의**
   - 팝업이 순차적으로 뜨는지, 동시에 뜨는지 확인
   - 대기 시간 조정 필요할 수 있음

3. **기존 함수 참고**
   - `lib/isp-payment.js`의 `runPowerShell()` 함수 사용
   - 기존 창 찾기 로직 (`findWindowScript`) 참고

## 테스트 방법

1. Windows에서 수동으로 ISP 결제 진행
2. 결제 후 뜨는 팝업 창 제목 확인
3. PowerShell 스크립트로 해당 창 찾기 테스트
4. 버튼 클릭/창 닫기 테스트
5. `lib/isp-payment.js`에 통합

## 예상 코드 구조

```javascript
// lib/isp-payment.js에 추가

async function handlePostPaymentPopups() {
  console.log("[ISP] 결제 후 팝업 처리 시작...");

  // 최대 30초 동안 팝업 대기 및 처리
  for (let i = 0; i < 30; i++) {
    // 1. 스크립트 확인 창 찾기 및 "예" 클릭
    const scriptPopupScript = `...PowerShell...`;
    const scriptResult = await runPowerShell(scriptPopupScript, true);

    // 2. 광고 팝업 찾기 및 닫기
    const adPopupScript = `...PowerShell...`;
    const adResult = await runPowerShell(adPopupScript, true);

    // 두 팝업 모두 처리됐으면 종료
    if (/* 조건 */) break;

    await new Promise(r => setTimeout(r, 1000));
  }

  console.log("[ISP] 결제 후 팝업 처리 완료");
}

// automateISPPayment() 함수 끝부분에서 호출
await handlePostPaymentPopups();
```

## 파일 위치
- 수정 대상: `/lib/isp-payment.js`
- 테스트: swadpia, napkin, adpia 주문에서 ISP 결제 시 확인
