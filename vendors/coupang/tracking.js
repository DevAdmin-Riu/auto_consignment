/**
 * 쿠팡 송장번호 조회 모듈
 *
 * 주문번호로 쿠팡 주문상세에서 상품별 송장번호를 크롤링
 * - vendorItemId로 상품 블록 매칭
 * - "N개 중 M개" 파싱으로 분리/묶음 배송 구분
 * - 각 블록별 배송조회 클릭 → 개별 송장번호 추출
 */

const { coupangLogin } = require("./login");
const { normalizeCarrier } = require("../../lib/carrier");
const {
  createTrackingErrorCollector,
  TRACKING_STEPS,
  ERROR_CODES,
} = require("../../lib/automation-error");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 배송 정보 테이블 셀렉터
const DELIVERY_TABLE_SELECTOR =
  "#__next > div.my-area-body > div.my-area-contents > div > table > tbody > tr > td > table > tbody";

/**
 * 쿠팡 송장번호 조회 (상품별)
 * @param {Page} page - Puppeteer 페이지
 * @param {Object} vendor - 쿠팡 협력사 설정
 * @param {string[]} openMallOrderNumbers - 조회할 오픈몰 주문번호 배열
 * @param {Object} fulfillmentMap - { openMallOrderNumber: { fulfillments: [{ fulfillmentId, vendorItemId, productName }] } }
 * @returns {Object} { results: [{ fulfillmentId, trackingNumber, carrier }], automationErrors }
 */
