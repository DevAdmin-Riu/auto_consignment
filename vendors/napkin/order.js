/**
 * 냅킨코리아 주문 모듈
 *
 * 흐름:
 * 1. 로그인
 * 2. 상품 페이지 이동
 * 3. 옵션 선택 (있는 경우)
 * 4. 수량 설정
 * 5. 장바구니 담기
 * 6. 주문/결제
 */

const { getEnv } = require("../config");
const {
  createOrderErrorCollector,
  ORDER_STEPS,
  ERROR_CODES,
} = require("../../lib/automation-error");
const { saveOrderResults } = require("../../lib/graphql-client");
const { automateISPPayment } = require("../../lib/isp-payment");

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
    idInput: '#member_id',
    pwInput: '#member_passwd',
    submitBtn: 'form[id^="member_form"] fieldset a, .btn_login, a.btn_login',
    loginForm: 'form[id^="member_form"]',
  },
  // 상품 페이지
  product: {
    // 옵션 선택
    optionSelect: 'select[id^="product_option_id"], select[class^="ProductOption"]',
    optionItem: (value) => `option[value*="${value}"]`,
    // 수량
    quantityInput: 'input[name="quantity"], input.quantity',
    quantityPlus: '.quantity_plus, .up, button.up',
    quantityMinus: '.quantity_minus, .down, button.down',
    // 버튼
    addToCartBtn: '#cartBtn',
    buyNowBtn: '.btn_buy, a.btn_buy, #btn_buy',
    // 장바구니 담기 후 팝업
    confirmGoCartBtn: '#confirmLayer > div.xans-element-.xans-product.xans-product-basketadd.ec-base-layer > div.ec-base-button > p > a:nth-child(1)',
    // 가격
    totalPrice: '.total_price, #totalPrice, .price_total',
  },
  // 장바구니
  cart: {
    url: 'https://www.napkinkorea.co.kr/order/basket.html',
    selectAll: 'input[name="checkall"], input.check_all',
    orderBtn: '.btn_order, a.btn_order, #btn_order, a[href*="order"]',
    orderAllBtn: '#sp-content > div:nth-child(2) > div.xans-element-.xans-order.xans-order-basketpackage > div.xans-element-.xans-order.xans-order-totalorder.ec-base-button.justify > a:nth-child(1)',
    itemCheckbox: 'input[name="cart_select[]"], input.cart_check',
    clearBtn: '#sp-content > div:nth-child(2) > div.xans-element-.xans-order.xans-order-basketpackage > div.xans-element-.xans-order.xans-order-selectorder.ec-base-button > span.gRight > a:nth-child(2)',
  },
  // 주문서
  order: {
    // 배송지 직접입력 버튼
    newAddressBtn: '#ec-jigsaw-tab-shippingInfo-newAddress > a',
    // 배송지
    receiverName: '#rname',
    addressSearchBtn: '#btn_search_rzipcode',
    addressDetail: '#raddr2',
    // 휴대폰
    phoneFirst: '#rphone2_1', // select
    phoneMiddle: '#rphone2_2',
    phoneLast: '#rphone2_3',
    // 다음 주소 검색 iframe
    daumPostcodeFrame: "iframe[title='우편번호 검색 프레임']",
    daumAddressInput: '#region_name',
    daumSearchButton: '#searchForm > fieldset > div > button.btn_search',
    daumAddressItem: 'li.list_post_item',
    // 결제
    payBtn: '#orderFixItem > div',
    agreeAll: 'input[name="agree_all"], input.agree_all',
    // 결제 수단
    cardPayment: 'input[value="card"], input[name="payment_method"][value*="card"]',
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
    waitUntil: "networkidle2",
    timeout: 30000,
  });
  await delay(1500); // 로그인 상태 확인을 위해 대기

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
    return style.display !== 'none' && style.visibility !== 'hidden';
  }, SELECTORS.login.idInput);

  if (!isVisible) {
    console.log("[napkin] 아이디 입력창 숨김 상태 - 이미 로그인됨");
    return { success: true, message: "이미 로그인됨" };
  }

  console.log("[napkin] 로그인 페이지 확인됨, 로그인 진행...");

  // 3. 아이디 입력
  console.log("[napkin] 2. 아이디 입력...");
  await idInput.click({ clickCount: 3 }); // 기존 값 선택 후 덮어쓰기
  await delay(300);
  await idInput.type(vendor.userId, { delay: 50 });

  // 4. 비밀번호 입력
  console.log("[napkin] 3. 비밀번호 입력...");
  const pwInput = await waitFor(page, SELECTORS.login.pwInput, 5000);
  if (!pwInput) {
    return { success: false, message: "비밀번호 입력창을 찾을 수 없음" };
  }
  await pwInput.click({ clickCount: 3 }); // 기존 값 선택 후 덮어쓰기
  await delay(300);
  await pwInput.type(vendor.password, { delay: 50 });

  // 5. 로그인 버튼 클릭
  console.log("[napkin] 4. 로그인 버튼 클릭...");
  const submitBtn = await page.$(SELECTORS.login.submitBtn);
  if (submitBtn) {
    await submitBtn.click();
  } else {
    // 버튼 못찾으면 엔터키로 시도
    await page.keyboard.press("Enter");
  }

  await delay(2000);

  // 페이지 이동 대기
  await page
    .waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 })
    .catch(() => {});
  await delay(1500);

  console.log("[napkin] 로그인 완료!");
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

  // confirm 다이얼로그 자동 수락 설정 (named function으로 나중에 제거 가능)
  const napkinDialogHandler = async (dialog) => {
    console.log("[napkin] confirm 다이얼로그:", dialog.message());
    await dialog.accept();
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
    const inputResult = await page.evaluate((optTitle, optValue) => {
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
              const input = td.querySelector("input[type='text'], input:not([type]), textarea");
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
    }, title, value);

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
    const selectResult = await page.evaluate((optTitle, optValue) => {
      const normalize = (str) => str.replace(/\s+/g, '');
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
                  if (normalizedText.includes(normalizedValue) || normalizedValue.includes(normalizedText) ||
                      normalizedOptValue.includes(normalizedValue) || normalizedValue.includes(normalizedOptValue)) {
                    select.value = opt.value;
                    select.dispatchEvent(new Event("change", { bubbles: true }));
                    return { found: true, thText, selectedValue: opt.value, selectedText: opt.textContent };
                  }
                }
              }
            }
          }
        }
      }

      // title로 못 찾으면 기존 방식 (모든 select에서 value로 검색)
      const allSelects = document.querySelectorAll('select[id^="product_option_id"], select[class^="ProductOption"]');
      for (const select of allSelects) {
        const options = select.querySelectorAll("option");
        for (const opt of options) {
          const normalizedText = normalize(opt.textContent);
          const normalizedOptValue = normalize(opt.value);
          if (normalizedText.includes(normalizedValue) || normalizedValue.includes(normalizedText) ||
              normalizedOptValue.includes(normalizedValue) || normalizedValue.includes(normalizedOptValue)) {
            select.value = opt.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            return { found: true, fallback: true, selectedValue: opt.value, selectedText: opt.textContent };
          }
        }
      }

      return { found: false };
    }, title, value);

    if (selectResult.found) {
      console.log(`[napkin] ✅ SELECT 선택 완료: "${title}" = "${selectResult.selectedText || value}"`);
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
async function setQuantityAndGetPrice(page, quantity, vendorPriceExcludeVat, boxIndex = 1) {
  let priceInfo = null;

  // 수량 필드 찾기 및 수량 설정 (세트별로 다른 박스)
  const quantitySelector = `#option_box${boxIndex}_quantity`;
  console.log(`[napkin] 수량 필드 대기: ${quantitySelector} (수량: ${quantity}, 박스: ${boxIndex})`);

  const quantityInput = await waitFor(page, quantitySelector, 10000);
  if (!quantityInput) {
    console.log(`[napkin] ⚠️ 수량 필드 못찾음: ${quantitySelector}`);
  }

  if (quantityInput && quantity > 1) {
    console.log(`[napkin] 수량 입력: ${quantity} (박스 ${boxIndex})`);
    await quantityInput.click();
    await delay(100);
    await quantityInput.click({ clickCount: 3 });
    await delay(200);
    await page.keyboard.type(String(quantity), { delay: 50 });
    await page.evaluate(el => {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }, quantityInput);
    await delay(2000);
  }

  // 가격 정보 가져오기 (세트별로 다른 박스)
  const priceSelector = `#option_box${boxIndex}_price input.option_box_price`;
  const priceInput = await page.$(priceSelector);

  if (priceInput) {
    const totalPrice = await page.evaluate(el => parseInt(el.value) || 0, priceInput);
    const unitPrice = Math.round(totalPrice / quantity);
    console.log(`[napkin] 가격 정보 - 총액: ${totalPrice}원, 수량: ${quantity}, 단가: ${unitPrice}원`);

    if (vendorPriceExcludeVat) {
      const expectedUnitPrice = Math.round(vendorPriceExcludeVat * 1.1);
      const priceDifference = Math.abs(unitPrice - expectedUnitPrice);
      const PRICE_TOLERANCE = 3;

      if (priceDifference > PRICE_TOLERANCE) {
        console.log(`[napkin] ⚠️ 가격 불일치: 냅킨 ${unitPrice}원 vs 협력사 ${expectedUnitPrice}원 (차이: ${unitPrice - expectedUnitPrice}원)`);
        priceInfo = {
          unitPrice,
          totalPrice,
          expectedUnitPrice,
          vendorPriceExcludeVat,
          priceMismatch: true,
          difference: unitPrice - expectedUnitPrice,
        };
      } else {
        console.log(`[napkin] ✓ 가격 일치: 냅킨 ${unitPrice}원, 협력사 ${expectedUnitPrice}원 (오차: ${priceDifference}원)`);
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
async function selectOptions(page, openMallOptions, quantity = 1, vendorPriceExcludeVat = null) {
  if (!openMallOptions || openMallOptions.length === 0) {
    console.log("[napkin] 옵션 없음, 스킵");
    return { success: true, skipped: true };
  }

  console.log("[napkin] 옵션 선택 시작:", JSON.stringify(openMallOptions));

  // 옵션 탭 로딩 대기
  console.log("[napkin] 옵션 탭 로딩 대기...");
  const optionTab = await waitFor(page, '#sp-detail-optiontab > div > div', 10000);
  if (!optionTab) {
    console.log("[napkin] 옵션 탭 로딩 실패");
    return { success: false, message: "옵션 탭 로딩 실패" };
  }
  await delay(500);

  let priceInfo = null;

  // 2D 구조 검증: [{options: [{title, value}, ...]}, ...]
  const is2DStructure = openMallOptions[0] && Array.isArray(openMallOptions[0].options);

  if (is2DStructure) {
    console.log(`[napkin] 옵션 세트 처리: ${openMallOptions.length}개 세트`);

    for (let s = 0; s < openMallOptions.length; s++) {
      const set = openMallOptions[s];
      const setOptions = set.options || [];

      console.log(`[napkin] --- 세트 ${s + 1}/${openMallOptions.length} 처리 시작 (${setOptions.length}개 옵션) ---`);

      // 세트 내 모든 옵션 선택
      for (let i = 0; i < setOptions.length; i++) {
        const option = setOptions[i];
        console.log(`[napkin] 세트 ${s + 1}, 옵션 ${i + 1}: ${option.title} = ${option.value}`);

        const result = await processSingleOption(page, option);
        if (!result.success) {
          return result;
        }
      }

      // 세트 내 모든 옵션 선택 후 수량 설정 및 가격 확인
      console.log(`[napkin] 세트 ${s + 1} 옵션 선택 완료, 수량 필드 대기...`);
      await delay(2000);

      priceInfo = await setQuantityAndGetPrice(page, quantity, vendorPriceExcludeVat, s + 1);
      await delay(1000);
    }

    return { success: true, priceInfo };
  }

  // 2D 구조가 아닌 경우 에러
  return { success: false, message: "잘못된 옵션 구조: 2D 구조 [{options: [...]}] 형식이어야 합니다" };
}

/**
 * 수량 설정
 */
async function setQuantity(page, quantity) {
  console.log(`[napkin] 수량 설정: ${quantity}`);

  const quantityInput = await page.$(SELECTORS.product.quantityInput);
  if (quantityInput) {
    await quantityInput.click({ clickCount: 3 });
    await delay(200);
    await quantityInput.type(String(quantity), { delay: 50 });
    await delay(300);
    return { success: true };
  }

  // 수량 버튼으로 설정
  const plusBtn = await page.$(SELECTORS.product.quantityPlus);
  if (plusBtn) {
    for (let i = 1; i < quantity; i++) {
      await plusBtn.click();
      await delay(300);
    }
    return { success: true };
  }

  console.log("[napkin] 수량 입력 불가, 기본값 사용");
  return { success: true, skipped: true };
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
    const altBtn = await waitFor(page, 'a[href*="basket"], .btn_cart, #btn_cart, .addToCart', 3000);
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
      const altSelectors = ['a[href*="basket"]', '.btn_cart', '#btn_cart', '.addToCart', '#cartBtn'];
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
  { products, purchaseOrderId, shippingAddress, lineIds },
  authToken
) {
  console.log("=".repeat(50));
  console.log("[napkin] 주문 처리 시작");
  console.log("[napkin] 발주번호:", purchaseOrderId);
  console.log("[napkin] 상품 수:", products?.length);
  console.log("=".repeat(50));

  // lineIds 직접 사용
  const purchaseOrderLineIds = lineIds || [];

  // 에러 수집기 초기화
  const errorCollector = createOrderErrorCollector("napkin");

  try {
    // 1. 로그인
    const loginResult = await loginToNapkin(page, vendor);
    if (!loginResult.success) {
      errorCollector.addError(ORDER_STEPS.LOGIN, ERROR_CODES.LOGIN_FAILED, loginResult.message, { purchaseOrderId });
      await saveOrderResults(authToken, {
        purchaseOrderId,
        products: [],
        priceMismatches: [],
        optionFailedProducts: [],
        automationErrors: errorCollector.getErrors(),
        lineIds,
        success: false,
      });
      return res.json({
        success: false,
        vendor: vendor.name,
        message: `로그인 실패: ${loginResult.message}`,
        automationErrors: errorCollector.getErrors(),
      });
    }

    // 2. 장바구니 비우기
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
        console.log(`[napkin] ❌ 상품 URL이 없음 - 스킵: ${product.productName}`);
        errorCollector.addError(
          ORDER_STEPS.PRODUCT_ACCESS,
          ERROR_CODES.PRODUCT_NOT_FOUND,
          `상품 URL이 없음: ${product.productName}`,
          { productSku: product.productSku, lineId }
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
        await page.goto(product.productUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        }).catch(() => {
          console.log("[napkin] 페이지 이동 중 리다이렉트 발생, 계속 진행...");
        });
        await delay(2000);

        // 3-2. 옵션 선택
        let options = product.openMallOptions;
        // 문자열이면 파싱
        if (typeof options === 'string') {
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
          console.log(`[napkin] 수량 변환: ${baseQuantity}개 × ${qtyPerUnit} = ${actualQuantity}개`);
        }

        let hasOptions = options && options.length > 0;
        let priceInfo = null;
        if (hasOptions) {
          const optionResult = await selectOptions(page, options, actualQuantity, product.vendorPriceExcludeVat);
          if (!optionResult.success) {
            errorCollector.addError(ORDER_STEPS.ADD_TO_CART, null, optionResult.message, {
              purchaseOrderId,
              purchaseOrderLineId: lineId,
              productVariantVendorId: product.productVariantVendorId,
            });
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
          await setQuantity(page, actualQuantity);
        }

        // 3-4. 장바구니 담기
        const cartResult = await addToCart(page);
        if (!cartResult.success) {
          errorCollector.addError(ORDER_STEPS.ADD_TO_CART, null, cartResult.message, {
            purchaseOrderId,
            purchaseOrderLineId: lineId,
            productVariantVendorId: product.productVariantVendorId,
          });
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
        errorCollector.addError(ORDER_STEPS.ADD_TO_CART, null, productError.message, {
          purchaseOrderId,
          purchaseOrderLineId: lineId,
          productVariantVendorId: product.productVariantVendorId,
        });
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
    const successCount = results.filter(r => r.success).length;
    if (successCount === 0) {
      console.log("[napkin] 모든 상품 처리 실패 - 장바구니 이동 안함");
      const optionFailedProducts = results
        .filter(r => !r.success && r.message?.includes('옵션'))
        .map(r => ({
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
        lineIds,
        success: false,
      });
      return res.json({
        success: false,
        vendor: vendor.name,
        purchaseOrderId,
        message: "모든 상품 처리 실패",
        results,
        lineIds: purchaseOrderLineIds,
        automationErrors: errorCollector.getErrors(),
      });
    }

    // 4. 장바구니 이동 버튼 클릭 (마지막 상품의 팝업에서)
    console.log("\n[napkin] 장바구니 이동 버튼 클릭...");
    const goCartBtn = await waitFor(page, SELECTORS.product.confirmGoCartBtn, 5000);
    if (goCartBtn) {
      await goCartBtn.click();
      await delay(2000);
    } else {
      // 팝업이 없으면 직접 이동
      console.log("[napkin] 팝업 없음, 직접 장바구니 이동...");
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
      await page.evaluate(el => el.click(), orderAllBtn);
      await delay(2000);
    } else {
      console.log("[napkin] 전체상품 주문하기 버튼 없음");
    }

    // 6. 배송지 직접입력 버튼 클릭
    console.log("[napkin] 배송지 직접입력 버튼 클릭...");
    await delay(1500); // 페이지 로딩 대기
    const newAddressBtn = await waitFor(page, SELECTORS.order.newAddressBtn, 5000);
    if (newAddressBtn) {
      await page.evaluate(el => el.click(), newAddressBtn);
      await delay(1000);
    } else {
      console.log("[napkin] 배송지 직접입력 버튼 없음");
    }

    // 7. 배송지 정보 입력
    if (shippingAddress) {
      console.log("[napkin] 배송지 정보 입력 시작...");

      // 7-1. 받는사람 입력
      const receiverName = shippingAddress.name || shippingAddress.recipientName || "";
      if (receiverName) {
        console.log(`[napkin] 받는사람: ${receiverName}`);
        const nameInput = await page.$(SELECTORS.order.receiverName);
        if (nameInput) {
          await nameInput.click({ clickCount: 3 });
          await delay(100);
          await page.keyboard.type(receiverName, { delay: 50 });
          await delay(300);
        }
      }

      // 7-2. 주소 검색 버튼 클릭
      console.log("[napkin] 주소 검색 버튼 클릭...");
      const addressSearchBtn = await page.$(SELECTORS.order.addressSearchBtn);
      if (addressSearchBtn) {
        await page.evaluate(el => el.click(), addressSearchBtn);
        await delay(1500);

        // 7-3. 다음 주소 검색 iframe 찾기
        console.log("[napkin] 주소 검색 iframe 찾기...");
        let frame = null;
        for (let i = 0; i < 30; i++) {
          const allFrames = page.frames();
          for (const f of allFrames) {
            try {
              const hasInput = await f.$(SELECTORS.order.daumAddressInput);
              if (hasInput) {
                frame = f;
                console.log(`[napkin] 주소 검색 iframe 발견 (${i + 1}회)`);
                break;
              }
            } catch (e) {
              // 무시
            }
          }
          if (frame) break;
          await delay(500);
        }

        if (frame) {
          // 7-4. 주소 검색어 입력
          const searchAddress = shippingAddress.streetAddress1 || shippingAddress.address || "";
          if (searchAddress) {
            console.log(`[napkin] 주소 검색어: ${searchAddress}`);
            const addressInput = await frame.$(SELECTORS.order.daumAddressInput);
            if (addressInput) {
              await addressInput.click();
              await addressInput.type(searchAddress, { delay: 50 });
              await delay(300);

              // 검색 버튼 클릭 또는 Enter
              const searchBtn = await frame.$(SELECTORS.order.daumSearchButton);
              if (searchBtn) {
                await searchBtn.click();
              } else {
                await frame.keyboard.press("Enter");
              }
              await delay(1500);

              // 7-5. 검색 결과 첫 번째 항목 클릭
              console.log("[napkin] 주소 검색 결과 선택...");
              try {
                await frame.waitForSelector(SELECTORS.order.daumAddressItem, { timeout: 5000 });
                await delay(500);
                await frame.evaluate((selector) => {
                  const firstItem = document.querySelector(selector);
                  if (firstItem) {
                    const roadAddrBtn = firstItem.querySelector(".main_road .link_post");
                    if (roadAddrBtn) {
                      roadAddrBtn.click();
                    } else {
                      firstItem.click();
                    }
                  }
                }, SELECTORS.order.daumAddressItem);
                console.log("[napkin] 주소 선택 완료");
                await delay(1500);
              } catch (e) {
                console.log("[napkin] 주소 검색 결과 없음:", e.message);
              }
            }
          }
        } else {
          console.log("[napkin] 주소 검색 iframe 못찾음");
        }
      }

      // 7-6. 상세주소 입력
      const detailAddress = shippingAddress.streetAddress2 || shippingAddress.addressDetail || "";
      if (detailAddress) {
        console.log(`[napkin] 상세주소: ${detailAddress}`);
        await delay(500);
        const detailInput = await page.$(SELECTORS.order.addressDetail);
        if (detailInput) {
          await detailInput.click({ clickCount: 3 });
          await delay(100);
          await page.keyboard.type(detailAddress, { delay: 50 });
          await delay(300);
        }
      }

      // 7-7. 휴대폰 번호 입력
      const phone = shippingAddress.phone || shippingAddress.recipientPhone || "";
      if (phone) {
        // 숫자만 추출
        let phoneDigits = phone.replace(/[^0-9]/g, "");

        // 국가번호(82) 제거하고 0 추가 (예: 821012345678 → 01012345678)
        if (phoneDigits.startsWith("82")) {
          phoneDigits = "0" + phoneDigits.substring(2);
        }

        if (phoneDigits.length >= 10) {
          const first = phoneDigits.substring(0, 3);   // 010
          const middle = phoneDigits.substring(3, 7);  // XXXX
          const last = phoneDigits.substring(7, 11);   // XXXX

          console.log(`[napkin] 휴대폰: ${first}-${middle}-${last}`);

          // 앞자리 선택 (select)
          await page.select(SELECTORS.order.phoneFirst, first);
          await delay(200);

          // 가운데 4자리
          const middleInput = await page.$(SELECTORS.order.phoneMiddle);
          if (middleInput) {
            await middleInput.click({ clickCount: 3 });
            await delay(100);
            await page.keyboard.type(middle, { delay: 50 });
            await delay(200);
          }

          // 마지막 4자리
          const lastInput = await page.$(SELECTORS.order.phoneLast);
          if (lastInput) {
            await lastInput.click({ clickCount: 3 });
            await delay(100);
            await page.keyboard.type(last, { delay: 50 });
            await delay(200);
          }
        }
      }

      console.log("[napkin] 배송지 정보 입력 완료");
    }

    // 결제하기 버튼 클릭
    console.log("[napkin] 결제하기 버튼 클릭...");
    await delay(1000);

    const payBtn = await waitFor(page, SELECTORS.order.payBtn, 5000);
    if (payBtn) {
      await payBtn.click();
      console.log("[napkin] ✅ 결제하기 버튼 클릭 완료");
      await delay(3000);

      // 토스페이먼츠 iframe 대기 및 전환
      console.log("[napkin] 토스페이먼츠 결제창 대기...");
      const iframeSelector = 'iframe#_lguplus_popup__iframe';
      const iframeEl = await waitFor(page, iframeSelector, 60000);

      if (iframeEl) {
        const frame = await iframeEl.contentFrame();
        if (frame) {
          console.log("[napkin] 토스페이먼츠 iframe 진입");
          await delay(2000);

          // 비씨 카드 찾아서 클릭 (텍스트 기반)
          const bcCardClicked = await frame.evaluate(() => {
            const links = document.querySelectorAll('a[data-focus-item="true"]');
            for (const link of links) {
              const text = link.textContent || '';
              if (text.includes('비씨')) {
                link.click();
                return true;
              }
            }
            return false;
          });

          if (bcCardClicked) {
            console.log("[napkin] ✅ 비씨카드 선택 완료");
            await delay(3000);

            // 필수 동의 버튼 클릭 (최대 10초 대기하면서 재시도)
            console.log("[napkin] 필수 동의 버튼 찾는 중...");

            let agreeClicked = null;
            for (let retry = 0; retry < 10; retry++) {
              agreeClicked = await frame.evaluate(() => {
                // 방법 1: aria-label로 찾기
                const inputs = document.querySelectorAll('input[type="checkbox"]');
                for (const input of inputs) {
                  const ariaLabel = input.getAttribute('aria-label') || '';
                  if (ariaLabel.includes('필수')) {
                    input.click();
                    return 'aria-label';
                  }
                }

                // 방법 2: label 텍스트로 찾기
                const labels = document.querySelectorAll('label');
                for (const label of labels) {
                  const text = label.textContent || '';
                  if (text.includes('필수')) {
                    const input = label.querySelector('input[type="checkbox"]');
                    if (input) {
                      input.click();
                      return 'label-input';
                    }
                    const forId = label.getAttribute('for');
                    if (forId) {
                      const linkedInput = document.getElementById(forId);
                      if (linkedInput) {
                        linkedInput.click();
                        return 'label-for';
                      }
                    }
                    label.click();
                    return 'label-click';
                  }
                }

                return null;
              });

              if (agreeClicked) {
                console.log(`[napkin] ✅ 필수 동의 클릭 (방법: ${agreeClicked}, 시도: ${retry + 1})`);
                await delay(2000);
                break;
              }

              console.log(`[napkin] 필수 동의 버튼 대기 중... (${retry + 1}/10)`);
              await delay(1000);
            }

            if (!agreeClicked) {
              console.log("[napkin] ⚠️ 필수 동의 버튼을 찾지 못함 (10초 대기 후)");
            }

            // 다음 버튼 클릭 전 현재 페이지 목록 저장
            const browser = page.browser();
            const pagesBeforeNext = await browser.pages();
            const pagesBeforeNextSet = new Set(pagesBeforeNext);
            console.log("[napkin] 현재 페이지 수:", pagesBeforeNext.length);

            // 새 페이지 생성 시 즉시 dialog 핸들러 등록 (alert 놓치지 않도록)
            let paymentPopup = null;
            const paymentDialogHandler = async (dialog) => {
              console.log("[napkin] 결제창 Dialog:", dialog.type(), dialog.message());
              await dialog.accept();
            };
            const targetCreatedHandler = async (target) => {
              if (target.type() === "page") {
                const newPage = await target.page();
                if (newPage && !pagesBeforeNextSet.has(newPage)) {
                  const url = newPage.url();
                  if (!url.startsWith("devtools://")) {
                    console.log("[napkin] 새 결제창 감지:", url);
                    paymentPopup = newPage;
                    newPage.on("dialog", paymentDialogHandler);
                  }
                }
              }
            };
            browser.on("targetcreated", targetCreatedHandler);

            // 다음 버튼 클릭 (최대 10초 대기하면서 재시도)
            console.log("[napkin] 다음 버튼 찾는 중...");

            let nextClicked = null;
            for (let retry = 0; retry < 10; retry++) {
              nextClicked = await frame.evaluate(() => {
                // 방법 1: 버튼 텍스트로 찾기
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                  const text = (btn.textContent || '').trim();
                  if (text === '다음' || text.includes('다음')) {
                    btn.click();
                    return 'text-다음';
                  }
                }

                // 방법 2: submit 타입 버튼
                const submitBtns = document.querySelectorAll('button[type="submit"]');
                for (const btn of submitBtns) {
                  btn.click();
                  return 'submit';
                }

                return null;
              });

              if (nextClicked) {
                console.log(`[napkin] ✅ 다음 버튼 클릭 (방법: ${nextClicked}, 시도: ${retry + 1})`);
                await delay(3000);
                break;
              }

              console.log(`[napkin] 다음 버튼 대기 중... (${retry + 1}/10)`);
              await delay(1000);
            }

            if (nextClicked) {
              // 두 번째 다음 버튼 클릭 (최대 10초 대기하면서 재시도)
              console.log("[napkin] 두 번째 다음 버튼 찾는 중...");

              let nextClicked2 = null;
              for (let retry = 0; retry < 10; retry++) {
                nextClicked2 = await frame.evaluate(() => {
                  const buttons = document.querySelectorAll('button');
                  for (const btn of buttons) {
                    const text = (btn.textContent || '').trim();
                    if (text === '다음' || text.includes('다음')) {
                      btn.click();
                      return 'text-다음';
                    }
                  }
                  const submitBtns = document.querySelectorAll('button[type="submit"]');
                  for (const btn of submitBtns) {
                    btn.click();
                    return 'submit';
                  }
                  return null;
                });

                if (nextClicked2) {
                  console.log(`[napkin] ✅ 두 번째 다음 버튼 클릭 (방법: ${nextClicked2}, 시도: ${retry + 1})`);
                  await delay(3000);
                  break;
                }

                console.log(`[napkin] 두 번째 다음 버튼 대기 중... (${retry + 1}/10)`);
                await delay(1000);
              }

              // BC카드 결제창 (새 창) 찾기 (이미 targetcreated에서 잡았을 수 있음)
              console.log("[napkin] BC카드 결제창 대기...");

              // 최대 60초 대기 (3초마다 체크)
              if (!paymentPopup) {
                for (let i = 0; i < 20; i++) {
                  const pagesAfterNext = await browser.pages();
                  for (const p of pagesAfterNext) {
                    // 이전에 없던 페이지 찾기
                    if (!pagesBeforeNextSet.has(p)) {
                      const url = p.url();
                      // DevTools 제외
                      if (url.startsWith("devtools://")) continue;
                      paymentPopup = p;
                      console.log("[napkin] BC카드 결제창 발견:", url);
                      paymentPopup.on("dialog", paymentDialogHandler);
                      break;
                    }
                  }
                  if (paymentPopup) break;
                  console.log(`[napkin] BC카드 결제창 대기 중... (${(i + 1) * 3}/60초)`);
                  await delay(3000);
                }
              }

              if (paymentPopup) {
                // 결제창 로드 대기
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
                  console.log("[napkin] 인증서 등록/결제 버튼 클릭...");
                  const certPaymentBtn = "#inapppay-dap2 > div.block1 > div.left > a.pay-item-s.pay-ctf";

                  try {
                    await paymentPopup.waitForSelector(certPaymentBtn, { timeout: 60000 });
                    await paymentPopup.click(certPaymentBtn);
                    console.log("[napkin] ✅ 인증서 등록/결제 버튼 클릭 완료");
                    await delay(3000);

                    // ISP/페이북 네이티브 윈도우 자동화
                    const ispPassword = vendor.ispPassword || getEnv("BC_ISP_PASSWORD") || "";
                    if (ispPassword) {
                      console.log("[napkin] ISP 네이티브 결제창 자동화 시작...");
                      const ispResult = await automateISPPayment(ispPassword);
                      if (ispResult.success) {
                        console.log("[napkin] ✅ ISP 결제 자동화 완료");
                      } else {
                        console.log("[napkin] ⚠️ ISP 결제 자동화 실패:", ispResult.error);
                        console.log("[napkin] 수동 결제가 필요합니다.");
                      }
                    } else {
                      console.log("[napkin] ⚠️ ISP 비밀번호 미설정 - 수동 결제 필요");
                    }
                  } catch (certError) {
                    console.log("[napkin] ⚠️ 인증서 등록/결제 버튼 클릭 실패:", certError.message);
                  }
                } catch (e) {
                  console.log("[napkin] ⚠️ 기타결제 버튼 클릭 실패:", e.message);
                }
              } else {
                console.log("[napkin] ⚠️ BC카드 결제창 팝업을 찾을 수 없음");
              }

              // targetcreated 핸들러 제거
              browser.off("targetcreated", targetCreatedHandler);
            }
          } else {
            console.log("[napkin] ⚠️ 비씨카드를 찾을 수 없음");
          }
        }
      } else {
        console.log("[napkin] ⚠️ 토스페이먼츠 iframe을 찾을 수 없음");
      }
    } else {
      console.log("[napkin] ⚠️ 결제하기 버튼을 찾을 수 없음");
    }

    // 결제 완료 대기 (ISP 결제 완료까지 충분히 대기)
    await delay(10000);

    // 주문번호 추출
    let vendorOrderNumber = null;
    const orderNumberSelector = "#mCafe24Order > div.resultArea > div > div > table > tbody > tr:nth-child(1) > td > span";

    try {
      await page.waitForSelector(orderNumberSelector, { timeout: 60000 });
      vendorOrderNumber = await page.$eval(orderNumberSelector, (el) => el.textContent.trim());
      console.log("[napkin] ✅ 주문번호:", vendorOrderNumber);
    } catch (orderNumError) {
      console.log("[napkin] ⚠️ 주문번호 추출 실패:", orderNumError.message);
    }

    // 현재 URL 반환
    const currentUrl = page.url();

    // 가격 불일치 상세 데이터 (시스템 저장용)
    const priceMismatchList = results.filter(r => r.priceInfo?.priceMismatch);
    const priceMismatches = priceMismatchList.map(r => ({
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
      differencePercent: r.priceInfo?.expectedUnitPrice > 0
        ? ((r.priceInfo?.difference / r.priceInfo?.expectedUnitPrice) * 100).toFixed(2)
        : 0,
    }));

    // 옵션 실패 상품 필터링
    const optionFailedProducts = results
      .filter(r => !r.success && r.message?.includes('옵션'))
      .map(r => ({
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
      products: products.map((p, i) => ({
        orderLineIds: p.orderLineIds,
        openMallOrderNumber: vendorOrderNumber || null,
      })),
      priceMismatches: priceMismatches?.map(p => ({
        productVariantVendorId: p.productVariantVendorId,
        purchaseOrderId: p.purchaseOrderId, // 개별 상품의 발주 ID
        vendorPriceExcludeVat: p.vendorPriceExcludeVat,
        openMallPrice: p.openMallPrice,
      })) || [],
      optionFailedProducts: [],
      automationErrors: [],
      lineIds,
      success: true,
    });

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
      products: products.map((p, i) => ({
        orderLineId: p.orderLineId || lineIds[i],
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
      automationErrors: errorCollector.hasErrors() ? errorCollector.getErrors() : [],
      lineIds,
      success: false,
    });
    return res.json({
      success: false,
      vendor: vendor.name,
      message: `주문 처리 에러: ${error.message}`,
      automationErrors: errorCollector.hasErrors() ? errorCollector.getErrors() : undefined,
    });
  }
}

module.exports = {
  processNapkinOrder,
  loginToNapkin,
};
