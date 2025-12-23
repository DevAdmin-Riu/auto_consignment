/**
 * 네이버 스마트스토어 모듈 - 메인 익스포트
 */

const { login } = require("./login");
const {
  processNaverOrder,
  selectOptions,
  setQuantity,
  addToCart,
  processProduct,
} = require("./order");
const { getNaverTrackingNumbers } = require("./tracking");

module.exports = {
  // 로그인
  login,

  // 주문 처리
  processNaverOrder,
  selectOptions,
  setQuantity,
  addToCart,
  processProduct,

  // 송장 조회
  getNaverTrackingNumbers,
};
