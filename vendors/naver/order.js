/**
 * 네이버 스마트스토어 주문 모듈
 *
 * 흐름:
 * 1. 상품 페이지 이동
 * 2. 옵션 선택 (openMallOptions)
 * 3. 수량 설정
 * 4. 장바구니 담기
 * 5. 주문/결제 (네이버페이)
 */

const { login } = require("./login");

// 딜레이 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 셀렉터 상수
const SELECTORS = {
  // 상품 페이지
  product: {
    // 옵션 선택
    optionSelect: "select._combination_option",
    optionSelectByIndex: (i) =>
      `select._combination_option:nth-of-type(${i + 1})`,
    optionItem: (value) => `option[value*="${value}"]`,
    // 수량
    quantityInput: "input._quantity",
    quantityPlus: "a._plus",
    quantityMinus: "a._minus",
    // 버튼
    buyNowBtn: "a._naver_pay_btn, button._naver_pay_btn, a.npay_btn_pay",
    addToCartBtn: "a._basket, button._basket, a.npay_btn_cart",
    // 가격
    totalPrice: "strong._total_price, span._total_price",
  },
  // 장바구니
  cart: {
    url: "https://order.pay.naver.com/basket",
    selectAll: "input._all_check",
    orderBtn: "a._order_button, button._order_button",
    itemCheckbox: "input._item_check",
  },
  // 주문서
  order: {
    // 배송지
    addressChange: "a._address_change, button._address_change",
    newAddress: "a._new_address, button._new_address",
    receiverName: "input[name='receiverName']",
    receiverPhone: "input[name='receiverPhone'], input[name='receiverTel']",
    zipcode: "input[name='zipcode']",
    address: "input[name='address']",
    addressDetail: "input[name='addressDetail']",
    // 결제
    payBtn: "button._pay_button, a._pay_button, button.btn_payment",
    agreeAll: "input._all_agree, input[name='agreeAll']",
  },
};

/**
 * 옵션 선택
 * @param {Page} page
 * @param {Array} openMallOptions - [{ title: "상품선택", value: "EH-158파이 소 400세트" }, ...]
 */
async function selectOptions(page, openMallOptions) {
  if (!openMallOptions || openMallOptions.length === 0) {
    console.log("[naver] 옵션 없음, 스킵");
    return true;
  }

  // 문자열이면 JSON 파싱
  let options = openMallOptions;
  if (typeof openMallOptions === "string") {
    try {
      options = JSON.parse(openMallOptions);
      console.log("[naver] 옵션 JSON 파싱 완료");
    } catch (e) {
      throw new Error(`[naver] 옵션 JSON 파싱 실패: ${e.message}`);
    }
  }

  // 첫 번째 옵션 유효성 검사
  const firstOption = options[0];
  if (!firstOption || !firstOption.title || !firstOption.value) {
    throw new Error(`[naver] 옵션 데이터 오류: ${JSON.stringify(firstOption)}`);
  }

  console.log("[naver] 옵션 선택 시작:", options.length, "개");

  for (let i = 0; i < options.length; i++) {
    const option = options[i];

    // 각 옵션 유효성 검사
    if (!option || !option.title || !option.value) {
      throw new Error(
        `[naver] 옵션 ${i + 1} 데이터 오류: ${JSON.stringify(option)}`
      );
    }

    console.log(`[naver] 옵션 ${i + 1}: ${option.title} = ${option.value}`);
    await delay(500);

    // 네이버 스마트스토어 옵션 버튼 찾기 (data-shp-contents-type 속성으로 매칭)
    const optionBtn = await page.$(
      `a._yGBCMWCWu[data-shp-contents-type="${option.title}"]`
    );

    if (optionBtn) {
      // 옵션 드롭다운 버튼 클릭
      await optionBtn.click();
      console.log(`[naver] 옵션 드롭다운 열기: ${option.title}`);
      await delay(1000);

      // 드롭다운에서 옵션 값 선택 (li 항목 중 텍스트 매칭)
      const selected = await page.evaluate((targetValue) => {
        const items = document.querySelectorAll(
          "ul[role='listbox'] li a, div[role='listbox'] li a, .option_list li a"
        );
        for (const item of items) {
          const rawText = item.textContent?.trim() || "";
          // 가격 부분 제거: "무지긴팔 (-3,500원)" → "무지긴팔"
          const text = rawText.replace(/\s*\([+-]?[\d,]+원\)\s*$/, "").trim();
          if (
            text === targetValue ||
            text.includes(targetValue) ||
            targetValue.includes(text)
          ) {
            item.click();
            return rawText;
          }
        }
        return null;
      }, option.value);

      if (selected) {
        console.log(`[naver] 옵션 선택됨: ${selected}`);
        await delay(1000);
      } else {
        console.log(`[naver] 옵션 값 매칭 실패: ${option.value}`);
      }
    } else {
      console.log(`[naver] 옵션 버튼 없음: ${option.title}`);
    }
  }

  return true;
}

