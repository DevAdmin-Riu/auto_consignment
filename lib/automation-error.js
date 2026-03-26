/**
 * 자동화 에러 수집 모듈
 *
 * order.js (자동 위탁 주문) 및 tracking.js (자동 송장번호 등록) 실패 시
 * 에러 정보를 수집하여 백엔드 mutation으로 전송하기 위한 헬퍼
 */

// 표준화된 에러 코드
const ERROR_CODES = {
  // 공통
  LOGIN_FAILED: "LOGIN_FAILED",
  ELEMENT_NOT_FOUND: "ELEMENT_NOT_FOUND",
  TIMEOUT: "TIMEOUT",
  NAVIGATION_FAILED: "NAVIGATION_FAILED",
  CLICK_FAILED: "CLICK_FAILED",
  INPUT_FAILED: "INPUT_FAILED",
  UNEXPECTED_ERROR: "UNEXPECTED_ERROR",

  // 주문 관련
  CART_CLEAR_FAILED: "CART_CLEAR_FAILED",
  PRODUCT_NOT_FOUND: "PRODUCT_NOT_FOUND",
  OPTION_SELECT_FAILED: "OPTION_SELECT_FAILED",
  QUANTITY_SET_FAILED: "QUANTITY_SET_FAILED",
  ADD_TO_CART_FAILED: "ADD_TO_CART_FAILED",
  ORDER_FAILED: "ORDER_FAILED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  OUT_OF_STOCK: "OUT_OF_STOCK",

  // 송장조회 관련
  EXTRACTION_FAILED: "EXTRACTION_FAILED",
};

// 자동화 타입
const AUTOMATION_TYPES = {
  ORDER: "ORDER",
  TRACKING: "TRACKING",
};

// 주문 단계
const ORDER_STEPS = {
  LOGIN: "LOGIN",
  CART_CLEARING: "CART_CLEARING",
  PRODUCT_SEARCH: "PRODUCT_SEARCH",
  OPTION_SELECTION: "OPTION_SELECTION",
  QUANTITY_SETTING: "QUANTITY_SETTING",
  ADD_TO_CART: "ADD_TO_CART",
  ORDER_PLACEMENT: "ORDER_PLACEMENT",
  PAYMENT: "PAYMENT",
  ORDER_CONFIRMATION: "ORDER_CONFIRMATION",
  SAVE_RESULTS: "ORDER_CONFIRMATION", // 백엔드 enum에 SAVE_RESULTS 없음 → ORDER_CONFIRMATION 사용
};

// 송장조회 단계
const TRACKING_STEPS = {
  LOGIN: "LOGIN",
  PAGE_NAVIGATION: "PAGE_NAVIGATION",
  BUTTON_FINDING: "BUTTON_FINDING",
  EXTRACTION: "EXTRACTION",
};

/**
 * 에러 메시지에서 에러 코드 추론
 * @param {string} message - 에러 메시지
 * @param {string} step - 현재 단계
 * @returns {string} 추론된 에러 코드
 */
