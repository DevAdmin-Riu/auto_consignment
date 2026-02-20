/**
 * 와우프레스 모듈
 * TODO: 자동화 구현 예정
 */

/**
 * 와우프레스 주문 처리
 */
async function processWowpressOrder(
  res,
  page,
  vendor,
  { productUrl, productName, quantity, orderData },
) {
  return res.json({
    success: false,
    vendor: vendor.name,
    automationType: "product_search",
    message: `[${vendor.name}] 자동화 구현 예정. 수동 발주 필요.`,
    siteUrl: vendor.siteUrl,
    paymentMethod: "카드결제",
    notes: "보내는분을 포장보스로 변경 필요",
  });
}

module.exports = {
  processWowpressOrder,
};
