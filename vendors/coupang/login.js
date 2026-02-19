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

  console.log("쿠팡 로그인 체크...");

  // WAF 우회: 메인 페이지 먼저 방문 후 로그인 버튼 클릭 (referrer 생성)
  console.log("[로그인] 메인 페이지 먼저 방문...");
  await page.goto(vendor.siteUrl, {
    waitUntil: "networkidle2",
    timeout: 30000,
  });
  await delay(2000 + Math.random() * 1000);

  // Access Denied 체크
  let pageContent = await page.content();
  if (pageContent.includes("Access Denied")) {
    throw new Error("Access Denied by Coupang WAF");
  }

  // 이미 로그인 되어있는지 확인 (마이쿠팡 버튼 존재 여부)
  const isAlreadyLoggedIn = await page.evaluate(() => {
    // 로그인 상태면 "마이쿠팡" 또는 사용자 이름이 표시됨
    const myPageLink = document.querySelector('a[title="마이쿠팡"], a[href*="mypage"]');
    const loginLink = document.querySelector('a[title="로그인"]');
    return myPageLink !== null && loginLink === null;
  });

  if (isAlreadyLoggedIn) {
    console.log("쿠팡 이미 로그인됨, 스킵");
    return true;
  }

  // 로그인 버튼 클릭으로 로그인 페이지 이동 (자연스러운 navigation)
  console.log("[로그인] 로그인 버튼 클릭...");
  const loginLink = await page.$('a[title="로그인"]');
  if (loginLink) {
    await loginLink.click();
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 });
    await delay(2000 + Math.random() * 1000);
  } else {
    // 로그인 버튼 없으면 이미 로그인된 것으로 간주 (직접 URL 이동 시 WAF 차단됨)
    console.log("[로그인] 로그인 버튼 없음, 이미 로그인된 것으로 간주");
    return true;
  }

  // 현재 URL 확인
  const currentUrl = page.url();
  console.log("[로그인 체크] 현재 URL:", currentUrl);

  if (!currentUrl.includes("login")) {
    console.log("쿠팡 이미 로그인됨, 스킵");
    return true;
  }

  // Access Denied 체크
  pageContent = await page.content();
  if (pageContent.includes("Access Denied")) {
    throw new Error("Access Denied by Coupang WAF");
  }

  console.log("쿠팡 로그인 시작...");
  console.log("[vendor 정보]", {
    email: vendor.email,
    password: vendor.password ? "***" + vendor.password.slice(-3) : "없음",
  });

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
