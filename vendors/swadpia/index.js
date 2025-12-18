const express = require("express");
const { setupRoutes, login, processSwadpiaOrder } = require("./order");

const router = express.Router();

/**
 * vendor 설정을 getter 보존하여 래핑
 */
function wrapVendorConfig(config) {
  const result = Object.create(null);
  const descriptors = Object.getOwnPropertyDescriptors(config);
  Object.defineProperties(result, descriptors);
  return result;
}

// 라우터 설정
setupRoutes(router, wrapVendorConfig);

module.exports = {
  router,
  login,
  processSwadpiaOrder,
};
