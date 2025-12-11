/**
 * 네이버 스마트스토어 모듈
 * TODO: 자동화 구현 예정
 */

/**
 * 네이버 주문 처리
 */
async function processNaverOrder(
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
    paymentMethod: "네이버페이",
  });
}

module.exports = {
  processNaverOrder,
};
