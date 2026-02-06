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
    const result = execSync(
      `python "${TYPE_SCRIPT}" ${device} "${text}"`,
      { encoding: "utf8", timeout: 10000, windowsHide: true }
    );
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

module.exports = {
  automateShinhanCardPayment,
  typeWithInterception,
};
