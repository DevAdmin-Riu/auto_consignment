/**
 * 냅킨코리아 주문 모듈
 *
 * 처리 방식: 배치 (여러 상품 장바구니 → 일괄 결제)
 *
 * 흐름:
 * 1. 로그인
 * 2. 장바구니 비우기
 * 3. 각 상품별:
 *    - 상품 페이지 이동
 *    - 옵션 선택 (openMallOptions - 2D 구조 지원)
 *    - 수량 설정 (세트상품 박스별 수량 처리)
 *    - 장바구니 담기
 * 4. 모든 상품 담은 후 → 주문/결제 (신한카드)
 * 5. saveOrderResults 호출
 *
 * 데이터 흐름:
 * - 입력: { products, shippingAddress, poLineIds, purchaseOrderId }
 * - poLineIds: PurchaseOrderLine ID 배열 (대행접수용) - n8n에서 전달
 * - products[].orderLineIds: OrderLine ID 배열 (주문번호 업데이트용)
 *
 * saveOrderResults 호출 시:
 * - success: true → 대행접수 + 출고처리 진행
 * - success: false → 옵션불일치/에러로그만 저장
 * - products[].orderLineIds: 주문번호 업데이트에 사용
 * - poLineIds: 대행접수(receivePurchaseOrderLines)에 사용
 *
 * 특이사항:
 * - 세트 상품: 박스별 수량 개별 입력 필요
 * - 신한카드 결제 (ISP 미사용)
 */

const {
  createOrderErrorCollector,
  ORDER_STEPS,
  ERROR_CODES,
} = require("../../lib/automation-error");
const {
  saveOrderResults,
  createPaymentLogs,
  calculateExpectedPaymentAmount,
} = require("../../lib/graphql-client");
const { automateISPPayment } = require("../../lib/isp-payment");
const {
  automateShinhanCardPayment,
  typeWithInterception,
  processPhonePayment,
} = require("../../lib/shinhan-payment");
const { getEnv } = require("../config");
const {
  findDaumFrameViaCDP,
  cleanupCDPFrame,
  searchAddressInFrame,
  selectAddressResult,
} = require("../../lib/daum-address");
const { searchAddressWithKakao, normalizeAddress } = require("../../lib/address-verify"); // eslint-disable-line

// 딜레이 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// waitFor 함수
async function waitFor(page, selector, timeout = 10000) {
  try {
    await page.waitForSelector(selector, { timeout });
    return await page.$(selector);
  } catch {
    return null;
  }
}

// 셀렉터 상수
const SELECTORS = {
  // 로그인
  login: {
    idInput: "#member_id",
    pwInput: "#member_passwd",
    submitBtn: 'form[id^="member_form"] fieldset a, .btn_login, a.btn_login',
    loginForm: 'form[id^="member_form"]',
  },
  // 상품 페이지
  product: {
    // 옵션 선택
    optionSelect:
      'select[id^="product_option_id"], select[class^="ProductOption"]',
    optionItem: (value) => `option[value*="${value}"]`,
    // 수량
    quantityInput: 'input[name="quantity"], input.quantity',
    quantityPlus: ".quantity_plus, .up, button.up",
    quantityMinus: ".quantity_minus, .down, button.down",
    // 버튼
    addToCartBtn: "#cartBtn",
    buyNowBtn: ".btn_buy, a.btn_buy, #btn_buy",
    // 장바구니 담기 후 팝업
    confirmGoCartBtn:
      "#confirmLayer > div.xans-element-.xans-product.xans-product-basketadd.ec-base-layer > div.ec-base-button > p > a:nth-child(1)",
    // 가격
    totalPrice: ".total_price, #totalPrice, .price_total",
  },
  // 장바구니
  cart: {
    url: "https://www.napkinkorea.co.kr/order/basket.html",
    selectAll: 'input[name="checkall"], input.check_all',
    orderBtn: '.btn_order, a.btn_order, #btn_order, a[href*="order"]',
    orderAllBtn:
      "#sp-content > div:nth-child(2) > div.xans-element-.xans-order.xans-order-basketpackage > div.xans-element-.xans-order.xans-order-totalorder.ec-base-button.justify > a:nth-child(1)",
    itemCheckbox: 'input[name="cart_select[]"], input.cart_check',
    clearBtn:
      "#sp-content > div:nth-child(2) > div.xans-element-.xans-order.xans-order-basketpackage > div.xans-element-.xans-order.xans-order-selectorder.ec-base-button > span.gRight > a:nth-child(2)",
  },
  // 주문서
  order: {
    // 배송지 직접입력 버튼
    newAddressBtn: "#ec-jigsaw-tab-shippingInfo-newAddress > a",
    // 배송지
    receiverName: "#rname",
    addressSearchBtn: "#btn_search_rzipcode",
    addressDetail: "#raddr2",
    // 휴대폰
    phoneFirst: "#rphone2_1", // select
    phoneMiddle: "#rphone2_2",
    phoneLast: "#rphone2_3",
    // 다음 주소 검색 iframe
    daumPostcodeFrame: "iframe[title='우편번호 검색 프레임']",
    daumAddressInput: "#region_name",
    daumSearchButton: "#searchForm > fieldset > div > button.btn_search",
    daumAddressItem: "li.list_post_item",
    // 결제
    payBtn: "#orderFixItem > div",
    agreeAll: 'input[name="agree_all"], input.agree_all',
    // 결제 수단
    cardPayment:
      'input[value="card"], input[name="payment_method"][value*="card"]',
  },
};

/**
 * 냅킨코리아 로그인
 */
async function loginToNapkin(page, vendor) {
  console.log("[napkin] 로그인 시작...");

  // 1. 로그인 페이지 이동
  console.log("[napkin] 1. 로그인 페이지 이동...");
  await page.goto(vendor.loginUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await delay(1500); // 로그인 상태 확인을 위해 대기

  // AlphaReview + review-overlay 팝업 즉시 제거 (로그인 전에 처리)
  await page.evaluate(() => {
    document.querySelectorAll("div[id^='app-saladlab-alphareview-onsite-box']").forEach(el => el.remove());
    document.querySelectorAll("review-overlay-portal").forEach(el => el.remove());
  });

  // 2. 이미 로그인 되어있는지 확인
  // 로그인 후 로그인 페이지로 이동하면 input이 보이지 않음
  const currentUrl = page.url();
  console.log("[napkin] 현재 URL:", currentUrl);

  const idInput = await page.$(SELECTORS.login.idInput);
  if (!idInput) {
    // 아이디 입력창이 없으면 이미 로그인된 상태
    console.log("[napkin] 아이디 입력창 없음 - 이미 로그인됨");
    return { success: true, message: "이미 로그인됨" };
  }

  // input이 보이는지 확인 (display:none 체크)
  const isVisible = await page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }, SELECTORS.login.idInput);

  if (!isVisible) {
    console.log("[napkin] 아이디 입력창 숨김 상태 - 이미 로그인됨");
    return { success: true, message: "이미 로그인됨" };
  }

  console.log("[napkin] 로그인 페이지 확인됨, 로그인 진행...");

  // 3. 아이디 입력
  console.log("[napkin] 2. 아이디 입력...");
  await page.evaluate((el) => { el.value = ''; el.focus(); el.click(); }, idInput);
  await delay(300);
  await idInput.type(vendor.userId, { delay: 50 });

  // 4. 비밀번호 입력
  console.log("[napkin] 3. 비밀번호 입력...");
  const pwInput = await waitFor(page, SELECTORS.login.pwInput, 5000);
  if (!pwInput) {
    return { success: false, message: "비밀번호 입력창을 찾을 수 없음" };
  }
  await page.evaluate((el) => { el.value = ''; el.focus(); el.click(); }, pwInput);
  await delay(300);
  await pwInput.type(vendor.password, { delay: 50 });

  // 5. 로그인 버튼 클릭 (evaluate 내부에서 직접 클릭 - 팝업 오버레이 무시)
  console.log("[napkin] 4. 로그인 버튼 클릭...");
  // 클릭 전 팝업 한번 더 제거
  await page.evaluate(() => {
    document.querySelectorAll("div[id^='app-saladlab-alphareview-onsite-box']").forEach(el => el.remove());
    document.querySelectorAll("review-overlay-portal").forEach(el => el.remove());
  });
  const loginClicked = await page.evaluate((selector) => {
    const btn = document.querySelector(selector);
    if (btn) { btn.click(); return true; }
    // 폴백: form submit
    const form = document.querySelector("form[id^='member_form']");
    if (form) { form.submit(); return true; }
    return false;
  }, SELECTORS.login.submitBtn);

  if (!loginClicked) {
    await page.keyboard.press("Enter");
  }

  await delay(2000);

  // 페이지 이동 대기
  await page
    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 })
    .catch(() => {});
  await delay(1500);

  // 로그인 성공 여부 확인 (로그인 페이지에 여전히 있으면 실패)
  const afterUrl = page.url();
  const stillOnLogin = afterUrl.includes("/member/login");
  if (stillOnLogin) {
    console.log("[napkin] 로그인 실패 - 여전히 로그인 페이지");
    return { success: false, message: "로그인 버튼 클릭 후에도 로그인 페이지에 머물러 있음 (팝업 방해 가능)" };
  }

  console.log("[napkin] 로그인 완료! URL:", afterUrl);
  return { success: true, message: "로그인 완료" };
}

/**
 * 장바구니 비우기
 */
