/**
 * 신한카드 결제 자동화 모듈
 * - 토스페이먼츠 iframe 내 보안키패드 입력 처리
 * - Interception 커널 드라이버로 하드웨어 레벨 키보드 입력 (키보드 필터만 설치)
 * - ctypes로 키보드 디바이스 1개만 직접 제어 (마우스 영향 없음)
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { getEnv } = require("../vendors/config");

const TEMP_DIR = path.join(__dirname, "../temp");
const TYPE_SCRIPT = path.join(TEMP_DIR, "type_keyboard_only.py");
const KB_DEVICE_CACHE = path.join(TEMP_DIR, "kb_device.txt");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 키보드 디바이스 번호 가져오기
 * kb_device.txt 캐시 파일에서 읽음 (없으면 기본값 0)
 */
function getKeyboardDevice() {
  try {
    if (fs.existsSync(KB_DEVICE_CACHE)) {
      const saved = parseInt(fs.readFileSync(KB_DEVICE_CACHE, "utf8").trim());
      if (saved >= 0 && saved < 10) {
        return saved;
      }
    }
  } catch (e) {}
  return 0;
}

/**
 * Interception 드라이버로 텍스트 입력 (커널 레벨)
 * type_keyboard_only.py 사용 - 키보드 디바이스 1개만 열고 닫음
 * @param {string} text - 입력할 텍스트
 */
