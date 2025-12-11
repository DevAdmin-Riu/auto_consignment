/**
 * 배민상회 모듈
 * TODO: 자동화 구현 예정
 */

/**
 * 배민상회 주문 처리
 */
async function processBaeminOrder(
  res,
  page,
  vendor,
  { productUrl, productName, quantity, orderData }
) {
  return res.json({
    success: false,
    vendor: vendor.name,
    automationType: "product_search",
    message: `[${vendor.name}] 자동화 구현 예정. 수동 발주 필요.`,
    siteUrl: vendor.siteUrl,
    paymentMethod: "네이버페이",
    notes: "법인폰(010-7749-7515) 기재 필수, 고객폰 안됨",
  });
}

module.exports = {
  processBaeminOrder,
};
