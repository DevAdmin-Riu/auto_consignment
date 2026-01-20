/**
 * 배민상회 주문 자동화 모듈
 *
 * 흐름:
 * 1. 로그인 (ID/PW)
 * 2. 상품 페이지 이동
 * 3. 옵션 선택 (있는 경우)
 * 4. 수량 설정
 * 5. 장바구니 담기
 * 6. 결제 (네이버페이)
 */

const fs = require("fs");
const path = require("path");
const { getLoginStatus, setLoginStatus, delay } = require("../../lib/browser");
const { enterNaverPayPin } = require("../naver/order");
const {
  createOrderErrorCollector,
  ORDER_STEPS,
  ERROR_CODES,
} = require("../../lib/automation-error");
const { saveOrderResults } = require("../../lib/graphql-client");

// ==================== 셀렉터 정의 ====================

const SELECTORS = {
  // 메인 페이지 - 로그인 버튼
  loginButton:
    "#root > div > div.sc-kKWCvc.jpWsxy > div.sc-hQxkJl.dZCqTc > div > ul:nth-child(2) > li:nth-child(2) > a",

  // 로그인 페이지
  loginIdInput:
    "#root > div.style__LoginWrap-sc-145yrm0-0.hKiYRl > div > div > form > div:nth-child(1) > span > input[type=text]",
  loginPwInput:
    "#root > div.style__LoginWrap-sc-145yrm0-0.hKiYRl > div > div > form > div.Input__InputWrap-sc-tapcpf-1.kjWnKT.mt-half-3 > span > input[type=password]",
  loginSubmitButton:
    "#root > div.style__LoginWrap-sc-145yrm0-0.hKiYRl > div > div > form > button",

  // 로그인 상태 확인 (마이페이지 또는 로그아웃 버튼 등)
  loggedInIndicator: '[class*="mypage"], [class*="logout"], [href*="mypage"]',

  // 모달 닫기 버튼
  modalCloseButton:
    "body > div.sc-gYbzsP.sc-cCjUiG.ezEUYI.jtlzcK > div.sc-jcMfQk.boexkD > div.sc-ikHGee.kEgDPX > button.sc-cabOPr.fIFnhp.sc-uhnfH.fXqXRo",

  // 상품 페이지
  productName: '[class*="product-name"], [class*="ProductName"], h1',
  productPrice: '[class*="price"], [class*="Price"]',

  // 옵션 선택
  optionDropdownButton:
    "#root > div > div.sc-jCbqOc.iPvcFH > div.sc-jephDI.fmkuTR > section > div.sc-eAkcsE.jxnmef > div.sc-gtMvKj.EzUvH > div > button",
  optionItemText: "span.sc-futgFh.bBkBPv",

  // 수량/장바구니 - 선택된 옵션 영역 (BEM 네이밍 기반 안정적 셀렉터)
  quantityPlusButton: "button.bm-goods-quantity__plus",
  quantityMinusButton: "button.bm-goods-quantity__minus",
  quantityInput: "input.bm-goods-quantity__input",

  // 장바구니 담기 버튼
  addToCartButton:
    "#root > div > div.sc-jCbqOc.iPvcFH > div.sc-jephDI.fmkuTR > section > div.sc-eAkcsE.jxnmef > section.sc-hSGdPf.hVCRoG > div.sc-VkFXi.sPWWk > button.sc-cabOPr.iNtiLO.sc-jxfubC.sc-cWFcCz.bMAkLs.imrCCx",

  // 장바구니 담기 후 모달 - 장바구니 이동 버튼
  goToCartButton:
    "body > div.sc-gYbzsP.sc-cCjUiG.ezEUYI.jtlzcK > div.sc-jcMfQk.boexkD > div > div.sc-jRwbcX.hcnXTy > div > div > div.sc-llWxG.hIJvDk > button",

  // 장바구니 페이지 - 비우기
  cartSelectAllLabel: "div.bm-checkbox-container_label",
  cartSelectAllCheckbox: "div.bm-checkbox-container_box",
  cartDeleteSelectedButton:
    "#root > div > div.sc-eraWZj.fwMUhT > div > div > section > div.sc-hgLaqn.jKlzyj > div.sc-FINNM.cSEDWD > div",
  cartDeleteConfirmButton:
    "body > div.sc-gYbzsP.sc-cCjUiG.ezEUYI.jtlzcK > div.sc-jcMfQk.boexkD > div > div.sc-dPWrhe.fbrzYW > button.sc-cabOPr.dffeCN.sc-bCfvAP.sc-cOxWqc.dggOrb.jSIUaC",

  // 장바구니 페이지 - 주문하기 버튼
  cartOrderButton:
    "#root > div > div.sc-gujqJk.fnLKeq > div > div > section > div.sc-jyaYzS.cDTiMW > div.sc-jWgTtR.icoyIL > div.sc-caPbAK.lfpGDL > button",

  // 최종 주문하기 버튼 (모달)
  finalOrderButton:
    "body > div.sc-gYbzsP.sc-cCjUiG.ezEUYI.jtlzcK > div.sc-jcMfQk.boexkD > div > button",

  // 결제 페이지 - 주소 변경
  addressChangeButton:
    "#root > div > div.sc-jephDI.fmkuTR > section > section > div.sc-jlLNHi.ivBwAR > div.sc-hQQLEc.bFNvC > div > div.sc-jccYHG.gBSXkF.sc-kgwZvu.ewRxLB > button",

  // 주소 변경 모달 - 수정 버튼
  addressEditButton:
    "body > div.sc-gYbzsP.sc-cCjUiG.ezEUYI.jtlzcK > div.sc-jcMfQk.boexkD > div.sc-hbWBzy.ihvGVX > div.sc-jephDI.fmkuTR > div > div > div.sc-jccYHG.gBSXkF.sc-cPIbRQ.glDLkI > div.sc-islFiG.fifJNq",

  // 주소 입력 폼
  recipientNameInput:
    "body > div:nth-child(16) > div.sc-jcMfQk.boexkD > form > div.sc-gXnjX.fdmBiR > div:nth-child(1) > div.sc-fWHiwC.dWvntu.sc-ckLdoV.gTFpWC > div > input",
  recipientPhoneInput:
    "body > div:nth-child(16) > div.sc-jcMfQk.boexkD > form > div.sc-gXnjX.fdmBiR > div:nth-child(2) > div.sc-fWHiwC.dWvntu.sc-ckLdoV.gTFpWC > div > input",
  addressSearchButton:
    "body > div:nth-child(16) > div.sc-jcMfQk.boexkD > form > div.sc-gXnjX.fdmBiR > div:nth-child(3) > button",

  // 다음 주소 검색 iframe
  daumPostcodeFrame: "iframe[title='우편번호 검색 프레임']",
  daumAddressInput: "#region_name",
  daumSearchButton: "#searchForm > fieldset > div > button.btn_search",
  daumAddressItem: "li.list_post_item",

  // 결제 수단 선택
  naverPayInput:
    "#root > div > div.sc-jephDI.fmkuTR > section > section > div.sc-jlLNHi.ivBwAR > section > div > div.sc-eAXloS.jQTqQj > div > div.sc-kGojKl.gXsWre > div.sc-hAjDme.hJGbzV > div > input",

  // 현금영수증 미발행
  cashReceiptNoIssue:
    "#root > div > div.sc-jephDI.fmkuTR > section > section > div.sc-jlLNHi.ivBwAR > section.sc-caoIEO.cLZbNX > div > section > div > div:nth-child(3) > input",

  // 필수 동의 라벨
  requiredAgreementLabel:
    "#root > div > div.sc-jephDI.fmkuTR > section > section > div.sc-fWpDKo.hauHbL > div.sc-eXGUsz.knNOLb > div.sc-jdudiz.eHkFji > div > label",

  // 결제하기 버튼
  paymentButton:
    "#root > div > div.sc-jephDI.fmkuTR > section > section > div.sc-fWpDKo.hauHbL > div.sc-eXGUsz.knNOLb > div.sc-jdudiz.eHkFji > button",
};

// ==================== 헬퍼 함수 ====================

/**
 * waitForSelector 래퍼 - 타임아웃 시 null 반환
 */
async function waitFor(page, selector, timeout = 5000) {
  try {
    return await page.waitForSelector(selector, { timeout, visible: true });
  } catch (e) {
    return null;
  }
}

// ==================== 로그인 관련 ====================

/**
 * 로그인 상태 확인
 */
async function checkLoginStatus(page) {
  try {
    const loggedIn = await waitFor(page, SELECTORS.loggedInIndicator, 3000);
    return !!loggedIn;
  } catch (error) {
    return false;
  }
}

/**
 * 배민상회 로그인
 */