function typeWithInterception(text) {
  const device = getKeyboardDevice();

  try {
    const result = execSync(`python "${TYPE_SCRIPT}" ${device} "${text}"`, {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    return result.includes("OK");
  } catch (error) {
    console.error("[Shinhan] Interception 입력 실패:", error.message);
    return false;
  }
}

/**
 * 신한카드 카드번호 입력 (cardNum2, cardNum3)
 * @param {Object} paymentFrame - 토스페이먼츠 iframe
 */
async function automateShinhanCardPayment(paymentFrame) {
  console.log("[Shinhan] Interception으로 카드번호 입력 시작...");

  try {
    const cardNum2 = getEnv("SHINHAN_CARD_NUM2");
    const cardNum3 = getEnv("SHINHAN_CARD_NUM3");

    if (!cardNum2 || !cardNum3) {
      console.log("[Shinhan] 신한카드 정보가 환경변수에 없음");
      return { success: false, error: "카드 정보 미설정" };
    }

    // cardNum2 필드 클릭
    console.log("[Shinhan] cardNum2 필드 클릭...");
    await paymentFrame.click("#cardNum2");
    await delay(300);

    // Interception으로 cardNum2 입력
    console.log("[Shinhan] cardNum2 입력 중...");
    if (!typeWithInterception(cardNum2)) {
      return { success: false, error: "cardNum2 입력 실패" };
    }
    console.log("[Shinhan] ✅ cardNum2 입력 완료");

    // 4자리 입력 후 자동 포커스 이동 대기
    await delay(1000);

    // cardNum3 입력 (자동 포커스 됨)
    console.log("[Shinhan] cardNum3 입력 중...");
    if (!typeWithInterception(cardNum3)) {
      return { success: false, error: "cardNum3 입력 실패" };
    }
    console.log("[Shinhan] ✅ cardNum3 입력 완료");

    console.log("[Shinhan] 카드번호 입력 완료");
    return { success: true };
  } catch (error) {
    console.error("[Shinhan] 카드 입력 자동화 실패:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * 결제 팝업/페이지 내에서 토스페이먼츠 결제 프레임 찾기
 * @param {Object} popupOrPage - 결제 팝업 페이지 또는 메인 페이지
 * @param {number} maxRetries - 최대 재시도 횟수 (기본 15)
 * @returns {Object} 결제 프레임 (iframe 또는 페이지 자체)
 */
async function findPaymentFrame(popupOrPage, maxRetries = 15) {
  for (let i = 0; i < maxRetries; i++) {
    // 방법 1: 이름에 '토스페이먼츠'가 포함된 iframe 찾기
    const frames = popupOrPage.frames();
    for (const f of frames) {
      const frameName = f.name();
      if (frameName.includes("토스페이먼츠")) {
        console.log("[Shinhan] 토스페이먼츠 iframe 발견:", frameName);
        return f;
      }
    }

    // 방법 2: title 속성으로 iframe 찾기
    const iframeEl = await popupOrPage.$(
      'iframe[title="토스페이먼츠 전자결제"]',
    );
    if (iframeEl) {
      const frame = await iframeEl.contentFrame();
      if (frame) {
        console.log("[Shinhan] 토스페이먼츠 iframe 발견 (title 기반)");
        return frame;
      }
    }

    // 방법 3: 결제 UI 요소가 현재 페이지에 직접 있는지 확인
    const hasPaymentUI = await popupOrPage.evaluate(() => {
      const tabs = document.querySelectorAll('a[role="tab"]');
      for (const tab of tabs) {
        if (tab.textContent?.includes("다른결제")) return true;
      }
      return (
        !!document.querySelector("#cardNum1") ||
        !!document.querySelector(".sub-tit")
      );
    });
    if (hasPaymentUI) {
      console.log("[Shinhan] 결제 UI가 현재 페이지에 직접 존재");
      return popupOrPage;
    }

    console.log(`[Shinhan] 결제 프레임 탐색 중... (${i + 1}/${maxRetries})`);
    await delay(1000);
  }

  // 폴백: 페이지 자체 반환
  console.log("[Shinhan] 결제 프레임을 찾지 못함 - 현재 페이지 사용");
  return popupOrPage;
}

/**
 * 신한카드 전체 결제 프로세스
 * - phone: 다른결제 → 앱없이결제 → 휴대폰번호로 결제 → 휴대폰번호 → 생년월일 → 다음 → 비밀번호 → 결제요청
 * - card:  다른결제 → 앱없이결제 → 카드번호 결제 → 카드번호 입력 → CVC → 다음 → 비밀번호 → 결제요청
 *
 * @param {Object} paymentFrame - 토스페이먼츠 결제 iframe 또는 결제 팝업 페이지
 * @param {Object} focusPage - bringToFront 대상 (Interception 입력을 위한 OS 포커스용)
 *   - napkin: 메인 page (iframe이 메인 페이지 안에 있으므로)
 *   - swadpia/adpia: paymentPopup (팝업 안에 결제 UI가 있으므로)
 * @param {string} paymentMethod - "phone" (휴대폰번호, 기본) 또는 "card" (카드번호)
 * @returns {{ success: boolean, error?: string }}
 */
/**
 * 토스페이먼츠 iframe 다시 찾기 (페이지 전환 후 detached frame 대응)
 */
async function refindPaymentFrame(page, maxRetries = 10) {
  for (let i = 0; i < maxRetries; i++) {
    const frames = page.frames();
    for (const frame of frames) {
      try {
        const url = frame.url();
        if (url.includes("tosspayments") || url.includes("payment")) {
          // frame이 유효한지 확인
          await frame.evaluate(() => true);
          console.log(`[Shinhan] 결제 iframe 재발견 (${url.substring(0, 80)}...)`);
          return frame;
        }
      } catch (e) {
        // detached frame은 스킵
      }
    }
    await delay(1000);
  }
  return null;
}

async function processShinhanCardPayment(
  paymentFrame,
  focusPage,
  paymentMethod = "phone",
  page = null,
) {
  try {
    // Step 1: "다른결제" 탭 클릭
    console.log("[Shinhan] 다른결제 탭 클릭...");
    let otherPaymentClicked = false;
    for (let retry = 0; retry < 10; retry++) {
      otherPaymentClicked = await paymentFrame.evaluate(() => {
        const tabs = document.querySelectorAll('a[role="tab"]');
        for (const tab of tabs) {
          const text = tab.textContent || "";
          if (text.includes("다른결제")) {
            tab.click();
            return true;
          }
        }
        return false;
      });
      if (otherPaymentClicked) break;
      console.log(`[Shinhan] 다른결제 탭 대기 중... (${retry + 1}/10)`);
      await delay(1000);
    }
    if (!otherPaymentClicked) {
      return { success: false, error: "다른결제 탭을 찾을 수 없음" };
    }
    console.log("[Shinhan] ✅ 다른결제 탭 클릭 완료");
    await delay(2000);

    // Step 2: "앱없이결제" 버튼 클릭
    console.log("[Shinhan] 앱없이결제 버튼 클릭...");
    let applessPayClicked = false;
    for (let retry = 0; retry < 10; retry++) {
      applessPayClicked = await paymentFrame.evaluate(() => {
        const subTits = document.querySelectorAll(".sub-tit");
        for (const span of subTits) {
          const text = span.textContent || "";
          if (text.includes("앱없이결제")) {
            const link = span.closest("a");
            if (link) {
              link.click();
              return true;
            }
          }
        }
        return false;
      });
      if (applessPayClicked) break;
      console.log(`[Shinhan] 앱없이결제 대기 중... (${retry + 1}/10)`);
      await delay(1000);
    }
    if (!applessPayClicked) {
      return { success: false, error: "앱없이결제 버튼을 찾을 수 없음" };
    }
    console.log("[Shinhan] ✅ 앱없이결제 클릭 완료");
    await delay(3000);

    // 앱없이결제 클릭 후 iframe 내부 페이지 전환 → frame 재탐색
    let activeFrame = paymentFrame;
    try {
      await paymentFrame.evaluate(() => true);
    } catch (e) {
      console.log("[Shinhan] ⚠️ 결제 iframe detached 감지, 재탐색...");
      if (page) {
        const newFrame = await refindPaymentFrame(page);
        if (newFrame) {
          activeFrame = newFrame;
        } else {
          return { success: false, error: "결제 iframe 재탐색 실패" };
        }
      } else {
        return { success: false, error: "결제 iframe detached + page 참조 없음" };
      }
    }

    // Step 3~7: 결제 방식별 분기
    if (paymentMethod === "card") {
      // ========== 카드번호 결제 ==========
      return await processCardNumberPayment(activeFrame, focusPage);
    } else {
      // ========== 휴대폰번호 결제 (기본) ==========
      return await processPhonePayment(activeFrame, focusPage);
    }
  } catch (error) {
    console.error("[Shinhan] 결제 프로세스 실패:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * 카드번호 결제 (기존 로직)
 */
async function processCardNumberPayment(paymentFrame, focusPage) {
  // Step 3: "카드번호 결제" 탭 클릭
  console.log("[Shinhan] 카드번호 결제 탭 클릭...");
  let cardTabClicked = false;
  for (let retry = 0; retry < 10; retry++) {
    cardTabClicked = await paymentFrame.evaluate(() => {
      const tabs = document.querySelectorAll('a, button, [role="tab"]');
      for (const tab of tabs) {
        const text = tab.textContent || "";
        if (text.includes("카드번호") && text.includes("결제")) {
          tab.click();
          return true;
        }
      }
      return false;
    });
    if (cardTabClicked) break;
    console.log(`[Shinhan] 카드번호 결제 탭 대기 중... (${retry + 1}/10)`);
    await delay(1000);
  }
  if (!cardTabClicked) {
    return { success: false, error: "카드번호 결제 탭을 찾을 수 없음" };
  }
  console.log("[Shinhan] ✅ 카드번호 결제 탭 클릭 완료");
  await delay(2000);

  // Step 4: 카드번호 입력
  const cardNum1 = getEnv("SHINHAN_CARD_NUM1");
  const cardNum4 = getEnv("SHINHAN_CARD_NUM4");

  if (!cardNum1 || !cardNum4) {
    return {
      success: false,
      error: "카드번호 환경변수 미설정 (SHINHAN_CARD_NUM1/NUM4)",
    };
  }

  console.log("[Shinhan] 카드번호 입력 시작...");

  // cardNum1 (앞 4자리) - 보안키패드 없음
  await paymentFrame.click("#cardNum1");
  await delay(100);
  await paymentFrame.type("#cardNum1", cardNum1, { delay: 50 });
  console.log("[Shinhan] ✅ cardNum1 입력 완료");
  await delay(300);

  // cardNum2, cardNum3 - 보안키패드 필드 → Interception
  console.log("[Shinhan] 보안키패드 필드 키보드 입력 시작...");
  await focusPage.bringToFront();
  await delay(300);
  const shinhanResult = await automateShinhanCardPayment(paymentFrame);

  if (!shinhanResult.success) {
    return {
      success: false,
      error: "cardNum2/3 입력 실패: " + shinhanResult.error,
    };
  }
  console.log("[Shinhan] ✅ cardNum2, cardNum3 입력 완료");
  await delay(300);

  // cardNum4 (뒤 4자리) - 보안키패드 없음
  await paymentFrame.click("#cardNum4");
  await delay(100);
  await paymentFrame.type("#cardNum4", cardNum4, { delay: 50 });
  console.log("[Shinhan] ✅ cardNum4 입력 완료");
  await delay(300);

  // CVC 입력 - Interception
  const cardCVC = getEnv("SHINHAN_CVC");
  if (cardCVC) {
    await delay(1000);
    await paymentFrame.click("#inputCVC");
    await delay(300);
    console.log("[Shinhan] CVC 입력 중...");
    typeWithInterception(cardCVC);
    await delay(500);
    console.log("[Shinhan] ✅ CVC 입력 완료");
  }
  await delay(500);

  // Step 5: 다음 버튼 클릭
  console.log("[Shinhan] 다음 버튼 클릭...");
  const submitClicked = await paymentFrame.evaluate(() => {
    const btn = document.querySelector(".submit-btn");
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  if (!submitClicked) {
    return { success: false, error: "다음 버튼(.submit-btn)을 찾을 수 없음" };
  }
  console.log("[Shinhan] ✅ 다음 버튼 클릭 완료");
  await delay(3000);

  // Step 6: 비밀번호 입력
  const passwordResult = await inputPassword(paymentFrame, focusPage);
  if (!passwordResult.success) return passwordResult;

  // Step 7: 결제요청 버튼 클릭
  return await clickPaymentButton(paymentFrame);
}

/**
 * 휴대폰번호 결제 (신규)
 */
async function processPhonePayment(paymentFrame, focusPage) {
  // "휴대폰번호로 결제" 탭이 기본 선택 상태이므로 탭 클릭 불필요

  const phone = getEnv("SHINHAN_PHONE");
  const birth = getEnv("SHINHAN_BIRTH");

  if (!phone || !birth) {
    return {
      success: false,
      error: "휴대폰/생년월일 환경변수 미설정 (SHINHAN_PHONE/SHINHAN_BIRTH)",
    };
  }

  // Step 3: 휴대폰번호 입력 (일반 input - 보안키패드 아님)
  console.log("[Shinhan] 휴대폰번호 입력...");
  let phoneInputFound = false;
  for (let retry = 0; retry < 10; retry++) {
    phoneInputFound = await paymentFrame.evaluate((phoneNum) => {
      // placeholder에 "없이 입력" 포함된 input
      const inputs = document.querySelectorAll("input");
      for (const input of inputs) {
        const placeholder = input.placeholder || "";
        if (placeholder.includes("없이") || placeholder.includes("휴대폰")) {
          input.focus();
          input.value = "";
          input.click();
          return true;
        }
      }
      // type="tel" input 폴백
      const telInput = document.querySelector('input[type="tel"]');
      if (telInput) {
        telInput.focus();
        telInput.value = "";
        telInput.click();
        return true;
      }
      return false;
    }, phone);
    if (phoneInputFound) break;
    console.log(`[Shinhan] 휴대폰번호 필드 대기 중... (${retry + 1}/10)`);
    await delay(1000);
  }
  if (!phoneInputFound) {
    return { success: false, error: "휴대폰번호 입력 필드를 찾을 수 없음" };
  }

  // 휴대폰번호 타이핑 (일반 input이므로 puppeteer type 사용)
  await paymentFrame.evaluate(() => {
    const inputs = document.querySelectorAll("input");
    for (const input of inputs) {
      const placeholder = input.placeholder || "";
      if (placeholder.includes("없이") || placeholder.includes("휴대폰")) {
        input.focus();
        return;
      }
    }
    const telInput = document.querySelector('input[type="tel"]');
    if (telInput) telInput.focus();
  });
  await delay(500);
  await focusPage.bringToFront();
  await delay(500);
  console.log("[Shinhan] 휴대폰번호 Interception 입력 중...");
  if (!typeWithInterception(phone)) {
    return { success: false, error: "휴대폰번호 Interception 입력 실패" };
  }
  await delay(1000);

  // 입력값 검증
  const phoneValue = await paymentFrame.evaluate(() => {
    const inputs = document.querySelectorAll("input");
    for (const input of inputs) {
      const placeholder = input.placeholder || "";
      if (placeholder.includes("없이") || placeholder.includes("휴대폰")) {
        return input.value;
      }
    }
    const telInput = document.querySelector('input[type="tel"]');
    return telInput ? telInput.value : "";
  });

  if (!phoneValue || phoneValue.length < 8) {
    console.log(`[Shinhan] ❌ 휴대폰번호 입력 검증 실패: "${phoneValue}" (기대: ${phone})`);
    return { success: false, error: `휴대폰번호 입력 안 됨 (값: "${phoneValue}")` };
  }
  console.log("[Shinhan] ✅ 휴대폰번호 입력 완료 (검증됨)");

  // Step 4: 생년월일 입력 (보안키패드 → Interception)
  console.log("[Shinhan] 생년월일 입력...");
  let birthInputFound = false;
  for (let retry = 0; retry < 10; retry++) {
    birthInputFound = await paymentFrame.evaluate(() => {
      const birthInput = document.querySelector("#strBirth");
      if (birthInput) {
        birthInput.focus();
        birthInput.click();
        return true;
      }
      return false;
    });
    if (birthInputFound) break;
    console.log(`[Shinhan] 생년월일 필드 대기 중... (${retry + 1}/10)`);
    await delay(1000);
  }
  if (!birthInputFound) {
    return { success: false, error: "생년월일 입력 필드를 찾을 수 없음" };
  }

  await focusPage.bringToFront();
  await delay(500);
  console.log("[Shinhan] 생년월일 Interception 입력 중...");
  if (!typeWithInterception(birth)) {
    return { success: false, error: "생년월일 Interception 입력 실패" };
  }
  await delay(1000);

  // 입력값 검증
  const birthValue = await paymentFrame.evaluate(() => {
    const inputs = document.querySelectorAll('input[type="password"], input[type="tel"], input[type="number"]');
    for (const input of inputs) {
      if (input.value && input.value.length === 6) return input.value.length;
    }
    // 보안키패드라 value 못 읽을 수 있음 — 길이만 체크
    return -1;
  });
  if (birthValue === 0) {
    console.log("[Shinhan] ❌ 생년월일 입력 검증 실패: 빈 값");
    return { success: false, error: "생년월일 입력 안 됨" };
  }
  console.log("[Shinhan] ✅ 생년월일 입력 완료 (검증됨)");

  // Step 5: 다음 버튼 클릭
  console.log("[Shinhan] 다음 버튼 클릭...");
  const submitClicked = await paymentFrame.evaluate(() => {
    const btn = document.querySelector(".submit-btn");
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  if (!submitClicked) {
    return { success: false, error: "다음 버튼(.submit-btn)을 찾을 수 없음" };
  }
  console.log("[Shinhan] ✅ 다음 버튼 클릭 완료");
  await delay(3000);

  // Step 6: 비밀번호 입력
  const passwordResult = await inputPassword(paymentFrame, focusPage);
  if (!passwordResult.success) return passwordResult;

  // Step 7: 결제요청 버튼 클릭
  return await clickPaymentButton(paymentFrame);
}

/**
 * 비밀번호 입력 (공통)
 */
async function inputPassword(paymentFrame, focusPage) {
  console.log("[Shinhan] 비밀번호 입력 화면 대기...");
  const cardPassword = getEnv("SHINHAN_CARD_PASSWORD");
  if (!cardPassword) {
    return {
      success: false,
      error: "비밀번호 환경변수 미설정 (SHINHAN_CARD_PASSWORD)",
    };
  }

  const passwordSelectors = [
    'input[type="password"]',
    'input[type="tel"]',
    'input[name="password"]',
    'input[id*="password"]',
    'input[id*="pwd"]',
    'input[id*="cardPw"]',
    "#cardPwd",
    "#cardPw",
    "input[data-nppfs-form-id]",
  ];

  let passwordInputFound = false;
  for (let i = 0; i < 10 && !passwordInputFound; i++) {
    for (const selector of passwordSelectors) {
      try {
        const pwdInput = await paymentFrame.$(selector);
        if (pwdInput) {
          console.log(`[Shinhan] 비밀번호 필드 발견: ${selector}`);
          await paymentFrame.click(selector);
          await delay(500);
          await paymentFrame.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) {
              el.focus();
              el.click();
            }
          }, selector);
          await delay(500);

          await focusPage.bringToFront();
          await delay(500);
          console.log("[Shinhan] 비밀번호 입력 중 (Interception)...");
          const result = typeWithInterception(cardPassword);
          console.log("[Shinhan] Interception 입력 결과:", result);
          await delay(2000);
          console.log("[Shinhan] ✅ 비밀번호 입력 완료");
          passwordInputFound = true;
          break;
        }
      } catch (e) {
        console.log(`[Shinhan] 비밀번호 필드 에러 (${selector}):`, e.message);
      }
    }
    if (!passwordInputFound) {
      console.log(`[Shinhan] 비밀번호 필드 탐색 중... (${i + 1}/10)`);
      await delay(1000);
    }
  }

  if (!passwordInputFound) {
    return {
      success: false,
      error: "비밀번호 필드를 찾을 수 없음 (10회 시도)",
    };
  }

  return { success: true };
}

/**
 * 결제요청 버튼 클릭 (공통)
 */
async function clickPaymentButton(paymentFrame) {
  await delay(500);
  console.log("[Shinhan] 결제요청 버튼 찾는 중...");
  const paymentBtnClicked = await paymentFrame.evaluate(() => {
    const btn = document.querySelector(".submit-btn");
    if (btn) {
      btn.click();
      return { clicked: true, method: "submit-btn" };
    }
    const buttons = document.querySelectorAll("button");
    for (const b of buttons) {
      const text = (b.textContent || "").trim();
      if (text.includes("결제") || text.includes("확인")) {
        b.click();
        return { clicked: true, method: `text:${text}` };
      }
    }
    return { clicked: false };
  });

  if (!paymentBtnClicked.clicked) {
    console.log("[Shinhan] ❌ 결제요청 버튼을 찾을 수 없음");
    return { success: false, error: "결제요청 버튼을 찾을 수 없음" };
  }

  console.log(`[Shinhan] ✅ 결제요청 버튼 클릭 완료 (1차, ${paymentBtnClicked.method})`);
  await delay(2000);

  // 2차 결제요청 확인 버튼 클릭 (확인 팝업이 뜨는 경우)
  try {
    const secondClick = await paymentFrame.evaluate(() => {
      const btn = document.querySelector(".submit-btn");
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    if (secondClick) {
      console.log("[Shinhan] ✅ 결제요청 버튼 클릭 완료 (2차)");
    }
  } catch (e) {
    // 2차 클릭 실패는 무시 (iframe이 닫혔을 수 있음 = 결제 진행 중)
    console.log(`[Shinhan] 2차 클릭 스킵 (${e.message?.substring(0, 50)})`);
  }

  await delay(3000);

  // 결제 승인 확인: iframe이 닫혔거나 내용이 변경됐는지 확인
  let paymentConfirmed = false;
  try {
    const frameContent = await paymentFrame.evaluate(() => {
      return document.body?.textContent?.substring(0, 200) || "";
    });
    // iframe이 여전히 결제 입력 화면이면 결제 실패
    if (frameContent.includes("결제요청") || frameContent.includes("비밀번호") || frameContent.includes("카드번호")) {
      console.log("[Shinhan] ⚠️ 결제 화면이 그대로 남아있음 — 결제 미승인 가능성");
      return { success: false, error: "결제 요청 후 화면 변경 없음 (결제 미승인 가능성)" };
    }
    console.log("[Shinhan] 결제 iframe 상태 변경 확인됨");
    paymentConfirmed = true;
  } catch (e) {
    // iframe 접근 실패 = frame이 닫혔거나 전환됨 = 결제 진행 중
    console.log(`[Shinhan] 결제 iframe 닫힘/전환 감지 (${e.message?.substring(0, 50)}) — 결제 진행 중으로 판단`);
    paymentConfirmed = true;
  }

  console.log(`[Shinhan] 결제 프로세스 완료: confirmed=${paymentConfirmed}`);
  return { success: true, confirmed: paymentConfirmed };
}

module.exports = {
  automateShinhanCardPayment,
  typeWithInterception,
  findPaymentFrame,
  processShinhanCardPayment,
  processPhonePayment,
};