/**
 * 수량 설정
 */
async function setQuantity(page, quantity) {
  if (quantity <= 1) return true;

  console.log(`[naver] 수량 설정: ${quantity}개`);

  // 수량 입력 필드 찾기 (옵션 리스트 첫 번째 항목)
  const quantityInput = await page.$(
    "ul.i_LQY8Lde9 > li:first-child input[type='number']"
  );

  if (quantityInput) {
    await quantityInput.click({ clickCount: 3 });
    await quantityInput.type(String(quantity));
    console.log("[naver] 수량 입력 완료");
    await delay(500);
    return true;
  }

  // 플러스 버튼으로 수량 증가
  const plusBtn = await page.$("a._plus, button._plus, button.plus");
  if (plusBtn) {
    for (let i = 1; i < quantity; i++) {
      await plusBtn.click();
      await delay(200);
    }
    console.log(`[naver] 수량 증가 버튼 클릭 ${quantity - 1}회`);
    return true;
  }

  console.log("[naver] 수량 설정 실패, 기본 수량 사용");
  return false;
}

/**
 * 장바구니 비우기
 */
async function clearCart(page) {
  console.log("[naver] 장바구니 비우기...");

  // 장바구니 페이지로 이동
  await page.goto("https://shopping.naver.com/cart", {
    waitUntil: "networkidle2",
    timeout: 30000,
  });
  await delay(2000);

  // dialog 핸들러 (confirm, alert 처리)
  page.on("dialog", async (dialog) => {
    console.log(`[naver] Dialog: ${dialog.type()} - ${dialog.message()}`);
    await dialog.accept();
  });

  // 선택 삭제 버튼 찾기
  const deleteBtn = await page.$(
    "#app > div > div.check_all--mLXOEtPdIW > div > div > button"
  );

  if (deleteBtn) {
    await deleteBtn.click();
    console.log("[naver] 선택 삭제 버튼 클릭");
    await delay(3000); // confirm → alert 처리 대기
    console.log("[naver] 장바구니 비우기 완료");
  } else {
    console.log("[naver] 장바구니가 비어있음 (삭제 버튼 없음)");
  }

  return true;
}

/**
 * 장바구니에 상품 담기
 */
async function addToCart(page) {
  console.log("[naver] 장바구니 담기...");

  // 장바구니 버튼 클릭
  const cartBtnSelector =
    "#content > div > div.Cpf2P_YsRS > div.RUSA6W3qmn > fieldset > div.J7P_iH8gvp > div:nth-child(2) > div.gvKCxawvOj.KlIstkZ0Ff.sys_chk_cart > a";

  const cartBtn = await page.$(cartBtnSelector);
  if (cartBtn) {
    await cartBtn.click();
    console.log("[naver] 장바구니 버튼 클릭");
    await delay(2000);

    // 모달에서 바로가기 버튼 클릭
    const goCartBtnSelector = "#MODAL_ROOT_ID > div > div > div.DlzoyvIyhw > a";
    const goCartBtn = await page.$(goCartBtnSelector);
    if (goCartBtn) {
      await goCartBtn.click();
      console.log("[naver] 장바구니 바로가기 클릭");
      await delay(2000);
      return true;
    } else {
      console.log("[naver] 바로가기 버튼 없음");
      return true; // 장바구니 버튼은 클릭됨
    }
  }

  console.log("[naver] 장바구니 버튼 없음");
  return false;
}

/**
 * 상품 페이지에서 상품 담기
 */
