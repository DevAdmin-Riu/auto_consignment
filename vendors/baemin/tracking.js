/**
 * 배민상회 송장번호 조회 모듈
 *
 * 흐름:
 * 1. 로그인 (baemin/order.js의 loginToBaemin 사용)
 * 2. 주문 상세 페이지 이동 (mart.baemin.com/orders/{주문번호})
 * 3. 배송 정보에서 송장번호 추출
 */

const { loginToBaemin } = require("./order");
const { normalizeCarrier } = require("../../lib/carrier");
const {
  createTrackingErrorCollector,
  TRACKING_STEPS,
  ERROR_CODES,
} = require("../../lib/automation-error");
const { safeGoto } = require("../../lib/browser");

// 딜레이 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 셀렉터 상수
const SELECTORS = {
  // 배송조회 버튼 (data 속성으로 찾기 - styled-components 클래스보다 안정적)
  deliveryTrackingBtn:
    'button[data-action-button-click-event-label="배송조회"]',
};

/**
 * 배민상회 송장번호 조회
 * @param {Page} page - Puppeteer 페이지
 * @param {Object} vendor - 배민상회 협력사 설정
 * @param {string[]} openMallOrderNumbers - 조회할 오픈몰 주문번호 배열
 * @returns {Array} 조회 결과 배열 [{ openMallOrderNumber, trackingNumber, carrier }, ...]
 */
