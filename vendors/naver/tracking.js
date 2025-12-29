/**
 * 네이버 스마트스토어 송장번호 조회 모듈
 *
 * 흐름:
 * 1. 로그인
 * 2. 주문 상태 페이지 이동 (orders.pay.naver.com/order/status/{주문번호})
 * 3. 배송조회 버튼 확인 (없으면 아직 배송중 아님)
 * 4. 배송조회 버튼 클릭
 * 5. 택배사, 송장번호 추출
 */

const { login } = require("./login");

// 딜레이 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 택배사명 정규화 (띄어쓰기 제거 후 매핑)
function normalizeCarrier(carrier) {
  if (!carrier) return null;

  // 띄어쓰기 제거
  let normalized = carrier.replace(/\s+/g, "");

  // 택배사 매핑
  const mappings = {
    CJ대한통운: "CJ대한통운",
    대한통운: "CJ대한통운",
    CJ: "CJ대한통운",
    롯데택배: "롯데택배",
    롯데: "롯데택배",
    한진택배: "한진택배",
    한진: "한진택배",
    로젠택배: "로젠택배",
    로젠: "로젠택배",
    우체국택배: "우체국택배",
    우체국: "우체국택배",
    경동택배: "경동택배",
    경동: "경동택배",
    합동택배: "합동택배",
    합동: "합동택배",
    천일택배: "천일택배",
    천일: "천일택배",
    건영택배: "건영택배",
    건영: "건영택배",
    일양로지스: "일양로지스",
    일양: "일양로지스",
    CVSnet편의점택배: "CVSnet편의점택배",
    편의점택배: "CVSnet편의점택배",
    GS편의점택배: "GS편의점택배",
    GS: "GS편의점택배",
    CU편의점택배: "CU편의점택배",
    CU: "CU편의점택배",
  };

  // 정규화된 이름으로 매핑
  if (mappings[normalized]) {
    normalized = mappings[normalized];
  }

  return normalized;
}

// 셀렉터 상수
const SELECTORS = {
  // 주문 상태 페이지
  orderStatus: {
    // 배송조회 버튼 (data-nlog-click-code="trackDelivery" 로 찾기)
    trackDeliveryBtn: 'button[data-nlog-click-code="trackDelivery"]',
    // 대체 셀렉터
    trackDeliveryBtnAlt:
      "#content > div > div:nth-child(4) > div.ContentWrapper_article__Bg6i8.ContentWrapper_bg-white__lpLoa > ul > li > ul > li > div.AssignmentButtonGroup_section-button__-QunD > div > div:nth-child(1) > button",
  },
  // 배송 추적 페이지
  deliveryTracking: {
    // 택배사
    carrier:
      "#content > div > div > div.DeliveryTracking_article__NOWG\\+ > div.Courier_article__hcV7i > span.Courier_company__WpuEg",
    carrierAlt: "span.Courier_company__WpuEg",
    // 송장번호
    trackingNumber:
      "#content > div > div > div.DeliveryTracking_article__NOWG\\+ > div.Courier_article__hcV7i > span.Courier_number__5MVoy",
    trackingNumberAlt: "span.Courier_number__5MVoy",
  },
};

/**
 * 네이버 송장번호 조회
 * @param {Page} page - Puppeteer 페이지
 * @param {Object} vendor - 네이버 협력사 설정
 * @param {string[]} openMallOrderNumbers - 조회할 오픈몰 주문번호 배열
 * @returns {Array} 조회 결과 배열 [{ openMallOrderNumber, trackingNumber, carrier }, ...]
 */
async function getNaverTrackingNumbers(page, vendor, openMallOrderNumbers) {
  console.log(`[naver 송장조회] 시작: ${openMallOrderNumbers.length}건`);

  const results = [];

  try {
    // 1. 로그인 확인/처리
    await login(page, vendor);
    console.log("[naver 송장조회] 로그인 완료");

    // 2. 각 주문번호에 대해 조회
    for (const openMallOrderNumber of openMallOrderNumbers) {
      try {
        console.log(
          `[naver 송장조회] 주문번호 ${openMallOrderNumber} 조회 중...`
        );

        // 주문 상태 페이지로 이동
        const orderStatusUrl = `https://orders.pay.naver.com/order/status/${openMallOrderNumber}`;
        await page.goto(orderStatusUrl, {
          waitUntil: "networkidle2",
          timeout: 30000,
        });
        await delay(2000);

        // 배송조회 버튼 찾기
        let trackBtn = await page.$(SELECTORS.orderStatus.trackDeliveryBtn);
        if (!trackBtn) {
          trackBtn = await page.$(SELECTORS.orderStatus.trackDeliveryBtnAlt);
        }

        if (!trackBtn) {
          console.log(
            `[naver 송장조회] ${openMallOrderNumber}: 배송조회 버튼 없음 (아직 배송 전)`
          );
          continue;
        }

        // 버튼 텍스트 확인 ("배송조회" 문구가 있는지)
        const btnText = await page.evaluate((btn) => {
          return btn.textContent?.trim() || "";
        }, trackBtn);

        if (!btnText.includes("배송조회")) {
          console.log(
            `[naver 송장조회] ${openMallOrderNumber}: 버튼 텍스트가 "배송조회"가 아님 (${btnText})`
          );
          continue;
        }

        // 배송조회 버튼 클릭
        await trackBtn.click();
        console.log(`[naver 송장조회] ${openMallOrderNumber}: 배송조회 클릭`);
        await delay(2000);

        // 택배사 추출
        let carrier = null;
        try {
          carrier = await page.$eval(
            SELECTORS.deliveryTracking.carrier,
            (el) => el.textContent?.trim() || ""
          );
        } catch (e) {
          try {
            carrier = await page.$eval(
              SELECTORS.deliveryTracking.carrierAlt,
              (el) => el.textContent?.trim() || ""
            );
          } catch (e2) {
            console.log(
              `[naver 송장조회] ${openMallOrderNumber}: 택배사 추출 실패`
            );
          }
        }

        // 송장번호 추출
        let trackingNumber = null;
        try {
          trackingNumber = await page.$eval(
            SELECTORS.deliveryTracking.trackingNumber,
            (el) => el.textContent?.trim() || ""
          );
        } catch (e) {
          try {
            trackingNumber = await page.$eval(
              SELECTORS.deliveryTracking.trackingNumberAlt,
              (el) => el.textContent?.trim() || ""
            );
          } catch (e2) {
            console.log(
              `[naver 송장조회] ${openMallOrderNumber}: 송장번호 추출 실패`
            );
          }
        }

        if (trackingNumber) {
          // 택배사 정규화
          const normalizedCarrier = normalizeCarrier(carrier);

          results.push({
            openMallOrderNumber,
            trackingNumber,
            carrier: normalizedCarrier || carrier,
          });
          console.log(
            `[naver 송장조회] ${openMallOrderNumber} → ${trackingNumber} (${normalizedCarrier || carrier})`
          );
        } else {
          console.log(
            `[naver 송장조회] ${openMallOrderNumber}: 송장번호를 찾을 수 없음`
          );
        }

        // 다음 조회 전 딜레이
        await delay(1000);
      } catch (error) {
        console.error(
          `[naver 송장조회] ${openMallOrderNumber} 에러:`,
          error.message
        );
      }
    }

    console.log(
      `[naver 송장조회] 완료: ${results.length}/${openMallOrderNumbers.length}건 조회됨`
    );
    return results;
  } catch (error) {
    console.error("[naver 송장조회] 전체 에러:", error);
    return results;
  }
}

module.exports = {
  getNaverTrackingNumbers,
};
