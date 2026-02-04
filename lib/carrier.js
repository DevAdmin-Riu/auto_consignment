/**
 * 택배사 매핑 모듈
 *
 * 모든 협력사 tracking.js에서 공통으로 사용
 */

// 택배사 정규화 매핑 (다양한 표기 → 표준 이름)
const CARRIER_MAPPINGS = {
  // CJ대한통운
  CJ대한통운: "CJ대한통운",
  대한통운: "CJ대한통운",
  CJ: "CJ대한통운",

  // 로젠택배
  로젠택배: "로젠택배",
  로젠: "로젠택배",

  // 롯데택배
  롯데택배: "롯데택배",
  롯데글로벌로지스: "롯데택배",
  롯데: "롯데택배",

  // 우체국
  우체국: "우체국",
  우체국택배: "우체국",
  우체국소포: "우체국",

  // 한진택배
  한진택배: "한진택배",
  한진: "한진택배",

  // 대신택배
  대신택배: "대신택배",
  대신: "대신택배",

  // 일양로지스
  일양로지스: "일양로지스",
  일양: "일양로지스",

  // 건영택배
  건영택배: "건영택배",
  건영: "건영택배",

  // 경동택배
  경동택배: "경동택배",
  경동: "경동택배",

  // 천일택배
  천일택배: "천일택배",
  천일: "천일택배",

  // 쿠팡
  쿠팡: "로켓배송",
  쿠팡로켓배송: "로켓배송",
  로켓배송: "로켓배송",
  쿠팡로켓: "로켓배송",
  로켓배송: "로켓배송",

  // 자체배송
  자체배송: "자체배송",
};

/**
 * 택배사 이름 정규화
 * @param {string} carrier - 원본 택배사 이름
 * @returns {string} 정규화된 택배사 이름
 */
function normalizeCarrier(carrier) {
  if (!carrier) return "자체배송";

  // 띄어쓰기 제거
  const normalized = carrier.replace(/\s+/g, "");

  // 매핑에서 찾기
  if (CARRIER_MAPPINGS[normalized]) {
    return CARRIER_MAPPINGS[normalized];
  }

  // 매핑에 없으면 원본 반환 (띄어쓰기 제거된 버전)
  return normalized;
}

module.exports = {
  CARRIER_MAPPINGS,
  normalizeCarrier,
};
