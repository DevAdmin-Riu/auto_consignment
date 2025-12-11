/**
 * 냅킨코리아 모듈
 * TODO: 자동화 구현 예정
 */

/**
 * 냅킨코리아 주문 처리
 */
async function processNapkinOrder(
  res,
  page,
  vendor,
  { productUrl, productName, quantity }
) {
  return res.json({
    success: false,
    vendor: vendor.name,
    automationType: "product_search",
    message: `[${vendor.name}] 자동화 구현 예정. 수동 발주 필요.`,
    siteUrl: vendor.siteUrl,
    paymentMethod: "카드결제",
  });
}

module.exports = {
  processNapkinOrder,
};
