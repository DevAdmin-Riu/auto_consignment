/**
 * 애드피아몰 송장번호 조회 모듈
 *
 * - 주문 완료 목록에서 송장번호 추출
 * - 택배사 정보 추출
 */

const { loginToAdpia } = require("./order");

// 딜레이 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 셀렉터 (송장 조회용)
const SELECTORS = {
  // 주문 내역 페이지
  orderHistory: {
    url: "https://www.adpiamall.com/order/ing",
    // 기간 3개월 버튼
    threeMonthBtn: "#sub_container > div > app-root > ordering > div > div > form > div > div.searchfield_wrap > div.searchdate > div.date > button:nth-child(5)",
    // 검색 주문번호 라디오
    orderNumberRadio: "#sub_container > div > app-root > ordering > div > div > form > div > div.searchfield_wrap > div.searchwindow_keyword > p:nth-child(2) > label",
    // 검색 input
    searchInput: ".searchwindow > #search_txt",
    // 조회 버튼
    searchBtn: "#sub_container > div > app-root > ordering > div > div > form > div > div.searchwindow > button",
  },
  // 배송조회 팝업
  deliverySearch: {
    trackingLink: "#sub_container > div > app-root > ordering > div > div > deliverysearch > div > div > div > div > a",
  },
};

// 택배사 (롯데택배 고정)
const DEFAULT_CARRIER = "롯데택배";

/**
 * 애드피아몰 송장번호 조회
 * @param {Page} page - Puppeteer 페이지
 * @param {Object} vendor - 애드피아몰 협력사 설정
 * @param {string[]} openMallOrderNumbers - 조회할 오픈몰 주문번호 배열
 * @returns {Array} 조회 결과 배열 [{ openMallOrderNumber, trackingNumber, carrier }, ...]
 */
async function getAdpiaTrackingNumbers(page, vendor, openMallOrderNumbers) {
  console.log(`[adpia 송장조회] 시작: ${openMallOrderNumbers.length}건`);

  const results = [];

  try {
    // 1. 로그인 확인/처리
    const loginResult = await loginToAdpia(page, vendor);
    if (!loginResult.success) {
      console.error("[adpia 송장조회] 로그인 실패:", loginResult.message);
      return results;
    }
    console.log("[adpia 송장조회] 로그인 완료");

    // 2. 주문 내역 페이지로 이동
    console.log("[adpia 송장조회] 주문 내역 페이지로 이동...");
    await page.goto(SELECTORS.orderHistory.url, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await delay(2000);
    console.log("[adpia 송장조회] 주문 내역 페이지 도착");

    // 3. 기간 3개월 버튼 클릭
    console.log("[adpia 송장조회] 기간 3개월 버튼 클릭...");
    const threeMonthBtn = await page.$(SELECTORS.orderHistory.threeMonthBtn);
    if (threeMonthBtn) {
      await threeMonthBtn.click();
      await delay(500);
    }

    // 4. 검색 주문번호 라디오 클릭
    console.log("[adpia 송장조회] 주문번호 검색 선택...");
    const orderNumberRadio = await page.$(SELECTORS.orderHistory.orderNumberRadio);
    if (orderNumberRadio) {
      await orderNumberRadio.click();
      await delay(500);
    }

    // 5. 각 주문번호에 대해 조회
    for (const openMallOrderNumber of openMallOrderNumbers) {
      try {
        console.log(`[adpia 송장조회] 주문번호 ${openMallOrderNumber} 검색 중...`);

        // 검색어 입력
        const searchInput = await page.$(SELECTORS.orderHistory.searchInput);
        if (searchInput) {
          await searchInput.click({ clickCount: 3 });
          await delay(100);
          await searchInput.type(openMallOrderNumber, { delay: 30 });
          await delay(300);
        }

        // 조회 버튼 클릭
        const searchBtn = await page.$(SELECTORS.orderHistory.searchBtn);
        if (searchBtn) {
          await searchBtn.click();
          await delay(2000);
        }

        // 6. 배송조회 버튼 찾기 (텍스트로 검색)
        const trackingBtn = await page.evaluateHandle(() => {
          const buttons = document.querySelectorAll("button");
          for (const btn of buttons) {
            if (btn.textContent.trim() === "배송조회") return btn;
          }
          return null;
        });

        if (trackingBtn && trackingBtn.asElement()) {
          console.log(`[adpia 송장조회] 배송조회 버튼 클릭...`);
          await trackingBtn.asElement().click();
          await delay(2000);

          // 7. 배송조회 팝업에서 송장번호 추출
          const trackingLink = await page.$(SELECTORS.deliverySearch.trackingLink);
          if (trackingLink) {
            const trackingInfo = await page.evaluate((el) => {
              return {
                trackingNumber: el.textContent.trim(),
                href: el.href,
              };
            }, trackingLink);

            if (trackingInfo.trackingNumber) {
              console.log(`[adpia 송장조회] ${openMallOrderNumber}: ${trackingInfo.trackingNumber} (${DEFAULT_CARRIER})`);
              results.push({
                openMallOrderNumber,
                trackingNumber: trackingInfo.trackingNumber,
                carrier: DEFAULT_CARRIER,
              });
            }
          } else {
            console.log(`[adpia 송장조회] ${openMallOrderNumber}: 송장번호 링크 없음`);
          }

        } else {
          console.log(`[adpia 송장조회] ${openMallOrderNumber}: 배송조회 버튼 없음 (발송 전)`);
        }

      } catch (err) {
        console.error(`[adpia 송장조회] ${openMallOrderNumber} 조회 실패:`, err.message);
      }
    }

  } catch (error) {
    console.error("[adpia 송장조회] 에러:", error.message);
  }

  console.log(`[adpia 송장조회] 완료: ${results.length}건 조회됨`);
  return results;
}

module.exports = {
  getAdpiaTrackingNumbers,
};
