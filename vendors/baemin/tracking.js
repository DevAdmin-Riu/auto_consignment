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
const { sendAlertMail } = require("../../lib/alert-mail");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 배민상회 송장번호 조회 (상품별)
 * @param {Page} page
 * @param {Object} vendor
 * @param {string[]} openMallOrderNumbers
 * @param {Object} fulfillmentMap - { openMallOrderNumber: { fulfillments: [{ fulfillmentId, vendorItemId, openMallOptions }] } }
 */
async function getBaeminTrackingNumbers(page, vendor, openMallOrderNumbers, fulfillmentMap = {}, onTrackingFound = null) {
  console.log(`[baemin 송장조회] 시작: ${openMallOrderNumbers.length}건`);

  const errorCollector = createTrackingErrorCollector("baemin");
  const results = [];
  const allAlerts = []; // 지연/취소 수집

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

        // 배송지연/취소 체크 (배송조회 버튼 기준으로 블록 탐색)
        const alertInfo = await page.evaluate(() => {
          const alerts = [];
          const deliveryBtns = document.querySelectorAll('[data-action-button-click-event-label="배송조회"]');

          for (const btn of deliveryBtns) {
            // 버튼에서 위로 올라가며 컨테이너 찾기
            let container = btn.parentElement;
            while (container && !container.querySelector('a[href*="/goods/detail/"]')) {
              container = container.parentElement;
            }
            if (!container) continue;

            // 상태 텍스트: 컨테이너 안의 모든 텍스트에서 키워드 검색
            const allText = container.innerText || "";
            let state = null;
            if (allText.includes("취소")) state = "취소";
            else if (allText.includes("품절")) state = "품절";
            else if (allText.includes("지연")) state = "지연";

            if (state) {
              // 상품명
              const nameLink = container.querySelectorAll('a[href*="/goods/detail/"]');
              let productName = "알 수 없음";
              for (const link of nameLink) {
                const text = link.textContent?.trim();
                if (text && text.length > 5) { productName = text; break; }
              }
              alerts.push({ state, productName });
            }
          }
          return alerts;
        });

        if (alertInfo.length > 0) {
          const orderUrl = `https://mart.baemin.com/mymart/order/detail/${openMallOrderNumber}`;
          console.log(`[baemin 송장조회] ⚠️ ${openMallOrderNumber}: 이상 상태 감지 ${alertInfo.length}건`);
          for (const a of alertInfo) {
            allAlerts.push({ openMallOrderNumber, orderUrl, ...a });
          }
        }

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

    // 지연/취소 모아서 메일 발송
    if (allAlerts.length > 0) {
      const rows = allAlerts.map(a =>
        `<tr>
          <td style="padding:6px 10px;border:1px solid #ddd;">${a.openMallOrderNumber}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;color:red;font-weight:bold;">${a.state}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;">${a.productName}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;"><a href="${a.orderUrl}">주문상세</a></td>
        </tr>`
      ).join("");

      sendAlertMail({
        subject: `배민상회 배송 이상 ${allAlerts.length}건`,
        body: `<p>배민상회 송장조회 중 지연/취소가 감지되었습니다.</p>
        <table style="border-collapse:collapse;font-size:13px;">
          <tr style="background:#f0f0f0;">
            <th style="padding:6px 10px;border:1px solid #ddd;">주문번호</th>
            <th style="padding:6px 10px;border:1px solid #ddd;">상태</th>
            <th style="padding:6px 10px;border:1px solid #ddd;">상품명</th>
            <th style="padding:6px 10px;border:1px solid #ddd;">링크</th>
          </tr>
          ${rows}
        </table>`,
        vendor: "배민상회",
      });
      console.log(`[baemin 송장조회] 이상 알림 메일 발송: ${allAlerts.length}건`);
    }

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

      // 상품명, 옵션, 가격 추출
      // 배민 구조:
      //   container > a (이미지링크) + div.info (정보) + div.buttons (버튼들)
      //   div.info > a > div (상품명) + div (가격) + div (옵션)
      let productName = "";
      let optionText = "";
      let priceText = "";

      // 버튼 컨테이너가 아닌 직계 div = 정보 컨테이너
      const directChildren = container.querySelectorAll(':scope > div');
      for (const child of directChildren) {
        // 버튼 컨테이너는 스킵
        if (child.querySelector('[data-action-button-click-event-label]')) continue;

        // 정보 컨테이너의 직계 자식들 순회
        const infoChildren = child.children;
        for (const el of infoChildren) {
          const text = el.textContent?.trim() || "";
          if (!text) continue;

          if (el.tagName === 'A') {
            // 상품명 링크
            productName = text;
          } else if (text.match(/[\d,]+원\s*\/\s*수량/)) {
            // 가격
            priceText = text;
          } else if (text.length < 200) {
            // 나머지 = 옵션
            optionText = text;
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

    // vendorItemId == goodsId
    if (f.vendorItemId) {
      for (let i = 0; i < blockResults.length; i++) {
        if (usedBlocks.has(i)) continue;
        if (blockResults[i].goodsId === f.vendorItemId) {
          if (optionValue && blockResults[i].optionText) {
            const blockKey = blockResults[i].optionText.substring(0, 20);
            const optKey = optionValue.substring(0, 20);
            if (blockKey === optKey || blockResults[i].optionText.includes(optKey) || optionValue.includes(blockKey)) {
              bestBlock = blockResults[i];
              bestBlockIdx = i;
              break;
            }
          } else {
            bestBlock = blockResults[i];
            bestBlockIdx = i;
            break;
          }
        }
      }
    }

    // 옵션 텍스트 매칭
    if (!bestBlock && optionValue) {
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

    // 블록 1개 + 미사용이면 자동 매칭
    if (!bestBlock && blockResults.length === 1 && !usedBlocks.has(0)) {
      bestBlock = blockResults[0];
      bestBlockIdx = 0;
    }

    if (bestBlock && bestBlockIdx >= 0) {
      usedBlocks.add(bestBlockIdx);
      matched[fi] = { fulfillmentId: f.fulfillmentId, trackingNumber: bestBlock.trackingNumber, carrier: bestBlock.carrier };
      console.log(`[baemin 매칭] ${openMallOrderNumber}: fulfillment ${f.fulfillmentId} → 옵션 "${bestBlock.optionText}", 송장=${bestBlock.trackingNumber || "없음"}`);
    }
  }

  // === 2패스: 매칭 실패한 fulfillment → usedBlocks 무시하고 재매칭 ===
  for (let fi = 0; fi < fulfillments.length; fi++) {
    if (matched[fi]) continue;
    const f = fulfillments[fi];
    const optionValue = optionValues[fi];
    let bestBlock = null;

    // vendorItemId로 재매칭 (usedBlocks 무시)
    if (f.vendorItemId) {
      for (const block of blockResults) {
        if (block.goodsId === f.vendorItemId) {
          if (optionValue && block.optionText) {
            const blockKey = block.optionText.substring(0, 20);
            const optKey = optionValue.substring(0, 20);
            if (blockKey === optKey || block.optionText.includes(optKey) || optionValue.includes(blockKey)) {
              bestBlock = block;
              break;
            }
          } else {
            bestBlock = block;
            break;
          }
        }
      }
    }

    // 옵션 텍스트로 재매칭 (usedBlocks 무시)
    if (!bestBlock && optionValue) {
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

    if (bestBlock) {
      matched[fi] = { fulfillmentId: f.fulfillmentId, trackingNumber: bestBlock.trackingNumber, carrier: bestBlock.carrier };
      console.log(`[baemin 매칭] ${openMallOrderNumber}: fulfillment ${f.fulfillmentId} → 2패스 재매칭 "${bestBlock.optionText}", 송장=${bestBlock.trackingNumber || "없음"}`);
    } else {
      // 최종 폴백: 첫 번째 송장번호
      const firstWithTracking = blockResults.find(b => b.trackingNumber);
      if (firstWithTracking) {
        matched[fi] = { fulfillmentId: f.fulfillmentId, trackingNumber: firstWithTracking.trackingNumber, carrier: firstWithTracking.carrier };
        console.log(`[baemin 매칭] ${openMallOrderNumber}: fulfillment ${f.fulfillmentId} → 첫 번째 송장 폴백: ${firstWithTracking.trackingNumber}`);
      } else {
        matched[fi] = { fulfillmentId: f.fulfillmentId, trackingNumber: null, carrier: null };
        console.log(`[baemin 매칭] ${openMallOrderNumber}: fulfillment ${f.fulfillmentId} → 매칭 실패 (옵션: "${optionValue}")`);
      }
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
