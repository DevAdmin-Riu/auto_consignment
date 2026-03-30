/**
 * 와우프레스 결제 자동화 모듈
 *
 * 처리 방식: 미납금 전체 결제 (네이버페이)
 *
 * 흐름:
 * 1. 와우프레스 로그인
 * 2. 미납금 결제 페이지 이동 (https://wowpress.co.kr/mpag/upay/list)
 * 3. 기타결제 버튼 클릭
 * 4. 네이버페이 버튼 클릭
 * 5. 결제하기 버튼 클릭
 * 6. 네이버페이 결제 페이지 → 동의하고 결제하기
 * 7. 비밀번호 입력 → 결제 완료
 *
 * 주의: API 주문은 n8n에서 처리 완료 후, 이 모듈은 결제만 담당
 */

const { getLoginStatus, setLoginStatus, delay } = require("../../lib/browser");
const { enterNaverPayPin } = require("../naver/order");

const URLS = {
  login: "https://wowpress.co.kr/cust/lgin/form",
  paymentList: "https://wowpress.co.kr/mpag/upay/list",
};

// ==================== 로그인 ====================

async function login(page, vendor) {
  const isLoggedIn = getLoginStatus(vendor.key);
  if (isLoggedIn) {
    console.log("[wowpress] 이미 로그인됨, 스킵");
    // 로그인 상태 확인
    await page.goto(URLS.paymentList, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await delay(1000);

    const currentUrl = page.url();
    if (!currentUrl.includes("lgin")) {
      console.log("[wowpress] 로그인 상태 확인됨");
      return true;
    }
    console.log("[wowpress] 세션 만료, 재로그인...");
    setLoginStatus(vendor.key, false);
  }

  console.log("[wowpress] 로그인 시작...");
  // 메인 페이지 먼저 접근
  await page.goto("https://wowpress.co.kr", {
    waitUntil: "networkidle2",
    timeout: 30000,
  });
  await delay(2000);
  // 로그인 페이지로 이동
  await page.goto(URLS.login, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(2000);

  // 로그인 폼 렌더링 대기
  console.log("[wowpress] 현재 URL:", page.url());

  // evaluate로 직접 아이디/비밀번호 입력 + 로그인 클릭
  await page.evaluate(
    (userId, password) => {
      const uid = document.querySelector("#authUid");
      const pw = document.querySelector("#authPw");
      if (uid) {
        uid.value = "";
        uid.value = userId;
        uid.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (pw) {
        pw.value = "";
        pw.value = password;
        pw.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const btn = document.querySelector(".memberlog_login");
      if (btn) btn.click();
    },
    vendor.userId,
    vendor.password,
  );
  console.log("[wowpress] 아이디/비밀번호 입력 + 로그인 버튼 클릭");

  await page
    .waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 })
    .catch(() => {});
  await delay(2000);

  const afterUrl = page.url();
  if (afterUrl.includes("lgin")) {
    console.log("[wowpress] 로그인 실패");
    return false;
  }

  console.log("[wowpress] 로그인 성공!");
  setLoginStatus(vendor.key, true);
  return true;
}

// ==================== 미납금 결제 ====================

async function payOutstanding(page, browser, vendor) {
  // 1. 미납금 결제 페이지 이동
  console.log("[wowpress] 미납금 결제 페이지로 이동...");
  await page.goto(URLS.paymentList, {
    waitUntil: "networkidle2",
    timeout: 30000,
  });
  await delay(2000);

  // 미납금이 있는지 확인 - #btn_etcpg 버튼 존재 여부로 판단
  const hasPayBtn = await page.evaluate(
    () => !!document.querySelector("#btn_etcpg"),
  );
  console.log("[wowpress] 현재 URL:", page.url());
  console.log("[wowpress] 기타결제 버튼 존재:", hasPayBtn);

  if (!hasPayBtn) {
    console.log("[wowpress] 미납금 없음 (기타결제 버튼 없음)");
    return { success: true, message: "미납금 없음", paymentAmount: 0 };
  }

  // 미납금 금액 파싱
  const paymentAmount = await page.evaluate(() => {
    const allSpans = document.querySelectorAll(".deco_wowpress.emphasis.fs18");
    for (const span of allSpans) {
      const text = span.textContent.trim();
      const match = text.match(/([\d,]+)\s*원/);
      if (match) return parseInt(match[1].replace(/,/g, ""), 10) || 0;
    }
    return 0;
  });
  console.log(`[wowpress] 총 결제해야할 미납금: ${paymentAmount.toLocaleString()}원`);

  // 2. 기타결제 버튼 클릭
  console.log("[wowpress] 기타결제 버튼 클릭...");
  await page.evaluate(() => {
    const btn = document.querySelector("#btn_etcpg");
    if (btn) btn.click();
  });
  await delay(2000);

  // 3. 네이버페이 버튼 클릭
  console.log("[wowpress] 네이버페이 버튼 클릭...");
  await page.evaluate(() => {
    const btn = document.querySelector("#btn_naver");
    if (btn) btn.click();
  });
  await delay(2000);

  // 4. 결제하기 버튼 클릭
  console.log("[wowpress] 결제하기 버튼 클릭...");

  // 현재 페이지 수 기록
  const pagesBefore = await browser.pages();
  const pagesCountBefore = pagesBefore.length;
  console.log(`[wowpress] 현재 페이지 수: ${pagesCountBefore}`);

  await page.evaluate(() => {
    const btn = document.querySelector(".payment_pay");
    if (btn) btn.click();
  });
  console.log("[wowpress] 결제하기 클릭 완료");

  // 5. 네이버페이 새창 대기 (폴링)
  console.log("[wowpress] 네이버페이 새창 대기...");
  let naverPayPage = null;

  for (let i = 0; i < 20; i++) {
    await delay(500);
    const pagesAfter = await browser.pages();
    console.log(
      `[wowpress] 페이지 수 체크 (${i + 1}/20): ${pagesAfter.length}`,
    );

    if (pagesAfter.length > pagesCountBefore) {
      naverPayPage = pagesAfter[pagesAfter.length - 1];
      console.log("[wowpress] 새창 감지 성공!");
      break;
    }
  }

  if (!naverPayPage) {
    console.log("[wowpress] 새창 감지 실패, 기존 페이지에서 진행...");
    naverPayPage = page;
  }

  await delay(2000);
  const naverPayUrl = naverPayPage.url();
  console.log(`[wowpress] 네이버페이 URL: ${naverPayUrl}`);

  // 6. 네이버 로그인 (필요한 경우)
  if (naverPayUrl.includes("nid.naver.com") || naverPayUrl.includes("login")) {
    console.log("[wowpress] 네이버 로그인 필요...");
    const { getVendorByKey } = require("../config");
    const naverConfig = getVendorByKey("naver");

    if (!naverConfig || !naverConfig.userId || !naverConfig.password) {
      console.log("[wowpress] 네이버 로그인 정보 없음");
      return { success: false, message: "네이버 로그인 정보 없음" };
    }

    const idInput = await naverPayPage.$("#id");
    if (idInput) {
      await idInput.click();
      await idInput.type(naverConfig.userId, { delay: 50 });
      console.log("[wowpress] 네이버 아이디 입력 완료");
    }
    await delay(500);

    const pwInput = await naverPayPage.$("#pw");
    if (pwInput) {
      await pwInput.click();
      await pwInput.type(naverConfig.password, { delay: 50 });
      console.log("[wowpress] 네이버 비밀번호 입력 완료");
    }
    await delay(500);

    const submitBtn = await naverPayPage.$("#submit_btn");
    if (submitBtn) {
      await submitBtn.click();
      console.log("[wowpress] 네이버 로그인 버튼 클릭");
    }

    await naverPayPage
      .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 })
      .catch(() => {});
    await delay(2000);
    console.log(`[wowpress] 로그인 후 URL: ${naverPayPage.url()}`);
  }

  // 7. "동의하고 결제하기" 버튼 클릭
  console.log("[wowpress] 동의하고 결제하기 버튼 클릭...");
  await delay(2000);

  const agreePayBtnSelector =
    "#root > div > div:nth-child(3) > div > div > div > div > div > button";
  const agreePayBtn = await naverPayPage.$(agreePayBtnSelector);

  if (agreePayBtn) {
    await agreePayBtn.click();
    console.log("[wowpress] 동의하고 결제하기 버튼 클릭 완료");
  } else {
    console.log("[wowpress] 셀렉터 실패, 텍스트로 검색...");
    const agreeClicked = await naverPayPage.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = (btn.innerText || btn.textContent || "").trim();
        if (text.includes("동의") && text.includes("결제")) {
          btn.click();
          return { clicked: true, text };
        }
      }
      return { clicked: false };
    });
    if (agreeClicked.clicked) {
      console.log(
        `[wowpress] 동의하고 결제하기 클릭 (텍스트): "${agreeClicked.text}"`,
      );
    } else {
      console.log("[wowpress] 동의하고 결제하기 버튼 없음");
    }
  }

  // 8. 결제 비밀번호(PIN) 입력
  console.log("[wowpress] PIN 입력 대기...");
  await delay(3000);

  const { getVendorByKey } = require("../config");
  const naverConfig = getVendorByKey("naver");
  const pin = naverConfig?.naverPayPin;

  if (!pin) {
    console.log("[wowpress] 네이버페이 PIN 미설정");
    return { success: false, message: "네이버페이 PIN이 설정되지 않음" };
  }

  const pinResult = await enterNaverPayPin(naverPayPage, pin);

  if (!pinResult.success) {
    console.log("[wowpress] PIN 입력 실패:", pinResult.reason || "알 수 없음");
    return {
      success: false,
      message: `PIN 입력 실패: ${pinResult.reason || "알 수 없음"}`,
    };
  }

  console.log("[wowpress] PIN 입력 완료!");
  await delay(1000);

  // 9. 결제 완료 확인 - 팝업 닫힘 대기
  console.log("[wowpress] 결제 완료 확인...");
  for (let i = 0; i < 10; i++) {
    try {
      const isOpen = naverPayPage && !naverPayPage.isClosed();
      if (!isOpen) {
        console.log(`[wowpress] 네이버페이 팝업 닫힘 확인 (${i + 1}회)`);
        break;
      }
      console.log(`[wowpress] 팝업 닫힘 대기... (${i + 1}/10)`);
      await delay(500);
    } catch (e) {
      console.log(`[wowpress] 팝업 닫힘: ${e.message}`);
      break;
    }
  }

  await delay(2000);
  console.log("[wowpress] 결제 완료!");
  return { success: true, message: "네이버페이 결제 완료", paymentAmount };
}

