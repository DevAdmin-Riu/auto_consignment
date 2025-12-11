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
  const emailSelectors = [
    'input[name="email"]',
    'input[type="email"]',
    "input#email",
  ];
  let emailInput = null;
  for (const selector of emailSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 3000 });
      emailInput = await page.$(selector);
      if (emailInput) {
        break;
      }
    } catch (e) {
      continue;
    }
  }

  if (!emailInput) {
    throw new Error("로그인 폼을 찾을 수 없습니다");
  }

  await emailInput.click({ clickCount: 3 });
  await delay(300);
  await page.keyboard.press("Backspace");
  await delay(200);
  for (const char of vendor.email) {
    await page.keyboard.type(char, { delay: 30 + Math.random() * 30 });
  }

  // 비밀번호 입력
  await delay(500);
  const passwordInput = await page.$('input[type="password"]');
  if (passwordInput) {
    await passwordInput.click({ clickCount: 3 });
    await delay(200);
    await page.keyboard.press("Backspace");
    await delay(200);
    for (const char of vendor.password) {
      await page.keyboard.type(char, { delay: 30 + Math.random() * 30 });
    }
  }

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