function inferErrorCode(message, step) {
  const lowerMsg = message.toLowerCase();

  // 타임아웃 관련
  if (
    lowerMsg.includes("timeout") ||
    lowerMsg.includes("시간 초과") ||
    lowerMsg.includes("timed out")
  ) {
    return ERROR_CODES.TIMEOUT;
  }

  // 요소 찾기 실패
  if (
    lowerMsg.includes("not found") ||
    lowerMsg.includes("찾을 수 없") ||
    lowerMsg.includes("없음") ||
    lowerMsg.includes("selector") ||
    lowerMsg.includes("element")
  ) {
    return ERROR_CODES.ELEMENT_NOT_FOUND;
  }

  // 로그인 실패
  if (
    lowerMsg.includes("login") ||
    lowerMsg.includes("로그인") ||
    lowerMsg.includes("auth")
  ) {
    return ERROR_CODES.LOGIN_FAILED;
  }

  // 네비게이션 실패
  if (
    lowerMsg.includes("navigation") ||
    lowerMsg.includes("navigate") ||
    lowerMsg.includes("이동")
  ) {
    return ERROR_CODES.NAVIGATION_FAILED;
  }

  // 클릭 실패
  if (lowerMsg.includes("click") || lowerMsg.includes("클릭")) {
    return ERROR_CODES.CLICK_FAILED;
  }

  // 재고 없음
  if (
    lowerMsg.includes("품절") ||
    lowerMsg.includes("재고") ||
    lowerMsg.includes("stock")
  ) {
    return ERROR_CODES.OUT_OF_STOCK;
  }

  // 단계별 기본 에러 코드
  switch (step) {
    case ORDER_STEPS.LOGIN:
      return ERROR_CODES.LOGIN_FAILED;
    case ORDER_STEPS.CART_CLEARING:
      return ERROR_CODES.CLICK_FAILED; // CART_CLEAR_FAILED → CLICK_FAILED로 통합
    case ORDER_STEPS.PRODUCT_SEARCH:
      return ERROR_CODES.ELEMENT_NOT_FOUND; // PRODUCT_NOT_FOUND → 담당자 확인 필요로 처리 (별도)
    case ORDER_STEPS.OPTION_SELECTION:
      return ERROR_CODES.ELEMENT_NOT_FOUND; // OPTION_SELECT_FAILED → 담당자 확인 필요로 처리 (별도)
    case ORDER_STEPS.QUANTITY_SETTING:
      return ERROR_CODES.INPUT_FAILED; // QUANTITY_SET_FAILED → INPUT_FAILED로 통합
    case ORDER_STEPS.ADD_TO_CART:
      return ERROR_CODES.CLICK_FAILED; // ADD_TO_CART_FAILED → CLICK_FAILED로 통합
    case ORDER_STEPS.ORDER_PLACEMENT:
    case ORDER_STEPS.ORDER_CONFIRMATION:
      return ERROR_CODES.UNEXPECTED_ERROR; // ORDER_FAILED → UNEXPECTED_ERROR로 통합
    case ORDER_STEPS.PAYMENT:
      return ERROR_CODES.PAYMENT_FAILED;
    case ORDER_STEPS.SAVE_RESULTS:
      return ERROR_CODES.UNEXPECTED_ERROR;
    case TRACKING_STEPS.EXTRACTION:
      return ERROR_CODES.EXTRACTION_FAILED;
    default:
      return ERROR_CODES.UNEXPECTED_ERROR;
  }
}

/**
 * 자동화 에러 수집기 클래스
 */
class AutomationErrorCollector {
  /**
   * @param {string} vendor - 벤더명 (naver, baemin, napkin, coupang, swadpia, adpia)
   * @param {string} automationType - 자동화 타입 (ORDER, TRACKING)
   */
  constructor(vendor, automationType) {
    this.vendor = vendor;
    this.automationType = automationType;
    this.errors = [];
  }

  /**
   * 에러 추가
   * @param {string} step - 실패 단계
   * @param {string|null} errorCode - 에러 코드 (null이면 메시지에서 추론)
   * @param {string} errorMessage - 에러 메시지
   * @param {Object} context - 추가 컨텍스트 정보
   */
  addError(step, errorCode, errorMessage, context = {}) {
    const error = {
      vendor: this.vendor,
      automationType: this.automationType,
      step,
      errorCode: errorCode || inferErrorCode(errorMessage, step),
      errorMessage: String(errorMessage).substring(0, 500), // 메시지 길이 제한
      ...context,
    };

    // undefined 값 제거
    Object.keys(error).forEach((key) => {
      if (error[key] === undefined || error[key] === null) {
        delete error[key];
      }
    });

    this.errors.push(error);
  }

  /**
   * 수집된 에러 목록 반환
   * @returns {Array} 에러 배열
   */
  getErrors() {
    return this.errors;
  }

  /**
   * 에러 존재 여부 확인
   * @returns {boolean}
   */
  hasErrors() {
    return this.errors.length > 0;
  }

  /**
   * 에러 개수 반환
   * @returns {number}
   */
  count() {
    return this.errors.length;
  }

  /**
   * 에러 목록 초기화
   */
  clear() {
    this.errors = [];
  }
}

/**
 * 주문용 에러 수집기 생성 헬퍼
 * @param {string} vendor - 벤더명
 * @returns {AutomationErrorCollector}
 */
function createOrderErrorCollector(vendor) {
  return new AutomationErrorCollector(vendor, AUTOMATION_TYPES.ORDER);
}

/**
 * 송장조회용 에러 수집기 생성 헬퍼
 * @param {string} vendor - 벤더명
 * @returns {AutomationErrorCollector}
 */
function createTrackingErrorCollector(vendor) {
  return new AutomationErrorCollector(vendor, AUTOMATION_TYPES.TRACKING);
}

module.exports = {
  ERROR_CODES,
  AUTOMATION_TYPES,
  ORDER_STEPS,
  TRACKING_STEPS,
  AutomationErrorCollector,
  createOrderErrorCollector,
  createTrackingErrorCollector,
  inferErrorCode,
};
