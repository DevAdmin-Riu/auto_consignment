/**
 * 브라우저 관리 모듈
 * puppeteer-real-browser를 사용한 브라우저 인스턴스 관리
 *
 * 협력사별 브라우저 설정:
 * - 쿠팡: WAF 우회가 중요 (기본 설정)
 * - 성원애드피아: 팝업 허용 필요
 */

const { connect } = require("puppeteer-real-browser");

// 브라우저 인스턴스
let browserInstance = null;
let pageInstance = null;
let currentVendorKey = null; // 현재 브라우저가 어떤 협력사용인지 추적

// 로그인 상태 관리
const vendorLoginStatus = {};

// 딜레이 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 협력사별 브라우저 args 설정
 */
function getBrowserArgs(vendorKey) {
  // 기본 args (쿠팡 등 WAF가 엄격한 사이트용)
  const baseArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
  ];

  // 협력사별 추가 args
  const vendorArgs = {
    swadpia: [
      "--disable-popup-blocking", // 다음 주소 검색 팝업
      "--disable-notifications",
      // 로컬 네트워크 접근 권한 프롬프트 비활성화
      "--disable-features=PrivateNetworkAccessPermissionPrompt,PrivateNetworkAccessForNavigations,PrivateNetworkAccessForWorkers,PrivateNetworkAccessNonSecureContextsAllowed,LocalNetworkAccessCheck,DialMediaRouteProvider",
    ],
    adpia: ["--disable-popup-blocking", "--disable-notifications"],
  };

  const extraArgs = vendorArgs[vendorKey] || [];
  return [...baseArgs, ...extraArgs];
}

/**
 * 브라우저 시작 (Real Browser)
 * @param {string} vendorKey - 협력사 키 (coupang, swadpia 등)
 */
async function getBrowser(vendorKey = null) {
  // 다른 협력사용 브라우저가 이미 있으면 재사용 (args는 처음 연결 시에만 적용됨)
  // 단, 협력사가 바뀌면 로그를 남김
  if (
    browserInstance &&
    vendorKey &&
    currentVendorKey &&
    vendorKey !== currentVendorKey
  ) {
    console.log(
      `[브라우저] 협력사 변경: ${currentVendorKey} → ${vendorKey} (기존 브라우저 재사용)`
    );
  }

  if (!browserInstance) {
    console.log("Real Browser 연결 시작...");
    const isHeadless = process.env.HEADLESS === "true";
    console.log(`Headless 모드: ${isHeadless}`);

    const args = getBrowserArgs(vendorKey);
    console.log(`[브라우저] 협력사: ${vendorKey || "default"}, Args:`, args);

    const { browser, page } = await connect({
      headless: false,
      args,
      customConfig: {},
      connectOption: {
        defaultViewport: { width: 1920, height: 1080 },
      },
    });

    browserInstance = browser;
    pageInstance = page;
    currentVendorKey = vendorKey;
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
  currentVendorKey = null;
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
 * @param {string} vendorKey - 협력사 키
 */
async function recoverPage(vendorKey = null) {
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
  return await getBrowser(vendorKey);
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

/**
 * getPage - swadpia 호환용 alias
 * @param {object} options - { headless: boolean } (현재 무시됨)
 */
async function getPage(options = {}) {
  return await getBrowser("swadpia");
}

/**
 * closeBrowser - swadpia 호환용 alias
 */
async function closeBrowser() {
  return await resetBrowser();
}

module.exports = {
  getBrowser,
  resetBrowser,
  isPageValid,
  recoverPage,
  getLoginStatus,
  setLoginStatus,
  delay,
  // swadpia 호환용 alias
  getPage,
  closeBrowser,
};