async function loginToBaemin(page, vendor) {
  console.log("[baemin] 로그인 시작...");

  try {
    // 1. 메인 페이지로 이동
    console.log("[baemin] 1. 메인 페이지 이동: https://mart.baemin.com/");
    await page.goto("https://mart.baemin.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await delay(1100);

    // 2. 로그인 버튼 클릭 시도
    console.log("[baemin] 2. 로그인 버튼 찾기...");
    const loginBtn = await page.$(SELECTORS.loginButton);

    if (loginBtn) {
      console.log("[baemin] 로그인 버튼 클릭...");
      await loginBtn.click();
      await delay(2000); // 페이지 이동 대기
    } else {
      console.log("[baemin] 로그인 버튼 없음, 직접 로그인 페이지로 이동...");
      await page.goto("https://biz-member.baemin.com/login", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await delay(1100);
    }

    // 로그인 버튼 클릭 후 현재 URL 확인
    const currentUrl = page.url();
    console.log(`[baemin] 현재 URL: ${currentUrl}`);

    // 로그인 페이지가 아니면 이미 로그인된 상태
    if (!currentUrl.includes("biz-member.baemin.com/login") && !currentUrl.includes("/login")) {
      console.log("[baemin] 로그인 페이지가 아님 → 이미 로그인 되어있음, 스킵");
      setLoginStatus("baemin", true);
      return { success: true, message: "이미 로그인됨" };
    }

    console.log("[baemin] 로그인 페이지 확인됨, 로그인 진행...");

    // 3. 아이디 입력
    console.log("[baemin] 3. 아이디 입력...");
    const idInput = await waitFor(page, SELECTORS.loginIdInput, 10000);
    await delay(1100);
    if (!idInput) {
      return { success: false, message: "아이디 입력창을 찾을 수 없음" };
    }
    await idInput.click({ clickCount: 3 }); // 기존 값 선택 후 덮어쓰기
    await idInput.type(vendor.userId, { delay: 50 });

    // 4. 비밀번호 입력
    console.log("[baemin] 4. 비밀번호 입력...");
    const pwInput = await waitFor(page, SELECTORS.loginPwInput, 5000);
    await delay(1100);
    if (!pwInput) {
      return { success: false, message: "비밀번호 입력창을 찾을 수 없음" };
    }
    await pwInput.click({ clickCount: 3 }); // 기존 값 선택 후 덮어쓰기
    await pwInput.type(vendor.password, { delay: 50 });

    // 5. 로그인 버튼 클릭
    console.log("[baemin] 5. 로그인 제출 버튼 클릭...");
    const submitBtn = await waitFor(page, SELECTORS.loginSubmitButton, 5000);
    await delay(1100);
    if (!submitBtn) {
      return { success: false, message: "로그인 제출 버튼을 찾을 수 없음" };
    }
    await submitBtn.click();

    // 6. 페이지 이동 대기
    await page
      .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 })
      .catch(() => {});
    await delay(1100);

    // 7. 로그인 성공 확인
    const afterLoginUrl = page.url();
    console.log(`[baemin] 현재 URL: ${afterLoginUrl}`);

    // login/success 또는 로그인 페이지가 아니면 성공
    if (
      afterLoginUrl.includes("login/success") ||
      !afterLoginUrl.includes("/login")
    ) {
      console.log("[baemin] 로그인 성공!");
      setLoginStatus("baemin", true);

      // 모달 닫기 (있으면)
      const modalCloseBtn = await waitFor(
        page,
        SELECTORS.modalCloseButton,
        2000
      );
      await delay(1100);
      if (modalCloseBtn) {
        console.log("[baemin] 모달 닫기 버튼 클릭...");
        await modalCloseBtn.click();
        await delay(1100);
      }

      return { success: true, message: "로그인 성공" };
    } else {
      console.log("[baemin] 로그인 실패 - 아직 로그인 페이지");
      return { success: false, message: "로그인 실패" };
    }
  } catch (error) {
    console.error("[baemin] 로그인 에러:", error.message);
    return { success: false, message: error.message };
  }
}

// ==================== 상품 처리 ====================

/**
 * 상품 페이지로 이동
 */