async function clearCart(page) {
  console.log("[napkin] 장바구니 비우기 시작...");

  // 장바구니 페이지 이동
  await page.goto(SELECTORS.cart.url, {
    waitUntil: "networkidle2",
    timeout: 30000,
  });
  await delay(1500);

  // 기존 핸들러가 남아있으면 먼저 제거 (이전 주문 에러로 미제거된 경우)
  if (page._napkinDialogHandler) {
    page.off("dialog", page._napkinDialogHandler);
    delete page._napkinDialogHandler;
    console.log("[napkin] 이전 dialog 핸들러 제거");
  }

  // confirm 다이얼로그 자동 수락 설정 (named function으로 나중에 제거 가능)
  const napkinDialogHandler = async (dialog) => {
    try {
      console.log("[napkin] confirm 다이얼로그:", dialog.message());
      await dialog.accept();
    } catch (e) {
      console.log("[napkin] 다이얼로그 처리 실패 (이미 처리됨):", e.message);
    }
  };
  page.on("dialog", napkinDialogHandler);
  // 핸들러 반환해서 나중에 제거할 수 있게 함
  page._napkinDialogHandler = napkinDialogHandler;

  // 버튼 렌더링 대기
  await delay(1500);

  // 장바구니 비우기 버튼 클릭 (JavaScript로 직접 클릭)
  const clicked = await page.evaluate((selector) => {
    const btn = document.querySelector(selector);
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }, SELECTORS.cart.clearBtn);

  if (!clicked) {
    console.log("[napkin] 장바구니 비우기 버튼 없음 (이미 비어있을 수 있음)");
    return { success: true, message: "장바구니 비어있음" };
  }

  await delay(2000);

  console.log("[napkin] 장바구니 비우기 완료");
  return { success: true, message: "장바구니 비우기 완료" };
}

/**
 * 단일 옵션 처리 (SELECT/INPUT_TEXT 타입 지원)
 * @returns { success, message? }
 */
async function processSingleOption(page, option) {
  const { title, value, type = "SELECT" } = option;
  console.log(`[napkin] 옵션 처리 [${type}]: ${title} = ${value}`);

  if (type === "INPUT_TEXT") {
    // INPUT_TEXT: tr > th에서 title 찾고 → td에서 input에 텍스트 입력
    const inputResult = await page.evaluate(
      (optTitle, optValue) => {
        // 모든 tr에서 th 텍스트로 찾기
        const rows = document.querySelectorAll("tr");
        for (const row of rows) {
          const th = row.querySelector("th");
          if (th) {
            const thText = (th.textContent || "").trim();
            if (thText.includes(optTitle)) {
              // 같은 tr의 td에서 input 찾기
              const td = row.querySelector("td");
              if (td) {
                const input = td.querySelector(
                  "input[type='text'], input:not([type]), textarea",
                );
                if (input) {
                  input.focus();
                  input.value = "";
                  input.dispatchEvent(new Event("input", { bubbles: true }));
                  input.value = optValue;
                  input.dispatchEvent(new Event("input", { bubbles: true }));
                  input.dispatchEvent(new Event("change", { bubbles: true }));
                  return { found: true, thText };
                }
              }
            }
          }
        }
        return { found: false };
      },
      title,
      value,
    );

    if (inputResult.found) {
      console.log(`[napkin] ✅ INPUT_TEXT 입력 완료: "${title}" = "${value}"`);
      await delay(800); // 페이지 업데이트 대기
      return { success: true };
    } else {
      console.log(`[napkin] ❌ INPUT_TEXT 입력창 못찾음: "${title}"`);
      return { success: false, message: `텍스트 입력창 못찾음: ${title}` };
    }
  } else {
    // SELECT: tr > th에서 title 찾고 → td에서 select 선택
    const selectResult = await page.evaluate(
      (optTitle, optValue) => {
        const normalize = (str) => str.replace(/\s+/g, "");
        const normalizedValue = normalize(optValue);

        // 모든 tr에서 th 텍스트로 찾기
        const rows = document.querySelectorAll("tr");
        for (const row of rows) {
          const th = row.querySelector("th");
          if (th) {
            const thText = (th.textContent || "").trim();
            if (thText.includes(optTitle)) {
              // 같은 tr의 td에서 select 찾기
              const td = row.querySelector("td");
              if (td) {
                const select = td.querySelector("select");
                if (select) {
                  // select 내에서 옵션 찾기
                  const options = select.querySelectorAll("option");
                  for (const opt of options) {
                    const normalizedText = normalize(opt.textContent);
                    const normalizedOptValue = normalize(opt.value);
                    if (
                      normalizedText.includes(normalizedValue) ||
                      normalizedValue.includes(normalizedText) ||
                      normalizedOptValue.includes(normalizedValue) ||
                      normalizedValue.includes(normalizedOptValue)
                    ) {
                      select.value = opt.value;
                      select.dispatchEvent(
                        new Event("change", { bubbles: true }),
                      );
                      return {
                        found: true,
                        thText,
                        selectedValue: opt.value,
                        selectedText: opt.textContent,
                      };
                    }
                  }
                }
              }
            }
          }
        }

        // title로 못 찾으면 기존 방식 (모든 select에서 value로 검색)
        const allSelects = document.querySelectorAll(
          'select[id^="product_option_id"], select[class^="ProductOption"]',
        );
        for (const select of allSelects) {
          const options = select.querySelectorAll("option");
          for (const opt of options) {
            const normalizedText = normalize(opt.textContent);
            const normalizedOptValue = normalize(opt.value);
            if (
              normalizedText.includes(normalizedValue) ||
              normalizedValue.includes(normalizedText) ||
              normalizedOptValue.includes(normalizedValue) ||
              normalizedValue.includes(normalizedOptValue)
            ) {
              select.value = opt.value;
              select.dispatchEvent(new Event("change", { bubbles: true }));
              return {
                found: true,
                fallback: true,
                selectedValue: opt.value,
                selectedText: opt.textContent,
              };
            }
          }
        }

        return { found: false };
      },
      title,
      value,
    );

    if (selectResult.found) {
      console.log(
        `[napkin] ✅ SELECT 선택 완료: "${title}" = "${selectResult.selectedText || value}"`,
      );
      await delay(2000); // 페이지 업데이트 대기
      return { success: true };
    } else {
      console.log(`[napkin] ❌ SELECT 옵션 못찾음: "${title}" = "${value}"`);
      return { success: false, message: `옵션 "${value}" 선택 실패` };
    }
  }
}

/**
 * 수량 설정 및 가격 정보 추출
 * @param {number} boxIndex - 옵션 박스 인덱스 (1부터 시작, 세트 추가 시 증가)
 * @returns { priceInfo }
 */
async function setQuantityAndGetPrice(
  page,
  quantity,
  vendorPriceExcludeVat,
  boxIndex = 1,
) {
  let priceInfo = null;

  // 수량 필드 찾기 및 수량 설정 (세트별로 다른 박스)
  const quantitySelector = `#option_box${boxIndex}_quantity`;
  console.log(
    `[napkin] 수량 필드 대기: ${quantitySelector} (수량: ${quantity}, 박스: ${boxIndex})`,
  );

  const quantityInput = await waitFor(page, quantitySelector, 10000);
  if (!quantityInput) {
    throw new Error(`수량 필드 못찾음: ${quantitySelector} (박스: ${boxIndex})`);
  }

  if (quantityInput && quantity > 1) {
    console.log(`[napkin] 수량 입력: ${quantity} (박스 ${boxIndex})`);

    try {
      // page.evaluate로 클릭 및 값 입력 (더 안정적)
      await page.evaluate(
        (selector, qty) => {
          const input = document.querySelector(selector);
          if (input) {
            input.focus();
            input.select();
            input.value = "";
            input.value = String(qty);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            input.dispatchEvent(new Event("blur", { bubbles: true }));
          }
        },
        quantitySelector,
        quantity,
      );
      await delay(2000);
    } catch (e) {
      console.log(
        `[napkin] 수량 입력 실패 (page.evaluate), Puppeteer 방식 시도: ${e.message}`,
      );
      // 폴백: Puppeteer 방식
      try {
        await page.evaluate((el) => { el.value = ''; el.focus(); el.click(); }, quantityInput);
        await delay(200);
        await page.keyboard.type(String(quantity), { delay: 50 });
        await page.evaluate((el) => {
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
        }, quantityInput);
        await delay(2000);
      } catch (e2) {
        console.log(`[napkin] 수량 입력 완전 실패: ${e2.message}`);
      }
    }
  }

  // 가격 정보 가져오기 (세트별로 다른 박스)
  const priceSelector = `#option_box${boxIndex}_price input.option_box_price`;
  const priceInput = await page.$(priceSelector);

  if (priceInput) {
    const totalPrice = await page.evaluate(
      (el) => parseInt(el.value) || 0,
      priceInput,
    );
    const unitPrice = Math.round(totalPrice / quantity);
    console.log(
      `[napkin] 가격 정보 - 총액: ${totalPrice}원, 수량: ${quantity}, 단가: ${unitPrice}원`,
    );

    if (vendorPriceExcludeVat) {
      const expectedUnitPrice = Math.round(vendorPriceExcludeVat * 1.1);
      const priceDifference = Math.abs(unitPrice - expectedUnitPrice);
      const PRICE_TOLERANCE = 3;

      if (priceDifference > PRICE_TOLERANCE) {
        console.log(
          `[napkin] ⚠️ 가격 불일치: 냅킨 ${unitPrice}원 vs 협력사 ${expectedUnitPrice}원 (차이: ${unitPrice - expectedUnitPrice}원)`,
        );
        priceInfo = {
          unitPrice,
          totalPrice,
          expectedUnitPrice,
          vendorPriceExcludeVat,
          priceMismatch: true,
          difference: unitPrice - expectedUnitPrice,
        };
      } else {
        console.log(
          `[napkin] ✓ 가격 일치: 냅킨 ${unitPrice}원, 협력사 ${expectedUnitPrice}원 (오차: ${priceDifference}원)`,
        );
        priceInfo = {
          unitPrice,
          totalPrice,
          expectedUnitPrice,
          vendorPriceExcludeVat,
          priceMismatch: false,
          difference: unitPrice - expectedUnitPrice,
        };
      }
    } else {
      priceInfo = { unitPrice, totalPrice };
    }
  }

  return priceInfo;
}

