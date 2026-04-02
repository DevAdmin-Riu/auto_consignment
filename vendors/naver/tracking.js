/**
 * 네이버 스마트스토어 송장번호 조회 모듈
 *
 * 흐름:
 * 1. 로그인
 * 2. 주문 상태 페이지 이동 (orders.pay.naver.com/order/status/{주문번호})
 * 3. 상품별 배송조회 버튼 클릭 → 송장번호 추출
 * 4. fulfillment와 매칭 (옵션 텍스트 / prod-order-no)
 */

const { login } = require("./login");
const { normalizeCarrier } = require("../../lib/carrier");
const {
  createTrackingErrorCollector,
  TRACKING_STEPS,
  ERROR_CODES,
} = require("../../lib/automation-error");
const { sendAlertMail } = require("../../lib/alert-mail");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 배송 추적 페이지 셀렉터
const DELIVERY_SELECTORS = {
  carrier: "span.Courier_company__WpuEg",
  trackingNumber: "span.Courier_number__5MVoy",
};

/**
 * 네이버 송장번호 조회 (상품별)
 * @param {Page} page
 * @param {Object} vendor
 * @param {string[]} openMallOrderNumbers
 * @param {Object} fulfillmentMap - { openMallOrderNumber: { fulfillments: [{ fulfillmentId, openMallOptions, productName }] } }
 */