async function navigateToProduct(page, productUrl) {
  console.log(`[baemin] 상품 페이지 이동 시작: ${productUrl}`);

  try {
    // 모달 닫기 (있으면)
    const modalCloseBtn = await waitFor(page, SELECTORS.modalCloseButton, 1000);
    await delay(1100);
    if (modalCloseBtn) {
      console.log(`[baemin] 모달 닫기 버튼 클릭`);
      await modalCloseBtn.click();
      await delay(1100);
    }

    await page.goto(productUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await delay(1100);
    console.log(`[baemin] 페이지 로드 완료, URL: ${page.url()}`);

    // 모달 다시 닫기 (상품 페이지에서도 뜰 수 있음)
    const modalCloseBtn2 = await waitFor(
      page,
      SELECTORS.modalCloseButton,
      1000
    );
    await delay(1100);
    if (modalCloseBtn2) {
      console.log(`[baemin] 모달 닫기 버튼 클릭 (상품 페이지)`);
      await modalCloseBtn2.click();
      await delay(1100);
    }

    // 상품 페이지 로드 확인
    const productNameEl = await waitFor(page, SELECTORS.productName, 5000);
    await delay(1100);
    if (productNameEl) {
      const productName = await page.evaluate(
        (el) => el.textContent.trim(),
        productNameEl
      );
      console.log(`[baemin] 상품명 확인: ${productName}`);
      return { success: true, productName };
    }

    console.log(`[baemin] 상품명 셀렉터 못찾음, 페이지는 로드됨`);
    return { success: true, productName: null };
  } catch (error) {
    console.error("[baemin] 상품 페이지 이동 실패:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * 옵션 선택 (단일)
 * - Chrome Recorder에서 추출한 안정적인 셀렉터 사용
 * - data-testid='sanity-goods-detail-option-list' 가 핵심
 * @param {Page} page - Puppeteer 페이지
 * @param {string} targetValue - 선택할 옵션 값 (예: "검정")
 * @param {string} optionTitle - 옵션 타이틀 (예: "색상") - 드롭다운 버튼 찾기용
 */
async function selectSingleOption(page, targetValue, optionTitle = null) {
  try {
    // 1. 옵션 드롭다운 버튼 찾기
    await delay(1100);
    const dropdownBtn = await page.evaluateHandle((title) => {
      const buttons = Array.from(document.querySelectorAll('button'));

      // 방법 1: title로 드롭다운 찾기 (가장 정확 - 여러 옵션이 있을 때 필수)
      if (title) {
        const titleBtn = buttons.find(b => b.textContent.includes(title));
        if (titleBtn) return titleBtn;
      }

      // 방법 2: downArrow 이미지를 가진 버튼 (단일 옵션일 때)
      const btnWithArrow = document.querySelector('button:has(img[alt="downArrow"])');
      if (btnWithArrow) return btnWithArrow;

      // 방법 3: "옵션을 선택해주세요" 텍스트를 포함하는 버튼 (fallback)
      return buttons.find(b => b.textContent.includes('옵션을 선택해주세요')) || null;
    }, optionTitle);

    const btnElement = dropdownBtn.asElement();
    if (!btnElement) {
      console.log(
        `[baemin] 옵션 드롭다운 버튼 없음 (title: "${optionTitle || 'N/A'}") - 옵션이 없는 상품일 수 있음`
      );
      return { success: true, selectedOption: null, price: 0 };
    }

    console.log(`[baemin] 옵션 드롭다운 버튼 클릭 (title: "${optionTitle || '자동감지'}")...`);
    await btnElement.click();
    await delay(1500); // 드롭다운 애니메이션 대기

    // 2. 옵션 목록에서 targetValue와 매칭되는 옵션 찾기
    // Chrome Recorder에서 발견: data-testid='sanity-goods-detail-option-list'
    const matchResult = await page.evaluate((target) => {
      // 핵심: data-testid로 옵션 리스트 컨테이너 찾기 (가장 안정적)
      const optionList = document.querySelector("[data-testid='sanity-goods-detail-option-list']");
      let optionItems = [];

      if (optionList) {
        // 옵션 리스트 내 직계 자식 div들이 각 옵션
        optionItems = Array.from(optionList.querySelectorAll(':scope > div'));
        console.log(`[baemin] data-testid 옵션 리스트 발견: ${optionItems.length}개 옵션`);
      }

      // fallback: 일반적인 셀렉터들
      if (optionItems.length === 0) {
        const potentialItems = document.querySelectorAll('li, div[role="option"], [class*="option"], [class*="item"]');
        optionItems = Array.from(potentialItems).filter(el => {
          const text = el.textContent.trim();
          return text && text.length > 0 && text.length < 200;
        });
      }

      const allItems = optionItems.map((el, i) => ({
        index: i,
        text: el.textContent.trim(),
        element: el
      })).filter(item => item.text.length > 0);

      // 매칭 로직
      for (const item of allItems) {
        const optionText = item.text;
        const cleanText = optionText.replace(/^\d+\.\s*/, "");

        if (
          optionText.includes(target) ||
          target.includes(cleanText) ||
          optionText === target
        ) {
          // 가격 추출
          const priceMatch = optionText.match(/[\+\-]?\s*([\d,]+)\s*원/);
          const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, ""), 10) : 0;

          return {
            found: true,
            index: item.index,
            text: optionText,
            price,
            useDataTestId: !!document.querySelector("[data-testid='sanity-goods-detail-option-list']"),
            allOptions: allItems.slice(0, 10).map(i => i.text) // 디버깅용
          };
        }
      }

      return {
        found: false,
        useDataTestId: !!document.querySelector("[data-testid='sanity-goods-detail-option-list']"),
        allOptions: allItems.slice(0, 10).map(i => i.text) // 디버깅용
      };
    }, targetValue);

    console.log(`[baemin] 옵션 검색 방식: ${matchResult.useDataTestId ? 'data-testid (안정적)' : 'fallback'}`);
    console.log(`[baemin] 발견된 옵션들: ${JSON.stringify(matchResult.allOptions)}`);

    if (!matchResult.found) {
      console.log(`[baemin] ❌ 옵션 매칭 실패: "${targetValue}"`);
      await page.keyboard.press("Escape");
      return { success: false, reason: `옵션 값 매칭 실패: ${targetValue}` };
    }

    const matchedOption = matchResult.text;
    const optionPrice = matchResult.price;
    const matchedIndex = matchResult.index;
    console.log(`[baemin] ✅ 매칭된 옵션: "${matchedOption}" (인덱스: ${matchedIndex}, 가격: ${optionPrice}원)`);

    // 3. 매칭된 옵션 클릭 (data-testid 우선, fallback으로 텍스트 매칭)
    const clickResult = await page.evaluate((targetIndex, targetText, useDataTestId) => {
      // 방법 1: data-testid 리스트에서 인덱스로 클릭 (가장 정확)
      if (useDataTestId) {
        const optionList = document.querySelector("[data-testid='sanity-goods-detail-option-list']");
        if (optionList) {
          const items = optionList.querySelectorAll(':scope > div');
          if (items[targetIndex]) {
            items[targetIndex].click();
            return { clicked: true, method: 'data-testid-index' };
          }
        }
      }

      // 방법 2: 텍스트 매칭으로 클릭 (fallback)
      const elements = document.querySelectorAll('li, div[role="option"], [class*="option"], [class*="item"], span, button');
      for (const el of elements) {
        if (el.textContent.trim() === targetText) {
          el.click();
          return { clicked: true, method: 'text-match' };
        }
      }
      return { clicked: false };
    }, matchedIndex, matchedOption, matchResult.useDataTestId);

    if (!clickResult.clicked) {
      console.log(`[baemin] ❌ 옵션 클릭 실패: "${matchedOption}"`);
      return { success: false, reason: `옵션 클릭 실패: ${matchedOption}` };
    }

    console.log(`[baemin] 옵션 클릭 성공 (방식: ${clickResult.method})`);
    await delay(1100);

    console.log(`[baemin] 옵션 선택 완료: "${matchedOption}"`);
    return { success: true, selectedOption: matchedOption, price: optionPrice };
  } catch (error) {
    console.error("[baemin] 옵션 선택 에러:", error.message);
    return { success: false, reason: error.message };
  }
}

/**
 * 옵션 선택 (2D 세트 구조)
 * - 배민상회는 한 상품에서 여러 옵션을 선택할 수 있음
 * - 각 세트 선택 후 수량을 설정해야 함
 * - 옵션 가격들을 합산하여 반환
 *
 * 구조: [{options: [{value: "검정"}]}, {options: [{value: "노랑"}]}]
 */
async function selectOption(page, optionValue, quantity = 1) {
  if (!optionValue) {
    console.log("[baemin] 옵션값 없음, 옵션 선택 스킵");
    return { success: true, selectedOption: null, selectedOptions: [], totalOptionPrice: 0 };
  }

  // JSON 파싱
  let parsed = optionValue;
  if (typeof optionValue === "string") {
    try {
      parsed = JSON.parse(optionValue);
    } catch (e) {
      // JSON이 아닌 경우 단일 옵션으로 처리
      parsed = [{ value: optionValue }];
    }
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    console.log("[baemin] 파싱된 옵션값 없음");
    return { success: true, selectedOption: null, selectedOptions: [], totalOptionPrice: 0 };
  }

  // 2D 구조 검증: [{options: [{value}, ...]}, ...]
  const is2DStructure = parsed[0] && Array.isArray(parsed[0].options);

  const selectedOptions = [];
  let totalOptionPrice = 0;

  if (is2DStructure) {
    console.log(`[baemin] 옵션 세트 처리: ${parsed.length}개 세트 (각 수량: ${quantity})`);

    for (let s = 0; s < parsed.length; s++) {
      const set = parsed[s];
      const setOptions = set.options || [];

      console.log(`\n[baemin] --- 세트 ${s + 1}/${parsed.length} 처리 시작 (${setOptions.length}개 옵션) ---`);

      // 세트 내 모든 옵션 선택
      for (let i = 0; i < setOptions.length; i++) {
        const option = setOptions[i];
        const targetValue = option.value || option;
        const optionTitle = option.title || null;  // 드롭다운 버튼 찾기용

        console.log(`[baemin] 세트 ${s + 1}, 옵션 ${i + 1}: title="${optionTitle}", value="${targetValue}"`);

        const result = await selectSingleOption(page, targetValue, optionTitle);

        if (!result.success) {
          return {
            success: false,
            reason: result.reason,
            selectedOptions,
            totalOptionPrice,
          };
        }

        if (result.selectedOption) {
          selectedOptions.push(result.selectedOption);
          totalOptionPrice += result.price || 0;
        }
      }

      // 세트 내 모든 옵션 선택 후 수량 설정
      console.log(`[baemin] 세트 ${s + 1} 옵션 선택 완료, 수량 설정: ${quantity}개`);
      await setQuantity(page, quantity);
    }
  } else {
    // 2D 구조가 아닌 경우 에러
    return {
      success: false,
      reason: "잘못된 옵션 구조: 2D 구조 [{options: [...]}] 형식이어야 합니다",
      selectedOptions: [],
      totalOptionPrice: 0,
    };
  }

  console.log(`\n[baemin] 옵션 선택 완료: ${selectedOptions.length}개, 총 옵션가격: ${totalOptionPrice}원`);
  return {
    success: true,
    selectedOption: selectedOptions.join(" / "),
    selectedOptions,
    totalOptionPrice,
  };
}

/**
 * 상품 가격 추출
 */
async function getProductPrice(page) {
  try {
    const priceEl = await waitFor(page, SELECTORS.productPrice, 3000);
    await delay(1100);
    if (priceEl) {
      const priceText = await page.evaluate(
        (el) => el.textContent.trim(),
        priceEl
      );
      const price = parseInt(priceText.replace(/[^0-9]/g, ""), 10);
      console.log(`[baemin] 상품 가격: ${price}원`);
      return price;
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * 수량 설정 (마지막 선택된 옵션의 수량)
 * - 옵션 선택 시 옵션 박스가 아래로 쌓이는 구조
 * - 모든 + 버튼 중 마지막 것을 클릭하여 수량 조절
 */
async function setQuantity(page, quantity) {
  console.log(`[baemin] 수량 설정: ${quantity}`);

  if (quantity <= 1) {
    console.log("[baemin] 수량 1개, 기본값 유지");
    return true;
  }

  try {
    await delay(500);

    // 모든 + 버튼 찾아서 마지막 것 클릭 (옵션 박스가 쌓이는 구조)
    const clickCount = quantity - 1;
    console.log(`[baemin] + 버튼으로 수량 조절 (${clickCount}회 클릭)...`);

    const result = await page.evaluate((selector, clicks) => {
      const plusButtons = document.querySelectorAll(selector);
      if (plusButtons.length === 0) {
        return { success: false, reason: "수량 + 버튼을 찾을 수 없음", count: 0 };
      }

      // 마지막 + 버튼 (가장 최근 선택된 옵션)
      const lastPlusBtn = plusButtons[plusButtons.length - 1];
      console.log(`[baemin] + 버튼 ${plusButtons.length}개 발견, 마지막 버튼 클릭`);

      for (let i = 0; i < clicks; i++) {
        lastPlusBtn.click();
      }

      return { success: true, buttonCount: plusButtons.length, clicks };
    }, SELECTORS.quantityPlusButton, clickCount);

    if (result.success) {
      console.log(`[baemin] 수량 조절 완료: ${quantity}개 (버튼 ${result.buttonCount}개 중 마지막, ${result.clicks}회 클릭)`);
      await delay(300);
      return true;
    }

    console.log(`[baemin] ${result.reason}`);
    return false;
  } catch (error) {
    console.error("[baemin] 수량 설정 실패:", error.message);
    return false;
  }
}

/**
 * 장바구니 담기
 */
async function addToCart(page) {
  console.log("[baemin] 장바구니 담기...");

  try {
    // 1. 장바구니 담기 버튼 클릭 (텍스트 기반으로 찾기)
    await delay(1100);
    const cartBtnClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const cartBtn = buttons.find(btn => btn.textContent.trim() === '장바구니 담기');
      if (cartBtn) {
        cartBtn.click();
        return true;
      }
      return false;
    });

    if (!cartBtnClicked) {
      console.log("[baemin] 장바구니 버튼을 찾을 수 없음");
      return false;
    }

    await delay(1100);
    console.log("[baemin] 장바구니 담기 버튼 클릭됨");

    // 2. 장바구니 이동 모달 버튼 클릭 (텍스트 기반으로 찾기)
    await delay(1500); // 모달 로딩 대기
    const goToCartClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const goToCartBtn = buttons.find(btn => btn.textContent.trim() === '장바구니 이동');
      if (goToCartBtn) {
        goToCartBtn.click();
        return true;
      }
      return false;
    });

    if (goToCartClicked) {
      console.log("[baemin] 장바구니 이동 버튼 클릭...");
      await delay(1100);
      console.log("[baemin] 장바구니 페이지로 이동 완료");
    } else {
      console.log(
        "[baemin] 장바구니 이동 모달 버튼 없음 - 이미 장바구니에 담김"
      );
    }

    console.log("[baemin] 장바구니 담기 완료");
    return true;
  } catch (error) {
    console.error("[baemin] 장바구니 담기 실패:", error.message);
    return false;
  }
}

/**
 * 장바구니 비우기
 */
async function clearCart(page) {
  console.log("[baemin] 장바구니 비우기 시작...");

  try {
    // 1. 장바구니 페이지로 이동
    await page.goto("https://mart.baemin.com/cart", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await delay(1100);

    // 2. 전체선택 라벨 대기
    const labelEl = await waitFor(page, SELECTORS.cartSelectAllLabel, 5000);
    await delay(1100);
    if (!labelEl) {
      console.log("[baemin] 장바구니 비어있음 (전체선택 라벨 없음)");
      return { success: true, message: "장바구니 비어있음" };
    }

    const labelText = await page.evaluate(
      (el) => el.textContent.trim(),
      labelEl
    );
    console.log(`[baemin] 전체선택 라벨 텍스트: "${labelText}"`);

    // 3. 라벨 클릭 (전체선택 → 1번, 선택해제 → 2번)
    if (labelText.includes("전체선택")) {
      console.log("[baemin] 전체선택 상태 → 라벨 1번 클릭");
      await labelEl.click();
      await delay(1100);
    } else if (labelText.includes("선택해제")) {
      console.log("[baemin] 선택해제 상태 → 라벨 2번 클릭");
      await labelEl.click();
      await delay(1100);
      await labelEl.click();
      await delay(1100);
    }

    // 4. 선택 삭제 버튼 클릭 (텍스트로 찾기)
    console.log("[baemin] 선택 삭제 버튼 찾는 중 (텍스트 검색)...");
    await delay(1100);

    // 디버깅: 페이지에 있는 "삭제" 관련 텍스트 모두 출력
    const debugTexts = await page.evaluate(() => {
      const results = [];
      const allElements = document.querySelectorAll("div, button, span, a");
      for (const el of allElements) {
        const text = el.innerText || el.textContent || "";
        if (text.includes("삭제")) {
          results.push({
            tag: el.tagName,
            text: text.trim().substring(0, 50),
            className: el.className.substring(0, 50),
          });
        }
      }
      return results;
    });
    console.log(
      "[baemin] '삭제' 포함 요소들:",
      JSON.stringify(debugTexts, null, 2)
    );

    const deleteClicked = await page.evaluate(() => {
      // BUTTON 먼저 찾기
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = (btn.innerText || btn.textContent || "").trim();
        if (text === "선택 삭제" || text === "선택삭제") {
          btn.click();
          return { clicked: true, text, tag: "BUTTON" };
        }
      }
      return { clicked: false };
    });

    if (!deleteClicked.clicked) {
      console.log("[baemin] 선택 삭제 버튼 없음 - 삭제할 상품 없음");
      return { success: true, message: "삭제할 상품 없음" };
    }

    console.log(`[baemin] 선택 삭제 버튼 클릭 완료: "${deleteClicked.text}"`);
    await delay(1100);

    // 5. 삭제 확인 모달 버튼 대기 및 클릭 (텍스트로 찾기)
    console.log("[baemin] 삭제 확인 모달 대기 중...");
    await delay(1100);

    const confirmClicked = await page.evaluate(() => {
      // 모달 내 "삭제" 버튼 찾기
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = (btn.innerText || btn.textContent || "").trim();
        if (text === "삭제") {
          btn.click();
          return { clicked: true, text };
        }
      }
      return { clicked: false };
    });

    if (confirmClicked.clicked) {
      console.log(
        `[baemin] 삭제 확인 버튼 클릭 완료: "${confirmClicked.text}"`
      );
      await delay(1100);
    } else {
      console.log("[baemin] 삭제 확인 모달 버튼 없음");
    }

    console.log("[baemin] 장바구니 비우기 완료");
    return { success: true, message: "장바구니 비우기 완료" };
  } catch (error) {
    console.error("[baemin] 장바구니 비우기 실패:", error.message);
    return { success: false, message: error.message };
  }
}