// ==================== 메인 처리 ====================

async function processWowpressOrder(
  res,
  page,
  vendor,
  { browser, purchaseOrderId },
  authToken,
) {
  console.log("\n[wowpress] ===== 와우프레스 결제 시작 =====");

  try {
    // 1. 로그인
    const loggedIn = await login(page, vendor);
    if (!loggedIn) {
      return res.json({
        success: false,
        vendor: vendor.name,
        message: "[와우프레스] 로그인 실패",
      });
    }

    // 2. 미납금 결제
    const payResult = await payOutstanding(page, browser, vendor);

    if (!payResult.success) {
      return res.json({
        success: false,
        vendor: vendor.name,
        message: payResult.message,
      });
    }

    // 3. 결제 성공 → 결제내역 저장 (백엔드 처리)
    if (purchaseOrderId && authToken) {
      const graphqlClient = require("../../lib/graphql-client");
      try {
        console.log(
          `[wowpress] 결제내역 저장: ${purchaseOrderId}, 결제금액: ${payResult.paymentAmount || 0}원`,
        );
        await graphqlClient.callGraphQL(
          authToken,
          `
          mutation WowPressCreatePaymentLog($purchaseOrderId: ID!, $paymentAmount: Int!) {
            wowPressCreatePaymentLog(purchaseOrderId: $purchaseOrderId, paymentAmount: $paymentAmount) {
              result
              wowPressErrors { field message }
            }
          }
        `,
          { purchaseOrderId, paymentAmount: payResult.paymentAmount || 0 },
        );
        console.log(`[wowpress] ✅ 결제내역 저장 완료`);
      } catch (e) {
        console.log(
          `[wowpress] ❌ 결제내역 저장 실패: ${e.message}`,
        );
      }
    }

    return res.json({
      success: true,
      vendor: vendor.name,
      message: payResult.message,
      paymentAmount: payResult.paymentAmount || 0,
    });
  } catch (error) {
    console.error("[wowpress] 처리 에러:", error.message);
    return res.json({
      success: false,
      vendor: vendor.name,
      message: `[와우프레스] 에러: ${error.message}`,
    });
  }
}

module.exports = {
  processWowpressOrder,
};
