/**
 * 냅킨코리아 송장번호 조회 모듈
 *
 * 주문상세에서 행별로 옵션 + 송장번호 파싱
 * - 옵션 텍스트로 fulfillment 매칭
 * - delivery_trace URL에서 invoice_no 직접 추출 (버튼 클릭 불필요)
 */

const { loginToNapkin } = require("./order");
const { normalizeCarrier } = require("../../lib/carrier");
const {
  createTrackingErrorCollector,
  TRACKING_STEPS,
  ERROR_CODES,
} = require("../../lib/automation-error");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 냅킨코리아 송장번호 조회 (상품별)
 * @param {Page} page
 * @param {Object} vendor
 * @param {string[]} openMallOrderNumbers
 * @param {Object} fulfillmentMap - { openMallOrderNumber: { fulfillments: [{ fulfillmentId, openMallOptions }] } }
 */
async function getNapkinTrackingNumbers(page, vendor, openMallOrderNumbers, fulfillmentMap = {}) {
  console.log(`[napkin 송장조회] 시작: ${openMallOrderNumbers.length}건`);

  const errorCollector = createTrackingErrorCollector("napkin");
  const results = [];

  try {
    const loginResult = await loginToNapkin(page, vendor);
    if (!loginResult.success) {
      console.error("[napkin 송장조회] 로그인 실패:", loginResult.message);
      errorCollector.addError(TRACKING_STEPS.LOGIN, ERROR_CODES.LOGIN_FAILED, loginResult.message);
      return { results, automationErrors: errorCollector.getErrors() };
    }
    console.log("[napkin 송장조회] 로그인 완료");

    for (const openMallOrderNumber of openMallOrderNumbers) {
      try {
        console.log(`[napkin 송장조회] 주문번호 ${openMallOrderNumber} 검색 중...`);

        const orderUrl = `https://www.napkinkorea.co.kr/myshop/order/detail.html?order_id=${openMallOrderNumber}&page=1`;
        console.log(`[napkin 송장조회] 주문 페이지 이동: ${orderUrl}`);

        await page.goto(orderUrl, { waitUntil: "networkidle2", timeout: 30000 });
        await delay(2000);

        const fulfillmentInfo = fulfillmentMap?.[openMallOrderNumber];

        if (fulfillmentInfo?.fulfillments?.length > 0) {
          // 상품별 매칭 모드
          const rowResults = await parseAllRows(page, openMallOrderNumber);

          if (rowResults.length === 0) {
            console.log(`[napkin 송장조회] ${openMallOrderNumber}: 상품 행 없음`);
            continue;
          }

          const matched = matchFulfillmentsToRows(fulfillmentInfo.fulfillments, rowResults, openMallOrderNumber);

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
            console.log(`[napkin 송장조회] ${openMallOrderNumber} → ${trackingInfo.trackingNumber} (${trackingInfo.carrier})`);
          } else {
            console.log(`[napkin 송장조회] ${openMallOrderNumber} → 송장번호 없음`);
          }
        }

        await delay(1000);
      } catch (error) {
        console.error(`[napkin 송장조회] ${openMallOrderNumber} 에러:`, error.message);
        errorCollector.addError(TRACKING_STEPS.EXTRACTION, ERROR_CODES.EXTRACTION_FAILED, error.message, { openMallOrderNumber });
      }
    }

    console.log(`[napkin 송장조회] 완료: ${results.length}/${openMallOrderNumbers.length}건 조회됨`);
    return {
      results,
      automationErrors: errorCollector.hasErrors() ? errorCollector.getErrors() : undefined,
    };
  } catch (error) {
    console.error("[napkin 송장조회] 전체 에러:", error);
    errorCollector.addError(TRACKING_STEPS.EXTRACTION, ERROR_CODES.EXTRACTION_FAILED, error.message);
    return { results, automationErrors: errorCollector.getErrors() };
  }
}

/**
 * 주문상세에서 모든 상품 행 파싱 (옵션 + 송장번호)
 * @returns {Array} [{ optionText, productName, trackingNumber, carrier, productNo, optId }]
 */
