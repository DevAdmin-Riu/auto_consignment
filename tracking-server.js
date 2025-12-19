/**
 * 송장번호 조회 서버
 *
 * - 포트: 3001
 * - 독립 브라우저 인스턴스 사용
 * - 쿠팡 주문목록에서 송장번호 크롤링
 */

const express = require("express");
const { connect } = require("puppeteer-real-browser");
const { VENDORS } = require("./vendors/config");
const { getCoupangTrackingNumbers } = require("./vendors/coupang/tracking");

const app = express();
app.use(express.json());

// 브라우저 인스턴스 (발주 서버와 독립)
let browserInstance = null;
let pageInstance = null;

// 딜레이 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 브라우저 시작
 */
async function getBrowser() {
  if (!browserInstance) {
    console.log("[tracking] 브라우저 연결 시작...");

    const { browser, page } = await connect({
      headless: false,
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
    console.log("[tracking] 브라우저 연결 완료!");
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
}

// ==================== API 엔드포인트 ====================

/**
 * 쿠팡 송장번호 조회
 * POST /api/tracking/coupang
 * Body: { orderNumbers: ["28100159951030", ...] }
 */
app.post("/api/tracking/coupang", async (req, res) => {
  try {
    const { orderNumbers } = req.body;

    if (!orderNumbers || !Array.isArray(orderNumbers) || orderNumbers.length === 0) {
      return res.status(400).json({
        success: false,
        error: "orderNumbers 배열이 필요합니다",
      });
    }

    console.log(`[tracking] 쿠팡 송장 조회 요청: ${orderNumbers.length}건`);

    const { browser, page } = await getBrowser();
    const vendor = VENDORS.coupang;

    const result = await getCoupangTrackingNumbers(page, vendor, orderNumbers);

    return res.json(result);
  } catch (error) {
    console.error("[tracking] 에러:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * 상태 확인
 */
app.get("/api/tracking/status", async (req, res) => {
  try {
    const hasBrowser = !!browserInstance;
    res.json({
      success: true,
      status: hasBrowser ? "ready" : "no_browser",
      service: "tracking",
      port: 3001,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 브라우저 리셋
 */
app.post("/api/tracking/reset", async (req, res) => {
  try {
    await resetBrowser();
    res.json({ success: true, message: "브라우저 리셋 완료" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== 서버 시작 ====================
const PORT = process.env.TRACKING_PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  송장번호 조회 서버 시작`);
  console.log(`  포트: ${PORT}`);
  console.log(`  API: POST /api/tracking/coupang`);
  console.log(`========================================\n`);
});
