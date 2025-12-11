/**
 * 쿠팡 모듈 - 메인 익스포트
 */

const { coupangLogin } = require("./login");
const {
  processCoupangOrder,
  selectMatchedAddress,
  clickChangeAddressButton,
} = require("./order");

module.exports = {
  // 로그인
  coupangLogin,

  // 주문 처리
  processCoupangOrder,

  // 배송지 관련
  selectMatchedAddress,
  clickChangeAddressButton,
};