/**
 * 옵션 선택 (SELECT/INPUT_TEXT 타입 지원, 2D 세트 구조)
 * - tr > th로 title 찾고 → td에서 input/select 처리
 *
 * 구조: [{options: [{title, value, type}, ...]}, ...]
 *
 * @returns { success, priceInfo }
 */
async function selectOptions(
  page,
  openMallOptions,
  quantity = 1,
  vendorPriceExcludeVat = null,
) {
  if (!openMallOptions || openMallOptions.length === 0) {
    console.log("[napkin] 옵션 없음, 스킵");
    return { success: true, skipped: true };
  }

  console.log("[napkin] 옵션 선택 시작:", JSON.stringify(openMallOptions));

  // 옵션 탭 로딩 대기
  console.log("[napkin] 옵션 탭 로딩 대기...");
  const optionTab = await waitFor(
    page,
    "#sp-detail-optiontab > div > div",
    10000,
  );
  if (!optionTab) {
    console.log("[napkin] 옵션 탭 로딩 실패");
    return { success: false, message: "옵션 탭 로딩 실패" };
  }
  await delay(500);

  let priceInfo = null;

  // 2D 구조 검증: [{options: [{title, value}, ...]}, ...]
  const is2DStructure =
    openMallOptions[0] && Array.isArray(openMallOptions[0].options);

  if (is2DStructure) {
    console.log(`[napkin] 옵션 세트 처리: ${openMallOptions.length}개 세트`);

    for (let s = 0; s < openMallOptions.length; s++) {
      const set = openMallOptions[s];
      const setOptions = set.options || [];

      console.log(
        `[napkin] --- 세트 ${s + 1}/${openMallOptions.length} 처리 시작 (${setOptions.length}개 옵션) ---`,
      );

      // 세트 내 모든 옵션 선택
      for (let i = 0; i < setOptions.length; i++) {
        const option = setOptions[i];
        console.log(
          `[napkin] 세트 ${s + 1}, 옵션 ${i + 1}: ${option.title} = ${option.value}`,
        );

        const result = await processSingleOption(page, option);
        if (!result.success) {
          return result;
        }
      }

      // 세트 내 모든 옵션 선택 후 수량 설정 및 가격 확인
      console.log(`[napkin] 세트 ${s + 1} 옵션 선택 완료, 수량 필드 대기...`);
      await delay(2000);

      priceInfo = await setQuantityAndGetPrice(
        page,
        quantity,
        vendorPriceExcludeVat,
        s + 1,
      );
      await delay(1000);
    }

    return { success: true, priceInfo };
  }

  // 2D 구조가 아닌 경우 에러
  return {
    success: false,
    message: "잘못된 옵션 구조: 2D 구조 [{options: [...]}] 형식이어야 합니다",
  };
}

/**
 * 수량 설정
 */
