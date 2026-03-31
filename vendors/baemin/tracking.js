/**
 * 배민상회 송장번호 조회 모듈
 *
 * 주문상세에서 상품별 송장번호를 크롤링
 * - goods ID + 옵션 텍스트로 상품 블록 매칭
 * - 각 블록별 배송조회 클릭 → 개별 송장번호 추출
 */

const { loginToBaemin } = require("./order");
const { normalizeCarrier } = require("../../lib/carrier");
const {
  createTrackingErrorCollector,
  TRACKING_STEPS,
  ERROR_CODES,
} = require("../../lib/automation-error");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 배민상회 송장번호 조회 (상품별)
 * @param {Page} page
 * @param {Object} vendor
 * @param {string[]} openMallOrderNumbers
 * @param {Object} fulfillmentMap - { openMallOrderNumber: { fulfillments: [{ fulfillmentId, vendorItemId, openMallOptions }] } }
 */
async function getBaeminTrackingNumbers(page, vendor, openMallOrderNumbers, fulfillmentMap = {}) {
  console.log(`[baemin 송장조회] 시작: ${openMallOrderNumbers.length}건`);

  const errorCollector = createTrackingErrorCollector("baemin");
  const results = [];

  try {
    const loginResult = await loginToBaemin(page, vendor);
    if (!loginResult.success) {
      console.log("[baemin 송장조회] 로그인 실패:", loginResult.message);
      errorCollector.addError(TRACKING_STEPS.LOGIN, ERROR_CODES.LOGIN_FAILED, loginResult.message);
      return { results, automationErrors: errorCollector.getErrors() };
    }
    console.log("[baemin 송장조회] 로그인 완료");

    for (const openMallOrderNumber of openMallOrderNumbers) {
      try {
        console.log(`[baemin 송장조회] 주문번호 ${openMallOrderNumber} 조회 중...`);

        const orderDetailUrl = `https://mart.baemin.com/mymart/order/detail/${openMallOrderNumber}`;
        await page.goto(orderDetailUrl, { waitUntil: "networkidle2", timeout: 30000 });
        await delay(2000);

        console.log(`[baemin 송장조회] 현재 URL: ${page.url()}`);

        const fulfillmentInfo = fulfillmentMap?.[openMallOrderNumber];

        if (fulfillmentInfo?.fulfillments?.length > 0) {
          // 상품별 매칭 모드
          const blockResults = await findTrackingNumbersByBlock(page, openMallOrderNumber);

          if (blockResults.length === 0) {
            console.log(`[baemin 송장조회] ${openMallOrderNumber}: 배송 블록 없음`);
            continue;
          }

          const matched = matchFulfillmentsToBlocks(fulfillmentInfo.fulfillments, blockResults, openMallOrderNumber);

          for (const m of matched) {
            if (m.trackingNumber) {
              results.push({
                openMallOrderNumber,
                fulfillmentId: m.fulfillmentId,
                trackingNumber: m.trackingNumber,
                carrier: normalizeCarrier(m.carrier),
              });
            }
          }
        } else {
          // 기존 방식 (하위 호환)
          const trackingInfo = await findTrackingNumberLegacy(page, openMallOrderNumber);
          if (trackingInfo?.trackingNumber) {
            results.push({
              openMallOrderNumber,
              trackingNumber: trackingInfo.trackingNumber,
              carrier: normalizeCarrier(trackingInfo.carrier),
            });
            console.log(`[baemin 송장조회] ${openMallOrderNumber} → ${trackingInfo.trackingNumber} (${trackingInfo.carrier})`);
          } else {
            console.log(`[baemin 송장조회] ${openMallOrderNumber} → 송장번호 없음`);
          }
        }

        await delay(1000);
      } catch (error) {
        console.error(`[baemin 송장조회] ${openMallOrderNumber} 에러:`, error.message);
        errorCollector.addError(TRACKING_STEPS.EXTRACTION, ERROR_CODES.EXTRACTION_FAILED, error.message, { openMallOrderNumber });
      }
    }

    console.log(`[baemin 송장조회] 완료: ${results.length}/${openMallOrderNumbers.length}건 조회됨`);
    return {
      results,
      automationErrors: errorCollector.hasErrors() ? errorCollector.getErrors() : undefined,
    };
  } catch (error) {
    console.error("[baemin 송장조회] 전체 에러:", error);
    errorCollector.addError(TRACKING_STEPS.EXTRACTION, ERROR_CODES.EXTRACTION_FAILED, error.message);
    return { results, automationErrors: errorCollector.getErrors() };
  }
}

