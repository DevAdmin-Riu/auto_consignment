/**
 * 협력사 설정
 *
 * 환경변수를 .env 파일에서 동적으로 로드
 * getter를 사용하여 매번 최신 값 참조
 */

const fs = require("fs");
const path = require("path");

// .env 파일 경로
const ENV_FILE_PATH = path.join(__dirname, "../.env");

// .env 파일 캐시 (파일 변경 시 자동 갱신)
let envCache = {};
let lastModified = 0;

/**
 * .env 파일을 파싱하여 캐시에 저장
 */
function loadEnvFile() {
  try {
    const stats = fs.statSync(ENV_FILE_PATH);
    const currentModified = stats.mtimeMs;

    // 파일이 변경되었거나 캐시가 비어있으면 다시 로드
    if (
      currentModified !== lastModified ||
      Object.keys(envCache).length === 0
    ) {
      const content = fs.readFileSync(ENV_FILE_PATH, "utf8");
      envCache = {};

      content.split("\n").forEach((line) => {
        // 주석과 빈 줄 무시
        line = line.trim();
        if (!line || line.startsWith("#")) return;

        const equalIndex = line.indexOf("=");
        if (equalIndex > 0) {
          const key = line.substring(0, equalIndex).trim();
          const value = line.substring(equalIndex + 1).trim();
          envCache[key] = value;
        }
      });

      lastModified = currentModified;
      console.log(
        "[config] .env 파일 로드됨:",
        Object.keys(envCache).length,
        "개 항목"
      );
    }
  } catch (error) {
    console.error("[config] .env 파일 로드 실패:", error.message);
  }
}

/**
 * 환경변수를 동적으로 가져오는 함수
 * .env 파일에서 먼저 찾고, 없으면 process.env에서 찾음
 */
function getEnv(key) {
  loadEnvFile();
  return envCache[key] || process.env[key] || "";
}

const VENDORS = {
  // 쿠팡 - 쿠팡페이 결제
  쿠팡: {
    key: "coupang",
    loginUrl: "https://login.coupang.com/login/login.pang",
    siteUrl: "https://www.coupang.com",
    get email() {
      return getEnv("COUPANG_EMAIL");
    },
    get password() {
      return getEnv("COUPANG_PASSWORD");
    },
    get paymentPin() {
      return getEnv("COUPANG_PAYMENT_PIN");
    },
    paymentMethod: "coupang_pay",
    automationType: "product_search",
  },
  // 냅킨코리아 - ISP/페이북 결제
  냅킨코리아: {
    key: "napkin",
    loginUrl: "https://www.napkinkorea.co.kr/member/login.html",
    siteUrl: "https://www.napkinkorea.co.kr",
    get userId() {
      return getEnv("NAPKIN_USER_ID");
    },
    get password() {
      return getEnv("NAPKIN_PASSWORD");
    },
    get ispPassword() {
      return getEnv("BC_ISP_PASSWORD");
    },
    paymentMethod: "card",
    automationType: "product_search",
  },
  // 배민상회 - 네이버페이 결제
  배민상회: {
    key: "baemin",
    loginUrl: "https://mart.baemin.com/login",
    siteUrl: "https://mart.baemin.com",
    get userId() {
      return getEnv("BAEMIN_USER_ID");
    },
    get password() {
      return getEnv("BAEMIN_PASSWORD");
    },
    paymentMethod: "naver_pay",
    get phone() {
      return getEnv("BAEMIN_PHONE");
    },
    automationType: "product_search",
  },
  // 네이버 스마트스토어 - 네이버페이 결제
  네이버: {
    key: "naver",
    loginUrl: "https://nid.naver.com/nidlogin.login",
    siteUrl: "https://smartstore.naver.com",
    get userId() {
      return getEnv("NAVER_USER_ID");
    },
    get password() {
      return getEnv("NAVER_PASSWORD");
    },
    get naverPayPin() {
      return getEnv("NAVER_PAY_PIN");
    },
    paymentMethod: "naver_pay",
    automationType: "product_search",
  },
  // 성원애드피아 - ISP/페이북 결제
  성원애드피아: {
    key: "swadpia",
    loginUrl: "https://www.swadpia.co.kr/member/re_login",
    siteUrl: "https://www.swadpia.co.kr",
    get email() {
      return getEnv("SWADPIA_EMAIL");
    },
    get password() {
      return getEnv("SWADPIA_PASSWORD");
    },
    get ispPassword() {
      return getEnv("BC_ISP_PASSWORD");
    },
    paymentMethod: "card",
    automationType: "product_search",
  },
  // 애드피아몰
  애드피아몰: {
    key: "adpia",
    loginUrl: "https://www.adpiamall.com/login",
    siteUrl: "https://www.adpiamall.com",
    get userId() {
      return getEnv("ADPIA_USER_ID");
    },
    get password() {
      return getEnv("ADPIA_PASSWORD");
    },
    get ispPassword() {
      return getEnv("BC_ISP_PASSWORD");
    },
    paymentMethod: "card",
    requiresProofing: true,
    hideSender: true,
    automationType: "product_search",
  },
  // 와우프레스
  와우프레스: {
    key: "wowpress",
    loginUrl: "https://www.wowpress.co.kr/member/login.html",
    siteUrl: "https://www.wowpress.co.kr",
    get userId() {
      return getEnv("WOWPRESS_USER_ID");
    },
    get password() {
      return getEnv("WOWPRESS_PASSWORD");
    },
    paymentMethod: "card",
    hideSender: true,
    automationType: "product_search",
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
 * 협력사 이름 별칭 매핑
 * 위탁용 협력사 등 실제 오픈몰과 다른 이름으로 등록된 경우
 */
const VENDOR_ALIASES = {
  위탁전용_임시협력사: "네이버",
  // 추후 다른 별칭 추가
};

/**
 * 협력사 이름으로 설정 찾기
 */
function getVendorByName(vendorName) {
  // 별칭 매핑 확인
  const resolvedName = VENDOR_ALIASES[vendorName] || vendorName;

  if (VENDORS[resolvedName]) {
    return wrapVendorConfig(resolvedName, VENDORS[resolvedName]);
  }
  for (const [name, config] of Object.entries(VENDORS)) {
    if (resolvedName.includes(name) || name.includes(resolvedName)) {
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
  getEnv,
};