async function parseAllRows(page, openMallOrderNumber) {
  const rows = await page.evaluate(() => {
    const results = [];
    const trs = document.querySelectorAll("tbody tr.xans-record-");

    for (const tr of trs) {
      // 옵션 텍스트
      const optionEl = tr.querySelector("td.left .option");
      let optionText = optionEl?.textContent?.trim() || "";
      // "[옵션: xxx]" 에서 xxx 추출
      const optMatch = optionText.match(/\[옵션:\s*(.+?)\]/);
      if (optMatch) optionText = optMatch[1].trim();

      // 상품명
      const nameEl = tr.querySelector("td.left .name a");
      const productName = nameEl?.textContent?.trim() || "";

      // 상품 URL에서 product_no 추출
      const productLink = nameEl?.getAttribute("href") || "";
      const prodNoMatch = productLink.match(/\/(\d+)\//);
      const productNo = prodNoMatch ? prodNoMatch[1] : null;

      // 송장번호 + 택배사: delivery_trace URL에서 추출
      let trackingNumber = null;
      let carrier = null;
      let optId = null;

      const links = tr.querySelectorAll("td a");
      for (const link of links) {
        const href = link.getAttribute("href") || "";
        const onclick = link.getAttribute("onclick") || "";
        const text = link.textContent?.trim() || "";

        // delivery_trace URL에서 invoice_no, opt_id 추출
        const traceUrl = href.includes("delivery_trace") ? href : "";
        const onclickTrace = onclick.includes("delivery_trace") ? onclick : "";
        const sourceUrl = traceUrl || onclickTrace;

        if (sourceUrl) {
          const invoiceMatch = sourceUrl.match(/invoice_no=(\d+)/);
          const optIdMatch = sourceUrl.match(/opt_id=([^&'"]+)/);

          if (invoiceMatch) trackingNumber = invoiceMatch[1];
          if (optIdMatch) optId = optIdMatch[1];

          // 택배사: delivery_trace 링크의 텍스트 (sp-btn 아닌 것)
          if (href.includes("delivery_trace") && !link.classList.contains("sp-btn")) {
            carrier = text;
          }
        }
      }

      results.push({
        optionText,
        productName: productName.substring(0, 80),
        productNo,
        optId,
        trackingNumber,
        carrier,
      });
    }

    return results;
  });

  console.log(`[napkin 송장조회] ${openMallOrderNumber}: 상품 행 ${rows.length}개 발견`);
  for (const r of rows) {
    console.log(`  - 옵션="${r.optionText}", 송장=${r.trackingNumber || "없음"} (${r.carrier || "없음"}), productNo=${r.productNo}`);
  }

  return rows;
}

/**
 * fulfillment와 행 매칭 (옵션 텍스트 기반)
 */
function matchFulfillmentsToRows(fulfillments, rowResults, openMallOrderNumber) {
  const matched = new Array(fulfillments.length).fill(null);
  const usedRows = new Set();

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

  // === 1패스: usedRows 적용 (다른 상품끼리 정확 매칭) ===
  for (let fi = 0; fi < fulfillments.length; fi++) {
    const f = fulfillments[fi];
    const optionValue = optionValues[fi];
    let bestRow = null;
    let bestRowIdx = -1;

    if (optionValue) {
      for (let i = 0; i < rowResults.length; i++) {
        if (usedRows.has(i)) continue;
        const row = rowResults[i];
        if (!row.optionText) continue;
        const rowKey = row.optionText.substring(0, 20);
        const optKey = optionValue.substring(0, 20);
        if (rowKey === optKey || row.optionText.includes(optKey) || optionValue.includes(rowKey)) {
          bestRow = row;
          bestRowIdx = i;
          break;
        }
      }
    }

    if (!bestRow && rowResults.length === 1 && !usedRows.has(0)) {
      bestRow = rowResults[0];
      bestRowIdx = 0;
    }

    if (bestRow && bestRowIdx >= 0) {
      usedRows.add(bestRowIdx);
      matched[fi] = { fulfillmentId: f.fulfillmentId, trackingNumber: bestRow.trackingNumber, carrier: bestRow.carrier };
      console.log(`[napkin 매칭] ${openMallOrderNumber}: fulfillment ${f.fulfillmentId} → 옵션 "${bestRow.optionText}", 송장=${bestRow.trackingNumber || "없음"}`);
    }
  }

  // === 2패스: 매칭 실패한 fulfillment → usedRows 무시하고 재매칭 ===
  for (let fi = 0; fi < fulfillments.length; fi++) {
    if (matched[fi]) continue;
    const f = fulfillments[fi];
    const optionValue = optionValues[fi];
    let bestRow = null;

    if (optionValue) {
      for (const row of rowResults) {
        if (!row.optionText) continue;
        const rowKey = row.optionText.substring(0, 20);
        const optKey = optionValue.substring(0, 20);
        if (rowKey === optKey || row.optionText.includes(optKey) || optionValue.includes(rowKey)) {
          bestRow = row;
          break;
        }
      }
    }

    if (bestRow) {
      matched[fi] = { fulfillmentId: f.fulfillmentId, trackingNumber: bestRow.trackingNumber, carrier: bestRow.carrier };
      console.log(`[napkin 매칭] ${openMallOrderNumber}: fulfillment ${f.fulfillmentId} → 2패스 재매칭 "${bestRow.optionText}", 송장=${bestRow.trackingNumber || "없음"}`);
    } else {
      // 최종 폴백: 첫 번째 송장번호
      const firstWithTracking = rowResults.find(r => r.trackingNumber);
      if (firstWithTracking) {
        matched[fi] = { fulfillmentId: f.fulfillmentId, trackingNumber: firstWithTracking.trackingNumber, carrier: firstWithTracking.carrier };
        console.log(`[napkin 매칭] ${openMallOrderNumber}: fulfillment ${f.fulfillmentId} → 첫 번째 송장 폴백: ${firstWithTracking.trackingNumber}`);
      } else {
        matched[fi] = { fulfillmentId: f.fulfillmentId, trackingNumber: null, carrier: null };
        console.log(`[napkin 매칭] ${openMallOrderNumber}: fulfillment ${f.fulfillmentId} → 매칭 실패 (옵션: "${optionValue}")`);
      }
    }
  }

  return matched;
}

/**
 * 기존 방식 (하위 호환) — 첫 번째 송장번호만
 */
async function findTrackingNumberLegacy(page, openMallOrderNumber) {
  const trackingInfo = await page.evaluate(() => {
    const tds = document.querySelectorAll("td");
    for (const td of tds) {
      const statusEl = td.querySelector("p.txtEm");
      if (!statusEl) continue;
      const status = statusEl.textContent.trim();
      if (!status.includes("배송") && !status.includes("발송")) continue;

      const links = td.querySelectorAll("p a");
      let carrier = null;
      let trackingNumber = null;

      for (const link of links) {
        const text = link.textContent.trim();
        const href = link.getAttribute("href") || "";
        const onclick = link.getAttribute("onclick") || "";

        if (href.includes("delivery_trace") && !link.classList.contains("sp-btn")) {
          carrier = text;
        }
        if (link.classList.contains("sp-btn") || (onclick.includes("delivery_trace") && /^\d+$/.test(text))) {
          trackingNumber = text;
        }
      }

      if (trackingNumber || carrier) {
        return { carrier, trackingNumber };
      }
    }
    return { carrier: null, trackingNumber: null };
  });

  if (trackingInfo.trackingNumber) {
    return {
      trackingNumber: trackingInfo.trackingNumber,
      carrier: trackingInfo.carrier || "자체배송",
      status: "found",
    };
  }

  return { trackingNumber: null, carrier: null, status: "tracking_not_found" };
}

module.exports = {
  getNapkinTrackingNumbers,
};
