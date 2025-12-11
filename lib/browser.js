/**
 * 브라우저 관리 모듈
 * puppeteer-real-browser를 사용한 브라우저 인스턴스 관리
 */

const { connect } = require("puppeteer-real-browser");

// 브라우저 인스턴스
let browserInstance = null;
let pageInstance = null;

// 로그인 상태 관리
const vendorLoginStatus = {};

// 딜레이 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 브라우저 시작 (Real Browser)
 */
async function getBrowser() {
  if (!browserInstance) {
    console.log("Real Browser 연결 시작...");
    const isHeadless = process.env.HEADLESS === "true";
    console.log(`Headless 모드: ${isHeadless}`);
    const { browser, page } = await connect({
      headless: false,
      turnstile: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
      customConfig: {},
      connectOption: {
        defaultViewport: { width: 1920, height: 1080 },
      },
    });

    browserInstance = browser;
    pageInstance = page;
    console.log("Real Browser 연결 완료!");
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
