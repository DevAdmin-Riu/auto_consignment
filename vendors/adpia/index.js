const { processAdpiaOrder, loginToAdpia } = require("./order");
const { getAdpiaTrackingNumbers } = require("./tracking");

module.exports = {
  processAdpiaOrder,
  loginToAdpia,
  getAdpiaTrackingNumbers,
};