async function getBaeminTrackingNumbers(page, vendor, openMallOrderNumbers) {
  console.log(`[baemin 송장조회] 시작: ${openMallOrderNumbers.length}건`);

  const errorCollector = createTrackingErrorCollector("baemin");
  const results = [];

  try {
    // 1. 로그인 확인/처리
    const loginResult = await loginToBaemin(page, vendor);
    if (!loginResult.success) {
      console.log("[baemin 송장조회] 로그인 실패:", loginResult.message);
      errorCollector.addError(
        TRACKING_STEPS.LOGIN,
        ERROR_CODES.LOGIN_FAILED,
        loginResult.message,
      );
      return {
        results,
        automationErrors: errorCollector.getErrors(),
      };
    }
    console.log("[baemin 송장조회] 로그인 완료");

    // 2. 각 주문번호에 대해 조회
    for (const openMallOrderNumber of openMallOrderNumbers) {
      try {
        console.log(
          `[baemin 송장조회] 주문번호 ${openMallOrderNumber} 조회 중...`,
        );

        // 주문 상세 페이지로 이동
        // 배민상회 주문 상세 URL 패턴: https://mart.baemin.com/mymart/order/detail/{주문번호}
        const orderDetailUrl = `https://mart.baemin.com/mymart/order/detail/${openMallOrderNumber}`;
        await safeGoto(page, orderDetailUrl, { timeout: 30000 });
        await delay(2000);

        // 현재 URL 확인 (로그인 리다이렉트 등)
        const currentUrl = page.url();
        console.log(`[baemin 송장조회] 현재 URL: ${currentUrl}`);

        // 배송조회 버튼 찾기
        let deliveryBtn = await page.$(SELECTORS.deliveryTrackingBtn);

        // 셀렉터로 못찾으면 텍스트로 폴백
        if (!deliveryBtn) {
          console.log(
            `[baemin 송장조회] 셀렉터로 버튼 못찾음, 텍스트로 검색...`,
          );
          deliveryBtn = await page.evaluateHandle(() => {
            const buttons = document.querySelectorAll("button");
            for (const btn of buttons) {
              const text = (btn.innerText || btn.textContent || "").trim();
              if (text.includes("배송조회")) {
                return btn;
              }
            }
            return null;
          });

          // evaluateHandle 결과가 null이면 버튼 없음
          const btnValue = await deliveryBtn.jsonValue();
          if (!btnValue) {
            deliveryBtn = null;
          }
        }

        if (!deliveryBtn) {
          console.log(
            `[baemin 송장조회] ${openMallOrderNumber}: 배송조회 버튼 없음 (아직 배송 전)`,
          );
          continue;
        }

        // 배송조회 버튼 클릭
        await deliveryBtn.click();
        console.log(
          `[baemin 송장조회] ${openMallOrderNumber}: 배송조회 버튼 클릭`,
        );
        await delay(2000);

        // 모달에서 송장번호, 택배사 추출
        // 패턴: "롯데택배 운송장번호: 260798121124"
        const trackingInfo = await page.evaluate(() => {
          const allText = document.body.innerText || "";

          // "택배사 운송장번호: 숫자" 패턴 찾기
          // 예: "롯데택배 운송장번호: 260798121124"
          const combinedPattern =
            /(CJ대한통운|대한통운|로켓배송|롯데택배|한진택배|로젠택배|우체국택배|경동택배|합동택배|천일택배|건영택배|일양로지스|대신택배|롯데|대신)\s*운송장번호[:\s]*(\d{10,14})/;
          const combinedMatch = allText.match(combinedPattern);

          if (combinedMatch) {
            return {
              carrier: combinedMatch[1],
              trackingNumber: combinedMatch[2],
              pageText: null,
            };
          }

          // 폴백: 개별 패턴으로 찾기
          const trackingPatterns = [
            /운송장번호[:\s]*(\d{10,14})/,
            /송장번호[:\s]*(\d{10,14})/,
            /송장\s*:\s*(\d{10,14})/,
          ];

          let trackingNumber = null;
          for (const pattern of trackingPatterns) {
            const match = allText.match(pattern);
            if (match) {
              trackingNumber = match[1];
              break;
            }
          }

          // 택배사 찾기
          const carrierPatterns = [
            /(CJ대한통운|대한통운|롯데택배|한진택배|로젠택배|우체국택배|경동택배|합동택배|천일택배|건영택배|일양로지스|대신택배|롯데|대신)/,
          ];

          let carrier = null;
          for (const pattern of carrierPatterns) {
            const match = allText.match(pattern);
            if (match) {
              carrier = match[1];
              break;
            }
          }

          return {
            trackingNumber,
            carrier,
            pageText: allText.substring(0, 1000),
          };
        });

        console.log(
          `[baemin 송장조회] ${openMallOrderNumber} 추출 결과:`,
          JSON.stringify({
            trackingNumber: trackingInfo.trackingNumber,
            carrier: trackingInfo.carrier,
          }),
        );

        if (trackingInfo.trackingNumber) {
          const normalizedCarrier = normalizeCarrier(trackingInfo.carrier);

          results.push({
            openMallOrderNumber,
            trackingNumber: trackingInfo.trackingNumber,
            carrier: normalizedCarrier || trackingInfo.carrier || "알수없음",
          });
          console.log(
            `[baemin 송장조회] ${openMallOrderNumber} → ${trackingInfo.trackingNumber} (${normalizedCarrier || trackingInfo.carrier})`,
          );
        } else {
          console.log(
            `[baemin 송장조회] ${openMallOrderNumber}: 송장번호를 찾을 수 없음`,
          );

          if (trackingInfo.pageText) {
            console.log(
              `[baemin 송장조회] 페이지 텍스트: ${trackingInfo.pageText.substring(0, 300)}...`,
            );
          }
        }

        // 다음 조회 전 딜레이
        await delay(1000);
      } catch (error) {
        console.error(
          `[baemin 송장조회] ${openMallOrderNumber} 에러:`,
          error.message,
        );
        errorCollector.addError(
          TRACKING_STEPS.EXTRACTION,
          ERROR_CODES.EXTRACTION_FAILED,
          error.message,
          { openMallOrderNumber },
        );
      }
    }

    console.log(
      `[baemin 송장조회] 완료: ${results.length}/${openMallOrderNumbers.length}건 조회됨`,
    );
    return {
      results,
      automationErrors: errorCollector.hasErrors()
        ? errorCollector.getErrors()
        : undefined,
    };
  } catch (error) {
    console.error("[baemin 송장조회] 전체 에러:", error);
    errorCollector.addError(
      TRACKING_STEPS.EXTRACTION,
      ERROR_CODES.EXTRACTION_FAILED,
      error.message,
    );
    return {
      results,
      automationErrors: errorCollector.getErrors(),
    };
  }
}

module.exports = {
  getBaeminTrackingNumbers,
};
