/**
 * 네이버 스마트스토어 송장번호 조회 모듈
 *
 * TODO: 구현 필요
 * - 네이버페이 주문내역에서 송장번호 조회
 */

const { login } = require("./login");

// 딜레이 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 네이버 송장번호 조회
 * @param {Page} page - Puppeteer 페이지
 * @param {Object} vendor - 네이버 협력사 설정
 * @param {string[]} openMallOrderNumbers - 조회할 오픈몰 주문번호 배열
 * @returns {Array} 조회 결과 배열 [{ openMallOrderNumber, trackingNumber, carrier }, ...]
 */
async function getNaverTrackingNumbers(page, vendor, openMallOrderNumbers) {
  console.log(`[naver 송장조회] 시작: ${openMallOrderNumbers.length}건`);

  const results = [];

  try {
    // 1. 로그인 확인/처리
    await login(page, vendor);
    console.log("[naver 송장조회] 로그인 완료");

    // TODO: 네이버페이 주문내역 페이지에서 송장번호 조회 구현
    // https://order.pay.naver.com/home

    console.log("[naver 송장조회] 아직 구현되지 않음");

    return results;
  } catch (error) {
    console.error("[naver 송장조회] 전체 에러:", error);
    return results;
  }
}

module.exports = {
  getNaverTrackingNumbers,
};
