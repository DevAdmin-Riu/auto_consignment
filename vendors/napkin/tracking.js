/**
 * 냅킨코리아 송장번호 조회 모듈
 *
 * 주문번호로 냅킨코리아 주문상세에서 송장번호를 크롤링
 */

const { loginToNapkin } = require("./order");
const { normalizeCarrier } = require("../../lib/carrier");
const {
  createTrackingErrorCollector,
  TRACKING_STEPS,
  ERROR_CODES,
} = require("../../lib/automation-error");

// 딜레이 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 셀렉터 상수
const SELECTORS = {
  // 택배사
  carrier: "#detailForm > div > div:nth-child(3) > div:nth-child(3) > table > tbody > tr:nth-child(1) > td:nth-child(6) > p:nth-child(2) > a",
  // 송장번호
  trackingNumber: "#detailForm > div > div:nth-child(3) > div:nth-child(3) > table > tbody > tr:nth-child(1) > td:nth-child(6) > p:nth-child(3) > a",
};

/**
 * 냅킨코리아 송장번호 조회
 * @param {Page} page - Puppeteer 페이지
 * @param {Object} vendor - 냅킨코리아 협력사 설정
 * @param {string[]} openMallOrderNumbers - 조회할 오픈몰 주문번호 배열
 * @returns {Array} 조회 결과 배열 [{ openMallOrderNumber, trackingNumber, carrier }, ...]
 */
async function getNapkinTrackingNumbers(page, vendor, openMallOrderNumbers) {
  console.log(`[napkin 송장조회] 시작: ${openMallOrderNumbers.length}건`);

  const errorCollector = createTrackingErrorCollector("napkin");
  const results = [];

  try {
    // 1. 로그인 확인/처리
    const loginResult = await loginToNapkin(page, vendor);
    if (!loginResult.success) {
      console.error("[napkin 송장조회] 로그인 실패:", loginResult.message);
      errorCollector.addError(TRACKING_STEPS.LOGIN, ERROR_CODES.LOGIN_FAILED, loginResult.message);
      return { results, automationErrors: errorCollector.getErrors() };
    }
    console.log("[napkin 송장조회] 로그인 완료");

    // 2. 각 주문번호에 대해 송장번호 조회
    for (const openMallOrderNumber of openMallOrderNumbers) {
      try {
        console.log(`[napkin 송장조회] 주문번호 ${openMallOrderNumber} 검색 중...`);

        const trackingInfo = await findTrackingNumber(page, openMallOrderNumber);

        if (trackingInfo?.trackingNumber) {
          const carrier = normalizeCarrier(trackingInfo.carrier);
          results.push({
            openMallOrderNumber,
            trackingNumber: trackingInfo.trackingNumber,
            carrier,
          });
          console.log(`[napkin 송장조회] ${openMallOrderNumber} → ${trackingInfo.trackingNumber} (${carrier})`);
        } else {
          console.log(`[napkin 송장조회] ${openMallOrderNumber} → 송장번호 없음`);
        }
      } catch (error) {
        console.error(`[napkin 송장조회] ${openMallOrderNumber} 에러:`, error.message);
        errorCollector.addError(TRACKING_STEPS.EXTRACTION, ERROR_CODES.EXTRACTION_FAILED, error.message, { openMallOrderNumber });
      }
    }

    return { results, automationErrors: errorCollector.hasErrors() ? errorCollector.getErrors() : undefined };
  } catch (error) {
    console.error("[napkin 송장조회] 전체 에러:", error);
    errorCollector.addError(TRACKING_STEPS.EXTRACTION, ERROR_CODES.EXTRACTION_FAILED, error.message);
    return { results, automationErrors: errorCollector.hasErrors() ? errorCollector.getErrors() : undefined };
  }
}

/**
 * 주문 상세 페이지에서 송장번호 조회
 * @param {Page} page - Puppeteer 페이지
 * @param {string} openMallOrderNumber - 오픈몰 주문번호
 * @returns {Object|null} 송장 정보 또는 null
 */
async function findTrackingNumber(page, openMallOrderNumber) {
  try {
    // 1. 주문 상세 페이지로 이동
    const orderUrl = `https://www.napkinkorea.co.kr/myshop/order/detail.html?order_id=${openMallOrderNumber}&page=1`;
    console.log(`[napkin 송장조회] 주문 페이지 이동: ${orderUrl}`);

    await page.goto(orderUrl, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await delay(2000);

    // 2. 택배사 추출
    let carrier = null;
    try {
      carrier = await page.$eval(SELECTORS.carrier, (el) => el.textContent?.trim());
    } catch (e) {
      console.log(`[napkin 송장조회] ${openMallOrderNumber}: 택배사 정보 없음`);
    }

    // 3. 송장번호 추출
    let trackingNumber = null;
    try {
      trackingNumber = await page.$eval(SELECTORS.trackingNumber, (el) => el.textContent?.trim());
    } catch (e) {
      console.log(`[napkin 송장조회] ${openMallOrderNumber}: 송장번호 없음`);
    }

    // 자체배송인 경우 송장번호가 전화번호 형태일 수 있음
    if (carrier === "자체배송" && trackingNumber) {
      // 전화번호 형태 그대로 사용 (010-xxxx-xxxx 등)
      console.log(`[napkin 송장조회] 자체배송 - 연락처: ${trackingNumber}`);
    }

    if (trackingNumber) {
      console.log(`[napkin 송장조회] 찾음: ${carrier || "자체배송"} / ${trackingNumber}`);
      return {
        trackingNumber,
        carrier: carrier || "자체배송",
        status: "found",
      };
    }

    console.log(`[napkin 송장조회] ${openMallOrderNumber}: 송장번호 없음`);
    return { trackingNumber: null, carrier: null, status: "tracking_not_found" };
  } catch (error) {
    console.error(`[napkin 송장조회] ${openMallOrderNumber} 조회 실패:`, error.message);
    return null;
  }
}

module.exports = {
  getNapkinTrackingNumbers,
  findTrackingNumber,
};