/**
 * 배송지 입력 (결제 페이지에서)
 */
async function enterShippingAddress(page, shippingAddress) {
  console.log("[baemin] 배송지 입력 시작...");

  if (!shippingAddress) {
    console.log("[baemin] 배송지 정보 없음");
    return { success: false, message: "배송지 정보 없음" };
  }

  try {
    // 1. 주소 변경 버튼 클릭
    console.log("[baemin] 1. 주소 변경 버튼 클릭...");
    const addressChangeBtn = await waitFor(page, SELECTORS.addressChangeButton, 5000);
    await delay(1100);

    if (!addressChangeBtn) {
      console.log("[baemin] 주소 변경 버튼 없음");
      return { success: false, message: "주소 변경 버튼 없음" };
    }

    await addressChangeBtn.click();
    await delay(1100);

    // 2. 수정 버튼 클릭
    console.log("[baemin] 2. 수정 버튼 클릭...");
    const editBtn = await waitFor(page, SELECTORS.addressEditButton, 5000);
    await delay(1100);

    if (!editBtn) {
      console.log("[baemin] 수정 버튼 없음");
      return { success: false, message: "수정 버튼 없음" };
    }

    await editBtn.click();
    await delay(1100);

    // 3. 받으실 분 입력 (puppeteer로 직접 입력)
    console.log("[baemin] 3. 받으실 분 입력...");
    const recipientName = shippingAddress.firstName || "";

    if (recipientName) {
      // input이 나타날 때까지 대기
      const nameInput = await waitFor(page, 'input[autocomplete="receiverName"]', 5000);
      await delay(500);

      if (nameInput) {
        await nameInput.click({ clickCount: 3 }); // 전체 선택
        await delay(200);
        await nameInput.type(recipientName, { delay: 50 });
        console.log(`[baemin] 받으실 분: ${recipientName}`);
      } else {
        console.log("[baemin] 받으실 분 input 못찾음");
      }
      await delay(500);
    }

    // 4. 연락처 입력 (고정값: 010-7749-7515)
    console.log("[baemin] 4. 연락처 입력...");
    const phoneNumber = "010-7749-7515";

    const phoneInput = await waitFor(page, 'input[autocomplete="mobile"]', 5000);
    await delay(500);

    if (phoneInput) {
      await phoneInput.click({ clickCount: 3 }); // 전체 선택
      await delay(200);
      await phoneInput.type(phoneNumber, { delay: 50 });
      console.log(`[baemin] 연락처: ${phoneNumber}`);
    } else {
      console.log("[baemin] 연락처 input 못찾음");
    }
    await delay(500);

    // 5. 주소 검색 버튼 클릭 (텍스트로 찾기)
    console.log("[baemin] 5. 주소 검색 버튼 클릭...");

    const searchClicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = (btn.innerText || btn.textContent || "").trim();
        if (text === "주소검색" || text === "주소 검색") {
          btn.click();
          return { clicked: true, text };
        }
      }
      return { clicked: false };
    });

    if (!searchClicked.clicked) {
      console.log("[baemin] 주소 검색 버튼 없음");
      return { success: false, message: "주소 검색 버튼 없음" };
    }
    console.log(`[baemin] 주소 검색 버튼 클릭: "${searchClicked.text}"`);
    await delay(1100);

    // 6. "주소 검색" 모달 내 iframe 찾기
    console.log("[baemin] 6. 주소 검색 모달 내 iframe 찾기...");

    // 디버깅: 페이지에 있는 iframe들 확인
    const iframeDebug = await page.evaluate(() => {
      const iframes = document.querySelectorAll("iframe");
      return Array.from(iframes).map((f, i) => ({
        index: i,
        title: f.title,
        src: f.src,
        id: f.id,
        className: f.className,
      }));
    });
    console.log("[baemin] 페이지 iframe 목록:", JSON.stringify(iframeDebug, null, 2));

    // iframe 로드 대기 - page.frames()로 모든 프레임에서 찾기
    let frame = null;

    console.log("[baemin] 다음 주소 검색 iframe 대기...");

    for (let i = 0; i < 30; i++) {
      try {
        // 모든 프레임 가져오기
        const allFrames = page.frames();
        console.log(`[baemin] 프레임 수: ${allFrames.length}`);

        // 각 프레임에서 #region_name 찾기
        for (const f of allFrames) {
          try {
            const url = f.url();
            // 다음 주소 검색 URL 패턴 확인
            if (url.includes('postcode') || url.includes('daum') || url.includes('daumcdn')) {
              console.log(`[baemin] 다음 주소 프레임 URL 발견: ${url.substring(0, 100)}`);
            }

            const hasInput = await f.$(SELECTORS.daumAddressInput);
            if (hasInput) {
              frame = f;
              console.log(`[baemin] #region_name 발견! (${i + 1}회, URL: ${url.substring(0, 80)})`);
              break;
            }

            // 다른 검색 input 찾기
            const searchInput = await f.$('input[type="text"], input.txt_search');
            if (searchInput && url.includes('daum')) {
              frame = f;
              console.log(`[baemin] 다음 검색 input 발견 (${i + 1}회)`);
              break;
            }
          } catch (e) {
            // 프레임 접근 실패 - 무시
          }
        }

        if (frame) break;

        console.log(`[baemin] iframe 콘텐츠 대기 중... (${i + 1}/30)`);
      } catch (e) {
        console.log(`[baemin] 프레임 검색 실패 (${i + 1}/30): ${e.message}`);
      }

      await delay(500);
    }

    if (!frame) {
      console.log("[baemin] 주소 검색 iframe 콘텐츠 로드 실패");
      return { success: false, message: "주소 검색 iframe 콘텐츠 없음" };
    }

    // 7. iframe 내부에서 주소 검색
    console.log("[baemin] 7. iframe 내부 주소 검색...");
    await delay(500);

    // 주소 검색어 입력
    const searchAddress = shippingAddress.streetAddress1 || shippingAddress.address || shippingAddress.streetAddress || "";
    if (searchAddress) {
      const addressInput = await frame.$(SELECTORS.daumAddressInput);
      if (addressInput) {
        await addressInput.click();
        await addressInput.type(searchAddress, { delay: 50 });
        console.log(`[baemin] 주소 검색어: ${searchAddress}`);
        await delay(300);

        // 검색 버튼 클릭
        const searchBtn = await frame.$(SELECTORS.daumSearchButton);
        if (searchBtn) {
          await searchBtn.click();
          console.log("[baemin] 검색 버튼 클릭");
        } else {
          await frame.keyboard.press("Enter");
          console.log("[baemin] Enter 키로 검색");
        }
        await delay(1500);
      }
    }

    // 8. 주소 검색 결과 첫 번째 항목 클릭 (li.list_post_item)
    console.log("[baemin] 8. 주소 검색 결과 선택...");
    try {
      await frame.waitForSelector(SELECTORS.daumAddressItem, { timeout: 5000 });
      await delay(500);

      // 첫 번째 li.list_post_item 클릭
      const addressClicked = await frame.evaluate((selector) => {
        const firstItem = document.querySelector(selector);
        if (firstItem) {
          // li 자체를 클릭하거나, 내부의 도로명 주소 버튼 클릭
          const roadAddrBtn = firstItem.querySelector(".main_road .link_post");
          if (roadAddrBtn) {
            roadAddrBtn.click();
            return { clicked: true, type: "road_button" };
          }
          // 폴백: li 클릭
          firstItem.click();
          return { clicked: true, type: "li" };
        }
        return { clicked: false };
      }, SELECTORS.daumAddressItem);

      if (addressClicked.clicked) {
        console.log(`[baemin] 주소 선택 완료 (${addressClicked.type})`);
        await delay(1500);
      } else {
        console.log("[baemin] 주소 검색 결과 없음");
      }
    } catch (e) {
      console.log("[baemin] 주소 선택 에러:", e.message);
    }

    // 9. "배송지 수정" 모달 내 상세주소 입력 (streetAddress2)
    console.log("[baemin] 9. 배송지 수정 모달에서 상세주소 입력...");
    const detailAddress = shippingAddress.streetAddress2 || "";

    // iframe 닫히고 "배송지 수정" 모달 대기
    await delay(1500);

    if (detailAddress) {
      // "배송지 수정" 모달 내 상세주소 input 찾기
      const detailInputResult = await page.evaluate((addr) => {
        // "배송지 수정" 텍스트가 있는 모달 찾기
        const allDivs = document.querySelectorAll("div");
        let modalContainer = null;

        for (const div of allDivs) {
          const text = (div.innerText || div.textContent || "").trim();
          if (text.startsWith("배송지 수정")) {
            // 상위로 올라가서 모달 컨테이너 찾기
            let parent = div.parentElement;
            while (parent) {
              const form = parent.querySelector("form");
              if (form) {
                modalContainer = parent;
                break;
              }
              parent = parent.parentElement;
            }
            break;
          }
        }

        if (!modalContainer) {
          return { found: false, reason: "배송지 수정 모달 못찾음" };
        }

        // 모달 내 input들 중 상세주소 찾기 (보통 5번째 또는 placeholder로)
        const inputs = modalContainer.querySelectorAll('input[type="text"], input:not([type])');
        let detailInput = null;

        // placeholder로 찾기
        for (const input of inputs) {
          const placeholder = input.placeholder || "";
          if (placeholder.includes("상세") || placeholder.includes("나머지") || placeholder.includes("동/호수")) {
            detailInput = input;
            break;
          }
        }

        // 못찾으면 마지막 input (상세주소는 보통 마지막)
        if (!detailInput && inputs.length > 0) {
          detailInput = inputs[inputs.length - 1];
        }

        if (detailInput) {
          detailInput.focus();
          detailInput.value = "";
          detailInput.dispatchEvent(new Event("input", { bubbles: true }));
          detailInput.value = addr;
          detailInput.dispatchEvent(new Event("input", { bubbles: true }));
          detailInput.dispatchEvent(new Event("change", { bubbles: true }));
          return { found: true, inputCount: inputs.length };
        }

        return { found: false, reason: "상세주소 input 못찾음" };
      }, detailAddress);

      if (detailInputResult.found) {
        console.log(`[baemin] 상세주소 입력 완료: ${detailAddress}`);
      } else {
        console.log(`[baemin] 상세주소 input 못찾음: ${detailInputResult.reason}`);
      }
      await delay(500);
    }

    // 10. "배송지 수정" 모달 내 저장하기 버튼 클릭
    console.log("[baemin] 10. 저장하기 버튼 클릭...");
    const saveClicked = await page.evaluate(() => {
      // "배송지 수정" 모달 내 form 찾기
      const allDivs = document.querySelectorAll("div");
      let form = null;

      for (const div of allDivs) {
        const firstText = div.childNodes[0]?.textContent?.trim() || "";
        if (firstText === "배송지 수정") {
          // 형제나 부모에서 form 찾기
          let parent = div.parentElement;
          while (parent) {
            form = parent.querySelector("form");
            if (form) break;
            parent = parent.parentElement;
          }
          break;
        }
      }

      if (form) {
        // form 내 저장하기 버튼 찾기
        const buttons = form.querySelectorAll("button");
        for (const btn of buttons) {
          const text = (btn.innerText || btn.textContent || "").trim();
          if (text === "저장하기" || text === "저장" || text === "완료") {
            btn.click();
            return { clicked: true, text, inForm: true };
          }
        }
      }

      // 폴백: 페이지 전체에서 "저장하기" 버튼 찾기
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = (btn.innerText || btn.textContent || "").trim();
        if (text === "저장하기") {
          btn.click();
          return { clicked: true, text, inForm: false };
        }
      }
      return { clicked: false };
    });

    if (saveClicked.clicked) {
      console.log(`[baemin] 저장하기 버튼 클릭: "${saveClicked.text}" (form내: ${saveClicked.inForm})`);
      await delay(1500);
    } else {
      console.log("[baemin] 저장하기 버튼 없음");
    }

    console.log("[baemin] 배송지 입력 완료");
    return { success: true, message: "배송지 입력 완료" };
  } catch (error) {
    console.error("[baemin] 배송지 입력 실패:", error.message);
    return { success: false, message: error.message };
  }
}