async function getCoupangTrackingNumbers(page, vendor, openMallOrderNumbers, fulfillmentMap = {}, onTrackingFound = null) {
  console.log(`[coupang 송장조회] 시작: ${openMallOrderNumbers.length}건`);

  const results = [];
  const errorCollector = createTrackingErrorCollector("coupang");

  try {
    await coupangLogin(page, vendor);
    console.log("[coupang 송장조회] 로그인 완료");

    for (const openMallOrderNumber of openMallOrderNumbers) {
      try {
        console.log(`[coupang 송장조회] 주문번호 ${openMallOrderNumber} 검색 중...`);

        const fulfillmentInfo = fulfillmentMap?.[openMallOrderNumber];

        // fulfillments 정보가 있으면 상품별 매칭, 없으면 기존 방식
        if (fulfillmentInfo?.fulfillments?.length > 0) {
          const blockResults = await findTrackingNumbersByBlock(page, openMallOrderNumber);

          if (blockResults.length === 0) {
            console.log(`[coupang 송장조회] ${openMallOrderNumber} → 배송 블록 없음`);
            continue;
          }

          // fulfillment와 블록 매칭
          const matched = matchFulfillmentsToBlocks(
            fulfillmentInfo.fulfillments,
            blockResults,
            openMallOrderNumber,
          );

          for (const m of matched) {
            if (m.trackingNumber) {
              const carrier = normalizeCarrier(m.carrier);
              results.push({
                openMallOrderNumber,
                fulfillmentId: m.fulfillmentId,
                trackingNumber: m.trackingNumber,
                carrier,
              });
              if (onTrackingFound && m.fulfillmentId) {
                await onTrackingFound({ openMallOrderNumber, trackingNumber: m.trackingNumber, carrier, fulfillmentId: m.fulfillmentId });
              }
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
            console.log(`[coupang 송장조회] ${openMallOrderNumber} → ${trackingInfo.trackingNumber} (${trackingInfo.carrier})`);
          } else {
            console.log(`[coupang 송장조회] ${openMallOrderNumber} → 송장번호 없음`);
          }
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

/**
 * 주문상세 페이지에서 모든 상품 블록별 송장번호 조회
 * @returns {Array} [{ vendorItemId, quantityText, trackingNumber, carrier, blockIndex }]
 */
async function findTrackingNumbersByBlock(page, openMallOrderNumber) {
  const orderUrl = `https://mc.coupang.com/ssr/desktop/order/${openMallOrderNumber}`;
  console.log(`[coupang 송장조회] 주문 페이지 이동: ${orderUrl}`);

  await page.goto(orderUrl, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(2000);

  // 1. 모든 상품 블록 파싱
  const blocks = await page.evaluate(() => {
    const tables = document.querySelectorAll("table");
    const results = [];

    for (const table of tables) {
      const tbody = table.querySelector("tbody");
      if (!tbody) continue;

      // vendorItemId가 있는 링크 찾기
      const link = tbody.querySelector('a[href*="vendorItemId="]');
      if (!link) continue;

      const href = link.getAttribute("href") || "";
      const vidMatch = href.match(/vendorItemId=(\d+)/);
      if (!vidMatch) continue;

      const vendorItemId = vidMatch[1];

      // 상품명
      const nameSpan = tbody.querySelector('span[color="#111111"]');
      const productName = nameSpan?.textContent?.trim() || "";

      // 수량 텍스트 ("3개", "2개 중 1개" 등)
      const allSpans = tbody.querySelectorAll("span");
      let quantityText = "";
      for (const span of allSpans) {
        const text = span.textContent?.trim() || "";
        if (/^\d+개/.test(text)) {
          quantityText = text;
        }
      }

      // 배송조회 버튼
      const buttons = tbody.querySelectorAll("button");
      let hasDeliveryBtn = false;
      let deliveryBtnIndex = -1;
      for (let i = 0; i < buttons.length; i++) {
        if (buttons[i].textContent?.trim() === "배송 조회") {
          hasDeliveryBtn = true;
          deliveryBtnIndex = i;
          break;
        }
      }

      results.push({
        vendorItemId,
        productName: productName.substring(0, 50),
        quantityText,
        hasDeliveryBtn,
        tableIndex: Array.from(document.querySelectorAll("table")).indexOf(table),
      });
    }

    return results;
  });

  console.log(`[coupang 송장조회] ${openMallOrderNumber}: 상품 블록 ${blocks.length}개 발견`);
  for (const b of blocks) {
    console.log(`  - vendorItemId=${b.vendorItemId}, ${b.quantityText}, 배송조회=${b.hasDeliveryBtn ? "있음" : "없음"}, ${b.productName}`);
  }

  // 2. 각 블록별 배송조회 클릭 → 송장번호 추출
  const trackingResults = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block.hasDeliveryBtn) {
      trackingResults.push({
        vendorItemId: block.vendorItemId,
        quantityText: block.quantityText,
        trackingNumber: null,
        carrier: null,
        blockIndex: i,
      });
      continue;
    }

    try {
      // 배송조회 버튼 클릭 (블록별로)
      const clicked = await page.evaluate((tableIdx) => {
        const tables = document.querySelectorAll("table");
        const table = tables[tableIdx];
        if (!table) return false;
        const btn = Array.from(table.querySelectorAll("button")).find(b => b.textContent?.trim() === "배송 조회");
        if (btn) { btn.click(); return true; }
        return false;
      }, block.tableIndex);

      if (!clicked) {
        trackingResults.push({
          vendorItemId: block.vendorItemId,
          quantityText: block.quantityText,
          trackingNumber: null,
          carrier: null,
          blockIndex: i,
        });
        continue;
      }

      console.log(`[coupang 송장조회] 블록 ${i}: 배송조회 클릭 (vendorItemId=${block.vendorItemId})`);
      await delay(2000);

      // 송장번호 추출
      const trackingInfo = await page.evaluate((baseSelector) => {
        const tbody = document.querySelector(baseSelector);
        if (!tbody) return null;

        let carrier = null;
        let trackingNumber = null;
        const allText = tbody.textContent || "";
        const isRocketDelivery = allText.includes("로켓배송");

        if (isRocketDelivery) {
          carrier = "로켓배송";
          const allRows = tbody.querySelectorAll("tr");
          for (const row of allRows) {
            const cells = row.querySelectorAll("td");
            for (let j = 0; j < cells.length - 1; j++) {
              const label = cells[j].textContent?.trim() || "";
              const value = cells[j + 1].textContent?.trim() || "";
              if (label.includes("송장")) {
                if (value && /^[\d-]+$/.test(value) && value.length >= 10) {
                  trackingNumber = value.replace(/-/g, "");
                  break;
                }
              }
            }
            if (trackingNumber) break;
          }
        } else {
          const rows = tbody.querySelectorAll(":scope > tr");
          for (const row of rows) {
            const labelCell = row.querySelector("td:first-child");
            const valueCell = row.querySelector("td:last-child");
            if (!labelCell || !valueCell) continue;
            const label = labelCell.textContent?.trim() || "";
            const value = valueCell.textContent?.trim() || "";
            if (label.includes("택배사") || label.includes("배송사")) carrier = value;
            if (label.includes("송장") && value && /^[\d-]+$/.test(value) && value.length >= 10) {
              trackingNumber = value.replace(/-/g, "");
            }
          }
        }

        return { carrier, trackingNumber };
      }, DELIVERY_TABLE_SELECTOR);

      trackingResults.push({
        vendorItemId: block.vendorItemId,
        quantityText: block.quantityText,
        trackingNumber: trackingInfo?.trackingNumber || null,
        carrier: trackingInfo?.carrier || null,
        blockIndex: i,
      });

      if (trackingInfo?.trackingNumber) {
        console.log(`[coupang 송장조회] 블록 ${i}: ${trackingInfo.trackingNumber} (${trackingInfo.carrier})`);
      } else {
        console.log(`[coupang 송장조회] 블록 ${i}: 송장번호 없음`);
      }

      // 배송조회 팝업 닫기 (뒤로가기로 원래 페이지 복원)
      await page.goto(`https://mc.coupang.com/ssr/desktop/order/${openMallOrderNumber}`, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
      await delay(1000);

    } catch (e) {
      console.error(`[coupang 송장조회] 블록 ${i} 에러:`, e.message);
      trackingResults.push({
        vendorItemId: block.vendorItemId,
        quantityText: block.quantityText,
        trackingNumber: null,
        carrier: null,
        blockIndex: i,
      });
    }
  }

  return trackingResults;
}

/**
 * fulfillment와 상품 블록 매칭
 *
 * 매칭 로직:
 * - vendorItemId로 매칭
 * - "N개 중 1개" → 블록 순서대로 fulfillment 1:1 매칭
 * - "N개" 또는 "N개 중 N개" → 해당 vendorItemId fulfillment 전부 같은 송장
 */
function matchFulfillmentsToBlocks(fulfillments, blockResults, openMallOrderNumber) {
  const matched = [];

  // vendorItemId별로 fulfillment 그룹핑
  const fulfillmentsByVid = {};
  for (const f of fulfillments) {
    if (!fulfillmentsByVid[f.vendorItemId]) {
      fulfillmentsByVid[f.vendorItemId] = [];
    }
    fulfillmentsByVid[f.vendorItemId].push(f);
  }

  // vendorItemId별로 블록 그룹핑
  const blocksByVid = {};
  for (const b of blockResults) {
    if (!blocksByVid[b.vendorItemId]) {
      blocksByVid[b.vendorItemId] = [];
    }
    blocksByVid[b.vendorItemId].push(b);
  }

  for (const [vid, fList] of Object.entries(fulfillmentsByVid)) {
    const bList = blocksByVid[vid] || [];

    if (bList.length === 0) {
      // 블록 없음 → 매칭 불가
      for (const f of fList) {
        matched.push({ fulfillmentId: f.fulfillmentId, trackingNumber: null, carrier: null });
      }
      console.log(`[coupang 매칭] ${openMallOrderNumber}: vendorItemId=${vid} 블록 없음`);
      continue;
    }

    // "N개 중 M개" 파싱
    const isSplit = bList.some(b => {
      const m = b.quantityText.match(/(\d+)개\s*중\s*(\d+)개/);
      return m && parseInt(m[2]) < parseInt(m[1]); // M < N → 분리 배송
    });

    if (isSplit && bList.length === fList.length) {
      // 분리 배송: 블록 순서대로 1:1 매칭
      for (let i = 0; i < fList.length; i++) {
        const block = bList[i] || {};
        matched.push({
          fulfillmentId: fList[i].fulfillmentId,
          trackingNumber: block.trackingNumber || null,
          carrier: block.carrier || null,
        });
        console.log(`[coupang 매칭] ${openMallOrderNumber}: fulfillment ${fList[i].fulfillmentId} → 블록 ${i} (분리), 송장=${block.trackingNumber || "없음"}`);
      }
    } else {
      // 묶음 배송 또는 단일: 첫 번째 블록 송장을 전체에 적용
      const firstBlock = bList[0] || {};
      for (const f of fList) {
        matched.push({
          fulfillmentId: f.fulfillmentId,
          trackingNumber: firstBlock.trackingNumber || null,
          carrier: firstBlock.carrier || null,
        });
      }
      console.log(`[coupang 매칭] ${openMallOrderNumber}: vendorItemId=${vid} 묶음, 송장=${firstBlock.trackingNumber || "없음"} → fulfillment ${fList.length}개`);
    }
  }

  return matched;
}

/**
 * 기존 방식 (하위 호환) — fulfillmentMap 없을 때
 */
async function findTrackingNumberLegacy(page, openMallOrderNumber) {
  const orderUrl = `https://mc.coupang.com/ssr/desktop/order/${openMallOrderNumber}`;
  console.log(`[coupang 송장조회] 주문 페이지 이동: ${orderUrl}`);

  await page.goto(orderUrl, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(2000);

  // 첫 번째 배송조회 버튼 찾기
  const deliveryBtn = await page.evaluate(() => {
    const buttons = document.querySelectorAll("button");
    for (const btn of buttons) {
      if (btn.textContent?.trim() === "배송 조회") {
        btn.click();
        return true;
      }
    }
    return false;
  });

  if (!deliveryBtn) {
    return { trackingNumber: null, carrier: null, status: "no_delivery_button" };
  }

  console.log(`[coupang 송장조회] 배송 조회 버튼 클릭`);
  await delay(2000);

  const trackingInfo = await page.evaluate((baseSelector) => {
    const tbody = document.querySelector(baseSelector);
    if (!tbody) return null;

    let carrier = null;
    let trackingNumber = null;
    const allText = tbody.textContent || "";
    const isRocketDelivery = allText.includes("로켓배송");

    if (isRocketDelivery) {
      carrier = "로켓배송";
      const allRows = tbody.querySelectorAll("tr");
      for (const row of allRows) {
        const cells = row.querySelectorAll("td");
        for (let j = 0; j < cells.length - 1; j++) {
          const label = cells[j].textContent?.trim() || "";
          const value = cells[j + 1].textContent?.trim() || "";
          if (label.includes("송장") && value && /^[\d-]+$/.test(value) && value.length >= 10) {
            trackingNumber = value.replace(/-/g, "");
            break;
          }
        }
        if (trackingNumber) break;
      }
    } else {
      const rows = tbody.querySelectorAll(":scope > tr");
      for (const row of rows) {
        const labelCell = row.querySelector("td:first-child");
        const valueCell = row.querySelector("td:last-child");
        if (!labelCell || !valueCell) continue;
        const label = labelCell.textContent?.trim() || "";
        const value = valueCell.textContent?.trim() || "";
        if (label.includes("택배사") || label.includes("배송사")) carrier = value;
        if (label.includes("송장") && value && /^[\d-]+$/.test(value) && value.length >= 10) {
          trackingNumber = value.replace(/-/g, "");
        }
      }
    }

    return { carrier, trackingNumber };
  }, DELIVERY_TABLE_SELECTOR);

  if (trackingInfo?.trackingNumber) {
    return { trackingNumber: trackingInfo.trackingNumber, carrier: trackingInfo.carrier || "알 수 없음", status: "found" };
  }

  return { trackingNumber: null, carrier: null, status: "tracking_not_found" };
}

module.exports = {
  getCoupangTrackingNumbers,
  findTrackingNumbersByBlock,
  findTrackingNumberLegacy,
};