/**
 * 주문상세에서 모든 상품 블록별 송장번호 조회
 * @returns {Array} [{ goodsId, optionText, productName, trackingNumber, carrier, blockIndex }]
 */
async function findTrackingNumbersByBlock(page, openMallOrderNumber) {
  // 1. 모든 상품 블록 파싱
  const blocks = await page.evaluate(() => {
    const deliveryBtns = document.querySelectorAll('[data-action-button-click-event-label="배송조회"]');
    const results = [];

    for (let i = 0; i < deliveryBtns.length; i++) {
      const btn = deliveryBtns[i];

      // 버튼에서 위로 올라가면서 goods 링크 찾기
      let container = btn.parentElement;
      while (container && !container.querySelector('a[href*="/goods/detail/"]')) {
        container = container.parentElement;
      }

      if (!container) continue;

      // goods ID
      const link = container.querySelector('a[href*="/goods/detail/"]');
      const goodsId = link?.href?.match(/\/goods\/detail\/(\d+)/)?.[1] || null;

      // 상품명
      const allDivs = container.querySelectorAll('div');
      let productName = "";
      let optionText = "";
      let priceText = "";

      for (const div of allDivs) {
        const text = div.textContent?.trim() || "";
        // 가격/수량 패턴: "25,850원 / 수량 : 1개"
        if (text.match(/[\d,]+원\s*\/\s*수량/)) {
          priceText = text;
        }
      }

      // 상품명: goods 링크 안의 텍스트
      const nameEl = link?.querySelector('div');
      if (nameEl) productName = nameEl.textContent?.trim() || "";

      // 옵션: 가격 div 다음 div (같은 컨테이너 안)
      // 배민 구조: 상품명 div → 가격 div → 옵션 div
      const infoContainer = container.querySelector('a[href*="/goods/detail/"]')?.parentElement;
      if (infoContainer) {
        const divs = infoContainer.querySelectorAll(':scope > div');
        for (const div of divs) {
          const text = div.textContent?.trim() || "";
          // 옵션은 가격도 아니고 상품명도 아닌 텍스트
          if (text && !text.match(/[\d,]+원\s*\/\s*수량/) && text !== productName && text.length < 200) {
            // 상품명과 다른 짧은 텍스트 = 옵션
            if (!text.includes("장바구니") && !text.includes("배송조회") && !text.includes("문의")) {
              optionText = text;
            }
          }
        }
      }

      results.push({
        goodsId,
        productName: productName.substring(0, 100),
        optionText,
        priceText,
        blockIndex: i,
      });
    }

    return results;
  });

  console.log(`[baemin 송장조회] ${openMallOrderNumber}: 상품 블록 ${blocks.length}개 발견`);
  for (const b of blocks) {
    console.log(`  - goodsId=${b.goodsId}, 옵션="${b.optionText}", ${b.productName}`);
  }

  // 2. 각 블록별 배송조회 클릭 → 송장번호 추출
  const trackingResults = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    try {
      // 배송조회 버튼 클릭 (i번째)
      const clicked = await page.evaluate((idx) => {
        const btns = document.querySelectorAll('[data-action-button-click-event-label="배송조회"]');
        if (btns[idx]) { btns[idx].click(); return true; }
        return false;
      }, i);

      if (!clicked) {
        trackingResults.push({ ...block, trackingNumber: null, carrier: null });
        continue;
      }

      console.log(`[baemin 송장조회] 블록 ${i}: 배송조회 클릭 (goodsId=${block.goodsId})`);
      await delay(2000);

      // 송장번호 추출 (모달/팝업)
      const trackingInfo = await extractTrackingFromPage(page);

      trackingResults.push({
        ...block,
        trackingNumber: trackingInfo.trackingNumber || null,
        carrier: trackingInfo.carrier || null,
      });

      if (trackingInfo.trackingNumber) {
        console.log(`[baemin 송장조회] 블록 ${i}: ${trackingInfo.trackingNumber} (${trackingInfo.carrier})`);
      } else {
        console.log(`[baemin 송장조회] 블록 ${i}: 송장번호 없음`);
      }

      // 주문상세로 복귀
      await page.goto(`https://mart.baemin.com/mymart/order/detail/${openMallOrderNumber}`, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
      await delay(1000);

    } catch (e) {
      console.error(`[baemin 송장조회] 블록 ${i} 에러:`, e.message);
      trackingResults.push({ ...block, trackingNumber: null, carrier: null });
    }
  }

  return trackingResults;
}