/**
 * 주문하기 (장바구니 → 결제 페이지)
 */
async function proceedToCheckout(page) {
  console.log("[baemin] 주문하기 시작...");

  try {
    // 1. 장바구니 페이지로 이동
    await page.goto("https://mart.baemin.com/cart", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await delay(1100);

    // 2. 주문하기 버튼 클릭 (셀렉터 우선, 텍스트 폴백)
    console.log("[baemin] 주문하기 버튼 찾는 중...");
    await delay(2000); // 페이지 완전 로드 대기

    // 셀렉터로 먼저 시도
    let orderBtn = await waitFor(page, SELECTORS.cartOrderButton, 3000);
    await delay(1100);

    if (orderBtn) {
      console.log("[baemin] 주문하기 버튼 발견 (셀렉터)");
      await orderBtn.click();
    } else {
      // 텍스트로 폴백
      console.log("[baemin] 셀렉터 실패, 텍스트로 검색...");
      const orderClicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll("button");
        for (const btn of buttons) {
          const text = (btn.innerText || btn.textContent || "").trim();
          if (text.includes("주문하기")) {
            btn.click();
            return { clicked: true, text: text.substring(0, 50) };
          }
        }
        return { clicked: false };
      });

      if (!orderClicked.clicked) {
        console.log("[baemin] 주문하기 버튼 없음");
        return { success: false, message: "주문하기 버튼 없음" };
      }
      console.log(`[baemin] 주문하기 버튼 클릭 (텍스트): "${orderClicked.text}"`);
    }

    await delay(1100);

    // 3. 최종 주문하기 모달 버튼 클릭 (셀렉터 우선)
    console.log("[baemin] 최종 주문하기 버튼 찾는 중...");
    await delay(1100);

    let finalOrderBtn = await waitFor(page, SELECTORS.finalOrderButton, 3000);
    await delay(1100);

    if (finalOrderBtn) {
      console.log("[baemin] 최종 주문하기 버튼 발견 (셀렉터)");
      await finalOrderBtn.click();
      await delay(1100);
    } else {
      // 텍스트로 폴백
      const finalOrderClicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll("button");
        for (const btn of buttons) {
          const text = (btn.innerText || btn.textContent || "").trim();
          if (text === "주문하기") {
            btn.click();
            return { clicked: true, text };
          }
        }
        return { clicked: false };
      });

      if (finalOrderClicked.clicked) {
        console.log(`[baemin] 최종 주문하기 버튼 클릭 (텍스트): "${finalOrderClicked.text}"`);
        await delay(1100);
      }
    }

    // 4. "확인" 모달 처리 (때때로 나타남)
    console.log("[baemin] 확인 모달 체크 중...");
    await delay(500);

    const confirmClicked = await page.evaluate(() => {
      // 모달 내 "확인" 버튼 찾기
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = (btn.innerText || btn.textContent || "").trim();
        if (text === "확인") {
          btn.click();
          return { clicked: true, text };
        }
      }
      return { clicked: false };
    });

    if (confirmClicked.clicked) {
      console.log(`[baemin] 확인 모달 버튼 클릭: "${confirmClicked.text}"`);
      await delay(1100);
    } else {
      console.log("[baemin] 확인 모달 없음, 계속 진행");
    }

    // 5. 결제 페이지 이동 대기
    await page
      .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 })
      .catch(() => {});
    await delay(1100);

    const currentUrl = page.url();
    console.log(`[baemin] 현재 URL: ${currentUrl}`);

    // 결제 페이지 확인
    if (
      currentUrl.includes("order") ||
      currentUrl.includes("checkout") ||
      currentUrl.includes("payment")
    ) {
      console.log("[baemin] 결제 페이지 진입 성공");
      return {
        success: true,
        message: "결제 페이지 진입 성공",
        url: currentUrl,
      };
    }

    return { success: true, message: "주문하기 완료", url: currentUrl };
  } catch (error) {
    console.error("[baemin] 주문하기 실패:", error.message);
    return { success: false, message: error.message };
  }
}

