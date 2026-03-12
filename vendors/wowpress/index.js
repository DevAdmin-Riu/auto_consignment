/**
 * 와우프레스 모듈
 * API 주문은 n8n에서 처리, 이 모듈은 미납금 결제만 담당
 */

const { processWowpressOrder } = require("./order");

module.exports = {
  processWowpressOrder,
};