async function getNaverTrackingNumbers(page, vendor, openMallOrderNumbers, fulfillmentMap = {}) {
  console.log(`[naver 송장조회] 시작: ${openMallOrderNumbers.length}건`);

  const results = [];
  const allDelays = [];
  const errorCollector = createTrackingErrorCollector("naver");

  try {
    try {
      await login(page, vendor);
      console.log("[naver 송장조회] 로그인 완료");
    } catch (loginError) {
      console.error("[naver 송장조회] 로그인 실패:", loginError.message);
      errorCollector.addError(TRACKING_STEPS.LOGIN, ERROR_CODES.LOGIN_FAILED, loginError.message);
      return { results, automationErrors: errorCollector.getErrors() };
    }

    // alert 자동 확인 핸들러
    const dialogHandler = async (dialog) => {
      console.log(`[naver 송장조회] alert 감지: "${dialog.message()}" → 확인`);
      await dialog.accept();
    };
    page.on("dialog", dialogHandler);

    for (const openMallOrderNumber of openMallOrderNumbers) {
      try {
        console.log(`[naver 송장조회] 주문번호 ${openMallOrderNumber} 조회 중...`);

        const orderStatusUrl = `https://orders.pay.naver.com/order/status/${openMallOrderNumber}`;
        await page.goto(orderStatusUrl, { waitUntil: "networkidle2", timeout: 30000 });
        await delay(2000);

        // 배송지연/발송지연 체크
        const delayInfo = await page.evaluate(() => {
          const items = document.querySelectorAll('li[class*="ProductInfoSection_product-item"]');
          const delays = [];
          for (const item of items) {
            const stateEl = item.querySelector('strong[class*="DeliveryState_state"]');
            const state = stateEl?.textContent?.trim() || "";
            if (state.includes("배송지연") || state.includes("발송지연")) {
              const nameEl = item.querySelector('strong[class*="ProductDetail_name"]');
              const productName = nameEl?.textContent?.trim()?.replace("상품명", "") || "알 수 없음";
              const optionEls = item.querySelectorAll('span[class*="ProductDetail_text"]');
              const optionText = Array.from(optionEls).map(el => el.textContent?.trim()).filter(Boolean).join(" / ");
              delays.push({ state, productName, optionText });
            }
          }
          return delays;
        });

        if (delayInfo.length > 0) {
          console.log(`[naver 송장조회] ⚠️ ${openMallOrderNumber}: 지연 감지 ${delayInfo.length}건`);
          for (const d of delayInfo) {
            allDelays.push({ openMallOrderNumber, orderUrl: orderStatusUrl, ...d });
          }
        }

        const fulfillmentInfo = fulfillmentMap?.[openMallOrderNumber];

        if (fulfillmentInfo?.fulfillments?.length > 0) {
          // 상품별 매칭 모드
          const blockResults = await findTrackingNumbersByBlock(page, openMallOrderNumber);

          if (blockResults.length === 0) {
            console.log(`[naver 송장조회] ${openMallOrderNumber}: 상품 블록 없음`);
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
          // 기존 방식 (하위 호환) — 첫 번째 배송조회만
          const trackingInfo = await findTrackingNumberLegacy(page, openMallOrderNumber);
          if (trackingInfo?.trackingNumber) {
            results.push({
              openMallOrderNumber,
              trackingNumber: trackingInfo.trackingNumber,
              carrier: normalizeCarrier(trackingInfo.carrier),
            });
            console.log(`[naver 송장조회] ${openMallOrderNumber} → ${trackingInfo.trackingNumber} (${trackingInfo.carrier})`);
          } else {
            console.log(`[naver 송장조회] ${openMallOrderNumber}: 송장번호 없음`);
          }
        }

        await delay(1000);
      } catch (error) {
        console.error(`[naver 송장조회] ${openMallOrderNumber} 에러:`, error.message);
        errorCollector.addError(TRACKING_STEPS.EXTRACTION, ERROR_CODES.EXTRACTION_FAILED, error.message, { openMallOrderNumber });
      }
    }

    // dialog 핸들러 제거
    page.off("dialog", dialogHandler);

    console.log(`[naver 송장조회] 완료: ${results.length}/${openMallOrderNumbers.length}건 조회됨`);

    // 배송지연/발송지연 모아서 메일 발송
    if (allDelays.length > 0) {
      const rows = allDelays.map(d =>
        `<tr>
          <td style="padding:6px 10px;border:1px solid #ddd;">${d.openMallOrderNumber}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;color:red;font-weight:bold;">${d.state}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;">${d.productName}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;">${d.optionText}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;"><a href="${d.orderUrl}">주문상세</a></td>
        </tr>`
      ).join("");

      sendAlertMail({
        subject: `네이버 배송/발송 지연 ${allDelays.length}건`,
        body: `<p>네이버 송장조회 중 배송지연/발송지연이 감지되었습니다.</p>
        <table style="border-collapse:collapse;font-size:13px;">
          <tr style="background:#f0f0f0;">
            <th style="padding:6px 10px;border:1px solid #ddd;">주문번호</th>
            <th style="padding:6px 10px;border:1px solid #ddd;">상태</th>
            <th style="padding:6px 10px;border:1px solid #ddd;">상품명</th>
            <th style="padding:6px 10px;border:1px solid #ddd;">옵션</th>
            <th style="padding:6px 10px;border:1px solid #ddd;">링크</th>
          </tr>
          ${rows}
        </table>`,
        vendor: "네이버",
      });
      console.log(`[naver 송장조회] 지연 알림 메일 발송: ${allDelays.length}건`);
    }

    return {
      results,
      automationErrors: errorCollector.hasErrors() ? errorCollector.getErrors() : undefined,
    };
  } catch (error) {
    console.error("[naver 송장조회] 전체 에러:", error);
    errorCollector.addError(TRACKING_STEPS.EXTRACTION, ERROR_CODES.UNEXPECTED_ERROR, error.message);
    return { results, automationErrors: errorCollector.getErrors() };
  }
}

/**
 * 주문상세에서 모든 상품 블록 파싱 + 배송조회 클릭 → 송장번호 추출
 * @returns {Array} [{ prodOrderNo, productName, optionText, trackingNumber, carrier, blockIndex }]
 */
async function findTrackingNumbersByBlock(page, openMallOrderNumber) {
  // 1. 모든 상품 블록 파싱
  const blocks = await page.evaluate(() => {
    const items = document.querySelectorAll('li[class*="ProductInfoSection_product-item"]');
    const results = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // prod-order-no (배송조회 버튼에서 추출)
      const trackBtn = item.querySelector('button[data-nlog-click-code="trackDelivery"]');
      const prodOrderNo = trackBtn?.getAttribute("data-nlog-prod-order-no") || null;

      // 배송조회 버튼이 없으면 스킵 (아직 배송 전)
      if (!trackBtn) continue;

      // 버튼 텍스트 확인
      const btnText = trackBtn.textContent?.trim() || "";
      if (!btnText.includes("배송조회")) continue;

      // 상품명
      const nameEl = item.querySelector('strong[class*="ProductDetail_name"]');
      const productName = nameEl?.textContent?.trim()?.replace("상품명", "") || "";

      // 옵션 텍스트
      const optionEls = item.querySelectorAll('span[class*="ProductDetail_text"]');
      const optionText = Array.from(optionEls).map(el => el.textContent?.trim()).filter(Boolean).join(" / ");

      results.push({
        prodOrderNo,
        productName: productName.substring(0, 100),
        optionText,
        blockIndex: i,
      });
    }

    return results;
  });

  console.log(`[naver 송장조회] ${openMallOrderNumber}: 상품 블록 ${blocks.length}개 발견`);
  for (const b of blocks) {
    console.log(`  - prodOrderNo=${b.prodOrderNo}, 옵션="${b.optionText}", ${b.productName}`);
  }

  // 2. 각 블록별 배송조회 클릭 → 송장번호 추출
  const trackingResults = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    try {
      // 배송조회 버튼 클릭 (prod-order-no로 찾기)
      const clicked = await page.evaluate((prodOrderNo) => {
        const btn = document.querySelector(`button[data-nlog-click-code="trackDelivery"][data-nlog-prod-order-no="${prodOrderNo}"]`);
        if (btn) { btn.click(); return true; }
        return false;
      }, block.prodOrderNo);

      if (!clicked) {
        trackingResults.push({ ...block, trackingNumber: null, carrier: null });
        continue;
      }

      console.log(`[naver 송장조회] 블록 ${i}: 배송조회 클릭 (prodOrderNo=${block.prodOrderNo})`);
      await delay(2000);

      // 송장번호 추출 (배송 추적 페이지)
      const trackingInfo = await extractTrackingFromPage(page);

      trackingResults.push({
        ...block,
        trackingNumber: trackingInfo.trackingNumber || null,
        carrier: trackingInfo.carrier || null,
      });

      if (trackingInfo.trackingNumber) {
        console.log(`[naver 송장조회] 블록 ${i}: ${trackingInfo.trackingNumber} (${trackingInfo.carrier})`);
      } else {
        console.log(`[naver 송장조회] 블록 ${i}: 송장번호 없음`);
      }

      // 주문상세로 복귀
      await page.goto(`https://orders.pay.naver.com/order/status/${openMallOrderNumber}`, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
      await delay(1000);

    } catch (e) {
      console.error(`[naver 송장조회] 블록 ${i} 에러:`, e.message);
      trackingResults.push({ ...block, trackingNumber: null, carrier: null });
    }
  }

  return trackingResults;
}