/**
 * 결제 처리 (네이버페이 선택 → 현금영수증 미발행 → 필수동의 → 결제하기)
 */
async function processPayment(page) {
  console.log("[baemin] 결제 처리 시작...");

  try {
    // 1. 네이버페이 선택
    console.log("[baemin] 1. 네이버페이 선택...");
    const naverPayInput = await waitFor(page, SELECTORS.naverPayInput, 5000);
    if (naverPayInput) {
      await naverPayInput.click();
      console.log("[baemin] 네이버페이 선택 완료");
    } else {
      console.log("[baemin] 네이버페이 input 없음, 텍스트로 검색...");
      await page.evaluate(() => {
        const labels = document.querySelectorAll("label");
        for (const label of labels) {
          const text = (label.innerText || label.textContent || "").trim();
          if (text.includes("네이버페이")) {
            label.click();
            return true;
          }
        }
        return false;
      });
    }
    await delay(1100);

    // 2. 현금영수증 미발행 선택
    console.log("[baemin] 2. 현금영수증 미발행 선택...");
    const cashReceiptInput = await waitFor(page, SELECTORS.cashReceiptNoIssue, 3000);
    if (cashReceiptInput) {
      await cashReceiptInput.click();
      console.log("[baemin] 현금영수증 미발행 선택 완료");
    } else {
      console.log("[baemin] 현금영수증 미발행 input 없음, 텍스트로 검색...");
      await page.evaluate(() => {
        const labels = document.querySelectorAll("label");
        for (const label of labels) {
          const text = (label.innerText || label.textContent || "").trim();
          if (text.includes("미발행") || text.includes("발행안함")) {
            label.click();
            return true;
          }
        }
        return false;
      });
    }
    await delay(1100);

    // 3. 필수 동의 체크
    console.log("[baemin] 3. 필수 동의 체크...");
    const agreementLabel = await waitFor(page, SELECTORS.requiredAgreementLabel, 3000);
    if (agreementLabel) {
      await agreementLabel.click();
      console.log("[baemin] 필수 동의 체크 완료");
    } else {
      console.log("[baemin] 필수 동의 라벨 없음, 텍스트로 검색...");
      await page.evaluate(() => {
        const labels = document.querySelectorAll("label");
        for (const label of labels) {
          const text = (label.innerText || label.textContent || "").trim();
          if (text.includes("필수") && text.includes("동의")) {
            label.click();
            return true;
          }
        }
        return false;
      });
    }
    await delay(1100);

    // 4. 결제하기 버튼 클릭
    console.log("[baemin] 4. 결제하기 버튼 클릭...");

    const browser = page.browser();
    let naverPayPage = null;

    // 현재 페이지 수 기록
    const pagesBefore = await browser.pages();
    const pagesCountBefore = pagesBefore.length;
    console.log(`[baemin] 현재 페이지 수: ${pagesCountBefore}`);

    // 결제하기 버튼 클릭
    const paymentBtn = await waitFor(page, SELECTORS.paymentButton, 3000);
    if (paymentBtn) {
      await paymentBtn.click();
      console.log("[baemin] 결제하기 버튼 클릭 완료");
    } else {
      console.log("[baemin] 결제하기 버튼 없음, 텍스트로 검색...");
      const clicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll("button");
        for (const btn of buttons) {
          const text = (btn.innerText || btn.textContent || "").trim();
          if (text.includes("결제하기")) {
            btn.click();
            return { clicked: true, text };
          }
        }
        return { clicked: false };
      });
      if (clicked.clicked) {
        console.log(`[baemin] 결제하기 버튼 클릭 (텍스트): "${clicked.text}"`);
      } else {
        return { success: false, message: "결제하기 버튼 없음" };
      }
    }

    // 5. 네이버페이 새창 대기 (폴링 방식)
    console.log("[baemin] 5. 네이버페이 새창 대기 (폴링)...");

    // 새 창이 열릴 때까지 폴링
    for (let i = 0; i < 20; i++) {
      await delay(500);
      const pagesAfter = await browser.pages();
      console.log(`[baemin] 페이지 수 체크 (${i + 1}/20): ${pagesAfter.length}`);

      if (pagesAfter.length > pagesCountBefore) {
        // 새 창 발견
        naverPayPage = pagesAfter[pagesAfter.length - 1];
        console.log("[baemin] 새창 감지 성공!");
        break;
      }
    }

    if (!naverPayPage) {
      console.log("[baemin] 새창 감지 실패, 기존 페이지에서 진행...");
      naverPayPage = page;
    }

    await delay(2000);

    const naverPayUrl = naverPayPage.url();
    console.log(`[baemin] 네이버페이 URL: ${naverPayUrl}`);

    // 6. 네이버 로그인 (필요한 경우)
    if (naverPayUrl.includes("nid.naver.com") || naverPayUrl.includes("login")) {
      console.log("[baemin] 6. 네이버 로그인 필요...");

      // 네이버 로그인 정보 가져오기
      const { getVendorByKey } = require("../config");
      const naverConfig = getVendorByKey("naver");

      if (!naverConfig || !naverConfig.userId || !naverConfig.password) {
        console.log("[baemin] 네이버 로그인 정보 없음");
        return { success: false, message: "네이버 로그인 정보 없음" };
      }

      // 아이디 입력
      const idInput = await naverPayPage.$("#id");
      if (idInput) {
        await idInput.click();
        await idInput.type(naverConfig.userId, { delay: 50 });
        console.log("[baemin] 네이버 아이디 입력 완료");
      }
      await delay(500);

      // 비밀번호 입력
      const pwInput = await naverPayPage.$("#pw");
      if (pwInput) {
        await pwInput.click();
        await pwInput.type(naverConfig.password, { delay: 50 });
        console.log("[baemin] 네이버 비밀번호 입력 완료");
      }
      await delay(500);

      // 로그인 버튼 클릭
      const submitBtn = await naverPayPage.$("#submit_btn");
      if (submitBtn) {
        await submitBtn.click();
        console.log("[baemin] 네이버 로그인 버튼 클릭");
      }

      // 로그인 후 페이지 이동 대기
      await naverPayPage
        .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 })
        .catch(() => {});
      await delay(2000);

      const afterLoginUrl = naverPayPage.url();
      console.log(`[baemin] 로그인 후 URL: ${afterLoginUrl}`);
    }

    // 7. "동의하고 결제하기" 버튼 클릭
    console.log("[baemin] 7. 동의하고 결제하기 버튼 클릭...");
    await delay(2000);

    const agreePayBtnSelector =
      "#root > div > div:nth-child(3) > div > div > div > div > div > button";
    const agreePayBtn = await naverPayPage.$(agreePayBtnSelector);

    if (agreePayBtn) {
      await agreePayBtn.click();
      console.log("[baemin] 동의하고 결제하기 버튼 클릭 완료");
    } else {
      // 텍스트로 폴백
      console.log("[baemin] 셀렉터 실패, 텍스트로 검색...");
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
          `[baemin] 동의하고 결제하기 버튼 클릭 (텍스트): "${agreeClicked.text}"`
        );
      } else {
        console.log("[baemin] 동의하고 결제하기 버튼 없음");
      }
    }

    // 8. 결제 비밀번호 입력 (OCR)
    console.log("[baemin] 8. 결제 비밀번호 입력 대기...");
    await delay(3000);

    // 네이버 설정에서 PIN 가져오기
    const { getVendorByKey } = require("../config");
    const naverConfig = getVendorByKey("naver");
    const pin = naverConfig?.naverPayPin;

    if (!pin) {
      console.log("[baemin] 네이버페이 PIN이 설정되지 않음 (NAVER_PAY_PIN)");
      return {
        success: false,
        message: "네이버페이 PIN이 설정되지 않음",
        naverPayPage,
      };
    }

    // OCR로 키패드 인식 및 PIN 입력
    const pinResult = await enterNaverPayPin(naverPayPage, pin);

    if (!pinResult.success) {
      console.log("[baemin] PIN 입력 실패:", pinResult.reason || "알 수 없음");
      return {
        success: false,
        message: `PIN 입력 실패: ${pinResult.reason || "알 수 없음"}`,
        naverPayPage,
      };
    }

    console.log("[baemin] PIN 입력 완료!");
    await delay(3000);

    // 9. 결제 완료 후 처리 - 팝업이 닫히고 원래 배민 페이지로 이동됨
    console.log("[baemin] 9. 결제 완료 확인 (배민 페이지)...");
    let orderNumber = null;

    // 팝업이 닫힐 때까지 대기
    for (let i = 0; i < 10; i++) {
      try {
        const isOpen = naverPayPage && !naverPayPage.isClosed();
        if (!isOpen) {
          console.log(`[baemin] 네이버페이 팝업 닫힘 확인 (${i + 1}회)`);
          break;
        }
        console.log(`[baemin] 네이버페이 팝업 닫힘 대기... (${i + 1}/10)`);
        await delay(1000);
      } catch (e) {
        console.log(`[baemin] 팝업 닫힘 확인: ${e.message}`);
        break;
      }
    }

    // 배민 페이지로 포커스 전환 및 결제 완료 확인
    await delay(2000);

    try {
      // 배민 페이지 URL 확인
      const baeminUrl = await page.url();
      console.log(`[baemin] 배민 페이지 URL: ${baeminUrl}`);

      // 10. "주문내역 상세보기" 버튼 대기 및 클릭 (배민 페이지)
      console.log("[baemin] 10. 주문내역 상세보기 버튼 대기 (배민 페이지)...");

      const orderDetailBtnSelector = "#root > div > section > div.sc-doGdGr.fdlYoH > div.sc-ctosZL.feYMnx > button.sc-ehvNnt.fxMHfA";

      // 버튼이 나타날 때까지 대기 (최대 30초)
      const orderDetailBtn = await waitFor(page, orderDetailBtnSelector, 30000);

      if (orderDetailBtn) {
        await orderDetailBtn.click();
        console.log("[baemin] 주문내역 상세보기 버튼 클릭 완료");
        await delay(3000);
      } else {
        // 텍스트로 폴백
        console.log("[baemin] 셀렉터 실패, 텍스트로 검색...");
        const detailClicked = await page.evaluate(() => {
          const buttons = document.querySelectorAll("button, a");
          for (const btn of buttons) {
            const text = (btn.innerText || btn.textContent || "").trim();
            if (text.includes("주문내역") || text.includes("상세보기")) {
              btn.click();
              return { clicked: true, text };
            }
          }
          return { clicked: false };
        });
        if (detailClicked.clicked) {
          console.log(`[baemin] 주문내역 상세보기 버튼 클릭 (텍스트): "${detailClicked.text}"`);
          await delay(3000);
        }
      }

      // 11. 주문번호 추출 (배민 페이지)
      console.log("[baemin] 11. 주문번호 추출...");

      const orderNumberSelector = "#root > div > div.sc-kvVhHC.cDSays > div.sc-gLBXkV.Rsxkb > div.sc-jmxFWv.kJriCA > div:nth-child(2) > div.sc-kLrQKW.evIhGF > div > div.sc-iODgfC.taTVJ > div > div > span.sc-dMLRKe.crbOaE";

      // 주문번호 셀렉터로 추출 시도
      const orderNumberSpan = await page.$(orderNumberSelector);
      if (orderNumberSpan) {
        const text = await page.evaluate((el) => el.textContent || "", orderNumberSpan);
        const match = text.match(/\d+/);
        if (match) {
          orderNumber = match[0];
          console.log(`[baemin] 주문번호 추출 완료 (셀렉터): ${orderNumber}`);
        }
      }

      // 페이지 텍스트에서 주문번호 추출 (폴백)
      if (!orderNumber) {
        console.log("[baemin] 셀렉터 실패, 텍스트로 검색...");
        const baeminOrderNumber = await page.evaluate(() => {
          const allText = document.body.innerText || "";
          const patterns = [
            /주문번호[:\s]*(\d+)/,
            /주문\s*번호[:\s]*(\d+)/,
          ];
          for (const pattern of patterns) {
            const match = allText.match(pattern);
            if (match) return match[1];
          }
          return null;
        });

        if (baeminOrderNumber) {
          orderNumber = baeminOrderNumber;
          console.log(`[baemin] 주문번호 추출 완료 (텍스트): ${orderNumber}`);
        }
      }
    } catch (e) {
      console.log("[baemin] 배민 페이지 확인 실패:", e.message);
    }

    // 최종 결과 반환
    let finalUrl = "unknown";
    try {
      finalUrl = page.url();
    } catch (e) {
      // ignore
    }
    console.log(`[baemin] 최종 URL: ${finalUrl}`);

    if (orderNumber) {
      console.log("[baemin] 결제 완료!");
      return {
        success: true,
        message: "결제 완료",
        orderNumber,
        url: finalUrl,
      };
    }

    // 주문번호는 못 찾았지만 결제는 완료된 것으로 간주
    console.log("[baemin] 결제 완료 (주문번호 추출 실패 - 나중에 확인 필요)");
    return { success: true, message: "결제 완료 (주문번호 확인 필요)", url: finalUrl };
  } catch (error) {
    console.error("[baemin] 결제 처리 실패:", error.message);
    return { success: false, message: error.message };
  }
}

