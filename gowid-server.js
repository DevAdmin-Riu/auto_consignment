const express = require("express");
const { getPage, closeBrowser } = require("./lib/browser");
const { loginToGowid } = require("./vendors/gowid/login");

const app = express();
app.use(express.json());

// 고위드 로그인 테스트
app.post("/api/gowid/login", async (req, res) => {
  let page;
  try {
    console.log("[gowid] 로그인 요청");
    page = await getPage("gowid");
    const result = await loginToGowid(page);

    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.json({ success: false, message: result.message });
    }
  } catch (error) {
    console.error("[gowid] 서버 에러:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 고위드 결제내역 조회 (추후 구현)
app.post("/api/gowid/payments", async (req, res) => {
  res.json({ success: false, message: "미구현" });
});

const PORT = process.env.GOWID_PORT || 3003;
app.listen(PORT, () => {
  console.log("========================================");
  console.log(`고위드 서버 시작`);
  console.log(`  포트: ${PORT}`);
  console.log("========================================");
});