/**
 * 배송 추적 페이지에서 택배사/송장번호 추출
 */
async function extractTrackingFromPage(page) {
  let carrier = null;
  let trackingNumber = null;

  try {
    carrier = await page.$eval(DELIVERY_SELECTORS.carrier, (el) => el.textContent?.trim() || "");
  } catch (e) {}

  try {
    trackingNumber = await page.$eval(DELIVERY_SELECTORS.trackingNumber, (el) => el.textContent?.trim() || "");
  } catch (e) {}

  return { carrier, trackingNumber };
}

/**
 * fulfillment와 블록 매칭
 * 매칭 기준: 옵션 텍스트 > 상품명 > 블록 1개면 자동
 */
function matchFulfillmentsToBlocks(fulfillments, blockResults, openMallOrderNumber) {
  const matched = new Array(fulfillments.length).fill(null);
  const usedBlocks = new Set();

  // 옵션 value 미리 추출
  const optionValues = fulfillments.map(f => {
    try {
      const options = typeof f.openMallOptions === "string" ? JSON.parse(f.openMallOptions) : f.openMallOptions;
      if (Array.isArray(options) && options.length > 0) {
        return options[0]?.options?.[0]?.value || "";
      }
    } catch (e) {}
    return "";
  });

  // === 1패스: usedBlocks 적용 (다른 상품끼리 정확 매칭) ===
  for (let fi = 0; fi < fulfillments.length; fi++) {
    const f = fulfillments[fi];
    const optionValue = optionValues[fi];
    let bestBlock = null;
    let bestBlockIdx = -1;

    // 옵션 텍스트 매칭
    if (optionValue) {
      for (let i = 0; i < blockResults.length; i++) {
        if (usedBlocks.has(i)) continue;
        const block = blockResults[i];
        if (!block.optionText) continue;
        const blockKey = block.optionText.substring(0, 20);
        const optKey = optionValue.substring(0, 20);
        if (blockKey === optKey || block.optionText.includes(optKey) || optionValue.includes(blockKey)) {
          bestBlock = block;
          bestBlockIdx = i;
          break;
        }
      }
    }

    // 상품명 매칭
    if (!bestBlock && f.productName) {
      for (let i = 0; i < blockResults.length; i++) {
        if (usedBlocks.has(i)) continue;
        const block = blockResults[i];
        if (!block.productName) continue;
        const blockName = block.productName.substring(0, 20);
        const fName = f.productName.substring(0, 20);
        if (blockName === fName || block.productName.includes(fName) || f.productName.includes(blockName)) {
          bestBlock = block;
          bestBlockIdx = i;
          break;
        }
      }
    }

    // 블록 1개 + 미사용이면 자동 매칭
    if (!bestBlock && blockResults.length === 1 && !usedBlocks.has(0)) {
      bestBlock = blockResults[0];
      bestBlockIdx = 0;
    }

    if (bestBlock && bestBlockIdx >= 0) {
      usedBlocks.add(bestBlockIdx);
      matched[fi] = { fulfillmentId: f.fulfillmentId, trackingNumber: bestBlock.trackingNumber, carrier: bestBlock.carrier };
      console.log(`[naver 매칭] ${openMallOrderNumber}: fulfillment ${f.fulfillmentId} → 옵션 "${bestBlock.optionText}", 송장=${bestBlock.trackingNumber || "없음"}`);
    }
  }

  // === 2패스: 매칭 실패한 fulfillment → usedBlocks 무시하고 재매칭 ===
  for (let fi = 0; fi < fulfillments.length; fi++) {
    if (matched[fi]) continue;
    const f = fulfillments[fi];
    const optionValue = optionValues[fi];
    let bestBlock = null;

    // 옵션 텍스트로 재매칭 (usedBlocks 무시)
    if (optionValue) {
      for (const block of blockResults) {
        if (!block.optionText) continue;
        const blockKey = block.optionText.substring(0, 20);
        const optKey = optionValue.substring(0, 20);
        if (blockKey === optKey || block.optionText.includes(optKey) || optionValue.includes(blockKey)) {
          bestBlock = block;
          break;
        }
      }
    }

    // 상품명으로 재매칭 (usedBlocks 무시)
    if (!bestBlock && f.productName) {
      for (const block of blockResults) {
        if (!block.productName) continue;
        const blockName = block.productName.substring(0, 20);
        const fName = f.productName.substring(0, 20);
        if (blockName === fName || block.productName.includes(fName) || f.productName.includes(blockName)) {
          bestBlock = block;
          break;
        }
      }
    }

    if (bestBlock) {
      matched[fi] = { fulfillmentId: f.fulfillmentId, trackingNumber: bestBlock.trackingNumber, carrier: bestBlock.carrier };
      console.log(`[naver 매칭] ${openMallOrderNumber}: fulfillment ${f.fulfillmentId} → 2패스 재매칭 "${bestBlock.optionText}", 송장=${bestBlock.trackingNumber || "없음"}`);
    } else {
      // 최종 폴백: 첫 번째 송장번호
      const firstWithTracking = blockResults.find(b => b.trackingNumber);
      if (firstWithTracking) {
        matched[fi] = { fulfillmentId: f.fulfillmentId, trackingNumber: firstWithTracking.trackingNumber, carrier: firstWithTracking.carrier };
        console.log(`[naver 매칭] ${openMallOrderNumber}: fulfillment ${f.fulfillmentId} → 첫 번째 송장 폴백: ${firstWithTracking.trackingNumber}`);
      } else {
        matched[fi] = { fulfillmentId: f.fulfillmentId, trackingNumber: null, carrier: null };
        console.log(`[naver 매칭] ${openMallOrderNumber}: fulfillment ${f.fulfillmentId} → 매칭 실패 (옵션: "${optionValue}")`);
      }
    }
  }

  return matched;
}

/**
 * 기존 방식 (하위 호환) — 첫 번째 배송조회만
 */
async function findTrackingNumberLegacy(page, openMallOrderNumber) {
  let trackBtn = await page.$('button[data-nlog-click-code="trackDelivery"]');
  if (!trackBtn) return { trackingNumber: null, carrier: null };

  const btnText = await page.evaluate((btn) => btn.textContent?.trim() || "", trackBtn);
  if (!btnText.includes("배송조회")) return { trackingNumber: null, carrier: null };

  await trackBtn.click();
  console.log(`[naver 송장조회] ${openMallOrderNumber}: 배송조회 클릭`);
  await delay(2000);

  return await extractTrackingFromPage(page);
}

module.exports = {
  getNaverTrackingNumbers,
};
