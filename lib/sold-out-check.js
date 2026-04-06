/**
 * 품절 체크 공통 모듈
 *
 * 페이지에서 품절 키워드를 감지하고,
 * 담당자 확인 + soldOut 기록 + 발송(PENDING 전환)까지 처리
 */

const {
  createNeedsManagerVerification,
  sendPurchaseOrder,
  updatePoLineN8nInfo,
} = require("./graphql-client");

/**
 * 페이지에서 품절 키워드 감지
 * @param {Page} page - Puppeteer 페이지
 * @returns {boolean} 품절 여부
 */
async function checkSoldOutOnPage(page) {
  try {
    return await page.evaluate(() => {
      const text = document.body?.innerText || "";
      return text.includes("품절") || text.includes("sold out") || text.includes("일시품절") || text.includes("판매중지");
    });
  } catch (e) {
    return false;
  }
}

/**
 * 품절 처리 (담당자 확인 + soldOut 기록 + 발송)
 * @param {Object} params
 * @param {string} params.authToken
 * @param {string} params.purchaseOrderId
 * @param {string} params.productVariantVendorId
 * @param {string} params.productSku
 * @param {string} params.productName
 * @param {string[]} params.poLineIds - 해당 발주의 poLine ID 배열
 * @param {string} params.vendor - 벤더명 (로그용)
 * @returns {{ handled: boolean }} 처리 여부
 */
async function handleSoldOut({ authToken, purchaseOrderId, productVariantVendorId, productSku, productName, poLineIds, vendor }) {
  const reason = `품절: ${productSku} (${productName})`;
  console.log(`[${vendor}] ⚠️ 품절 감지 → 담당자 확인 + 발송 처리: ${productSku}`);

  try {
    // 1. 담당자 확인 필요
    if (productVariantVendorId) {
      await createNeedsManagerVerification(authToken, [{
        productVariantVendorId,
        purchaseOrderId,
        reason,
      }]);
    }

    // 2. poLine soldOut 기록
    for (const plId of (poLineIds || [])) {
      try {
        await updatePoLineN8nInfo(authToken, plId, { soldOut: true, lastError: reason });
      } catch (e) {
        console.error(`[${vendor}] poLine 품절 기록 에러 (무시):`, e.message);
      }
    }

    // 3. 발송 (DRAFT → PENDING)
    await sendPurchaseOrder(authToken, purchaseOrderId);
    console.log(`[${vendor}] ✅ 품절 → 접수대기 전환 완료`);

    return { handled: true };
  } catch (e) {
    console.error(`[${vendor}] 품절 처리 에러 (무시):`, e.message);
    return { handled: false };
  }
}

module.exports = {
  checkSoldOutOnPage,
  handleSoldOut,
};
