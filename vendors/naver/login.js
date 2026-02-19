/**
 * 네이버 로그인 모듈
 */

const { safeGoto } = require("../../lib/browser");

// 딜레이 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 네이버 로그인 확인/처리
 */
async function login(page, vendor) {
  console.log("[naver] naver.com으로 이동...");

  // naver.com으로 이동
  await safeGoto(page, "https://www.naver.com", {
    timeout: 30000,
  });
  await delay(2000);

  // 로그인 버튼 클릭
  const loginBtn = await page.$("#account > div > a");
  if (loginBtn) {
    console.log("[naver] 로그인 버튼 클릭...");
    await loginBtn.click();
    await delay(2000);
  }

  // ID 입력 필드가 있으면 로그인 필요
  const idInput = await page.$("#id");

  if (idInput) {
    console.log("[naver] 로그인 폼 발견, 로그인 진행...");

    // ID 입력
    await idInput.click({ clickCount: 3 });
    await page.type("#id", vendor.userId, { delay: 50 });
    console.log("[naver] ID 입력 완료");

    await delay(500);

    // 비밀번호 입력
    const pwInput = await page.$("#pw");
    if (pwInput) {
      await pwInput.click({ clickCount: 3 });
      await page.type("#pw", vendor.password, { delay: 50 });
      console.log("[naver] 비밀번호 입력 완료");
    }

    await delay(500);

    // 로그인 버튼 클릭
    const submitBtn = await page.$("#log\\.login");
    if (submitBtn) {
      await submitBtn.click();
      console.log("[naver] 로그인 버튼 클릭");
      await delay(5000);
    }

    // 2차 인증 등 확인
    const afterLoginUrl = page.url();
    if (afterLoginUrl.includes("nid.naver.com")) {
      console.log("[naver] 추가 인증 필요할 수 있음. 현재 URL:", afterLoginUrl);
      console.log("[naver] 브라우저에서 수동 로그인 해주세요...");
      // 사용자가 수동으로 처리할 수 있도록 대기
      await delay(30000);
    }

    console.log("[naver] 로그인 완료");
  } else {
    console.log("[naver] 이미 로그인됨 (로그인 폼 없음)");
  }

  return true;
}

module.exports = {
  login,
};
