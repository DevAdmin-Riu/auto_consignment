const { getEnv } = require("../config");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LOGIN_URL = "https://www.gowid.com/login";

/**
 * 고위드 로그인
 * @param {object} page - Puppeteer page
 * @returns {Promise<{success: boolean, message?: string}>}
 */
async function loginToGowid(page) {
  const email = getEnv("GOWID_EMAIL");
  const password = getEnv("GOWID_PASSWORD");

  if (!email || !password) {
    return { success: false, message: "GOWID_EMAIL 또는 GOWID_PASSWORD가 .env에 설정되지 않음" };
  }

  console.log("[gowid] 로그인 시작...");

  try {
    // 1. 로그인 페이지 이동
    await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 30000 });
    console.log("[gowid] 로그인 페이지 이동 완료");

    // 이미 로그인되어 있는지 확인
    const currentUrl = page.url();
    if (!currentUrl.includes("/login")) {
      console.log("[gowid] 이미 로그인됨");
      return { success: true, message: "이미 로그인됨" };
    }

    // 2. 이메일 입력 (텍스트 기반으로 label 찾기)
    console.log("[gowid] 이메일 입력...");
    const emailInput = await page.evaluateHandle(() => {
      const labels = document.querySelectorAll("label");
      for (const label of labels) {
        if (label.textContent.trim() === "이메일") {
          const inputId = label.getAttribute("for");
          if (inputId) return document.getElementById(inputId);
        }
      }
      // 폴백: type="email" input
      return document.querySelector('input[type="email"]');
    });

    if (!emailInput || !emailInput.asElement()) {
      return { success: false, message: "이메일 입력 필드를 찾을 수 없음" };
    }

    await emailInput.click();
    await delay(300);
    await page.keyboard.type(email, { delay: 50 });
    console.log(`[gowid] 이메일 입력 완료: ${email}`);

    // 3. 비밀번호 입력
    console.log("[gowid] 비밀번호 입력...");
    const passwordInput = await page.evaluateHandle(() => {
      const labels = document.querySelectorAll("label");
      for (const label of labels) {
        if (label.textContent.trim() === "패스워드") {
          const inputId = label.getAttribute("for");
          if (inputId) return document.getElementById(inputId);
        }
      }
      // 폴백: type="password" input
      return document.querySelector('input[type="password"]');
    });

    if (!passwordInput || !passwordInput.asElement()) {
      return { success: false, message: "비밀번호 입력 필드를 찾을 수 없음" };
    }

    await passwordInput.click();
    await delay(300);
    await page.keyboard.type(password, { delay: 50 });
    console.log("[gowid] 비밀번호 입력 완료");

    // 4. 로그인 버튼 클릭
    console.log("[gowid] 로그인 버튼 클릭...");
    await delay(500);

    const loginClicked = await page.evaluate(() => {
      // id="login_submit" 버튼
      const submitBtn = document.querySelector("#login_submit");
      if (submitBtn) {
        submitBtn.removeAttribute("disabled");
        submitBtn.removeAttribute("aria-disabled");
        submitBtn.removeAttribute("data-disabled");
        submitBtn.click();
        return "login_submit";
      }
      // 폴백: "로그인" 텍스트 버튼
      const buttons = document.querySelectorAll('button[type="submit"]');
      for (const btn of buttons) {
        if (btn.textContent.includes("로그인")) {
          btn.click();
          return "text_submit";
        }
      }
      return null;
    });

    if (!loginClicked) {
      return { success: false, message: "로그인 버튼을 찾을 수 없음" };
    }
    console.log(`[gowid] 로그인 버튼 클릭: ${loginClicked}`);

    // 5. 로그인 완료 대기
    await delay(3000);

    // URL 변경 확인
    const afterUrl = page.url();
    if (afterUrl.includes("/login")) {
      // 에러 메시지 확인
      const errorMsg = await page.evaluate(() => {
        const alerts = document.querySelectorAll('[class*="Alert"], [class*="error"], [role="alert"]');
        for (const el of alerts) {
          const text = el.textContent?.trim();
          if (text) return text;
        }
        return null;
      });
      return { success: false, message: `로그인 실패: ${errorMsg || "URL이 변경되지 않음"}` };
    }

    console.log(`[gowid] 로그인 완료! URL: ${afterUrl}`);
    return { success: true, message: "로그인 성공" };

  } catch (error) {
    console.error("[gowid] 로그인 에러:", error.message);
    return { success: false, message: error.message };
  }
}

module.exports = { loginToGowid };