// ==================== 메인 주문 처리 ====================

/**
 * 배민상회 주문 처리 (메인)
 */
async function processBaeminOrder(
  res,
  page,
  vendor,
  { products, purchaseOrderId, shippingAddress, lineIds },
  authToken
) {
  console.log("\n========================================");
  console.log("[baemin] 배민상회 주문 처리 시작");
  console.log(`[baemin] 상품 수: ${products?.length || 0}`);
  console.log(`[baemin] lineIds: ${JSON.stringify(lineIds || [])}`);
  console.log("========================================\n");

  const steps = [];
  const addedProducts = [];
  // lineIds를 직접 사용 (request body에서 전달됨)
  const purchaseOrderLineIds = lineIds || [];
  const errorCollector = createOrderErrorCollector("baemin");

  try {
    // 1. 로그인
    const loginResult = await loginToBaemin(page, vendor);
    steps.push({
      step: "login",
      success: loginResult.success,
      message: loginResult.message,
    });

    if (!loginResult.success) {
      errorCollector.addError(
        ORDER_STEPS.LOGIN,
        ERROR_CODES.LOGIN_FAILED,
        loginResult.message,
        { purchaseOrderId }
      );
      await saveOrderResults(authToken, {
        purchaseOrderId,
        products: [],
        priceMismatches: [],
        optionFailedProducts: [],
        automationErrors: errorCollector.getErrors(),
        lineIds,
        success: false,
        vendor: "baemin",
      });
      return res.json({
        success: false,
        message: `로그인 실패: ${loginResult.message}`,
        purchaseOrderId,
        steps,
        automationErrors: errorCollector.getErrors(),
      });
    }

    // 2. 장바구니 비우기
    const clearResult = await clearCart(page);
    steps.push({
      step: "clear_cart",
      success: clearResult.success,
      message: clearResult.message,
    });

    // 3. 각 상품 처리
    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      console.log(`\n[baemin] === 상품 ${i + 1}/${products.length} ===`);
      console.log(`[baemin] 상품명: ${product.productName}`);
      console.log(`[baemin] URL: ${product.productUrl}`);

      try {
        // 3.1 상품 페이지 이동
        const navResult = await navigateToProduct(page, product.productUrl);
        if (!navResult.success) {
          steps.push({
            step: `product_${i + 1}`,
            success: false,
            error: navResult.error,
          });
          continue;
        }

        // 3.2 수량 계산 (openMallQtyPerUnit 적용)
        const baseQuantity = product.quantity || 1;
        const qtyPerUnit = product.openMallQtyPerUnit || 1;
        const actualQuantity = baseQuantity * qtyPerUnit;
        if (qtyPerUnit > 1) {
          console.log(`[baemin] 수량 변환: ${baseQuantity}개 × ${qtyPerUnit} = ${actualQuantity}개`);
        }

        // 3.3 옵션 선택 (openMallOptions가 있는 경우) - 각 옵션마다 수량 설정
        const optionValue = product.openMallOptions || null;
        let optionResult = { success: true, selectedOption: null, selectedOptions: [], totalOptionPrice: 0 };

        if (optionValue) {
          optionResult = await selectOption(page, optionValue, actualQuantity);
          if (!optionResult.success) {
            console.log(`[baemin] ⚠️ 옵션 선택 실패: ${optionResult.reason}`);
            addedProducts.push({
              ...product,
              optionFailed: true,
              optionFailReason: optionResult.reason,
              addedToCart: false,
            });
            steps.push({
              step: `product_${i + 1}`,
              productName: product.productName,
              success: false,
              error: `옵션 선택 실패: ${optionResult.reason}`,
            });
            continue;
          }
        } else {
          // 옵션이 없는 경우에만 수량 설정
          await setQuantity(page, actualQuantity);
        }

        // 3.4 가격 추출
        const openMallPrice = await getProductPrice(page);

        // 3.5 장바구니 담기
        const addedToCart = await addToCart(page);

        // 3.6 가격 비교
        // 배민상회: 옵션 가격 합산 = 협력사 가격 (VAT 제외)
        const totalOptionPrice = optionResult.totalOptionPrice || 0;
        const vendorPriceExcludeVat = totalOptionPrice > 0 ? totalOptionPrice : (product.vendorPriceExcludeVat || 0);
        const expectedPrice = Math.round(vendorPriceExcludeVat * 1.1);
        let priceMismatch = false;

        if (totalOptionPrice > 0) {
          console.log(`[baemin] 옵션 가격 합계: ${totalOptionPrice}원 (VAT 제외 협력사 가격)`);
          console.log(`[baemin] 예상 판매가 (VAT 포함): ${expectedPrice}원`);
        }

        if (openMallPrice && expectedPrice > 0) {
          if (openMallPrice !== expectedPrice) {
            console.log(
              `[baemin] ⚠️ 가격 불일치: 오픈몰 ${openMallPrice}원 vs 예상가 ${expectedPrice}원`
            );
            priceMismatch = true;
          } else {
            console.log(`[baemin] ✅ 가격 일치: ${openMallPrice}원`);
          }
        }

        addedProducts.push({
          ...product,
          openMallPrice,
          vendorPriceExcludeVat,
          totalOptionPrice,
          selectedOptions: optionResult.selectedOptions || [],
          priceMismatch,
          addedToCart,
          selectedOption: optionResult.selectedOption,
        });

        steps.push({
          step: `product_${i + 1}`,
          productName: product.productName,
          success: addedToCart,
        });
      } catch (error) {
        console.error(`[baemin] 상품 처리 실패:`, error.message);
        errorCollector.addError(
          ORDER_STEPS.ADD_TO_CART,
          null,
          error.message,
          {
            purchaseOrderId,
            purchaseOrderLineId: product.purchaseOrderLineId,
            productVariantVendorId: product.productVariantVendorId,
          }
        );
        steps.push({
          step: `product_${i + 1}`,
          productName: product.productName,
          success: false,
          error: error.message,
        });
      }
    }

    // 4. 주문하기 (결제 페이지 진입)
    const checkoutResult = await proceedToCheckout(page);
    steps.push({
      step: "checkout",
      success: checkoutResult.success,
      message: checkoutResult.message,
      url: checkoutResult.url,
    });

    // checkout 실패 시 에러 수집
    if (!checkoutResult.success) {
      errorCollector.addError(
        ORDER_STEPS.ORDER_PLACEMENT,
        ERROR_CODES.NAVIGATION_FAILED,
        checkoutResult.message || "결제 페이지 진입 실패",
        { purchaseOrderId }
      );
    }

    // 5. 배송지 입력
    if (checkoutResult.success && shippingAddress) {
      const addressResult = await enterShippingAddress(page, shippingAddress);
      steps.push({
        step: "shipping_address",
        success: addressResult.success,
        message: addressResult.message,
      });

      // 배송지 입력 실패 시 에러 수집
      if (!addressResult.success) {
        errorCollector.addError(
          ORDER_STEPS.ORDER_PLACEMENT,
          ERROR_CODES.ELEMENT_NOT_FOUND,
          addressResult.message || "배송지 입력 실패",
          { purchaseOrderId }
        );
      }

      // 6. 결제 처리 (네이버페이)
      if (addressResult.success) {
        const paymentResult = await processPayment(page);
        steps.push({
          step: "payment",
          success: paymentResult.success,
          message: paymentResult.message,
          url: paymentResult.url,
          orderNumber: paymentResult.orderNumber,
        });

        // 결제 실패 시 에러 수집
        if (!paymentResult.success) {
          errorCollector.addError(
            ORDER_STEPS.PAYMENT,
            ERROR_CODES.PAYMENT_FAILED,
            paymentResult.message || "결제 실패",
            { purchaseOrderId }
          );
        }

        // 결제 성공 시 주문번호를 각 상품에 설정
        if (paymentResult.success && paymentResult.orderNumber) {
          for (const p of addedProducts) {
            p.openMallOrderNumber = paymentResult.orderNumber;
          }
        }
      }
    }

    // 7. 결과 반환
    const successfulProducts = addedProducts.filter((p) => p.addedToCart);

    // 옵션 실패 상품 필터링 (조기 정의)
    const optionFailedProducts = addedProducts
      .filter((p) => p.optionFailed)
      .map((p) => ({
        orderLineIds: p.orderLineIds,
        purchaseOrderLineId: p.purchaseOrderLineId,
        productVariantVendorId: p.productVariantVendorId,
        productSku: p.productSku,
        productName: p.productName,
        reason: p.optionFailReason,
      }));

    if (successfulProducts.length === 0) {
      await saveOrderResults(authToken, {
        purchaseOrderId,
        products: addedProducts || [],
        priceMismatches: [],
        optionFailedProducts: optionFailedProducts?.map(p => ({
          productVariantVendorId: p.productVariantVendorId,
          reason: p.optionFailReason || p.reason,
        })) || [],
        automationErrors: errorCollector.getErrors(),
        lineIds,
        success: false,
        vendor: "baemin",
      });
      return res.json({
        success: false,
        message: "장바구니에 담긴 상품이 없습니다",
        purchaseOrderId,
        steps,
        addedProducts,
        automationErrors: errorCollector.getErrors(),
      });
    }

    // 가격 불일치 상세 데이터
    const priceMismatchList = addedProducts.filter((p) => p.priceMismatch);
    const priceMismatches = priceMismatchList.map((p) => {
      const vendorPriceExcludeVat = p.vendorPriceExcludeVat || 0;
      const expectedPrice = Math.round(vendorPriceExcludeVat * 1.1);
      const priceDiff = p.openMallPrice - expectedPrice;
      const priceDiffPercent =
        expectedPrice > 0 ? ((priceDiff / expectedPrice) * 100).toFixed(2) : 0;
      return {
        purchaseOrderLineId: p.purchaseOrderLineId || null,
        productVariantVendorId: p.productVariantVendorId || null,
        productCode: p.productSku,
        productName: p.productName,
        quantity: p.quantity,
        openMallPrice: p.openMallPrice,
        expectedPrice: expectedPrice,
        vendorPriceExcludeVat: vendorPriceExcludeVat,
        difference: priceDiff,
        differencePercent: priceDiffPercent,
      };
    });

    // 결제 결과에서 주문번호 추출
    const paymentStep = steps.find((s) => s.step === "payment");
    const finalOrderNumber = paymentStep?.orderNumber || null;
    const paymentSuccess = paymentStep?.success || false;

    await saveOrderResults(authToken, {
      purchaseOrderId,
      products: addedProducts.map(p => ({
        orderLineIds: p.orderLineIds,
        openMallOrderNumber: finalOrderNumber,
      })),
      priceMismatches: priceMismatches?.map(p => ({
        productVariantVendorId: p.productVariantVendorId,
        vendorPriceExcludeVat: p.vendorPriceExcludeVat,
        openMallPrice: p.openMallPrice,
      })) || [],
      optionFailedProducts: [],
      automationErrors: [],
      lineIds,
      success: true,
      vendor: "baemin",
    });

    return res.json({
      success: true,
      message: paymentSuccess && finalOrderNumber
        ? "주문 완료"
        : "주문 처리 완료 - 결제 확인 필요",
      orderNumber: finalOrderNumber,
      purchaseOrderId,
      purchaseOrderLineIds: purchaseOrderLineIds,
      products: addedProducts.map((p) => ({
        orderLineIds: p.orderLineIds,
        openMallOrderNumber: p.openMallOrderNumber || finalOrderNumber,
        productName: p.productName,
        productSku: p.productSku,
        quantity: p.quantity,
        openMallPrice: p.openMallPrice,
        vendorPriceExcludeVat: p.vendorPriceExcludeVat,
        totalOptionPrice: p.totalOptionPrice || 0,
        selectedOptions: p.selectedOptions || [],
        priceMismatch: p.priceMismatch,
        selectedOption: p.selectedOption || null,
        optionFailed: p.optionFailed || false,
        needsManagerVerification: p.needsManagerVerification || false,
      })),
      priceMismatchCount: priceMismatchList.length,
      priceMismatches: priceMismatches,
      optionFailedCount: optionFailedProducts.length,
      optionFailedProducts: optionFailedProducts,
      steps,
      cartUrl: "https://mart.baemin.com/cart",
      notes: "법인폰(010-7749-7515) 기재 필수",
    });
  } catch (error) {
    console.error("[baemin] 주문 처리 에러:", error);
    errorCollector.addError(
      ORDER_STEPS.ORDER_PLACEMENT,
      ERROR_CODES.UNEXPECTED_ERROR,
      error.message,
      { purchaseOrderId }
    );
    await saveOrderResults(authToken, {
      purchaseOrderId,
      products: addedProducts || [],
      priceMismatches: [],
      optionFailedProducts: [],
      automationErrors: errorCollector.getErrors(),
      lineIds,
      success: false,
      vendor: "baemin",
    });
    return res.json({
      success: false,
      message: error.message,
      purchaseOrderId,
      steps,
      automationErrors: errorCollector.getErrors(),
    });
  }
}

/**
 * 로그인 상태 반환
 */
function getBaeminLoginStatus() {
  return getLoginStatus("baemin");
}

/**
 * 로그인 상태 리셋
 */
function resetBaeminLoginStatus() {
  setLoginStatus("baemin", false);
}

module.exports = {
  processBaeminOrder,
  loginToBaemin,
  getLoginStatus: getBaeminLoginStatus,
  resetLoginStatus: resetBaeminLoginStatus,
};
