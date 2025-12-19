/**
 * 쿠팡 송장번호 조회 모듈
 *
 * 주문번호로 쿠팡 주문목록에서 송장번호를 크롤링
 */

const { coupangLogin } = require("./login");

// 딜레이 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 쿠팡 송장번호 조회
 * @param {Page} page - Puppeteer 페이지
 * @param {Object} vendor - 쿠팡 협력사 설정
 * @param {string[]} orderNumbers - 조회할 주문번호 배열
 * @returns {Object} 조회 결과
 */
async function getCoupangTrackingNumbers(page, vendor, orderNumbers) {
  console.log(`[송장조회] 시작: ${orderNumbers.length}건`);

  const results = [];
  const errors = [];

  try {
    // 1. 로그인 확인/처리
    await coupangLogin(page, vendor);
    console.log("[송장조회] 로그인 완료");

    // 2. 주문목록 페이지로 이동
    const orderListUrl = "https://www.coupang.com/np/orders";
    await page.goto(orderListUrl, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    console.log("[송장조회] 주문목록 페이지 이동");

    await delay(2000);

    // 3. 각 주문번호에 대해 송장번호 조회
    for (const orderNumber of orderNumbers) {
      try {
        console.log(`[송장조회] 주문번호 ${orderNumber} 검색 중...`);

        const trackingInfo = await findTrackingNumber(page, orderNumber);

        if (trackingInfo) {
          results.push({
            orderNumber,
            trackingNumber: trackingInfo.trackingNumber,
            carrier: trackingInfo.carrier,
            status: trackingInfo.status,
            found: true,
          });
          console.log(`[송장조회] ${orderNumber} → ${trackingInfo.trackingNumber} (${trackingInfo.carrier})`);
        } else {
          results.push({
            orderNumber,
            trackingNumber: null,
            carrier: null,
            status: "not_found",
            found: false,
          });
          console.log(`[송장조회] ${orderNumber} → 송장번호 없음`);
        }
      } catch (error) {
        console.error(`[송장조회] ${orderNumber} 에러:`, error.message);
        errors.push({
          orderNumber,
          error: error.message,
        });
        results.push({
          orderNumber,
          trackingNumber: null,
          carrier: null,
          status: "error",
          found: false,
          error: error.message,
        });
      }
    }

    return {
      success: true,
      totalRequested: orderNumbers.length,
      totalFound: results.filter(r => r.found).length,
      results,
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (error) {
    console.error("[송장조회] 전체 에러:", error);
    return {
      success: false,
      error: error.message,
      results,
      errors,
    };
  }
}

/**
 * 주문목록에서 특정 주문번호의 송장번호 찾기
 * @param {Page} page - Puppeteer 페이지
 * @param {string} orderNumber - 주문번호
 * @returns {Object|null} 송장 정보 또는 null
 */
async function findTrackingNumber(page, orderNumber) {
  // 주문목록 페이지에서 주문번호 검색
  // 쿠팡 주문목록 구조에 따라 셀렉터 조정 필요

  // 방법 1: 주문목록에서 직접 검색
  const trackingInfo = await page.evaluate((targetOrderNumber) => {
    // 주문 카드들을 순회
    const orderCards = document.querySelectorAll(".order-list__item, [class*='order-item'], [class*='OrderItem']");

    for (const card of orderCards) {
      const cardText = card.textContent || "";

      // 주문번호가 포함된 카드 찾기
      if (cardText.includes(targetOrderNumber)) {
        // 송장번호 찾기 (다양한 패턴 시도)
        // 패턴 1: "송장번호: XXXXX" 또는 "운송장번호: XXXXX"
        const trackingMatch = cardText.match(/(?:송장|운송장)\s*(?:번호)?\s*[:\s]*(\d{10,15})/);

        // 패턴 2: 배송사 + 송장번호
        const carrierMatch = cardText.match(/(CJ대한통운|한진택배|롯데택배|우체국택배|로젠택배|쿠팡로켓)/);

        if (trackingMatch) {
          return {
            trackingNumber: trackingMatch[1],
            carrier: carrierMatch ? carrierMatch[1] : "알 수 없음",
            status: "found",
          };
        }

        // 배송 상태 확인
        if (cardText.includes("배송완료")) {
          return { trackingNumber: null, carrier: null, status: "delivered_no_tracking" };
        }
        if (cardText.includes("배송중")) {
          return { trackingNumber: null, carrier: null, status: "shipping_no_tracking" };
        }
        if (cardText.includes("상품준비중")) {
          return { trackingNumber: null, carrier: null, status: "preparing" };
        }

        return { trackingNumber: null, carrier: null, status: "order_found_no_tracking" };
      }
    }

    return null;
  }, orderNumber);

  if (trackingInfo) {
    return trackingInfo;
  }

  // 방법 2: 주문 상세 페이지로 이동해서 조회
  // 주문목록에서 못 찾으면 상세 페이지 시도
  try {
    const detailUrl = `https://www.coupang.com/np/orders/detail?orderId=${orderNumber}`;
    await page.goto(detailUrl, {
      waitUntil: "networkidle2",
      timeout: 15000,
    });

    await delay(1500);

    const detailTrackingInfo = await page.evaluate(() => {
      const pageText = document.body.textContent || "";

      // 송장번호 패턴 검색
      const trackingMatch = pageText.match(/(?:송장|운송장)\s*(?:번호)?\s*[:\s]*(\d{10,15})/);
      const carrierMatch = pageText.match(/(CJ대한통운|한진택배|롯데택배|우체국택배|로젠택배|쿠팡로켓)/);

      if (trackingMatch) {
        return {
          trackingNumber: trackingMatch[1],
          carrier: carrierMatch ? carrierMatch[1] : "알 수 없음",
          status: "found",
        };
      }

      // 배송 상태 확인
      if (pageText.includes("배송완료")) {
        return { trackingNumber: null, carrier: null, status: "delivered_no_tracking" };
      }
      if (pageText.includes("배송중")) {
        return { trackingNumber: null, carrier: null, status: "shipping_no_tracking" };
      }

      return null;
    });

    // 주문목록 페이지로 복귀
    await page.goto("https://www.coupang.com/np/orders", {
      waitUntil: "networkidle2",
      timeout: 15000,
    });

    return detailTrackingInfo;
  } catch (error) {
    console.error(`[송장조회] 상세페이지 조회 실패 (${orderNumber}):`, error.message);
    return null;
  }
}

module.exports = {
  getCoupangTrackingNumbers,
  findTrackingNumber,
};