async function setQuantity(page, quantity) {
  console.log(`[napkin] 수량 설정: ${quantity}`);

  const quantityInput = await page.$(SELECTORS.product.quantityInput);
  if (quantityInput) {
    try {
      // page.evaluate로 값 입력 (더 안정적)
      await page.evaluate(
        (selector, qty) => {
          const input = document.querySelector(selector);
          if (input) {
            input.focus();
            input.select();
            input.value = "";
            input.value = String(qty);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
        },
        SELECTORS.product.quantityInput,
        quantity,
      );
      await delay(300);
      return { success: true };
    } catch (e) {
      console.log(
        `[napkin] 수량 입력 실패 (page.evaluate), Puppeteer 방식 시도: ${e.message}`,
      );
      try {
        await page.evaluate((el) => { el.value = ''; el.focus(); el.click(); }, quantityInput);
        await delay(200);
        await quantityInput.type(String(quantity), { delay: 50 });
        await delay(300);
        return { success: true };
      } catch (e2) {
        console.log(`[napkin] 수량 입력 완전 실패: ${e2.message}`);
      }
    }
  }

  // 수량 버튼으로 설정
  const plusBtn = await page.$(SELECTORS.product.quantityPlus);
  if (plusBtn) {
    try {
      for (let i = 1; i < quantity; i++) {
        await page.evaluate((selector) => {
          const btn = document.querySelector(selector);
          if (btn) btn.click();
        }, SELECTORS.product.quantityPlus);
        await delay(300);
      }
      return { success: true };
    } catch (e) {
      console.log(`[napkin] 수량 버튼 클릭 실패: ${e.message}`);
      return { success: false, message: `수량 버튼 클릭 실패: ${e.message}` };
    }
  }

  return { success: false, message: "수량 입력 불가: 수량 입력 필드와 수량 버튼 모두 찾을 수 없음" };
}

/**
 * 장바구니 담기
 */
async function addToCart(page) {
  console.log("[napkin] 장바구니 담기...");

  // 버튼 대기
  const cartBtn = await waitFor(page, SELECTORS.product.addToCartBtn, 5000);
  if (!cartBtn) {
    console.log("[napkin] #cartBtn 없음, 대체 셀렉터 시도...");
    // 대체 셀렉터 시도
    const altBtn = await waitFor(
      page,
      'a[href*="basket"], .btn_cart, #btn_cart, .addToCart',
      3000,
    );
    if (!altBtn) {
      return { success: false, message: "장바구니 버튼을 찾을 수 없음" };
    }
  }

  try {
    // JavaScript로 클릭 시도 (더 안정적)
    const clicked = await page.evaluate((selector) => {
      const btn = document.querySelector(selector);
      if (btn) {
        btn.click();
        return true;
      }
      // 대체 셀렉터들 시도
      const altSelectors = [
        'a[href*="basket"]',
        ".btn_cart",
        "#btn_cart",
        ".addToCart",
        "#cartBtn",
      ];
      for (const sel of altSelectors) {
        const altBtn = document.querySelector(sel);
        if (altBtn) {
          altBtn.click();
          return true;
        }
      }
      return false;
    }, SELECTORS.product.addToCartBtn);

    if (!clicked) {
      return { success: false, message: "장바구니 버튼 클릭 실패" };
    }

    await delay(1500);
  } catch (e) {
    console.log("[napkin] 장바구니 버튼 클릭 실패:", e.message);
    return { success: false, message: "장바구니 버튼 클릭 실패" };
  }

  return { success: true };
}

/**
 * 냅킨코리아 주문 처리 메인
 */
async function processNapkinOrder(
  res,
  page,
  vendor,
  { products, purchaseOrderId, shippingAddress, poLineIds },
  authToken,
) {
  console.log("=".repeat(50));
  console.log("[napkin] 주문 처리 시작");
  console.log("[napkin] 발주번호:", purchaseOrderId);
  console.log("[napkin] 상품 수:", products?.length);
  console.log("=".repeat(50));

  // poLineIds 직접 사용
  const purchaseOrderLineIds = poLineIds || [];

  // 에러 수집기 초기화
  const errorCollector = createOrderErrorCollector("napkin");

  try {
    // 1. 로그인
    const loginResult = await loginToNapkin(page, vendor);
    if (!loginResult.success) {
      errorCollector.addError(
        ORDER_STEPS.LOGIN,
        ERROR_CODES.LOGIN_FAILED,
        loginResult.message,
        { purchaseOrderId },
      );
      await saveOrderResults(authToken, {
        purchaseOrderId,
        products: [],
        priceMismatches: [],
        optionFailedProducts: [],
        automationErrors: errorCollector.getErrors(),
        poLineIds,
        success: false,
        vendor: "napkin",
      });
      return res.json({
        success: false,
        vendor: vendor.name,
        message: `로그인 실패: ${loginResult.message}`,
        automationErrors: errorCollector.getErrors(),
      });
    }

    // 2. AlphaReview + review-overlay 팝업 자동 제거 (결제 전에 중단)
    const killPopups = `
      const kill = () => {
        document.querySelectorAll("div[id^='app-saladlab-alphareview-onsite-box']").forEach(el => el.remove());
        document.querySelectorAll("review-overlay-portal").forEach(el => el.remove());
      };
      kill();
      window.__napkinPopupKiller = setInterval(kill, 500);
    `;
    await page.evaluateOnNewDocument(killPopups);
    await page.evaluate(`
      if (!window.__napkinPopupKiller) {
        ${killPopups}
      }
    `);
    console.log("[napkin] AlphaReview 팝업 자동 제거 적용됨 (setInterval)");

    // 3. 장바구니 비우기
    await clearCart(page);

    const results = [];

    // 3. 각 상품 처리
    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      const lineId = purchaseOrderLineIds[i];

      console.log(`\n[napkin] 상품 ${i + 1}/${products.length} 처리 시작`);
      console.log(`[napkin] 상품명: ${product.productName}`);
      console.log(`[napkin] URL: ${product.productUrl}`);
      console.log(`[napkin] 수량: ${product.quantity}`);

      // productUrl이 없으면 스킵
      if (!product.productUrl) {
        console.log(
          `[napkin] ❌ 상품 URL이 없음 - 스킵: ${product.productName}`,
        );
        errorCollector.addError(
          ORDER_STEPS.PRODUCT_ACCESS,
          ERROR_CODES.PRODUCT_NOT_FOUND,
          `상품 URL이 없음: ${product.productName}`,
          { productSku: product.productSku, lineId },
        );
        results.push({
          success: false,
          productName: product.productName,
          productSku: product.productSku,
          lineId,
          purchaseOrderId: product.purchaseOrderId, // 개별 상품의 발주 ID
          message: "상품 URL 없음",
        });
        continue;
      }

      try {
        // 3-1. 상품 페이지 이동
        await page
          .goto(product.productUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          })
          .catch(() => {
            console.log(
              "[napkin] 페이지 이동 중 리다이렉트 발생, 계속 진행...",
            );
          });
        await delay(2000);

        // 3-2. 옵션 선택
        let options = product.openMallOptions;
        // 문자열이면 파싱
        if (typeof options === "string") {
          try {
            options = JSON.parse(options);
          } catch (e) {
            console.log("[napkin] 옵션 파싱 실패:", e.message);
            options = [];
          }
        }

        // 실제 주문 수량 계산 (openMallQtyPerUnit 적용)
        const baseQuantity = product.quantity || 1;
        const qtyPerUnit = product.openMallQtyPerUnit || 1;
        const actualQuantity = baseQuantity * qtyPerUnit;
        if (qtyPerUnit > 1) {
          console.log(
            `[napkin] 수량 변환: ${baseQuantity}개 × ${qtyPerUnit} = ${actualQuantity}개`,
          );
        }

        let hasOptions = options && options.length > 0;
        let priceInfo = null;
        if (hasOptions) {
          const optionResult = await selectOptions(
            page,
            options,
            actualQuantity,
            product.vendorPriceExcludeVat,
          );
          if (!optionResult.success) {
            errorCollector.addError(
              ORDER_STEPS.ADD_TO_CART,
              null,
              optionResult.message,
              {
                purchaseOrderId,
                purchaseOrderLineId: lineId,
                productVariantVendorId: product.productVariantVendorId,
              },
            );
            results.push({
              lineId,
              productName: product.productName,
              productSku: product.productSku,
              productVariantVendorId: product.productVariantVendorId,
              purchaseOrderId: product.purchaseOrderId, // 개별 상품의 발주 ID
              success: false,
              message: optionResult.message,
            });
            continue; // 다음 상품으로
          }
          priceInfo = optionResult.priceInfo;
        }

        // 3-3. 수량 설정 (옵션이 없는 경우에만)
        if (!hasOptions) {
          const qtyResult = await setQuantity(page, actualQuantity);
          if (!qtyResult.success) {
            errorCollector.addError(
              ORDER_STEPS.ADD_TO_CART,
              null,
              qtyResult.message,
              {
                purchaseOrderId,
                purchaseOrderLineId: lineId,
                productVariantVendorId: product.productVariantVendorId,
              },
            );
            results.push({
              lineId,
              productName: product.productName,
              productSku: product.productSku,
              productVariantVendorId: product.productVariantVendorId,
              purchaseOrderId: product.purchaseOrderId,
              success: false,
              message: qtyResult.message,
            });
            continue; // 다음 상품으로
          }
        }

        // 3-4. 장바구니 담기
        const cartResult = await addToCart(page);
        if (!cartResult.success) {
          errorCollector.addError(
            ORDER_STEPS.ADD_TO_CART,
            null,
            cartResult.message,
            {
              purchaseOrderId,
              purchaseOrderLineId: lineId,
              productVariantVendorId: product.productVariantVendorId,
            },
          );
          results.push({
            lineId,
            productName: product.productName,
            productSku: product.productSku,
            productVariantVendorId: product.productVariantVendorId,
            purchaseOrderId: product.purchaseOrderId, // 개별 상품의 발주 ID
            success: false,
            message: cartResult.message,
          });
          continue;
        }

        results.push({
          lineId,
          productName: product.productName,
          productSku: product.productSku,
          productVariantVendorId: product.productVariantVendorId,
          purchaseOrderId: product.purchaseOrderId, // 개별 상품의 발주 ID
          quantity: product.quantity,
          vendorPriceExcludeVat: product.vendorPriceExcludeVat,
          success: true,
          message: "장바구니 담기 완료",
          priceInfo,
          needsManagerVerification: product.needsManagerVerification || false,
        });
      } catch (productError) {
        console.error(`[napkin] 상품 처리 에러:`, productError.message);
        errorCollector.addError(
          ORDER_STEPS.ADD_TO_CART,
          null,
          productError.message,
          {
            purchaseOrderId,
            purchaseOrderLineId: lineId,
            productVariantVendorId: product.productVariantVendorId,
          },
        );
        results.push({
          lineId,
          productName: product.productName,
          productSku: product.productSku,
          productVariantVendorId: product.productVariantVendorId,
          purchaseOrderId: product.purchaseOrderId, // 개별 상품의 발주 ID
          success: false,
          message: productError.message,
        });
      }
    }

    // 성공한 상품이 있는지 확인
    const successCount = results.filter((r) => r.success).length;
    if (successCount === 0) {
      console.log("[napkin] 모든 상품 처리 실패 - 장바구니 이동 안함");
      const optionFailedProducts = results
        .filter((r) => !r.success && r.message?.includes("옵션"))
        .map((r) => ({
          productVariantVendorId: r.productVariantVendorId,
          purchaseOrderId: r.purchaseOrderId, // 개별 상품의 발주 ID
          reason: r.message,
        }));
      await saveOrderResults(authToken, {
        purchaseOrderId,
        products: [],
        priceMismatches: [],
        optionFailedProducts,
        automationErrors: errorCollector.getErrors(),
        poLineIds,
        success: false,
        vendor: "napkin",
      });
      return res.json({
        success: false,
        vendor: vendor.name,
        purchaseOrderId,
        message: "모든 상품 처리 실패",
        results,
        poLineIds: purchaseOrderLineIds,
        automationErrors: errorCollector.getErrors(),
      });
    }

    // 4. 장바구니 이동 버튼 클릭 (마지막 상품의 팝업에서)
    console.log("\n[napkin] 장바구니 이동 버튼 클릭...");
    const goCartBtn = await waitFor(
      page,
      SELECTORS.product.confirmGoCartBtn,
      5000,
    );
    if (goCartBtn) {
      await page.evaluate((el) => el.click(), goCartBtn);
      await delay(3000);
    } else {
      // 팝업이 없으면 직접 이동
      console.log("[napkin] 팝업 없음, 직접 장바구니 이동...");
      await page.goto(SELECTORS.cart.url, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
      await delay(2000);
    }

    // 현재 페이지 URL 확인
    const cartPageUrl = page.url();
    console.log(`[napkin] 현재 URL: ${cartPageUrl}`);
    if (!cartPageUrl.includes("basket")) {
      console.log("[napkin] 장바구니 페이지가 아님, 직접 이동...");
      await page.goto(SELECTORS.cart.url, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
      await delay(2000);
    }


    // 결제 재시도 루프 (빈 창 등 결제 실패 시 장바구니에서 재시도)
    let paymentCompleted = false;
    let actualPaymentAmount = 0;
    const MAX_PAYMENT_RETRIES = 5;

    for (
      let paymentAttempt = 0;
      paymentAttempt < MAX_PAYMENT_RETRIES;
      paymentAttempt++
    ) {
      if (paymentAttempt > 0) {
        console.log(
          `\n[napkin] === 결제 재시도 (${paymentAttempt}/${MAX_PAYMENT_RETRIES - 1}) ===`,
        );
        console.log("[napkin] 장바구니로 이동...");
        await page.goto(SELECTORS.cart.url, {
          waitUntil: "networkidle2",
          timeout: 30000,
        });
        await delay(2000);
      }

      // 5. 전체상품 주문하기 버튼 클릭
      console.log("[napkin] 전체상품 주문하기 버튼 클릭...");
      await delay(1500); // 페이지 로딩 대기
      const orderAllBtn = await waitFor(page, SELECTORS.cart.orderAllBtn, 5000);
      if (orderAllBtn) {
        await page.evaluate((el) => el.click(), orderAllBtn);
        await delay(2000);
      } else {
        throw new Error(
          "전체상품 주문하기 버튼을 찾을 수 없음 - 장바구니가 비어있거나 페이지 오류",
        );
      }

      // 6. 배송지 직접입력 버튼 클릭
      console.log("[napkin] 주문서 페이지 로딩 대기 (2초)...");
      // 주문서 페이지 완전 로딩 대기 (탭 빙글빙글 끝날 때까지)
      await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 }).catch(() => {});
      await delay(1000);
      console.log("[napkin] 주문서 페이지 로딩 완료");

      // 주문서 페이지에서는 팝업 킬러 중단 (일반배송 등 정상 UI 보호)
      await page.evaluate(() => {
        if (window.__napkinPopupKiller) {
          clearInterval(window.__napkinPopupKiller);
          window.__napkinPopupKiller = null;
        }
      });

      console.log("[napkin] 배송지 직접입력 버튼 클릭...");
      const newAddressBtn = await waitFor(
        page,
        SELECTORS.order.newAddressBtn,
        5000,
      );
      if (newAddressBtn) {
        await page.evaluate((el) => el.click(), newAddressBtn);
        await delay(2000); // 탭 전환 대기 (늘림)
      } else {
        throw new Error(
          "배송지 직접입력 버튼을 찾을 수 없음 - 주문서 페이지 로드 실패",
        );
      }

      // 7. 배송지 정보 입력
      if (shippingAddress) {
        console.log("[napkin] 배송지 정보 입력 시작...");

        // 7-1. 받는사람 입력
        const receiverName =
          shippingAddress.name || shippingAddress.recipientName || "";
        if (receiverName) {
          console.log(`[napkin] 받는사람: ${receiverName}`);
          await page.evaluate((selector, val) => {
            const el = document.querySelector(selector);
            if (el) {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              setter.call(el, val);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, SELECTORS.order.receiverName, receiverName);
          await delay(500);
        }

        // 7-2. 주소 검색 버튼 클릭
        console.log("[napkin] 주소 검색 버튼 클릭...");
        const addressSearchBtn = await page.$(SELECTORS.order.addressSearchBtn);
        if (!addressSearchBtn) {
          throw new Error("주소 검색 버튼을 찾을 수 없음");
        }
        await page.evaluate((el) => el.click(), addressSearchBtn);
        await delay(1500);

        // 7-3. 카카오 API로 도로명 주소 정규화
        const rawAddress = shippingAddress.streetAddress1 || shippingAddress.address || "";
        const kakaoResult = await searchAddressWithKakao(rawAddress);
        const searchAddress = kakaoResult?.roadAddress || rawAddress;
        console.log(`[napkin] 카카오 정규화 주소: ${searchAddress} (원본: ${rawAddress})`);

        // 7-4. 다음 주소 검색 iframe 찾기 (공통 모듈 + 일반 frame 폴백)
        console.log("[napkin] 주소 검색 iframe 찾기...");
        let frame = null;

        // 일반 frame 접근 시도
        for (let i = 0; i < 30; i++) {
          const allFrames = page.frames();
          for (const f of allFrames) {
            try {
              const hasInput = await f.$(SELECTORS.order.daumAddressInput);
              if (hasInput) {
                frame = f;
                console.log(`[napkin] 주소 검색 iframe 발견 - 일반 frame (${i + 1}회)`);
                break;
              }
            } catch (e) { /* 무시 */ }
          }
          if (frame) break;
          await delay(500);
        }

        // 일반 접근 실패 시 CDP 방식 시도
        if (!frame) {
          console.log("[napkin] 일반 frame 접근 실패, CDP 방식 시도...");
          frame = await findDaumFrameViaCDP(page, SELECTORS.order.daumAddressInput, "[napkin]");
        }

        if (!frame) {
          throw new Error("주소 검색 iframe 못찾음");
        }

        await delay(1000);

        // 7-5. 주소 검색어 입력 (공통 모듈)
        if (!searchAddress) {
          throw new Error("검색할 주소가 없음");
        }
        const searchResult = await searchAddressInFrame(frame, searchAddress, "[napkin]");
        if (!searchResult.success) {
          await cleanupCDPFrame(frame, "[napkin]");
          throw new Error(`주소 검색 실패: ${searchResult.error}`);
        }

        // 7-6. 검색 결과 선택 (공통 모듈)
        console.log("[napkin] 주소 검색 결과 선택...");
        const selectResult = await selectAddressResult(frame, SELECTORS.order.daumAddressItem, "[napkin]");
        if (!selectResult.success) {
          await cleanupCDPFrame(frame, "[napkin]");
          throw new Error(`주소 선택 실패: ${selectResult.error}`);
        }
        console.log("[napkin] ✅ 주소 선택 완료");
        await cleanupCDPFrame(frame, "[napkin]");
        await delay(1500);

        // 7-6. 상세주소 입력
        const rawDetail = (shippingAddress.streetAddress2 || shippingAddress.addressDetail || "").trim();
        const detailAddress = rawDetail || shippingAddress.firstName || "";
        if (detailAddress) {
          console.log(`[napkin] 상세주소: ${detailAddress}`);
          await delay(700); // 주소 선택 후 대기 (늘림)
          const detailInput = await page.$(SELECTORS.order.addressDetail);
          if (detailInput) {
            await page.evaluate((el, val) => {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              setter.call(el, val);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }, detailInput, detailAddress);
            await delay(500);
          }
        }

        // 7-6-1. 주소 검증 (카카오 API vs 화면 표시 주소)
        console.log("[napkin] 주소 검증 시작...");
        const addrToVerify = rawAddress;
        const kakaoVerifyResult = await searchAddressWithKakao(addrToVerify);
        if (!kakaoVerifyResult) {
          console.log("[napkin] 카카오 API 결과 없음 - 검증 스킵");
        } else {
          const displayedAddr = await page.evaluate(() => {
            const addr1 = document.querySelector("#raddr1")?.value || "";
            const addr2 = document.querySelector("#raddr2")?.value || "";
            const zipcode = document.querySelector("#rzipcode")?.value || document.querySelector("#rzipcode1")?.value || "";
            return { zipcode, addr1, addr2, full: `${addr1} ${addr2}`.trim() };
          });
          console.log("[napkin] 화면 주소:", JSON.stringify(displayedAddr));

          const kakaoAddresses = [
            normalizeAddress(kakaoVerifyResult.roadAddress),
            normalizeAddress(kakaoVerifyResult.jibunAddress),
          ].filter(Boolean);

          const normalizedDisplayed = normalizeAddress(displayedAddr.full);
          const addressMatched = kakaoAddresses.some(
            (kakaoAddr) => normalizedDisplayed.includes(kakaoAddr) || kakaoAddr.includes(normalizeAddress(displayedAddr.addr1))
          );

          if (addressMatched) {
            console.log("[napkin] 주소 검증 성공");
          } else {
            console.error("[napkin] 주소 검증 실패!");
            console.error(`[napkin]   카카오 도로명: ${kakaoVerifyResult.roadAddress}`);
            console.error(`[napkin]   카카오 지번: ${kakaoVerifyResult.jibunAddress}`);
            console.error(`[napkin]   화면 주소: ${displayedAddr.full}`);
            throw new Error(`주소 검증 실패 - 카카오: ${kakaoVerifyResult.roadAddress}, 화면: ${displayedAddr.full}`);
          }
        }

        // 7-7. 휴대폰 번호 입력
        // 주소 변경 시 당일배송 여부 렌더링이 발생하므로
        // 먼저 phoneFirst를 클릭하여 렌더링 트리거 후 대기
        const phone =
          shippingAddress.phone || shippingAddress.recipientPhone || "";
        if (phone) {
          // 숫자만 추출
          let phoneDigits = phone.replace(/[^0-9]/g, "");

          // 국가번호(82) 제거하고 0 추가 (예: 821012345678 → 01012345678)
          if (phoneDigits.startsWith("82")) {
            phoneDigits = "0" + phoneDigits.substring(2);
          }

          if (phoneDigits.length >= 10) {
            const first = phoneDigits.substring(0, 3); // 010
            const middle = phoneDigits.substring(3, 7); // XXXX
            const last = phoneDigits.substring(7, 11); // XXXX

            console.log(`[napkin] 휴대폰: ${first}-${middle}-${last}`);

            // 앞자리 select 클릭 → 렌더링 트리거 후 대기
            await page.click(SELECTORS.order.phoneFirst);
            await delay(1500);

            // 앞자리 선택 (select)
            await page.select(SELECTORS.order.phoneFirst, first);
            await delay(2000); // 새벽배송 가능 여부 렌더링 대기

            // 가운데 4자리
            const middleInput = await page.$(SELECTORS.order.phoneMiddle);
            if (middleInput) {
              await middleInput.click({ clickCount: 3 });
              await delay(500);
              await page.keyboard.type(middle, { delay: 80 });
              await delay(600);
            }

            // 마지막 4자리
            const lastInput = await page.$(SELECTORS.order.phoneLast);
            if (lastInput) {
              await lastInput.click({ clickCount: 3 });
              await delay(500);
              await page.keyboard.type(last, { delay: 80 });
              await delay(600);
            }
          }
        }

        console.log("[napkin] 배송지 정보 입력 완료");
      }

      // 일반배송 선택 (새벽배송 대신) - 배송지 렌더링 완료 대기
      await delay(2000);
      console.log("[napkin] 일반배송 선택...");
      const normalDeliverySelector =
        "#chatis_dd_entrance_form_area > div > div.chatis_dd_modal_delivery_type_wrap > label.dawn_entrance_radio_wrap.dawn_entrance_inline_radio_wrap.chatis_dd_modal_type_radio_normal > input";
      const normalDeliveryRadio = await waitFor(
        page,
        normalDeliverySelector,
        3000,
      );
      if (normalDeliveryRadio) {
        await page.evaluate((el) => {
          el.checked = true;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('click', { bubbles: true }));
        }, normalDeliveryRadio);
        console.log("[napkin] ✅ 일반배송 선택 완료");
        await delay(500);
      } else {
        console.log(
          "[napkin] ⚠️ 일반배송 라디오 버튼을 찾을 수 없음 (무시하고 진행)",
        );
      }

      // 결제금액 파싱 (결제 버튼 클릭 전)
      actualPaymentAmount = 0;
      try {
        const amountText = await page.$eval(
          "#payment_total_order_sale_price_view",
          (el) => el.textContent?.trim() || "",
        );
        actualPaymentAmount =
          parseInt(amountText.replace(/[^0-9]/g, ""), 10) || 0;
        console.log(
          `[napkin] 결제금액 파싱: ${amountText} → ${actualPaymentAmount}원`,
        );
      } catch (e) {
        console.log(
          "[napkin] 결제금액 파싱 실패 (결제 진행에 영향 없음):",
          e.message,
        );
      }


      // 결제 수단 선택 (카드 결제)
      console.log("[napkin] 결제 수단 선택 (카드 결제)...");
      const cardSelected = await page.evaluate(() => {
        // 1순위: #addr_paymethod1 (value="card")
        const cardRadio = document.querySelector('#addr_paymethod1');
        if (cardRadio && cardRadio.value === 'card') {
          cardRadio.checked = true;
          cardRadio.dispatchEvent(new Event('change', { bubbles: true }));
          cardRadio.click();
          return { success: true, method: 'id', value: cardRadio.value };
        }
        // 2순위: name="addr_paymethod" value="card"
        const byName = document.querySelector('input[name="addr_paymethod"][value="card"]');
        if (byName) {
          byName.checked = true;
          byName.dispatchEvent(new Event('change', { bubbles: true }));
          byName.click();
          return { success: true, method: 'name', value: byName.value };
        }
        // 3순위: "카드 결제" 라벨 클릭
        const labels = document.querySelectorAll('label');
        for (const label of labels) {
          if (label.textContent?.trim() === '카드 결제') {
            label.click();
            return { success: true, method: 'label', value: 'card' };
          }
        }
        return { success: false };
      });
      if (cardSelected.success) {
        console.log(`[napkin] ✅ 카드 결제 선택 완료 (${cardSelected.method})`);
        await delay(1000);
      } else {
        console.log("[napkin] ⚠️ 카드 결제 선택 실패 - 결제 실패 가능");
      }

      // 결제하기 (신한카드)
      console.log("[napkin] 결제하기 버튼 클릭...");
      await delay(1000);

      const payBtn = await waitFor(page, SELECTORS.order.payBtn, 5000);
      if (payBtn) {
        await page.evaluate((el) => el.click(), payBtn);
        console.log("[napkin] ✅ 결제하기 버튼 클릭 완료");
        await delay(3000);

        // 토스페이먼츠 iframe 대기 및 전환
        console.log("[napkin] 토스페이먼츠 결제창 대기...");
        const iframeSelector = "iframe#_lguplus_popup__iframe";
        const iframeEl = await waitFor(page, iframeSelector, 60000);

        if (iframeEl) {
          const frame = await iframeEl.contentFrame();
          if (frame) {
            console.log("[napkin] 토스페이먼츠 iframe 진입");
            await delay(2000);

            // 카드 선택 (PAYMENT_CARD_TYPE에 따라 분기)
            const paymentCardType = getEnv("PAYMENT_CARD_TYPE") || "shinhan";
            const cardSearchText = paymentCardType === "bc" ? "비씨" : "신한";
            console.log(`[napkin] ${cardSearchText}카드 찾는 중...`);
            let cardClicked = false;
            for (let retry = 0; retry < 30; retry++) {
              cardClicked = await frame.evaluate((searchText) => {
                const links = document.querySelectorAll(
                  'a[data-focus-item="true"]',
                );
                for (const link of links) {
                  const text = link.textContent || "";
                  if (text.includes(searchText)) {
                    link.click();
                    return true;
                  }
                }
                return false;
              }, cardSearchText);
              if (cardClicked) break;
              console.log(`[napkin] ${cardSearchText}카드 대기 중... (${retry + 1}/30)`);
              await delay(1000);
            }

            if (cardClicked) {
              console.log(`[napkin] ✅ ${cardSearchText}카드 선택 완료`);
              await delay(3000);

              // 필수 동의 버튼 클릭 (최대 10초 대기하면서 재시도)
              console.log("[napkin] 필수 동의 버튼 찾는 중...");

              let agreeClicked = null;
              for (let retry = 0; retry < 10; retry++) {
                agreeClicked = await frame.evaluate(() => {
                  const inputs = document.querySelectorAll(
                    'input[type="checkbox"]',
                  );
                  for (const input of inputs) {
                    const ariaLabel = input.getAttribute("aria-label") || "";
                    if (ariaLabel.includes("필수")) {
                      input.click();
                      return "aria-label";
                    }
                  }
                  const labels = document.querySelectorAll("label");
                  for (const label of labels) {
                    const text = label.textContent || "";
                    if (text.includes("필수")) {
                      const input = label.querySelector(
                        'input[type="checkbox"]',
                      );
                      if (input) {
                        input.click();
                        return "label-input";
                      }
                      const forId = label.getAttribute("for");
                      if (forId) {
                        const linkedInput = document.getElementById(forId);
                        if (linkedInput) {
                          linkedInput.click();
                          return "label-for";
                        }
                      }
                      label.click();
                      return "label-click";
                    }
                  }
                  return null;
                });

                if (agreeClicked) {
                  console.log(
                    `[napkin] ✅ 필수 동의 클릭 (방법: ${agreeClicked}, 시도: ${retry + 1})`,
                  );
                  await delay(2000);
                  break;
                }
                console.log(
                  `[napkin] 필수 동의 버튼 대기 중... (${retry + 1}/10)`,
                );
                await delay(1000);
              }

              if (!agreeClicked) {
                console.log(
                  "[napkin] ⚠️ 필수 동의 버튼을 찾지 못함 (10초 대기 후)",
                );
              }

              // 다음 버튼 클릭 (최대 10초 대기하면서 재시도)
              console.log("[napkin] 다음 버튼 찾는 중...");
              let nextClicked = null;
              for (let retry = 0; retry < 10; retry++) {
                nextClicked = await frame.evaluate(() => {
                  const buttons = document.querySelectorAll("button");
                  for (const btn of buttons) {
                    const text = (btn.textContent || "").trim();
                    if (text === "다음" || text.includes("다음")) {
                      btn.click();
                      return "text-다음";
                    }
                  }
                  const submitBtns = document.querySelectorAll(
                    'button[type="submit"]',
                  );
                  for (const btn of submitBtns) {
                    btn.click();
                    return "submit";
                  }
                  return null;
                });
                if (nextClicked) {
                  console.log(
                    `[napkin] ✅ 다음 버튼 클릭 (방법: ${nextClicked}, 시도: ${retry + 1})`,
                  );
                  await delay(3000);
                  break;
                }
                console.log(`[napkin] 다음 버튼 대기 중... (${retry + 1}/10)`);
                await delay(1000);
              }

              if (nextClicked) {
                if (paymentCardType === "bc") {
                  // ===== BC카드: 두 번째 다음 → 결제 팝업 → ISP =====
                  console.log("[napkin] 두 번째 다음 버튼 찾는 중...");
                  let nextClicked2 = null;
                  for (let retry = 0; retry < 10; retry++) {
                    nextClicked2 = await frame.evaluate(() => {
                      const buttons = document.querySelectorAll("button");
                      for (const btn of buttons) {
                        const text = (btn.textContent || "").trim();
                        if (text === "다음" || text.includes("다음")) {
                          btn.click();
                          return true;
                        }
                      }
                      const submitBtns = document.querySelectorAll('button[type="submit"]');
                      for (const btn of submitBtns) { btn.click(); return true; }
                      return null;
                    });
                    if (nextClicked2) {
                      console.log(`[napkin] ✅ 두 번째 다음 버튼 클릭 (시도: ${retry + 1})`);
                      await delay(3000);
                      break;
                    }
                    console.log(`[napkin] 두 번째 다음 버튼 대기 중... (${retry + 1}/10)`);
                    await delay(1000);
                  }

                  // BC카드 결제 팝업 찾기
                  const browser = page.browser();
                  const pagesBeforeNextSet = new Set(await browser.pages());
                  let paymentPopup = null;

                  const paymentDialogHandler = async (dialog) => {
                    try {
                      console.log("[napkin] 결제창 Dialog:", dialog.type(), dialog.message());
                      await dialog.accept();
                    } catch (e) {}
                  };
                  const targetCreatedHandler = async (target) => {
                    if (target.type() === "page") {
                      const newPage = await target.page();
                      if (newPage && !pagesBeforeNextSet.has(newPage)) {
                        const url = newPage.url();
                        if (!url.startsWith("devtools://")) {
                          paymentPopup = newPage;
                          newPage.on("dialog", paymentDialogHandler);
                        }
                      }
                    }
                  };
                  browser.on("targetcreated", targetCreatedHandler);

                  console.log("[napkin] BC카드 결제창 대기...");
                  for (let i = 0; i < 20; i++) {
                    if (paymentPopup) break;
                    const pagesAfter = await browser.pages();
                    for (const p of pagesAfter) {
                      if (!pagesBeforeNextSet.has(p)) {
                        const url = p.url();
                        if (!url.startsWith("devtools://")) {
                          paymentPopup = p;
                          paymentPopup.on("dialog", paymentDialogHandler);
                          break;
                        }
                      }
                    }
                    if (paymentPopup) break;
                    console.log(`[napkin] BC카드 결제창 대기 중... (${(i + 1) * 3}/60초)`);
                    await delay(3000);
                  }

                  if (paymentPopup) {
                    await delay(2000);

                    // 기타결제 버튼 클릭
                    console.log("[napkin] 기타결제 버튼 클릭...");
                    const otherPaymentBtn = "#inapppay-dap1 > div.block2 > div.left > a";
                    try {
                      await paymentPopup.waitForSelector(otherPaymentBtn, { timeout: 60000 });
                      await paymentPopup.click(otherPaymentBtn);
                      console.log("[napkin] ✅ 기타결제 버튼 클릭 완료");
                      await delay(3000);

                      // 인증서 등록/결제 버튼 클릭
                      const certPaymentBtn = "#inapppay-dap2 > div.block1 > div.left > a.pay-item-s.pay-ctf";
                      try {
                        await paymentPopup.waitForSelector(certPaymentBtn, { timeout: 60000 });
                        await paymentPopup.click(certPaymentBtn);
                        console.log("[napkin] ✅ 인증서 등록/결제 버튼 클릭 완료");
                        await delay(3000);

                        // ISP/페이북 자동화
                        console.log("[napkin] ISP 네이티브 결제창 자동화 시작...");
                        const ispResult = await automateISPPayment();
                        if (ispResult.success) {
                          console.log("[napkin] ✅ ISP 결제 자동화 완료");
                          paymentCompleted = true;
                        } else {
                          console.log("[napkin] ⚠️ ISP 결제 실패:", ispResult.error);
                        }
                      } catch (certError) {
                        console.log("[napkin] ⚠️ 인증서 버튼 실패:", certError.message);
                      }
                    } catch (e) {
                      console.log("[napkin] ⚠️ 기타결제 버튼 실패:", e.message);
                    }
                  } else {
                    console.log("[napkin] ⚠️ BC카드 결제창 팝업을 찾을 수 없음");
                  }

                  browser.off("targetcreated", targetCreatedHandler);
                } else {
                // ===== 신한카드: 토스페이먼츠 전자결제 iframe =====
                console.log("[napkin] 토스페이먼츠 전자결제 iframe 대기...");
                await delay(3000);

                let paymentFrame = null;
                for (let i = 0; i < 10; i++) {
                  const frames = page.frames();
                  for (const f of frames) {
                    const frameName = f.name();
                    if (frameName.includes("토스페이먼츠")) {
                      paymentFrame = f;
                      console.log(
                        "[napkin] 토스페이먼츠 iframe 발견:",
                        frameName,
                      );
                      break;
                    }
                  }
                  if (paymentFrame) break;

                  const iframeEl2 = await page.$(
                    'iframe[title="토스페이먼츠 전자결제"]',
                  );
                  if (iframeEl2) {
                    paymentFrame = await iframeEl2.contentFrame();
                    if (paymentFrame) {
                      console.log(
                        "[napkin] 토스페이먼츠 iframe 발견 (title 기반)",
                      );
                      break;
                    }
                  }

                  console.log(
                    `[napkin] 토스페이먼츠 iframe 대기 중... (${i + 1}/10)`,
                  );
                  await delay(1000);
                }

                if (paymentFrame) {
                  await delay(2000);

                  // "다른결제" 탭 클릭
                  console.log("[napkin] 다른결제 탭 클릭...");
                  const otherPaymentClicked = await paymentFrame.evaluate(
                    () => {
                      const tabs = document.querySelectorAll('a[role="tab"]');
                      for (const tab of tabs) {
                        const text = tab.textContent || "";
                        if (text.includes("다른결제")) {
                          tab.click();
                          return true;
                        }
                      }
                      return false;
                    },
                  );

                  if (otherPaymentClicked) {
                    console.log("[napkin] ✅ 다른결제 탭 클릭 완료");
                    await delay(2000);

                    // "앱없이결제" 버튼 클릭
                    console.log("[napkin] 앱없이결제 버튼 클릭...");
                    const applessPayClicked = await paymentFrame.evaluate(
                      () => {
                        const subTits = document.querySelectorAll(".sub-tit");
                        for (const span of subTits) {
                          const text = span.textContent || "";
                          if (text.includes("앱없이결제")) {
                            const link = span.closest("a");
                            if (link) {
                              link.click();
                              return true;
                            }
                          }
                        }
                        return false;
                      },
                    );

                    if (applessPayClicked) {
                      console.log("[napkin] ✅ 앱없이결제 클릭 완료");
                      await delay(2000);

                      // 결제 방식 분기: phone(기본) / card
                      const paymentMethod = getEnv("SHINHAN_PAYMENT_METHOD") || "phone";
                      console.log(`[napkin] 결제 방식: ${paymentMethod}`);

                      if (paymentMethod === "card") {
                        // === 카드번호 결제 ===
                        console.log("[napkin] 카드번호 결제 탭 클릭...");
                        const cardTabClicked = await paymentFrame.evaluate(() => {
                          const tabs = document.querySelectorAll(
                            'a, button, [role="tab"]',
                          );
                          for (const tab of tabs) {
                            const text = tab.textContent || "";
                            if (
                              text.includes("카드번호") &&
                              text.includes("결제")
                            ) {
                              tab.click();
                              return true;
                            }
                          }
                          return false;
                        });

                        if (cardTabClicked) {
                          console.log("[napkin] ✅ 카드번호 결제 탭 클릭 완료");
                          await delay(2000);

                          const cardNum1 = getEnv("SHINHAN_CARD_NUM1");
                          const cardNum4 = getEnv("SHINHAN_CARD_NUM4");

                          if (cardNum1 && cardNum4) {
                            console.log("[napkin] 카드번호 입력 시작...");

                            // cardNum1 (앞 4자리) - 보안키패드 없음
                            await paymentFrame.waitForSelector("#cardNum1", {
                              timeout: 10000,
                            });
                            await paymentFrame.click("#cardNum1");
                            await delay(100);
                            await paymentFrame.type("#cardNum1", cardNum1, {
                              delay: 50,
                            });
                            console.log("[napkin] ✅ cardNum1 입력 완료");
                            await delay(300);

                            // cardNum2, cardNum3 - 보안키패드 필드 → Interception
                            console.log(
                              "[napkin] 보안키패드 필드 키보드 입력 시작...",
                            );
                            await page.bringToFront();
                            await delay(300);
                            const shinhanResult =
                              await automateShinhanCardPayment(paymentFrame);

                            if (shinhanResult.success) {
                              console.log(
                                "[napkin] ✅ cardNum2, cardNum3 입력 완료",
                              );

                              await delay(300);

                              // cardNum4 (뒤 4자리) - 보안키패드 없음
                              await paymentFrame.waitForSelector("#cardNum4", {
                                timeout: 10000,
                              });
                              await paymentFrame.click("#cardNum4");
                              await delay(100);
                              await paymentFrame.type("#cardNum4", cardNum4, {
                                delay: 50,
                              });
                              console.log("[napkin] ✅ cardNum4 입력 완료");
                              await delay(300);

                              // CVC 입력 - Interception
                              const cardCVC = getEnv("SHINHAN_CVC");
                              if (cardCVC) {
                                await delay(1000);
                                await paymentFrame.waitForSelector(
                                  "#inputCVC",
                                  { timeout: 10000 },
                                );
                                await paymentFrame.click("#inputCVC");
                                await delay(300);
                                console.log("[napkin] CVC 입력 중...");
                                typeWithInterception(cardCVC);
                                await delay(500);
                                console.log("[napkin] ✅ CVC 입력 완료");
                              }
                              await delay(500);

                              // 다음 버튼 클릭
                              console.log("[napkin] 다음 버튼 클릭...");
                              const submitClicked = await paymentFrame.evaluate(
                                () => {
                                  const btn =
                                    document.querySelector(".submit-btn");
                                  if (btn) {
                                    btn.click();
                                    return true;
                                  }
                                  return false;
                                },
                              );

                              if (submitClicked) {
                                console.log("[napkin] ✅ 다음 버튼 클릭 완료");
                                await delay(3000);

                                // 비밀번호 입력
                                console.log(
                                  "[napkin] 비밀번호 입력 화면 대기...",
                                );

                                const iframeHtml = await paymentFrame.evaluate(
                                  () => {
                                    return document.body.innerHTML;
                                  },
                                );
                                console.log(
                                  "[napkin] === 비밀번호 화면 HTML ===",
                                );
                                console.log(iframeHtml.substring(0, 3000));
                                console.log("[napkin] === HTML 끝 ===");

                                const cardPassword = getEnv(
                                  "SHINHAN_CARD_PASSWORD",
                                );
                                if (cardPassword) {
                                  const passwordSelectors = [
                                    'input[type="password"]',
                                    'input[type="tel"]',
                                    'input[name="password"]',
                                    'input[id*="password"]',
                                    'input[id*="pwd"]',
                                    'input[id*="cardPw"]',
                                    "#cardPwd",
                                    "#cardPw",
                                    "input[data-nppfs-form-id]",
                                  ];

                                  let passwordInputFound = false;
                                  for (
                                    let i = 0;
                                    i < 10 && !passwordInputFound;
                                    i++
                                  ) {
                                    for (const selector of passwordSelectors) {
                                      try {
                                        const pwdInput =
                                          await paymentFrame.$(selector);
                                        if (pwdInput) {
                                          console.log(
                                            `[napkin] 비밀번호 필드 발견: ${selector}`,
                                          );
                                          await paymentFrame.click(selector);
                                          await delay(500);
                                          await paymentFrame.evaluate((sel) => {
                                            const el =
                                              document.querySelector(sel);
                                            if (el) {
                                              el.focus();
                                              el.click();
                                            }
                                          }, selector);
                                          await delay(500);

                                          await page.bringToFront();
                                          await delay(300);
                                          console.log(
                                            "[napkin] 카드 비밀번호 입력 중 (Interception)...",
                                          );
                                          const result =
                                            typeWithInterception(cardPassword);
                                          console.log(
                                            "[napkin] Interception 입력 결과:",
                                            result,
                                          );
                                          await delay(1500);
                                          console.log(
                                            "[napkin] ✅ 카드 비밀번호 입력 완료",
                                          );
                                          passwordInputFound = true;
                                          break;
                                        }
                                      } catch (e) {
                                        console.log(
                                          `[napkin] 비밀번호 필드 에러 (${selector}):`,
                                          e.message,
                                        );
                                      }
                                    }
                                    if (!passwordInputFound) {
                                      console.log(
                                        `[napkin] 비밀번호 필드 탐색 중... (${i + 1}/10)`,
                                      );
                                      await delay(1000);
                                    }
                                  }

                                  if (passwordInputFound) {
                                    await delay(500);
                                    console.log(
                                      "[napkin] 결제요청 버튼 찾는 중...",
                                    );
                                    const paymentBtnClicked =
                                      await paymentFrame.evaluate(() => {
                                        const btn =
                                          document.querySelector(".submit-btn");
                                        if (btn) {
                                          btn.click();
                                          return true;
                                        }
                                        const buttons =
                                          document.querySelectorAll("button");
                                        for (const b of buttons) {
                                          const text = (
                                            b.textContent || ""
                                          ).trim();
                                          if (
                                            text.includes("결제") ||
                                            text.includes("확인")
                                          ) {
                                            b.click();
                                            return true;
                                          }
                                        }
                                        return false;
                                      });
                                    if (paymentBtnClicked) {
                                      console.log(
                                        "[napkin] ✅ 결제요청 버튼 클릭 완료",
                                      );
                                      paymentCompleted = true;
                                    }
                                  }
                                }
                              }
                            } else {
                              console.log(
                                "[napkin] ⚠️ 보안키패드 입력 실패:",
                                shinhanResult.error,
                              );
                            }
                          } else {
                            console.log(
                              "[napkin] ⚠️ 신한카드 정보가 환경변수에 없음",
                            );
                          }
                        } else {
                          console.log(
                            "[napkin] ⚠️ 카드번호 결제 탭을 찾을 수 없음",
                          );
                        }
                      } else {
                        // === 휴대폰번호로 결제 (기본) ===
                        console.log("[napkin] 휴대폰번호로 결제 진행...");
                        const phoneResult = await processPhonePayment(
                          paymentFrame,
                          page,
                        );

                        if (phoneResult.success) {
                          console.log("[napkin] ✅ 휴대폰번호 결제 완료");
                          paymentCompleted = true;
                        } else {
                          console.log(
                            "[napkin] ⚠️ 휴대폰번호 결제 실패:",
                            phoneResult.error,
                          );
                        }
                      }
                    } else {
                      console.log("[napkin] ⚠️ 앱없이결제 버튼을 찾을 수 없음");
                    }
                  } else {
                    console.log("[napkin] ⚠️ 다른결제 탭을 찾을 수 없음");
                  }
                } else {
                  console.log(
                    "[napkin] ⚠️ 토스페이먼츠 전자결제 iframe을 찾을 수 없음",
                  );
                }
              }
              } // end of else (신한카드 경로)
            } else {
              console.log(`[napkin] ⚠️ ${cardSearchText}카드를 찾을 수 없음`);
            }
          } else {
            console.log("[napkin] ⚠️ iframe contentFrame 접근 실패");
          }
        } else {
          console.log("[napkin] ⚠️ 토스페이먼츠 iframe을 찾을 수 없음");
        }
      } else {
        console.log("[napkin] ⚠️ 결제하기 버튼을 찾을 수 없음");
      }

      // 결제 완료 확인
      if (paymentCompleted) {
        console.log("[napkin] ✅ 결제 프로세스 완료");
        break;
      }

      if (paymentAttempt < MAX_PAYMENT_RETRIES - 1) {
        console.log(
          "[napkin] ⚠️ 결제 미완료 (빈 창 등) - 20초 대기 후 장바구니에서 재시도...",
        );
        await delay(20000);
      }
    } // end of payment retry loop



    if (!paymentCompleted) {
      console.log("[napkin] ❌ 결제 최대 재시도 초과 - 실패 처리");

      if (page._napkinDialogHandler) {
        page.off("dialog", page._napkinDialogHandler);
        delete page._napkinDialogHandler;
        console.log("[napkin] dialog 핸들러 제거 완료");
      }

      errorCollector.addError(
        "PAYMENT",
        "PAYMENT_FAILED",
        "신한카드 결제 실패 (빈 창 등) - 최대 재시도 초과",
        { purchaseOrderId },
      );
      await saveOrderResults(authToken, {
        purchaseOrderId,
        products: [],
        priceMismatches: [],
        optionFailedProducts: [],
        automationErrors: errorCollector.getErrors(),
        poLineIds,
        success: false,
        vendor: "napkin",
      });
      return res.json({
        success: false,
        vendor: vendor.name,
        message: "신한카드 결제 실패 (빈 창 등) - 최대 재시도 초과",
        automationErrors: errorCollector.getErrors(),
      });
    }

    // 결제 완료 대기
    await delay(10000);

    // 주문번호 추출
    let vendorOrderNumber = null;
    const orderNumberSelector =
      "#mCafe24Order > div.resultArea > div > div > table > tbody > tr:nth-child(1) > td > span";

    try {
      await page.waitForSelector(orderNumberSelector, { timeout: 60000 });
      vendorOrderNumber = await page.$eval(orderNumberSelector, (el) =>
        el.textContent.trim(),
      );
      console.log("[napkin] ✅ 주문번호:", vendorOrderNumber);
    } catch (orderNumError) {
      console.log("[napkin] ⚠️ 주문번호 추출 실패:", orderNumError.message);
    }

    // 현재 URL 반환
    const currentUrl = page.url();

    // 가격 불일치 상세 데이터 (시스템 저장용)
    const priceMismatchList = results.filter((r) => r.priceInfo?.priceMismatch);
    const priceMismatches = priceMismatchList.map((r) => ({
      purchaseOrderLineId: r.lineId,
      purchaseOrderId: r.purchaseOrderId, // 개별 상품의 발주 ID
      productVariantVendorId: r.productVariantVendorId || null,
      productCode: r.productSku,
      productName: r.productName,
      quantity: r.quantity,
      openMallPrice: r.priceInfo?.unitPrice,
      expectedPrice: r.priceInfo?.expectedUnitPrice,
      vendorPriceExcludeVat: r.priceInfo?.vendorPriceExcludeVat,
      difference: r.priceInfo?.difference,
      differencePercent:
        r.priceInfo?.expectedUnitPrice > 0
          ? (
              (r.priceInfo?.difference / r.priceInfo?.expectedUnitPrice) *
              100
            ).toFixed(2)
          : 0,
    }));

    // 옵션 실패 상품 필터링
    const optionFailedProducts = results
      .filter((r) => !r.success && r.message?.includes("옵션"))
      .map((r) => ({
        purchaseOrderLineId: r.lineId,
        purchaseOrderId: r.purchaseOrderId, // 개별 상품의 발주 ID
        productVariantVendorId: r.productVariantVendorId,
        productSku: r.productSku,
        productName: r.productName,
        reason: r.message,
      }));

    // saveOrderResults 호출 (성공)
    await saveOrderResults(authToken, {
      purchaseOrderId,
      products: products.map((p) => ({
        orderLineIds: p.orderLineIds,
        openMallOrderNumber: vendorOrderNumber || null,
      })),
      priceMismatches:
        priceMismatches?.map((p) => ({
          productVariantVendorId: p.productVariantVendorId,
          purchaseOrderId: p.purchaseOrderId, // 개별 상품의 발주 ID
          vendorPriceExcludeVat: p.vendorPriceExcludeVat,
          openMallPrice: p.openMallPrice,
        })) || [],
      optionFailedProducts: [],
      automationErrors: [],
      poLineIds,
      success: true,
      vendor: "napkin",
    });

    // 결제 로그 저장
    if (actualPaymentAmount > 0) {
      const expectedAmount = calculateExpectedPaymentAmount(products);
      try {
        await createPaymentLogs(authToken, [
          {
            vendor: "napkin",
            paymentAmount: actualPaymentAmount,
            expectedAmount,
            purchaseOrderId,
          },
        ]);
      } catch (e) {
        console.log("[napkin] 결제 로그 저장 실패 (무시):", e.message);
      }
    }

    // dialog 핸들러 제거 (다른 협력사와 충돌 방지)
    if (page._napkinDialogHandler) {
      page.off("dialog", page._napkinDialogHandler);
      delete page._napkinDialogHandler;
      console.log("[napkin] dialog 핸들러 제거 완료");
    }

    return res.json({
      success: true,
      message: vendorOrderNumber
        ? `${products.length}개 상품 주문 완료`
        : `${products.length}개 상품 장바구니 담기 완료`,
      vendor: vendor.name,
      purchaseOrderId: purchaseOrderId || null,
      purchaseOrderLineIds: purchaseOrderLineIds || [],
      products: products.map((p) => ({
        orderLineIds: p.orderLineIds,
        openMallOrderNumber: vendorOrderNumber || null,
        productName: p.productName,
        productSku: p.productSku,
        quantity: p.quantity,
        vendorPriceExcludeVat: p.vendorPriceExcludeVat,
      })),
      // 주문 결과
      orderResult: {
        placed: !!vendorOrderNumber,
        orderPageUrl: currentUrl,
        vendorOrderNumber: vendorOrderNumber || null,
      },
      // 가격 불일치 관련
      hasPriceMismatch: priceMismatchList.length > 0,
      priceMismatchCount: priceMismatchList.length,
      priceMismatches,
      // 옵션 실패 관련
      optionFailedCount: optionFailedProducts.length,
      optionFailedProducts,
    });
  } catch (error) {
    console.error("[napkin] 주문 처리 에러:", error);

    // dialog 핸들러 제거 (에러 발생 시에도)
    if (page._napkinDialogHandler) {
      page.off("dialog", page._napkinDialogHandler);
      delete page._napkinDialogHandler;
      console.log("[napkin] dialog 핸들러 제거 완료 (에러 처리)");
    }

    await saveOrderResults(authToken, {
      purchaseOrderId,
      products: [],
      priceMismatches: [],
      optionFailedProducts: [],
      automationErrors: errorCollector.hasErrors()
        ? errorCollector.getErrors()
        : [],
      poLineIds,
      success: false,
      vendor: "napkin",
    });
    return res.json({
      success: false,
      vendor: vendor.name,
      message: `주문 처리 에러: ${error.message}`,
      automationErrors: errorCollector.hasErrors()
        ? errorCollector.getErrors()
        : undefined,
    });
  }
}

module.exports = {
  processNapkinOrder,
  loginToNapkin,
};