async function processProduct(page, product) {
  const { productUrl, productName, quantity, openMallOptions } = product;

  console.log(`\n[naver] 상품 처리: ${productName || productUrl}`);
  console.log(`[naver] URL: ${productUrl}`);
  console.log(`[naver] 수량: ${quantity}`);
  if (openMallOptions) {
    console.log(`[naver] 옵션:`, JSON.stringify(openMallOptions));
  }

  // 1. 상품 페이지로 이동
  await page.goto(productUrl, {
    waitUntil: "networkidle2",
    timeout: 30000,
  });
  await delay(2000);

  // 2. 옵션 선택
  if (openMallOptions && openMallOptions.length > 0) {
    await selectOptions(page, openMallOptions);
    await delay(1000);
  }

  // 3. 수량 설정
  await setQuantity(page, quantity || 1);
  await delay(500);

  // 4. 장바구니에 담기
  const addedToCart = await addToCart(page);

  // TODO: 테스트 완료 후 아래 주석 해제
  // 장바구니 담기까지만 테스트 - 여기서 멈춤
  console.log("[naver] 장바구니 담기 완료 - 테스트 중지점");
  return {
    success: addedToCart,
    productName,
    quantity,
    step: "cart_added",
  };
}

/**
 * 네이버 스마트스토어 주문 처리
 */
async function processNaverOrder(
  res,
  page,
  vendor,
  { products, shippingAddress, lineIds, purchaseOrderId }
) {
  const steps = [];
  const addedProducts = [];

  try {
    console.log("[naver] 주문 처리 시작...");
    console.log("[naver] 상품 수:", products.length);

    // 1. 로그인 확인
    await login(page, vendor);
    steps.push({ step: "login", success: true });

    // 2. 장바구니 비우기
    await clearCart(page);
    steps.push({ step: "clear_cart", success: true });

    // 3. 각 상품 처리 (장바구니에 담기)
    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      console.log(`\n[naver] === 상품 ${i + 1}/${products.length} ===`);

      try {
        const result = await processProduct(page, product);
        addedProducts.push({
          ...product,
          addedToCart: result.success,
        });
        steps.push({
          step: `product_${i + 1}`,
          productName: product.productName,
          success: result.success,
        });
      } catch (error) {
        console.error(`[naver] 상품 처리 실패:`, error.message);
        steps.push({
          step: `product_${i + 1}`,
          productName: product.productName,
          success: false,
          error: error.message,
        });
      }
    }

    // TODO: 테스트 완료 후 아래 주석 해제
    // 옵션 선택까지만 테스트 - 여기서 멈춤
    console.log("[naver] 상품 처리 완료 - 테스트 중지점");
    return res.json({
      success: true,
      message: "옵션 선택까지 완료 (테스트 모드)",
      steps,
      addedProducts,
      purchaseOrderId,
    });

    // // 3. 장바구니로 이동
    // console.log("\n[naver] 장바구니 확인...");
    // await page.goto("https://order.pay.naver.com/basket", {
    //   waitUntil: "networkidle2",
    //   timeout: 30000,
    // });
    // await delay(2000);
    // steps.push({ step: "cart", success: true });

    // // 4. 배송지가 없으면 여기서 중단 (장바구니만 담기)
    if (!shippingAddress) {
      console.log("[naver] 배송지 없음 - 장바구니만 담기 완료");
      return res.json({
        success: true,
        orderNumber: null,
        message: "장바구니 담기 완료 (배송지 없음)",
        steps,
        addedProducts,
        purchaseOrderId,
      });
    }

    // TODO: 결제 처리 (네이버페이)
    // 네이버페이는 복잡한 인증 과정이 있어서 일단 장바구니까지만 자동화
    console.log("[naver] 결제는 수동 처리 필요");

    return res.json({
      success: true,
      orderNumber: null,
      message: "장바구니 담기 완료 - 결제는 수동 처리 필요",
      steps,
      addedProducts,
      purchaseOrderId,
      cartUrl: "https://order.pay.naver.com/basket",
      shippingAddress,
      paymentMethod: "naver_pay",
    });
  } catch (error) {
    console.error("[naver] 주문 처리 실패:", error);
    return res.json({
      success: false,
      error: error.message,
      steps,
      addedProducts,
      purchaseOrderId,
    });
  }
}

module.exports = {
  processNaverOrder,
  selectOptions,
  setQuantity,
  addToCart,
  processProduct,
  SELECTORS,
};
