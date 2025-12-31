/**
 * 배민상회 송장번호 조회 모듈
 *
 * 흐름:
 * 1. 로그인 (baemin/order.js의 loginToBaemin 사용)
 * 2. 주문 상세 페이지 이동 (mart.baemin.com/orders/{주문번호})
 * 3. 배송 정보에서 송장번호 추출
 */

const { loginToBaemin } = require("./order");

// 딜레이 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 택배사명 정규화
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
  };

  if (mappings[normalized]) {
    normalized = mappings[normalized];
  }

  return normalized;
}

/**
 * 배민상회 송장번호 조회
 * @param {Page} page - Puppeteer 페이지
 * @param {Object} vendor - 배민상회 협력사 설정
 * @param {string[]} openMallOrderNumbers - 조회할 오픈몰 주문번호 배열
 * @returns {Array} 조회 결과 배열 [{ openMallOrderNumber, trackingNumber, carrier }, ...]
 */
async function getBaeminTrackingNumbers(page, vendor, openMallOrderNumbers) {
  console.log(`[baemin 송장조회] 시작: ${openMallOrderNumbers.length}건`);

  const results = [];

  try {
    // 1. 로그인 확인/처리
    const loginResult = await loginToBaemin(page, vendor);
    if (!loginResult.success) {
      console.log("[baemin 송장조회] 로그인 실패:", loginResult.message);
      return results;
    }
    console.log("[baemin 송장조회] 로그인 완료");

    // 2. 각 주문번호에 대해 조회
    for (const openMallOrderNumber of openMallOrderNumbers) {
      try {
        console.log(
          `[baemin 송장조회] 주문번호 ${openMallOrderNumber} 조회 중...`
        );

        // 주문 상세 페이지로 이동
        // 배민상회 주문 상세 URL 패턴: https://mart.baemin.com/orders/{주문번호}
        const orderDetailUrl = `https://mart.baemin.com/orders/${openMallOrderNumber}`;
        await page.goto(orderDetailUrl, {
          waitUntil: "networkidle2",
          timeout: 30000,
        });
        await delay(2000);

        // 현재 URL 확인 (로그인 리다이렉트 등)
        const currentUrl = page.url();
        console.log(`[baemin 송장조회] 현재 URL: ${currentUrl}`);

        // 페이지에서 배송 정보 추출
        const trackingInfo = await page.evaluate(() => {
          // 방법 1: 배송조회 버튼 또는 송장번호 텍스트 찾기
          const allText = document.body.innerText || "";

          // 송장번호 패턴 찾기 (숫자 10-14자리)
          const trackingPatterns = [
            /송장번호[:\s]*(\d{10,14})/,
            /운송장[:\s]*(\d{10,14})/,
            /배송조회[:\s]*(\d{10,14})/,
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
            /(CJ대한통운|대한통운|롯데택배|한진택배|로젠택배|우체국택배|경동택배)/,
          ];

          let carrier = null;
          for (const pattern of carrierPatterns) {
            const match = allText.match(pattern);
            if (match) {
              carrier = match[1];
              break;
            }
          }

          // 배송 상태 텍스트 찾기
          const statusPatterns = [
            /배송중/,
            /배송완료/,
            /배송준비중/,
          ];
          let hasDeliveryStatus = false;
          for (const pattern of statusPatterns) {
            if (pattern.test(allText)) {
              hasDeliveryStatus = true;
              break;
            }
          }

          return {
            trackingNumber,
            carrier,
            hasDeliveryStatus,
            pageText: allText.substring(0, 500), // 디버깅용
          };
        });

        console.log(
          `[baemin 송장조회] ${openMallOrderNumber} 추출 결과:`,
          JSON.stringify({
            trackingNumber: trackingInfo.trackingNumber,
            carrier: trackingInfo.carrier,
            hasDeliveryStatus: trackingInfo.hasDeliveryStatus,
          })
        );

        if (trackingInfo.trackingNumber) {
          const normalizedCarrier = normalizeCarrier(trackingInfo.carrier);

          results.push({
            openMallOrderNumber,
            trackingNumber: trackingInfo.trackingNumber,
            carrier: normalizedCarrier || trackingInfo.carrier || "알수없음",
          });
          console.log(
            `[baemin 송장조회] ${openMallOrderNumber} → ${trackingInfo.trackingNumber} (${normalizedCarrier || trackingInfo.carrier})`
          );
        } else {
          console.log(
            `[baemin 송장조회] ${openMallOrderNumber}: 송장번호를 찾을 수 없음`
          );

          // 디버깅: 페이지 텍스트 일부 출력
          if (trackingInfo.pageText) {
            console.log(
              `[baemin 송장조회] 페이지 텍스트: ${trackingInfo.pageText.substring(0, 200)}...`
            );
          }
        }

        // 다음 조회 전 딜레이
        await delay(1000);
      } catch (error) {
        console.error(
          `[baemin 송장조회] ${openMallOrderNumber} 에러:`,
          error.message
        );
      }
    }

    console.log(
      `[baemin 송장조회] 완료: ${results.length}/${openMallOrderNumbers.length}건 조회됨`
    );
    return results;
  } catch (error) {
    console.error("[baemin 송장조회] 전체 에러:", error);
    return results;
  }
}

module.exports = {
  getBaeminTrackingNumbers,
};
