/**
 * 브라우저 관리 모듈
 * puppeteer-real-browser 사용 (봇 감지 우회)
 *
 * 주의: dotenv는 브라우저 연결 후에 로드해야 함 (충돌 방지)
 */

const { connect } = require("puppeteer-real-browser");
const fs = require("fs");
const path = require("path");

// .env 수동 파싱 (dotenv 대체)
function loadEnv() {
  try {
    const envPath = path.join(__dirname, "..", ".env");
    const content = fs.readFileSync(envPath, "utf8");
    content.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex > 0) {
          const key = trimmed.slice(0, eqIndex).trim();
          const value = trimmed.slice(eqIndex + 1).trim();
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }
    });
  } catch (e) {
    // .env 파일 없으면 무시
  }
}

// 브라우저 인스턴스
let browserInstance = null;
let pageInstance = null;

// 로그인 상태 관리
const vendorLoginStatus = {};

// 딜레이 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 브라우저 연결 상태 확인
 */
async function isBrowserConnected() {
  if (!browserInstance) return false;
  try {
    // 브라우저가 연결되어 있는지 확인
    const pages = await browserInstance.pages();
    return pages.length >= 0; // 연결되어 있으면 배열 반환
  } catch (e) {
    console.log("[브라우저] 연결 끊김 감지:", e.message);
    return false;
  }
}

/**
 * 브라우저 시작 (puppeteer-real-browser)
 */
async function getBrowser() {
  // 브라우저 연결 상태 확인
  if (browserInstance && !(await isBrowserConnected())) {
    console.log("[브라우저] 연결 끊김 - 재시작 필요");
    browserInstance = null;
    pageInstance = null;
  }

  if (!browserInstance) {
    console.log("브라우저 시작...");
    const isHeadless = process.env.HEADLESS === "true";
    console.log(`Headless 모드: ${isHeadless}`);

    const { browser, page } = await connect({
      headless: isHeadless,
      disableXvfb: true,
      args: [
        "--auto-open-devtools-for-tabs",
        "--disable-popup-blocking", // 팝업 차단 해제
        "--disable-notifications", // 알림 차단 해제
      ],
    });

    browserInstance = browser;
    pageInstance = page;

    await pageInstance.setViewport({ width: 1920, height: 1080 });
    console.log("브라우저 연결 완료!");

    // 브라우저 연결 후 env 로드
    loadEnv();

    // 브라우저 닫힘 이벤트 감지
    browserInstance.on("disconnected", () => {
      console.log("[브라우저] 연결 해제됨 - 인스턴스 초기화");
      browserInstance = null;
      pageInstance = null;
    });
  }
  return { browser: browserInstance, page: pageInstance };
}

/**
 * 브라우저 초기화
 */
async function resetBrowser() {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (e) {
      // 이미 닫혀있을 수 있음
    }
  }
  browserInstance = null;
  pageInstance = null;
  // 로그인 상태 초기화
  Object.keys(vendorLoginStatus).forEach(
    (key) => delete vendorLoginStatus[key]
  );
}

/**
 * 페이지 유효성 검사
 */
async function isPageValid(page) {
  try {
    await page.evaluate(() => true);
    return true;
  } catch (e) {
    console.log("[페이지 검사] 페이지 무효:", e.message);
    return false;
  }
}

/**
 * 페이지 복구
 */
async function recoverPage() {
  console.log("[복구] 브라우저 재연결 시도...");

  if (browserInstance) {
    try {
      const pages = await browserInstance.pages();
      if (pages.length > 0) {
        for (const p of pages) {
          if (await isPageValid(p)) {
            pageInstance = p;
            console.log("[복구] 기존 페이지 재사용");
            return { browser: browserInstance, page: pageInstance };
          }
        }
        pageInstance = await browserInstance.newPage();
        console.log("[복구] 새 페이지 생성");
        return { browser: browserInstance, page: pageInstance };
      }
    } catch (e) {
      console.log("[복구] 브라우저 손상, 완전 재시작 필요:", e.message);
    }
  }

  await resetBrowser();
  return await getBrowser();
}

/**
 * 로그인 상태 조회/설정
 */
function getLoginStatus(vendorKey) {
  return vendorLoginStatus[vendorKey] || false;
}

function setLoginStatus(vendorKey, status) {
  vendorLoginStatus[vendorKey] = status;
}

module.exports = {
  getBrowser,
  resetBrowser,
  isPageValid,
  recoverPage,
  getLoginStatus,
  setLoginStatus,
  delay,
};
