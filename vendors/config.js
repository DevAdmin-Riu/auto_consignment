/**
 * 협력사 설정
 *
 * 주의: dotenv 사용 금지 (puppeteer-real-browser와 충돌)
 * 환경변수는 browser.js의 loadEnv()로 로드됨
 */

// 환경변수를 동적으로 가져오는 함수
const getEnv = (key) => process.env[key] || "";

const VENDORS = {
  // 쿠팡 - 쿠팡페이 결제
  쿠팡: {
    key: "coupang",
    loginUrl: "https://login.coupang.com/login/login.pang",
    siteUrl: "https://www.coupang.com",
    get email() { return getEnv("COUPANG_EMAIL"); },
    get password() { return getEnv("COUPANG_PASSWORD"); },
    get paymentPin() { return getEnv("COUPANG_PAYMENT_PIN"); },
    paymentMethod: "coupang_pay",
    automationType: "product_search",
  },
  // 냅킨코리아 - 카드 결제
  냅킨코리아: {
    key: "napkin",
    loginUrl: "https://napkinkorea.com/member/login.html",
    siteUrl: "https://napkinkorea.com",
    get userId() { return getEnv("NAPKIN_USER_ID"); },
    get password() { return getEnv("NAPKIN_PASSWORD"); },
    paymentMethod: "card",
    automationType: "product_search",
  },
  // 배민상회 - 네이버페이 결제
  배민상회: {
    key: "baemin",
    loginUrl: "https://mart.baemin.com/login",
    siteUrl: "https://mart.baemin.com",
    get userId() { return getEnv("BAEMIN_USER_ID"); },
    get password() { return getEnv("BAEMIN_PASSWORD"); },
    paymentMethod: "naver_pay",
    get phone() { return getEnv("BAEMIN_PHONE"); },
    automationType: "product_search",
  },
  // 네이버 스마트스토어 - 네이버페이 결제
  네이버: {
    key: "naver",
    loginUrl: "https://nid.naver.com/nidlogin.login",
    siteUrl: "https://smartstore.naver.com",
    get userId() { return getEnv("NAVER_USER_ID"); },
    get password() { return getEnv("NAVER_PASSWORD"); },
    paymentMethod: "naver_pay",
    automationType: "product_search",
  },
  // 성원애드피아 - 교정확인 필요
  성원애드피아: {
    key: "sungwon",
    loginUrl: "https://www.sungwonadpia.co.kr/member/login.html",
    siteUrl: "https://www.sungwonadpia.co.kr",
    get userId() { return getEnv("SUNGWON_USER_ID"); },
    get password() { return getEnv("SUNGWON_PASSWORD"); },
    paymentMethod: "card",
    requiresProofing: true,
    hideSender: true,
    automationType: "needs_confirmation",
  },
  // 애드피아몰 - 교정확인 필요
  애드피아몰: {
    key: "adpia",
    loginUrl: "https://www.adpiamall.co.kr/member/login.html",
    siteUrl: "https://www.adpiamall.co.kr",
    get userId() { return getEnv("ADPIA_USER_ID"); },
    get password() { return getEnv("ADPIA_PASSWORD"); },
    paymentMethod: "card",
    requiresProofing: true,
    hideSender: true,
    automationType: "needs_confirmation",
  },
  // 와우프레스
  와우프레스: {
    key: "wowpress",
    loginUrl: "https://www.wowpress.co.kr/member/login.html",
    siteUrl: "https://www.wowpress.co.kr",
    get userId() { return getEnv("WOWPRESS_USER_ID"); },
    get password() { return getEnv("WOWPRESS_PASSWORD"); },
    paymentMethod: "card",
    hideSender: true,
    automationType: "product_search",
  },
  // 티엠데코
  티엠데코: {
    key: "tmdeco",
    siteUrl: "https://smartstore.naver.com/tmdeco",
    paymentMethod: "naver_pay",
    requiresKakaoDesign: true,
    automationType: "needs_kakao",
  },
  // 다원
  다원: {
    key: "dawon",
    siteUrl: "https://smartstore.naver.com/dawon",
    paymentMethod: "bank_transfer",
    requiresKakaoFile: true,
    automationType: "needs_kakao",
  },
  // 마플
  마플: {
    key: "marpple",
    loginUrl: "https://www.marpple.com/kr/login",
    siteUrl: "https://www.marpple.com",
    get email() { return getEnv("MARPPLE_EMAIL"); },
    get password() { return getEnv("MARPPLE_PASSWORD"); },
    paymentMethod: "card",
    automationType: "reorder",
  },
};

// 자동화 타입 분류
const AUTOMATION_TYPES = {
  product_search: "상품 검색 후 주문",
  reorder: "과거 주문에서 재주문",
  needs_confirmation: "교정확인 필요 (수동)",
  needs_kakao: "카카오톡 협의 필요 (수동)",
};

/**
 * 협력사 설정을 getter 보존하여 반환
 * (spread 연산자는 getter를 즉시 평가하므로 사용하지 않음)
 */
function wrapVendorConfig(name, config) {
  const result = Object.create(null);
  result.name = name;

  // getter를 보존하면서 프로퍼티 복사
  const descriptors = Object.getOwnPropertyDescriptors(config);
  Object.defineProperties(result, descriptors);

  return result;
}

/**
 * 협력사 이름으로 설정 찾기
 */
function getVendorByName(vendorName) {
  if (VENDORS[vendorName]) {
    return wrapVendorConfig(vendorName, VENDORS[vendorName]);
  }
  for (const [name, config] of Object.entries(VENDORS)) {
    if (vendorName.includes(name) || name.includes(vendorName)) {
      return wrapVendorConfig(name, config);
    }
  }
  return null;
}

/**
 * 협력사 키로 설정 찾기
 */
function getVendorByKey(key) {
  for (const [name, config] of Object.entries(VENDORS)) {
    if (config.key === key) {
      return wrapVendorConfig(name, config);
    }
  }
  return null;
}

module.exports = {
  VENDORS,
  AUTOMATION_TYPES,
  getVendorByName,
  getVendorByKey,
};
