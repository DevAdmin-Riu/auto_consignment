/**
 * 쿠팡 송장번호 조회 모듈
 *
 * 주문번호로 쿠팡 주문목록에서 송장번호를 크롤링
 */

const { coupangLogin } = require("./login");
const { normalizeCarrier } = require("../../lib/carrier");
const {
  createTrackingErrorCollector,
  TRACKING_STEPS,
  ERROR_CODES,
} = require("../../lib/automation-error");

// 딜레이 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 쿠팡 송장번호 조회
 * @param {Page} page - Puppeteer 페이지
 * @param {Object} vendor - 쿠팡 협력사 설정
 * @param {string[]} openMallOrderNumbers - 조회할 오픈몰 주문번호 배열
 * @returns {Array} 조회 결과 배열 [{ openMallOrderNumber, trackingNumber, carrier }, ...]
 */
async function getCoupangTrackingNumbers(page, vendor, openMallOrderNumbers) {
  console.log(`[coupang 송장조회] 시작: ${openMallOrderNumbers.length}건`);

  const results = [];
  const errorCollector = createTrackingErrorCollector("coupang");

  try {
    // 1. 로그인 확인/처리
    await coupangLogin(page, vendor);
    console.log("[coupang 송장조회] 로그인 완료");

    // 2. 각 주문번호에 대해 송장번호 조회
    for (const openMallOrderNumber of openMallOrderNumbers) {
      try {
        console.log(`[coupang 송장조회] 주문번호 ${openMallOrderNumber} 검색 중...`);

        const trackingInfo = await findTrackingNumber(page, openMallOrderNumber);

        if (trackingInfo?.trackingNumber) {
          const carrier = normalizeCarrier(trackingInfo.carrier);
          results.push({
            openMallOrderNumber,
            trackingNumber: trackingInfo.trackingNumber,
            carrier,
          });
          console.log(`[coupang 송장조회] ${openMallOrderNumber} → ${trackingInfo.trackingNumber} (${carrier})`);
        } else {
          console.log(`[coupang 송장조회] ${openMallOrderNumber} → 송장번호 없음`);
        }
      } catch (error) {
        console.error(`[coupang 송장조회] ${openMallOrderNumber} 에러:`, error.message);
        errorCollector.addError(TRACKING_STEPS.EXTRACTION, ERROR_CODES.EXTRACTION_FAILED, error.message, { openMallOrderNumber });
      }
    }

    return {
      results,
      automationErrors: errorCollector.hasErrors() ? errorCollector.getErrors() : undefined,
    };
  } catch (error) {
    console.error("[coupang 송장조회] 전체 에러:", error);
    errorCollector.addError(TRACKING_STEPS.LOGIN, ERROR_CODES.LOGIN_FAILED, error.message);
    return {
      results,
      automationErrors: errorCollector.hasErrors() ? errorCollector.getErrors() : undefined,
    };
  }
}

// 셀렉터 상수 (클래스 제거하고 구조로만 찾기)
const SELECTORS = {
  // 배송 조회 버튼
  deliveryTrackingBtn: '#__next > div.my-area-body > div.my-area-contents > div > div > table > tbody > tr > td > div > button',
  // 배송 정보 테이블 기본 경로
  deliveryTableBase: '#__next > div.my-area-body > div.my-area-contents > div > table > tbody > tr > td > table > tbody',
};

/**
 * 주문 상세 페이지에서 송장번호 조회
 * @param {Page} page - Puppeteer 페이지
 * @param {string} openMallOrderNumber - 오픈몰 주문번호
 * @returns {Object|null} 송장 정보 또는 null
 */
async function findTrackingNumber(page, openMallOrderNumber) {
  try {
    // 1. 주문 상세 페이지로 이동
    const orderUrl = `https://mc.coupang.com/ssr/desktop/order/${openMallOrderNumber}`;
    console.log(`[coupang 송장조회] 주문 페이지 이동: ${orderUrl}`);

    await page.goto(orderUrl, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await delay(2000);

    // 2. 배송 조회 버튼 클릭
    const deliveryBtn = await page.$(SELECTORS.deliveryTrackingBtn);
    if (!deliveryBtn) {
      console.log(`[coupang 송장조회] ${openMallOrderNumber}: 배송 조회 버튼 없음`);
      return { trackingNumber: null, carrier: null, status: "no_delivery_button" };
    }

    await deliveryBtn.click();
    console.log(`[coupang 송장조회] 배송 조회 버튼 클릭`);
    await delay(2000);

    // 3. 배송 정보 추출 (라벨 기반으로 찾기)
    const trackingInfo = await page.evaluate((baseSelector) => {
      const tbody = document.querySelector(baseSelector);
      if (!tbody) return null;

      let carrier = null;
      let trackingNumber = null;

      // 로켓배송 여부 확인 (중첩 테이블 구조)
      const allText = tbody.textContent || '';
      const isRocketDelivery = allText.includes('로켓배송');

      if (isRocketDelivery) {
        // 로켓배송: 중첩된 테이블에서 송장번호 찾기
        carrier = '로켓배송';
        const allRows = tbody.querySelectorAll('tr');
        for (const row of allRows) {
          const cells = row.querySelectorAll('td');
          for (let i = 0; i < cells.length - 1; i++) {
            const label = cells[i].textContent?.trim() || '';
            const value = cells[i + 1].textContent?.trim() || '';
            if (label.includes('송장')) {
              if (value && /^[\d-]+$/.test(value) && value.length >= 10) {
                trackingNumber = value.replace(/-/g, '');
                break;
              }
            }
          }
          if (trackingNumber) break;
        }
      } else {
        // 일반배송: 기존 로직
        const rows = tbody.querySelectorAll(':scope > tr');
        for (const row of rows) {
          const labelCell = row.querySelector('td:first-child');
          const valueCell = row.querySelector('td:last-child');

          if (!labelCell || !valueCell) continue;

          const label = labelCell.textContent?.trim() || '';
          const value = valueCell.textContent?.trim() || '';

          // 택배사 찾기
          if (label.includes('택배사') || label.includes('배송사')) {
            carrier = value;
          }

          // 송장번호 찾기 (라벨에 "송장" 포함)
          if (label.includes('송장')) {
            if (value && /^[\d-]+$/.test(value) && value.length >= 10) {
              trackingNumber = value.replace(/-/g, '');
            }
          }
        }
      }

      return { carrier, trackingNumber, isRocketDelivery };
    }, SELECTORS.deliveryTableBase);

    if (trackingInfo?.trackingNumber) {
      const deliveryType = trackingInfo.isRocketDelivery ? '[로켓]' : '[일반]';
      console.log(`[coupang 송장조회] ${deliveryType} 찾음: ${trackingInfo.carrier} / ${trackingInfo.trackingNumber}`);
      return {
        trackingNumber: trackingInfo.trackingNumber,
        carrier: trackingInfo.carrier || "알 수 없음",
        status: "found",
      };
    }

    console.log(`[coupang 송장조회] ${openMallOrderNumber}: 송장번호 없음`);
    return { trackingNumber: null, carrier: null, status: "tracking_not_found" };
  } catch (error) {
    console.error(`[coupang 송장조회] ${openMallOrderNumber} 조회 실패:`, error.message);
    return { trackingNumber: null, carrier: null, status: "error", error: error.message };
  }
}

module.exports = {
  getCoupangTrackingNumbers,
  findTrackingNumber,
};
