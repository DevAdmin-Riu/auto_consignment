/**
 * 성원애드피아 송장번호 조회 모듈
 *
 * 주문번호로 성원애드피아 주문목록에서 송장번호를 크롤링
 */

const { login } = require("./order");
const {
  createTrackingErrorCollector,
  TRACKING_STEPS,
  ERROR_CODES,
} = require("../../lib/automation-error");

// 딜레이 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 셀렉터 상수
const SELECTORS = {
  // 주문완료/배송조회 페이지
  orderIng: {
    url: "https://www.swadpia.co.kr/mypage/order_ing",
    // 기간 3개월 버튼
    threeMonthBtn: "#date_img4",
    // 주문번호 검색 input
    searchInput: "#search_value",
    // 조회 버튼
    searchButton:
      "#contents > form:nth-child(2) > div.boxstyle04.mar_b20 > table > tbody > tr:nth-child(1) > td:nth-child(4) > a > input[type=image]",
    // 배송 조회 링크 (href에서 송장번호 추출)
    deliveryTrackingLink:
      "#frm > table > tbody > tr:nth-child(2) > td:nth-child(8) > a",
  },
};

/**
 * 성원애드피아 송장번호 조회
 * @param {Page} page - Puppeteer 페이지
 * @param {Object} vendor - 성원애드피아 협력사 설정
 * @param {string[]} openMallOrderNumbers - 조회할 오픈몰 주문번호 배열 (vendorOrderNumber로 사용)
 * @returns {Array} 조회 결과 배열 [{ openMallOrderNumber, trackingNumber, carrier }, ...]
 */
async function getSwadpiaTrackingNumbers(page, vendor, openMallOrderNumbers) {
  console.log(`[swadpia 송장조회] 시작: ${openMallOrderNumbers.length}건`);

  const errorCollector = createTrackingErrorCollector("swadpia");
  const results = [];

  try {
    // 1. 로그인 확인/처리
    try {
      await login(page, {
        email: vendor.email,
        password: vendor.password,
      });
      console.log("[swadpia 송장조회] 로그인 완료");
    } catch (loginError) {
      errorCollector.addError(
        TRACKING_STEPS.LOGIN,
        ERROR_CODES.LOGIN_FAILED,
        loginError.message,
      );
      return { results, automationErrors: errorCollector.getErrors() };
    }

    // 2. 주문완료/배송조회 페이지로 이동
    console.log("[swadpia 송장조회] 주문완료/배송조회 페이지로 이동...");
    await page.goto(SELECTORS.orderIng.url, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await delay(2000);

    // 3. 기간 3개월 버튼 클릭
    try {
      const threeMonthBtn = await page.$(SELECTORS.orderIng.threeMonthBtn);
      if (threeMonthBtn) {
        await threeMonthBtn.click();
        console.log("[swadpia 송장조회] 기간 3개월 선택");
        await delay(1000);
      }
    } catch (e) {
      console.log("[swadpia 송장조회] 기간 버튼 클릭 실패, 기본값 사용");
    }

    // 4. 각 주문번호에 대해 검색 및 송장번호 조회
    for (const openMallOrderNumber of openMallOrderNumbers) {
      try {
        console.log(
          `[swadpia 송장조회] 주문번호 ${openMallOrderNumber} 검색 중...`,
        );

        // 검색창 초기화 및 주문번호 입력
        await page.waitForSelector(SELECTORS.orderIng.searchInput, {
          timeout: 5000,
        });
        await page.$eval(
          SELECTORS.orderIng.searchInput,
          (el) => (el.value = ""),
        );
        await page.type(SELECTORS.orderIng.searchInput, openMallOrderNumber, {
          delay: 50,
        });

        // 조회 버튼 클릭
        const searchBtn = await page.$(SELECTORS.orderIng.searchButton);
        if (searchBtn) {
          await searchBtn.click();
          await delay(2000);
        }

        // 배송 조회 링크 확인 (없으면 송장 아직 없음)
        const deliveryLink = await page.$(
          SELECTORS.orderIng.deliveryTrackingLink,
        );
        if (!deliveryLink) {
          console.log(
            `[swadpia 송장조회] ${openMallOrderNumber}: 배송 조회 링크 없음 (송장 미등록)`,
          );
          continue;
        }

        // href에서 송장번호 추출
        // href="javascript:DeliverysearchView('316031413176','','21483039','DVM10','DVC09');"
        const href = await page.$eval(
          SELECTORS.orderIng.deliveryTrackingLink,
          (el) => el.getAttribute("href") || "",
        );
        const trackingMatch = href.match(/DeliverysearchView\('(\d+)'/);

        if (trackingMatch && trackingMatch[1]) {
          const trackingNumber = trackingMatch[1];
          // 성원애드피아는 롯데택배 고정
          const carrier = "롯데택배";
          results.push({
            openMallOrderNumber,
            trackingNumber,
            carrier,
          });
          console.log(
            `[swadpia 송장조회] ${openMallOrderNumber} → ${trackingNumber} (${carrier})`,
          );
        } else {
          console.log(
            `[swadpia 송장조회] ${openMallOrderNumber} → 송장번호 추출 실패`,
          );
        }
      } catch (error) {
        console.error(
          `[swadpia 송장조회] ${openMallOrderNumber} 에러:`,
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

    return {
      results,
      automationErrors: errorCollector.hasErrors()
        ? errorCollector.getErrors()
        : undefined,
    };
  } catch (error) {
    console.error("[swadpia 송장조회] 전체 에러:", error);
    errorCollector.addError(
      TRACKING_STEPS.EXTRACTION,
      ERROR_CODES.UNEXPECTED_ERROR,
      error.message,
    );
    return { results, automationErrors: errorCollector.getErrors() };
  }
}

module.exports = {
  getSwadpiaTrackingNumbers,
};