/**
 * 페이지에서 송장번호/택배사 추출 (공통)
 */
async function extractTrackingFromPage(page) {
  return await page.evaluate(() => {
    const allText = document.body.innerText || "";

    // 택배사 + 운송장번호 통합 패턴
    const combinedPattern =
      /(CJ대한통운|대한통운|로켓배송|롯데택배|한진택배|로젠택배|우체국택배|경동택배|합동택배|천일택배|건영택배|일양로지스|대신택배|롯데|대신)\s*운송장번호[:\s]*(\d{10,14})/;
    const combinedMatch = allText.match(combinedPattern);

    if (combinedMatch) {
      return { carrier: combinedMatch[1], trackingNumber: combinedMatch[2] };
    }

    // 폴백: 개별 패턴
    let trackingNumber = null;
    const trackingPatterns = [/운송장번호[:\s]*(\d{10,14})/, /송장번호[:\s]*(\d{10,14})/, /송장\s*:\s*(\d{10,14})/];
    for (const p of trackingPatterns) {
      const m = allText.match(p);
      if (m) { trackingNumber = m[1]; break; }
    }

    let carrier = null;
    const carrierPattern = /(CJ대한통운|대한통운|롯데택배|한진택배|로젠택배|우체국택배|경동택배|합동택배|천일택배|건영택배|일양로지스|대신택배|롯데|대신)/;
    const carrierMatch = allText.match(carrierPattern);
    if (carrierMatch) carrier = carrierMatch[1];

    return { trackingNumber, carrier };
  });
}

/**
 * fulfillment와 블록 매칭 (옵션 텍스트 기반)
 */
function matchFulfillmentsToBlocks(fulfillments, blockResults, openMallOrderNumber) {
  const matched = [];

  for (const f of fulfillments) {
    let bestBlock = null;

    // openMallOptions에서 옵션 value 추출
    let optionValue = "";
    try {
      const options = typeof f.openMallOptions === "string" ? JSON.parse(f.openMallOptions) : f.openMallOptions;
      if (Array.isArray(options) && options.length > 0) {
        optionValue = options[0]?.options?.[0]?.value || "";
      }
    } catch (e) {}

    if (optionValue) {
      // 옵션 텍스트로 매칭
      for (const block of blockResults) {
        if (block.optionText && optionValue.includes(block.optionText.substring(0, 20))) {
          bestBlock = block;
          break;
        }
        if (block.optionText && block.optionText.includes(optionValue.substring(0, 20))) {
          bestBlock = block;
          break;
        }
      }
    }

    if (!bestBlock && blockResults.length === 1) {
      // 블록 1개면 그냥 매칭
      bestBlock = blockResults[0];
    }

    if (bestBlock) {
      matched.push({
        fulfillmentId: f.fulfillmentId,
        trackingNumber: bestBlock.trackingNumber,
        carrier: bestBlock.carrier,
      });
      console.log(`[baemin 매칭] ${openMallOrderNumber}: fulfillment ${f.fulfillmentId} → 옵션 "${bestBlock.optionText}", 송장=${bestBlock.trackingNumber || "없음"}`);
    } else {
      matched.push({ fulfillmentId: f.fulfillmentId, trackingNumber: null, carrier: null });
      console.log(`[baemin 매칭] ${openMallOrderNumber}: fulfillment ${f.fulfillmentId} → 매칭 실패`);
    }
  }

  return matched;
}

/**
 * 기존 방식 (하위 호환) — 첫 번째 배송조회만
 */
async function findTrackingNumberLegacy(page, openMallOrderNumber) {
  let deliveryBtn = await page.$('button[data-action-button-click-event-label="배송조회"]');

  if (!deliveryBtn) {
    deliveryBtn = await page.evaluateHandle(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        if ((btn.innerText || btn.textContent || "").trim().includes("배송조회")) return btn;
      }
      return null;
    });
    const btnValue = await deliveryBtn.jsonValue();
    if (!btnValue) return { trackingNumber: null, carrier: null };
  }

  await deliveryBtn.click();
  console.log(`[baemin 송장조회] ${openMallOrderNumber}: 배송조회 버튼 클릭`);
  await delay(2000);

  return await extractTrackingFromPage(page);
}

module.exports = {
  getBaeminTrackingNumbers,
};
