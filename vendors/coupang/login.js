/**
 * 쿠팡 로그인 모듈
 */

const { delay, setLoginStatus } = require("../../lib/browser");
const { getVendorByKey } = require("../config");

/**
 * 쿠팡 로그인
 */
async function coupangLogin(page) {
  const vendor = getVendorByKey("coupang");
  if (!vendor) {
    throw new Error("쿠팡 설정을 찾을 수 없습니다");
  }

  console.log("쿠팡 로그인 시작...");
  console.log("[vendor 정보]", {
    email: vendor.email,
    password: vendor.password ? "***" + vendor.password.slice(-3) : "없음",
    loginUrl: vendor.loginUrl,
  });

  // 쿠팡 메인 페이지 방문
  await page.goto("https://www.coupang.com", {
    waitUntil: "networkidle2",
    timeout: 30000,
  });

  await delay(2000 + Math.random() * 2000);
  await page.mouse.move(100 + Math.random() * 200, 100 + Math.random() * 200);
  await delay(500);

  // 로그인 페이지로 이동
  await page.goto(vendor.loginUrl, {
    waitUntil: "networkidle2",
    timeout: 30000,
  });

  await delay(2000 + Math.random() * 1000);

  // Access Denied 체크
  const pageContent = await page.content();
  if (pageContent.includes("Access Denied")) {
    throw new Error("Access Denied by Coupang WAF");
  }

  // 이메일 입력
  console.log("이메일 입력 필드 대기...");
  await page.waitForSelector("#login-email-input", { timeout: 10000 });

  // 필드 초기화 후 입력
  await page.evaluate(() => {
    const input = document.querySelector("#login-email-input");
    if (input) {
      input.value = "";
      input.focus();
    }
  });
  await delay(300);

  // page.type으로 입력 (셀렉터 직접 지정)
  await page.type("#login-email-input", vendor.email, { delay: 80 + Math.random() * 40 });
  console.log("이메일 입력 완료:", vendor.email);

  // 비밀번호 입력
  await delay(500);
  console.log("비밀번호 입력 필드 대기...");
  await page.waitForSelector("#login-password-input", { timeout: 10000 });

  // 비밀번호 필드 초기화
  await page.evaluate(() => {
    const input = document.querySelector("#login-password-input");
    if (input) {
      input.value = "";
      input.focus();
    }
  });
  await delay(300);

  // 비밀번호 입력
  await page.type("#login-password-input", vendor.password, { delay: 80 + Math.random() * 40 });
  console.log("비밀번호 입력 완료");

  // 로그인 버튼 클릭
  await delay(500);
  const loginBtn = await page.$('button[type="submit"]');
  if (loginBtn) {
    await loginBtn.click();
  }

  await delay(5000);

  const finalUrl = page.url();
  const isLoggedIn = !finalUrl.includes("login");

  if (isLoggedIn) {
    setLoginStatus("coupang", true);
  }

  return isLoggedIn;
}

module.exports = {
  coupangLogin,
};
