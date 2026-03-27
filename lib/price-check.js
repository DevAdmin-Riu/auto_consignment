/**
 * 가격 비교 공통 모듈
 *
 * 정책:
 * - 오픈몰이 시스템가보다 5,000원 초과 비싸면 → STOP (담당자 확인 필요)
 * - 오픈몰이 더 싸면 → 진행 (가격 불일치 기록)
 * - 가격 추출 실패 → STOP (에러 로그)
 */

const PRICE_DIFF_THRESHOLD = 5000;

/**
 * 가격 비교 결과 판단
 * @param {number} openMallPrice - 오픈몰 단가 (VAT 포함)
 * @param {number} systemPriceExcludeVat - 시스템 단가 (VAT 별도)
 * @returns {{ shouldStop: boolean, priceDiff: number, systemPriceWithVat: number, reason: string|null }}
 */
function checkPrice(openMallPrice, systemPriceExcludeVat) {
  const systemPriceWithVat = Math.round((systemPriceExcludeVat || 0) * 1.1);
  const priceDiff = (openMallPrice || 0) - systemPriceWithVat;

  // 가격 추출 실패
  if (!openMallPrice) {
    return {
      shouldStop: true,
      priceDiff: 0,
      systemPriceWithVat,
      reason: "가격 추출 실패",
      isExtractionFailure: true,
    };
  }

  // 오픈몰이 더 비쌈 → STOP
  if (priceDiff > PRICE_DIFF_THRESHOLD) {
    return {
      shouldStop: true,
      priceDiff,
      systemPriceWithVat,
      reason: `오픈몰 ${openMallPrice}원 vs 시스템 ${systemPriceWithVat}원 (차이 +${priceDiff}원)`,
      isExtractionFailure: false,
    };
  }

  // 가격 차이 있지만 허용 범위 (10원 초과면 기록)
  const hasMismatch = Math.abs(priceDiff) > 10;

  return {
    shouldStop: false,
    priceDiff,
    systemPriceWithVat,
    reason: null,
    isExtractionFailure: false,
    hasMismatch,
  };
}

module.exports = {
  checkPrice,
  PRICE_DIFF_THRESHOLD,
};
