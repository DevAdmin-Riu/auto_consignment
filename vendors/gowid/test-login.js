const { getBrowser } = require("../../lib/browser");
const { loginToGowid } = require("./login");

(async () => {
  try {
    console.log("[gowid] 로그인 테스트 시작...");
    const { page } = await getBrowser("gowid");
    const result = await loginToGowid(page);
    console.log("[gowid] 결과:", result);
    console.log("[gowid] 브라우저 유지 중... (Ctrl+C로 종료)");
  } catch (e) {
    console.error("[gowid] 에러:", e.message);
  }
})();
