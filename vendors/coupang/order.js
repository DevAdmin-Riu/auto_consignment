/**
 * 쿠팡 주문 처리 모듈
 *
 * 처리 방식: 배치 (여러 상품 장바구니 → 일괄 결제)
 *
 * 흐름:
 * 1. 로그인
 * 2. 장바구니 비우기
 * 3. 각 상품별:
 *    - 상품 페이지 이동
 *    - 옵션 선택 (openMallOptions - 2D 구조 지원)
 *    - 수량 설정 (openMallQtyPerUnit 적용)
 *    - 장바구니 담기
 * 4. 장바구니 수량 검증
 * 5. 모든 상품 담은 후 → 주문/결제
 * 6. saveOrderResults 호출
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
 * - 장바구니 수량 검증 후 불일치 시 재시도
 * - OCR로 주문번호 추출
 */

const { delay, getLoginStatus, setLoginStatus } = require("../../lib/browser");
const { coupangLogin } = require("./login");
const {
  createOrderErrorCollector,
  ORDER_STEPS,
  ERROR_CODES,
} = require("../../lib/automation-error");
const { saveOrderResults } = require("../../lib/graphql-client");
const Tesseract = require("tesseract.js");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

/**
 * 쿠팡 주문 처리 메인 함수
 */
async function processCoupangOrder(
  res,
  page,
  vendor,
  { products, shippingAddress, poLineIds, purchaseOrderId },
  authToken
) {
  const steps = [];
  const addedProducts = []; // 장바구니에 담긴 상품들 추적
  const errorCollector = createOrderErrorCollector("coupang");

  // 1. 로그인
  if (!getLoginStatus("coupang")) {
    console.log("Step 1: 쿠팡 로그인...");
    await coupangLogin(page);
    setLoginStatus("coupang", true);
    steps.push({ step: "login", success: true });
  } else {
    steps.push({ step: "login", success: true, skipped: true });
  }

  // 1.5. 장바구니 비우기 (깨끗한 상태에서 시작)
  console.log("Step 1.5: 장바구니 비우기...");
  try {
    const clearResult = await clearCart(page);
    console.log("장바구니 비우기 결과:", JSON.stringify(clearResult));
    steps.push({
      step: "clear_cart",
      success: clearResult.success,
      detail: clearResult,
    });
  } catch (e) {
    console.log("장바구니 비우기 실패:", e.message);
    steps.push({ step: "clear_cart", success: false, error: e.message });
  }

  // 장바구니 담기 재시도 루프 (수량 불일치 시 재시도)
  let cartRetryCount = 0;
  const maxCartRetries = 2;
  let cartVerified = false;

  while (cartRetryCount <= maxCartRetries && !cartVerified) {
    if (cartRetryCount > 0) {
      console.log(`\n⚠️ 장바구니 재시도 ${cartRetryCount}/${maxCartRetries}회`);
      // 재시도 시 addedProducts 초기화
      addedProducts.length = 0;
    }

    // 2. 각 상품을 장바구니에 담기 (여러 상품 지원)
    console.log(
      `\n========== 총 ${products.length}개 상품을 장바구니에 담기 시작 ==========`
    );

    for (let productIndex = 0; productIndex < products.length; productIndex++) {
      const product = products[productIndex];
      const productUrl = product.productUrl;
      // openMallQtyPerUnit 적용: 우리 1개 → 오픈몰 N개
      const baseQuantity = product.quantity || 1;
      const qtyPerUnit = product.openMallQtyPerUnit || 1;
      const quantity = baseQuantity * qtyPerUnit;
      if (qtyPerUnit > 1) {
        console.log(`[coupang] 수량 변환: ${baseQuantity}개 × ${qtyPerUnit} = ${quantity}개`);
      }
      const productName = product.productName;

      console.log(
        `\n----- [${productIndex + 1}/${products.length}] 상품 처리: ${
          productName || productUrl
        } -----`
      );

      if (!productUrl) {
        console.log(`상품 ${productIndex + 1}: URL 없음, 스킵`);
        steps.push({
          step: `product_${productIndex + 1}_skip`,
          success: false,
          error: "URL 없음",
        });
        errorCollector.addError(ORDER_STEPS.ADD_TO_CART, ERROR_CODES.PRODUCT_NOT_FOUND, "URL 없음", {
          purchaseOrderId,
          purchaseOrderLineId: poLineIds?.[productIndex],
          productVariantVendorId: product.productVariantVendorId,
        });
        continue;
      }

      // 2-1. 상품 페이지 이동
      console.log(`상품 ${productIndex + 1}: 페이지 이동...`, productUrl);
      try {
        await page.goto(productUrl, {
          waitUntil: "networkidle2",
          timeout: 30000,
        });
        await delay(2000);

        // 상품명 추출
        let extractedName = "";
        try {
          const titleElem = await page.$(
            "h1.prod-buy-header__title, h2.prod-buy-header__title, .prod-buy-header__title"
          );
          if (titleElem) {
            extractedName = await page.evaluate(
              (el) => el.textContent,
              titleElem
            );
          }
        } catch (e) {}

        steps.push({
          step: `product_${productIndex + 1}_navigate`,
          success: true,
          productName: extractedName?.trim() || productName,
        });

        // 2-2. 수량 설정
        if (quantity > 1) {
          console.log(`상품 ${productIndex + 1}: 수량 설정...`, quantity);
          let qtySet = false;

          // 방법 1: "수량더하기" 버튼 클릭 (가장 안정적)
          try {
            for (let i = 1; i < Math.min(quantity, 50); i++) {
              const clicked = await page.evaluate(() => {
                const containers = document.querySelectorAll(
                  ".product-quantity > div"
                );
                for (const container of containers) {
                  if (container.offsetParent === null) {
                    continue;
                  }
                  const btns = container.querySelectorAll("button");
                  for (const btn of btns) {
                    if (
                      btn.textContent.includes("수량더하기") &&
                      !btn.disabled
                    ) {
                      btn.click();
                      return true;
                    }
                  }
                }
                return false;
              });
              if (clicked) {
                await delay(200);
                qtySet = true;
              } else {
                console.log(`수량 버튼 클릭 실패 (${i}/${quantity - 1})`);
                break;
              }
            }
          } catch (e) {
            console.log("수량 설정 방법 1 실패:", e.message);
          }

          // 방법 2: input 값 직접 변경 + Enter키 (fallback)
          if (!qtySet) {
            try {
              const input = await page.$(
                '.product-quantity input[type="text"]'
              );
              if (input) {
                await input.click({ clickCount: 3 });
                await delay(200);
                await page.keyboard.press("Backspace");
                await page.keyboard.type(String(quantity), { delay: 50 });
                await page.keyboard.press("Enter");
                await delay(500);
                qtySet = true;
              }
            } catch (e) {
              console.log("수량 설정 방법 2 실패:", e.message);
            }
          }

          await delay(1000);
          steps.push({
            step: `product_${productIndex + 1}_quantity`,
            success: qtySet,
            quantity,
          });
        }

        // 2-3. 장바구니 담기
        console.log(`상품 ${productIndex + 1}: 장바구니 담기...`);
        const cartBtn = await page.$("button.prod-cart-btn");
        if (cartBtn) {
          await cartBtn.click();
          await delay(1500);
          steps.push({
            step: `product_${productIndex + 1}_cart`,
            success: true,
          });

          // vendorItemId 추출하여 저장 (나중에 장바구니에서 선택할 때 사용)
          const vendorItemIdMatch = productUrl.match(/vendorItemId=(\d+)/);
          addedProducts.push({
            productUrl,
            productName: extractedName?.trim() || productName,
            quantity,
            vendorItemId: vendorItemIdMatch ? vendorItemIdMatch[1] : null,
          });
        } else {
          steps.push({
            step: `product_${productIndex + 1}_cart`,
            success: false,
            error: "버튼을 찾을 수 없음",
          });
          errorCollector.addError(ORDER_STEPS.ADD_TO_CART, ERROR_CODES.ELEMENT_NOT_FOUND, "장바구니 버튼을 찾을 수 없음", {
            purchaseOrderId,
            purchaseOrderLineId: poLineIds?.[productIndex],
            productVariantVendorId: product.productVariantVendorId,
          });
        }
      } catch (e) {
        console.log(`상품 ${productIndex + 1} 처리 실패:`, e.message);
        steps.push({
          step: `product_${productIndex + 1}_error`,
          success: false,
          error: e.message,
        });
        errorCollector.addError(ORDER_STEPS.ADD_TO_CART, null, e.message, {
          purchaseOrderId,
          purchaseOrderLineId: poLineIds?.[productIndex],
          productVariantVendorId: product.productVariantVendorId,
        });
      }
    }

    console.log(
      `\n========== 장바구니 담기 완료: ${addedProducts.length}/${products.length}개 성공 ==========\n`
    );

    // 3. 장바구니 페이지로 이동
    console.log("Step 3: 장바구니 페이지로 이동...");
    await page.goto("https://cart.coupang.com/cartView.pang", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await delay(1000);
    steps.push({ step: "cart_page", success: true });

    // 4. 전체 선택 해제 후 방금 담은 상품들만 선택
    console.log("Step 4: 담은 상품들만 선택...");
    try {
      // 전체 선택 체크박스 해제 (이미 선택되어 있으면)
      const allChecked = await page.evaluate(() => {
        const allCheckbox = document.querySelector(
          'input[name="allCheckbox"], input.all-checkbox, #allCheckbox'
        );
        if (allCheckbox && allCheckbox.checked) {
          allCheckbox.click();
          return true;
        }
        return false;
      });
      if (allChecked) {
        await delay(1000);
        console.log("전체 선택 해제됨");
      }

      // 방금 담은 상품들 선택 (vendorItemId로 매칭)
      const vendorItemIds = addedProducts
        .filter((p) => p.vendorItemId)
        .map((p) => p.vendorItemId);

      console.log(`선택할 vendorItemIds: ${vendorItemIds.join(", ")}`);

      const selectedCount = await page.evaluate((vendorItemIds) => {
        let count = 0;
        const items = document.querySelectorAll('div[id^="item_"]');

        for (const item of items) {
          const link = item.querySelector('a[href*="coupang.com/vp/products"]');
          const checkbox = item.querySelector('input[type="checkbox"]');

          if (link && checkbox) {
            const href = link.getAttribute("href") || "";
            // vendorItemId들 중 하나와 매칭되면 선택
            for (const vendorItemId of vendorItemIds) {
              if (href.includes(vendorItemId)) {
                if (!checkbox.checked) {
                  checkbox.click();
                }
                count++;
                break;
              }
            }
          }
        }

        return count;
      }, vendorItemIds);

      console.log(`${selectedCount}개 상품 선택됨`);
      steps.push({
        step: "select_items",
        success: selectedCount > 0,
        selectedCount,
      });
      await delay(1000);
    } catch (e) {
      console.log("상품 선택 실패:", e.message);
      steps.push({ step: "select_items", success: false, error: e.message });
    }

    // 4.5 장바구니 검증 - 선택된 상품이 주문할 상품과 일치하는지 확인
    console.log("Step 4.5: 장바구니 검증...");
    try {
      const cartVerification = await verifyCartItems(page, addedProducts);
      console.log(
        "장바구니 검증 결과:",
        JSON.stringify(cartVerification, null, 2)
      );

      steps.push({
        step: "cart_verification",
        success: cartVerification.isValid,
        detail: cartVerification,
      });

      // 수량 불일치가 있으면 장바구니 비우고 재시도
      if (
        cartVerification.quantityMismatches &&
        cartVerification.quantityMismatches.length > 0
      ) {
        console.log("⚠️ 수량 불일치 발견! 장바구니 비우고 재시도");
        await clearCart(page);
        cartRetryCount++;
        continue; // while 루프 재시도
      }

      // 불필요한 상품이 선택되어 있으면 장바구니 비우고 재시도
      if (
        cartVerification.unexpectedItems &&
        cartVerification.unexpectedItems.length > 0
      ) {
        console.log("⚠️ 예상치 못한 상품 발견! 장바구니 비우고 재시도");
        await clearCart(page);
        cartRetryCount++;
        continue; // while 루프 재시도
      }

      // 검증 성공
      cartVerified = true;
    } catch (e) {
      console.log("장바구니 검증 실패:", e.message);
      steps.push({
        step: "cart_verification",
        success: false,
        error: e.message,
      });
      cartVerified = true; // 검증 실패해도 진행
    }
  } // while 루프 끝

  // 재시도 횟수 초과 시 에러 반환
  if (!cartVerified) {
    const errorMessage = `장바구니 검증 실패 - ${maxCartRetries}회 재시도 후에도 실패`;
    errorCollector.addError(ORDER_STEPS.ADD_TO_CART, null, errorMessage, { purchaseOrderId });
    await saveOrderResults(authToken, {
      purchaseOrderId,
      products: addedProducts || [],
      priceMismatches: [],
      optionFailedProducts: [],
      automationErrors: errorCollector.getErrors(),
      poLineIds,
      success: false,
        vendor: "coupang",
    });
    return res.json({
      success: false,
      vendor: vendor.name,
      error: errorMessage,
      steps,
      automationErrors: errorCollector.getErrors(),
    });
  }

  // 5. 주문하기 버튼 클릭
  console.log("Step 5: 주문하기 버튼 클릭...");
  try {
    const orderClicked = await page.evaluate(() => {
      const btn = document.querySelector("#btnPay");
      if (btn && btn.offsetParent !== null) {
        btn.click();
        return { success: true, selector: "#btnPay" };
      }
      return { success: false, error: "#btnPay 버튼을 찾을 수 없음" };
    });

    console.log("주문하기 버튼 결과:", JSON.stringify(orderClicked));

    if (orderClicked.success) {
      await delay(1500);
      steps.push({
        step: "checkout_click",
        success: true,
        detail: orderClicked,
      });
    } else {
      steps.push({
        step: "checkout_click",
        success: false,
        error: "주문하기 버튼을 찾을 수 없음",
        buttons: orderClicked.buttons,
      });
    }
  } catch (e) {
    console.log("주문하기 버튼 클릭 오류:", e.message);
    steps.push({ step: "checkout_click", success: false, error: e.message });
  }

  // 6. 배송지 정보 처리
  if (shippingAddress) {
    console.log("Step 6: 배송지 변경 버튼 클릭...");
    try {
      const changeResult = await clickChangeAddressButton(page);
      console.log("배송지 변경 버튼 결과:", JSON.stringify(changeResult));

      if (changeResult.success) {
        steps.push({
          step: "shipping_change_button",
          success: true,
          detail: changeResult,
        });

        // 배송지 목록에서 수정 버튼 클릭
        console.log("Step 6-1: 배송지 목록에서 수정 버튼 클릭...");
        await delay(1500); // 모달 로딩 대기

        const editResult = await clickEditAddressInList(page);
        console.log("배송지 수정 버튼 결과:", JSON.stringify(editResult));

        if (editResult.success) {
          const isAddNew = editResult.action === "add_new";
          const stepName = isAddNew
            ? "shipping_add_button"
            : "shipping_edit_button";
          const message = isAddNew
            ? "새 배송지 추가 폼 열림"
            : "배송지 수정 폼 열림";

          console.log(`[배송지] ${message} (action: ${editResult.action})`);

          steps.push({
            step: stepName,
            success: true,
            detail: editResult,
          });

          // Step 6-2: 배송지 폼에 데이터 입력
          console.log("Step 6-2: 배송지 폼에 데이터 입력...");
          await delay(1000); // 폼 로딩 대기

          const fillResult = await fillAddressForm(page, shippingAddress);
          console.log(
            "배송지 폼 입력 결과:",
            JSON.stringify(fillResult, null, 2)
          );

          steps.push({
            step: "shipping_fill_form",
            success: fillResult.success,
            detail: fillResult,
          });

          if (!fillResult.success) {
            // 배송지 폼 입력 실패 - 여기서 멈춤
            errorCollector.addError(ORDER_STEPS.ORDER_PLACEMENT, ERROR_CODES.INPUT_FAILED, "배송지 폼 입력 실패", { purchaseOrderId });
            await saveOrderResults(authToken, {
              purchaseOrderId,
              products: addedProducts || [],
              priceMismatches: [],
              optionFailedProducts: [],
              automationErrors: errorCollector.getErrors(),
              poLineIds,
              success: false,
        vendor: "coupang",
            });
            return res.json({
              success: false,
              vendor: vendor.name,
              message: "배송지 폼 입력 실패",
              action: editResult.action,
              addressCount: editResult.count,
              fillResult,
              steps,
              automationErrors: errorCollector.getErrors(),
            });
          }
          // 배송지 입력 성공 - 결제 단계로 진행
          console.log("[배송지] 배송지 입력 완료, 결제 단계로 진행...");
        } else {
          console.log("배송지 버튼 클릭 실패:", editResult.error);
          steps.push({
            step: "shipping_address_button",
            success: false,
            error: editResult.error,
            addressCount: editResult.count,
          });
          // 배송지 처리 실패 - 여기서 멈춤
          const shippingError = editResult.count === 0
            ? "배송지 추가 버튼 클릭 실패"
            : "배송지 수정 버튼 클릭 실패";
          errorCollector.addError(ORDER_STEPS.ORDER_PLACEMENT, ERROR_CODES.CLICK_FAILED, shippingError, { purchaseOrderId });
          await saveOrderResults(authToken, {
            purchaseOrderId,
            products: addedProducts || [],
            priceMismatches: [],
            optionFailedProducts: [],
            automationErrors: errorCollector.getErrors(),
            poLineIds,
            success: false,
        vendor: "coupang",
          });
          return res.json({
            success: false,
            vendor: vendor.name,
            error: shippingError,
            addressCount: editResult.count,
            steps,
            automationErrors: errorCollector.getErrors(),
          });
        }
      } else {
        console.log("배송지 변경 버튼 클릭 실패:", changeResult.error);
        steps.push({
          step: "shipping_change_button",
          success: false,
          error: changeResult.error,
          debug: changeResult.debug,
        });
        // 배송지 처리 실패 - 여기서 멈춤
        errorCollector.addError(ORDER_STEPS.ORDER_PLACEMENT, ERROR_CODES.CLICK_FAILED, "배송지 변경 버튼 클릭 실패", { purchaseOrderId });
        await saveOrderResults(authToken, {
          purchaseOrderId,
          products: addedProducts || [],
          priceMismatches: [],
          optionFailedProducts: [],
          automationErrors: errorCollector.getErrors(),
          poLineIds,
          success: false,
        vendor: "coupang",
        });
        return res.json({
          success: false,
          vendor: vendor.name,
          error: "배송지 변경 버튼 클릭 실패",
          steps,
          automationErrors: errorCollector.getErrors(),
        });
      }
    } catch (e) {
      console.log("배송지 처리 오류:", e.message);
      steps.push({
        step: "shipping_address",
        success: false,
        error: e.message,
      });
      // 배송지 처리 실패 - 여기서 멈춤
      errorCollector.addError(ORDER_STEPS.ORDER_PLACEMENT, null, e.message, { purchaseOrderId });
      await saveOrderResults(authToken, {
        purchaseOrderId,
        products: addedProducts || [],
        priceMismatches: [],
        optionFailedProducts: [],
        automationErrors: errorCollector.getErrors(),
        poLineIds,
        success: false,
        vendor: "coupang",
      });
      return res.json({
        success: false,
        vendor: vendor.name,
        error: e.message,
        steps,
        automationErrors: errorCollector.getErrors(),
      });
    }
  }

  // 7. 결제하기 버튼 클릭
  console.log("Step 7: 결제하기 버튼 클릭...");
  try {
    await delay(2000);

    // 결제하기 버튼 클릭
    const paymentClicked = await page.evaluate(() => {
      const btn = document.querySelector("#purchase > button");
      if (btn && btn.offsetParent !== null) {
        btn.click();
        return { success: true, selector: "#purchase > button" };
      }
      return {
        success: false,
        error: "#purchase > button 버튼을 찾을 수 없음",
      };
    });

    console.log("결제하기 버튼 결과:", JSON.stringify(paymentClicked));

    if (paymentClicked.success) {
      await delay(3000); // 쿠팡페이 팝업/결제 화면 로딩 대기
      steps.push({
        step: "payment_click",
        success: true,
        detail: paymentClicked,
      });

      // 쿠팡페이 비밀번호 입력 (재시도 포함)
      if (vendor.paymentPin) {
        console.log("Step 7-1: 쿠팡페이 비밀번호 입력...");

        const maxPinRetries = 5;
        let pinSuccess = false;
        let lastPinResult = null;

        for (let pinRetry = 1; pinRetry <= maxPinRetries && !pinSuccess; pinRetry++) {
          try {
            console.log(`[쿠팡페이] 비밀번호 입력 시도 ${pinRetry}/${maxPinRetries}`);
            const pinEntered = await enterCoupangPayPin(page, vendor.paymentPin);
            console.log("비밀번호 입력 결과:", JSON.stringify(pinEntered));
            lastPinResult = pinEntered;

            if (pinEntered.success) {
              // 5초 대기 후 키패드가 아직 존재하는지 확인
              await delay(5000);

              const keypadStillExists = await checkKeypadExists(page);
              console.log(`[쿠팡페이] 키패드 존재 여부: ${keypadStillExists}`);

              if (keypadStillExists) {
                console.log(`[쿠팡페이] 비밀번호 입력 실패 - 키패드가 아직 존재함 (재시도 ${pinRetry}/${maxPinRetries})`);
                // 재시도 전 잠시 대기
                await delay(2000);
              } else {
                // 키패드가 사라짐 = 비밀번호 입력 성공
                pinSuccess = true;
                console.log("[쿠팡페이] 비밀번호 입력 성공 - 키패드 사라짐");
              }
            }
          } catch (e) {
            console.log(`비밀번호 입력 실패 (시도 ${pinRetry}):`, e.message);
            lastPinResult = { success: false, error: e.message };
          }
        }

        steps.push({
          step: "payment_pin",
          success: pinSuccess,
          detail: lastPinResult,
          retryCount: maxPinRetries,
        });

        if (pinSuccess) {
          await delay(3000); // 결제 처리 대기
        }
      }

      // 쿠팡페이 결제 완료 대기 (팝업 닫힘 또는 결제 완료 페이지 감지)
      console.log("Step 8: 쿠팡페이 결제 완료 대기...");

      // 결제 완료 감지 (최대 60초 대기)
      let paymentCompleted = false;
      let waitCount = 0;
      const maxWait = 60; // 60초

      while (!paymentCompleted && waitCount < maxWait) {
        await delay(2000);
        waitCount += 2;

        // 현재 URL 또는 페이지 상태 확인
        const currentUrl = page.url();
        const pageState = await page.evaluate(() => {
          // 결제 완료 페이지 감지
          const completionIndicators = [
            document.querySelector('[class*="complete"]'),
            document.querySelector('[class*="success"]'),
            document.querySelector('[class*="order-complete"]'),
            document.body.textContent.includes("주문이 완료"),
            document.body.textContent.includes("결제가 완료"),
            document.body.textContent.includes("감사합니다"),
          ];

          const isComplete = completionIndicators.some(
            (indicator) => !!indicator
          );

          // 주문번호 추출 시도
          let orderNumber = null;
          const orderNumEl = document.querySelector(
            '[class*="order-number"], [class*="orderNumber"]'
          );
          if (orderNumEl) {
            orderNumber = orderNumEl.textContent?.trim();
          }

          // 주문금액 추출 (배송비 제외한 순수 상품 금액)
          let orderAmount = null;
          try {
            // 방법 1: "주문금액" 텍스트를 찾아서 다음 셀의 값 추출
            const allTds = document.querySelectorAll("td");
            for (let i = 0; i < allTds.length; i++) {
              const td = allTds[i];
              if (td.textContent?.trim() === "주문금액" && allTds[i + 1]) {
                const amountText = allTds[i + 1].textContent?.trim();
                // "6,750 원" 또는 "6,750원" 형식에서 숫자만 추출
                const numMatch = amountText.replace(/[,\s원]/g, "");
                if (numMatch && !isNaN(parseInt(numMatch))) {
                  orderAmount = parseInt(numMatch);
                }
                break;
              }
            }

            // 방법 2: 테이블 구조에서 "주문금액" 행 찾기
            if (!orderAmount) {
              const rows = document.querySelectorAll("tr");
              for (const row of rows) {
                const cells = row.querySelectorAll("td, th");
                for (let i = 0; i < cells.length; i++) {
                  if (
                    cells[i].textContent?.includes("주문금액") &&
                    cells[i + 1]
                  ) {
                    const amountText = cells[i + 1].textContent?.trim();
                    const numMatch = amountText.replace(/[,\s원]/g, "");
                    if (numMatch && !isNaN(parseInt(numMatch))) {
                      orderAmount = parseInt(numMatch);
                      break;
                    }
                  }
                }
                if (orderAmount) break;
              }
            }
          } catch (e) {
            console.log("주문금액 추출 실패:", e.message);
          }

          return {
            isComplete,
            orderNumber,
            orderAmount,
            bodyText: document.body.textContent?.substring(0, 500),
          };
        });

        console.log(
          `[결제 대기 ${waitCount}초] URL: ${currentUrl.substring(0, 50)}...`
        );

        // 결제 완료 페이지 감지
        if (
          currentUrl.includes("order/complete") ||
          currentUrl.includes("order-complete") ||
          currentUrl.includes("success") ||
          pageState.isComplete
        ) {
          paymentCompleted = true;
          console.log("결제 완료 감지!");
          if (pageState.orderAmount) {
            console.log(`[가격] 쿠팡 주문금액: ${pageState.orderAmount}원`);
          }

          // 결제 완료 확인 버튼 클릭 → 주문번호 페이지로 이동
          let finalOrderNumber = pageState.orderNumber;
          try {
            await delay(1000);
            const confirmBtn = await page.$(
              "#__next > div.sc-445mix-0.bdbSye > div.sc-wh3cod-0.sNTur > button.sc-1vm0jpx-0.sc-1vm0jpx-2.sc-wh3cod-1.gWgVCb.iqKTcw.hmSagB"
            );
            if (confirmBtn) {
              await confirmBtn.click();
              console.log("[결제 완료] 확인 버튼 클릭");
              await delay(3000);

              // 주문번호 추출
              const orderInfo = await page.evaluate(() => {
                const orderSpan = document.querySelector(
                  "#__next > div.sc-vv7pzb-0.kqeqyx.my-area-body > div.sc-vv7pzb-1.dHwqA-d.my-area-contents > div > div.sc-llyby5-0.cpmwZc > div.sc-llyby5-1.hEqipt > span.sc-llyby5-2.jtryGp"
                );
                if (orderSpan) {
                  const text = orderSpan.textContent || "";
                  const match = text.match(/(\d+)/);
                  return match ? match[1] : text;
                }
                return null;
              });

              if (orderInfo) {
                finalOrderNumber = orderInfo;
                console.log(`[결제 완료] 주문번호: ${finalOrderNumber}`);
              }
            }
          } catch (e) {
            console.log("[결제 완료] 확인 버튼/주문번호 처리 실패:", e.message);
          }

          steps.push({
            step: "payment_complete",
            success: true,
            orderNumber: finalOrderNumber,
            orderAmount: pageState.orderAmount,
            url: currentUrl,
          });
        }
      }

      if (!paymentCompleted) {
        console.log("결제 완료 대기 시간 초과 (60초)");
        steps.push({
          step: "payment_wait",
          success: false,
          error: "결제 완료 대기 시간 초과",
          currentUrl: page.url(),
        });
      }
    } else {
      steps.push({
        step: "payment_click",
        success: false,
        error: "결제하기 버튼을 찾을 수 없음",
        buttons: paymentClicked.buttons,
      });
    }
  } catch (e) {
    console.log("결제 처리 실패:", e.message);
    steps.push({
      step: "payment",
      success: false,
      error: e.message,
    });
  }

  // 최종 결과 확인
  const paymentStep = steps.find((s) => s.step === "payment_complete");
  const isPaymentComplete = paymentStep && paymentStep.success;

  // 상품별 가격 비교 로직 (리스트 형태로 반환)
  const productResults = [];
  const PRICE_TOLERANCE = 3; // 부가세 반올림 오차 허용 (3원)

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    // openMallQtyPerUnit 적용: 우리 1개 → 오픈몰 N개
    const baseQuantity = product.quantity || 1;
    const qtyPerUnit = product.openMallQtyPerUnit || 1;
    const quantity = baseQuantity * qtyPerUnit;
    let priceMismatch = null;

    if (isPaymentComplete && product.vendorPriceExcludeVat) {
      // 부가세(10%) 추가하여 예상 단가 계산
      const expectedUnitPrice = Math.round(product.vendorPriceExcludeVat * 1.1);

      // 쿠팡 실제 단가 (addedProducts에서 추출, 없으면 주문금액에서 계산)
      const addedProduct = addedProducts[i];
      let coupangUnitPrice = null;

      if (addedProduct?.unitPrice) {
        coupangUnitPrice = addedProduct.unitPrice;
      } else if (paymentStep?.orderAmount) {
        // 전체 주문금액을 총 수량으로 나눠서 추정
        const totalQuantity = products.reduce(
          (sum, p) => sum + (p.quantity || 1),
          0
        );
        coupangUnitPrice = Math.round(paymentStep.orderAmount / totalQuantity);
      }

      if (coupangUnitPrice !== null) {
        const priceDifference = Math.abs(coupangUnitPrice - expectedUnitPrice);

        if (priceDifference > PRICE_TOLERANCE) {
          priceMismatch = {
            detected: true,
            productName:
              product.productName ||
              addedProduct?.productName ||
              `상품 ${i + 1}`,
            productUrl: product.productUrl,
            coupangPrice: coupangUnitPrice,
            expectedPrice: expectedUnitPrice,
            vendorPriceExcludeVat: product.vendorPriceExcludeVat,
            quantity: quantity,
            difference: coupangUnitPrice - expectedUnitPrice,
            differencePercent: (
              ((coupangUnitPrice - expectedUnitPrice) / expectedUnitPrice) *
              100
            ).toFixed(2),
            message: `가격 불일치: 쿠팡 ${coupangUnitPrice.toLocaleString()}원 vs 협력사 ${expectedUnitPrice.toLocaleString()}원 (차이: ${(
              coupangUnitPrice - expectedUnitPrice
            ).toLocaleString()}원)`,
          };
          console.log(`[가격 불일치] 상품 ${i + 1}: ${priceMismatch.message}`);
        } else {
          console.log(
            `[가격 일치] 상품 ${
              i + 1
            }: 쿠팡 ${coupangUnitPrice}원, 협력사 ${expectedUnitPrice}원 (오차: ${priceDifference}원)`
          );
        }
      }
    }

    // 각 상품별 결과 추가
    productResults.push({
      success: isPaymentComplete,
      productIndex: i + 1,
      productName: product.productName || addedProducts[i]?.productName || null,
      productSku: product.productSku || null,  // 제품코드 (가격 불일치 mutation용)
      productUrl: product.productUrl,
      quantity: quantity,
      orderLineIds: product.orderLineIds || null,  // OrderLine IDs (mutation용)
      lineId: poLineIds?.[i] || null,  // PurchaseOrderLine ID
      productVariantVendorId: product.productVariantVendorId || null,  // ProductVariantVendor ID
      orderNumber: paymentStep?.orderNumber || null,
      orderAmount: paymentStep?.orderAmount || null,
      priceMismatch: priceMismatch,
    });
  }

  // 가격 불일치 목록
  const priceMismatchList = productResults.filter(
    (p) => p.priceMismatch?.detected
  );

  // 가격 불일치 상세 데이터 (시스템 저장용)
  const priceMismatches = priceMismatchList.map(p => ({
    purchaseOrderLineId: p.lineId,  // PurchaseOrderLine ID (mutation용)
    productVariantVendorId: p.productVariantVendorId || null,  // ProductVariantVendor ID
    productCode: p.priceMismatch?.productUrl?.match(/vendorItemId=(\d+)/)?.[1] || null,
    productName: p.priceMismatch?.productName || p.productName,
    quantity: p.priceMismatch?.quantity || p.quantity,
    openMallPrice: p.priceMismatch?.coupangPrice,       // 오픈몰 현재 가격 (VAT 포함)
    expectedPrice: p.priceMismatch?.expectedPrice,      // 예상 가격 (VAT 포함)
    vendorPriceExcludeVat: p.priceMismatch?.vendorPriceExcludeVat,  // 협력사 매입가 (VAT 별도)
    difference: p.priceMismatch?.difference,
    differencePercent: p.priceMismatch?.differencePercent,
  }));

  // saveOrderResults 호출
  if (isPaymentComplete) {
    await saveOrderResults(authToken, {
      purchaseOrderId,
      products: productResults.map(p => ({
        orderLineIds: p.orderLineIds,
        openMallOrderNumber: paymentStep?.orderNumber || null,
      })),
      priceMismatches: priceMismatches.map(p => ({
        productVariantVendorId: p.productVariantVendorId,
        vendorPriceExcludeVat: p.vendorPriceExcludeVat,
        openMallPrice: p.openMallPrice,
      })),
      optionFailedProducts: [],
      automationErrors: [],
      poLineIds,
      success: true,
      vendor: "coupang",
    });
  } else {
    await saveOrderResults(authToken, {
      purchaseOrderId,
      products: addedProducts || [],
      priceMismatches: [],
      optionFailedProducts: [],
      automationErrors: errorCollector.getErrors(),
      poLineIds,
      success: false,
        vendor: "coupang",
    });
  }

  // 응답 반환 (필수 데이터만)
  return res.json({
    success: isPaymentComplete,
    orderNumber: paymentStep?.orderNumber || null,
    purchaseOrderId: purchaseOrderId || null,
    purchaseOrderLineIds: poLineIds || [],  // PurchaseOrderLinesReceive mutation용
    // 상품별 결과 (mutation용 orderLineId 포함)
    products: productResults.map(p => ({
      orderLineIds: p.orderLineIds,
      openMallOrderNumber: p.orderNumber,
      productName: p.productName,
      productSku: p.productSku,
      quantity: p.quantity,
      openMallPrice: p.priceMismatch?.coupangPrice || null,   // 쿠팡 현재 가격
      vendorPriceExcludeVat: p.priceMismatch?.vendorPriceExcludeVat || null,  // 협력사 매입가 (VAT 별도)
      priceMismatch: p.priceMismatch?.detected || false,
      needsManagerVerification: p.needsManagerVerification || false,
    })),
    // 가격 불일치 관련
    priceMismatchCount: priceMismatchList.length,
    priceMismatches: priceMismatches,
    automationErrors: errorCollector.hasErrors() ? errorCollector.getErrors() : undefined,
  });
}

/**
 * 배송지 변경 버튼 클릭
 * - 주문/결제 페이지에서 "배송지 변경" 버튼을 찾아 클릭
 * - 배송지 목록 모달을 띄움
 */
async function clickChangeAddressButton(page) {
  console.log("[배송지] 배송지 변경 버튼 클릭 시작...");

  // 주문/결제 페이지 로딩 대기
  await delay(2000);

  // 쿠팡 배송지 변경 버튼 셀렉터
  const changeButtonSelectors = [
    "#deliveryAddress > div > div > div > div.twc-flex.twc-items-center.twc-justify-between.twc-rounded.twc-bg-rds-bluegray-100.twc-p-4 > button",
    "#deliveryAddress button",
  ];

  // 각 셀렉터로 시도 (retry loop)
  let clickResult = { success: false };

  for (let retry = 0; retry < 10; retry++) {
    for (const selector of changeButtonSelectors) {
      try {
        const btn = await page.$(selector);
        if (btn) {
          const isVisible = await page.evaluate(
            (el) => el.offsetParent !== null,
            btn
          );
          if (isVisible) {
            console.log(`[배송지] 버튼 발견: ${selector}`);
            await btn.click();
            clickResult = { success: true, selector };
            break;
          }
        }
      } catch (e) {
        // 무시
      }
    }

    if (clickResult.success) break;

    console.log(`[배송지] 버튼 찾기 재시도... (${retry + 1}/10)`);
    await delay(500);
  }

  console.log("[배송지] 클릭 결과:", JSON.stringify(clickResult));

  if (clickResult.success) {
    // iframe 로딩 대기
    await delay(1500);

    return {
      success: true,
      buttonClicked: clickResult,
    };
  }

  return {
    success: false,
    error: "배송지 변경 버튼을 찾을 수 없음",
  };
}

/**
 * 배송지 목록에서 수정 버튼 클릭
 * - iframe 내 배송지 목록 확인
 * - 첫 번째 배송지의 수정 버튼 클릭
 */
async function clickEditAddressInList(page) {
  console.log("[배송지] 배송지 목록에서 수정 버튼 찾기...");

  // addressbook iframe 찾기
  let addressFrame = null;

  for (let retry = 0; retry < 15; retry++) {
    try {
      const iframeHandle = await page.$("iframe[src*='addressbook']");
      if (iframeHandle) {
        addressFrame = await iframeHandle.contentFrame();
        if (addressFrame) {
          console.log("[배송지] addressbook iframe 발견");
          break;
        }
      }
    } catch (e) {
      // 무시
    }

    console.log(`[배송지] iframe 찾기 재시도... (${retry + 1}/15)`);
    await delay(500);
  }

  if (!addressFrame) {
    return { success: false, error: "배송지 iframe을 찾을 수 없음" };
  }

  // 배송지 목록 확인
  const addressListInfo = await addressFrame.evaluate(() => {
    const addressCards = document.querySelectorAll(".address-card");
    return {
      count: addressCards.length,
      cards: Array.from(addressCards).map((card, index) => {
        const title = card
          .querySelector(".address-card__title")
          ?.textContent?.trim();
        const address = card
          .querySelector(".address-card__text--address")
          ?.textContent?.trim();
        const phone = card
          .querySelector(".address-card__text--cellphone")
          ?.textContent?.trim();
        const hasEditBtn = !!card.querySelector(".address-card__button--edit");
        return { index, title, address, phone, hasEditBtn };
      }),
    };
  });

  console.log(`[배송지] 배송지 목록: ${addressListInfo.count}개`);
  console.log(
    "[배송지] 목록 상세:",
    JSON.stringify(addressListInfo.cards, null, 2)
  );

  // 배송지 목록이 비어있으면 배송지 추가 폼이 바로 열려있음 (버튼 클릭 불필요)
  if (addressListInfo.count === 0) {
    console.log("[배송지] 배송지 목록 비어있음 - 추가 폼이 바로 열려있음");
    return {
      success: true,
      action: "add_new",
      count: 0,
    };
  }

  // 배송지 목록이 있으면 첫 번째 배송지의 수정 버튼 클릭
  const editBtn = await addressFrame.$(
    ".address-card .address-card__button--edit"
  );
  if (editBtn) {
    console.log("[배송지] 수정 버튼 발견: .address-card__button--edit");
    await editBtn.click();
    return {
      success: true,
      action: "edit_existing",
      count: addressListInfo.count,
      clickedAddress: addressListInfo.cards[0],
    };
  }

  return {
    success: false,
    error: "수정 버튼을 찾을 수 없음",
    count: addressListInfo.count,
  };
}

/**
 * 배송지 폼에 데이터 입력
 * - iframe 내 배송지 폼 필드에 값 입력
 * - shippingAddress: { name, phone, zonecode, address, addressDetail }
 */
async function fillAddressForm(page, shippingAddress) {
  console.log("[배송지] 폼 데이터 입력 시작...");
  console.log(
    "[배송지] 입력할 데이터:",
    JSON.stringify(shippingAddress, null, 2)
  );

  // addressbook iframe 찾기
  let addressFrame = null;

  for (let retry = 0; retry < 10; retry++) {
    try {
      const iframeHandle = await page.$("iframe[src*='addressbook']");
      if (iframeHandle) {
        addressFrame = await iframeHandle.contentFrame();
        if (addressFrame) {
          console.log("[배송지] addressbook iframe 발견");
          break;
        }
      }
    } catch (e) {
      // 무시
    }

    console.log(`[배송지] iframe 찾기 재시도... (${retry + 1}/10)`);
    await delay(500);
  }

  if (!addressFrame) {
    return { success: false, error: "배송지 iframe을 찾을 수 없음" };
  }

  // 폼 로딩 대기
  await delay(1000);

  // 폼 필드 정보 확인
  const formInfo = await addressFrame.evaluate(() => {
    const form = document.querySelector("form");
    if (!form) return { hasForm: false };

    const inputs = Array.from(form.querySelectorAll("input, textarea"));
    return {
      hasForm: true,
      fields: inputs.map((input) => ({
        name: input.name,
        id: input.id,
        type: input.type,
        placeholder: input.placeholder,
        className: input.className,
        value: input.value,
      })),
    };
  });

  if (!formInfo.hasForm) {
    return { success: false, error: "배송지 폼을 찾을 수 없음" };
  }

  const filledFields = [];
  const errors = [];

  // 받는 분 (recipientName) 입력 - firstName 또는 name 사용
  const recipientName = shippingAddress.firstName || shippingAddress.name;
  if (recipientName) {
    try {
      const nameInput = await addressFrame.$('input[name="recipientName"]');
      if (nameInput) {
        // 기존 값 지우고 새 값 입력
        await nameInput.click();
        await delay(100);
        await nameInput.evaluate((el) => (el.value = ""));
        await delay(100);
        await page.keyboard.type(recipientName, { delay: 50 });
        filledFields.push({
          field: "recipientName",
          value: recipientName,
        });
        console.log("[배송지] 받는 분 입력 완료:", recipientName);
      } else {
        errors.push({
          field: "recipientName",
          error: "input[name='recipientName'] 찾을 수 없음",
        });
      }
    } catch (e) {
      errors.push({ field: "recipientName", error: e.message });
    }
  }

  // 연락처 (recipientCellphone) 입력
  if (shippingAddress.phone) {
    try {
      const phoneInput = await addressFrame.$(
        'input[name="recipientCellphone"]'
      );
      if (phoneInput) {
        // 하이픈 제거, 국가코드 제거 (쿠팡은 국가코드 별도 관리)
        // +821012345678 → 1012345678, 010-1234-5678 → 1012345678
        let phoneNumber = shippingAddress.phone.replace(/-/g, "");
        if (phoneNumber.startsWith("+82")) {
          phoneNumber = phoneNumber.substring(3);
        } else if (phoneNumber.startsWith("0")) {
          phoneNumber = phoneNumber.substring(1);
        }
        // 기존 값 지우고 새 값 입력
        await phoneInput.click();
        await delay(100);
        await phoneInput.evaluate((el) => (el.value = ""));
        await delay(100);
        await page.keyboard.type(phoneNumber, { delay: 50 });
        filledFields.push({ field: "recipientCellphone", value: phoneNumber });
        console.log("[배송지] 연락처 입력 완료:", phoneNumber);
      } else {
        errors.push({
          field: "recipientCellphone",
          error: "input[name='recipientCellphone'] 찾을 수 없음",
        });
      }
    } catch (e) {
      errors.push({ field: "recipientCellphone", error: e.message });
    }
  }

  // 주소 검색 (우편번호 검색 팝업 사용)
  const postalCode = shippingAddress.postalCode;
  const streetAddress1 = shippingAddress.streetAddress1;
  if (postalCode || streetAddress1) {
    try {
      console.log("[배송지] 주소 검색 시작...");

      // 우편번호 검색 버튼 클릭
      const zipcodeTrigger = await addressFrame.$("._addressBookZipcodeTrigger");
      if (zipcodeTrigger) {
        await zipcodeTrigger.click();
        console.log("[배송지] 우편번호 검색 버튼 클릭");
        await delay(1500);

        // 주소 검색 picker iframe 찾기 (id.coupang.com/addressbook/picker)
        let pickerFrame = null;

        // 디버깅: 페이지의 모든 iframe 확인
        const allIframes = await page.$$("iframe");
        console.log(`[배송지 디버그] 페이지 내 iframe 개수: ${allIframes.length}`);
        for (let i = 0; i < allIframes.length; i++) {
          const src = await allIframes[i].evaluate((el) => el.src);
          console.log(`[배송지 디버그] iframe[${i}] src: ${src}`);
        }

        for (let retry = 0; retry < 10; retry++) {
          try {
            const pickerIframeHandle = await page.$("iframe[src*='addressbook/picker']");
            console.log(`[배송지 디버그] pickerIframeHandle: ${pickerIframeHandle ? "found" : "null"}`);
            if (pickerIframeHandle) {
              pickerFrame = await pickerIframeHandle.contentFrame();
              console.log(`[배송지 디버그] pickerFrame: ${pickerFrame ? "found" : "null"}`);
              if (pickerFrame) {
                console.log("[배송지] picker iframe 발견");
                break;
              }
            }
          } catch (e) {
            console.log(`[배송지 디버그] iframe 찾기 에러: ${e.message}`);
          }
          console.log(`[배송지] picker iframe 찾기 재시도... (${retry + 1}/10)`);
          await delay(500);
        }

        if (!pickerFrame) {
          console.log("[배송지] picker iframe 찾을 수 없음");
          errors.push({ field: "roadAddress", error: "picker iframe 찾을 수 없음" });
        } else {
          const searchQuery = streetAddress1 || postalCode;
          console.log(`[배송지 디버그] searchQuery: ${searchQuery}`);

          // 검색 입력 필드 찾기 - picker iframe 내부
          let searchInput = await pickerFrame.$("div.zipcode__keyword-box._zipcodeSearchKeyBox > input");
          let zipcodeFrame = null; // iframe 안의 iframe (zipcode 검색 화면)
          console.log(`[배송지 디버그] searchInput (zipcode): ${searchInput ? "found" : "null"}`);

          // 다른 셀렉터로도 시도
          if (!searchInput) {
            // 모든 input 태그 확인
            const allInputs = await pickerFrame.$$("input");
            console.log(`[배송지 디버그] pickerFrame 내 input 개수: ${allInputs.length}`);
            for (let i = 0; i < Math.min(allInputs.length, 5); i++) {
              const inputInfo = await allInputs[i].evaluate((el) => ({
                name: el.name,
                id: el.id,
                type: el.type,
                placeholder: el.placeholder,
                className: el.className,
              }));
              console.log(`[배송지 디버그] input[${i}]:`, JSON.stringify(inputInfo));
            }

            // 주소 변경 버튼 찾기 (검색 화면으로 이동)
            const changeAddressBtn = await pickerFrame.$("._addressBookZipcodeTrigger");
            console.log(`[배송지 디버그] changeAddressBtn (_addressBookZipcodeTrigger): ${changeAddressBtn ? "found" : "null"}`);

            if (changeAddressBtn) {
              // 버튼 상태 확인
              const btnInfo = await changeAddressBtn.evaluate((el) => ({
                tagName: el.tagName,
                className: el.className,
                innerText: el.innerText.substring(0, 50),
                href: el.href,
              }));
              console.log(`[배송지 디버그] 버튼 정보:`, JSON.stringify(btnInfo));

              // disabled 클래스 제거 (버튼이 비활성화 상태일 수 있음)
              await changeAddressBtn.evaluate((el) => {
                el.classList.remove("icon-text-field__button--disabled");
                el.removeAttribute("disabled");
              });
              console.log("[배송지 디버그] disabled 클래스 제거");

              // 버튼이 보이도록 스크롤
              await changeAddressBtn.evaluate((el) => el.scrollIntoView({ behavior: "instant", block: "center" }));
              await delay(300);

              // 클릭 시도
              console.log("[배송지 디버그] 클릭 시도...");
              await changeAddressBtn.click();
              await delay(2000);

              // zipcode__wrapper 확인
              let wrapperFound = await pickerFrame.$("div.zipcode__wrapper");
              console.log(`[배송지 디버그] 클릭 후 zipcode__wrapper: ${wrapperFound ? "found" : "null"}`);

              // 안되면 href 직접 이동 시도 (A 태그)
              if (!wrapperFound && btnInfo.href) {
                console.log(`[배송지 디버그] href로 이동 시도: ${btnInfo.href}`);
                await pickerFrame.goto(btnInfo.href);
                await delay(2000);
                wrapperFound = await pickerFrame.$("div.zipcode__wrapper");
                console.log(`[배송지 디버그] href 이동 후 zipcode__wrapper: ${wrapperFound ? "found" : "null"}`);
              }

              // pickerFrame 안의 iframe 확인 (iframe 안에 iframe 구조)
              const innerIframes = await pickerFrame.$$("iframe");
              console.log(`[배송지 디버그] pickerFrame 내 iframe 개수: ${innerIframes.length}`);

              for (let i = 0; i < innerIframes.length; i++) {
                const src = await innerIframes[i].evaluate((el) => el.src);
                console.log(`[배송지 디버그] pickerFrame 내 iframe[${i}] src: ${src}`);
                const innerFrame = await innerIframes[i].contentFrame();
                if (innerFrame) {
                  const hasWrapper = await innerFrame.$("div.zipcode__wrapper");
                  console.log(`[배송지 디버그] iframe[${i}] zipcode__wrapper: ${hasWrapper ? "found" : "null"}`);
                  if (hasWrapper) {
                    zipcodeFrame = innerFrame;
                    console.log("[배송지 디버그] zipcode__wrapper가 있는 iframe 발견!");
                    break;
                  }
                }
              }

              // zipcodeFrame에서 searchInput 찾기
              if (zipcodeFrame) {
                searchInput = await zipcodeFrame.$("div.zipcode__keyword-box._zipcodeSearchKeyBox > input");
                console.log(`[배송지 디버그] searchInput (zipcodeFrame): ${searchInput ? "found" : "null"}`);
              }

              // pickerFrame에서 찾기
              if (!searchInput) {
                searchInput = await pickerFrame.$("div.zipcode__keyword-box._zipcodeSearchKeyBox > input");
                console.log(`[배송지 디버그] searchInput (pickerFrame): ${searchInput ? "found" : "null"}`);
              }

              // addressFrame에서 찾기
              if (!searchInput) {
                searchInput = await addressFrame.$("div.zipcode__keyword-box._zipcodeSearchKeyBox > input");
                console.log(`[배송지 디버그] searchInput (addressFrame): ${searchInput ? "found" : "null"}`);
              }
            }
          }

          if (searchInput) {
            // iframe 내의 input에 직접 값 설정 (page.keyboard.type은 메인 페이지에서만 동작)
            await searchInput.click();
            console.log("[배송지 디버그] searchInput 클릭 완료");
            await delay(100);

            // 값 직접 설정 및 input 이벤트 발생
            await searchInput.evaluate((el, val) => {
              el.value = val;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            }, searchQuery);
            console.log("[배송지] 주소 검색어 입력:", searchQuery);
            await delay(500);

            // 검색 버튼 클릭 (zipcodeFrame 또는 pickerFrame 내에서)
            let searchBtn = null;
            if (zipcodeFrame) {
              searchBtn = await zipcodeFrame.$("div.zipcode__search-trigger > button");
              console.log(`[배송지 디버그] searchBtn (zipcodeFrame): ${searchBtn ? "found" : "null"}`);
            }
            if (!searchBtn) {
              searchBtn = await pickerFrame.$("div.zipcode__search-trigger > button");
              console.log(`[배송지 디버그] searchBtn (pickerFrame): ${searchBtn ? "found" : "null"}`);
            }
            if (searchBtn) {
              await searchBtn.click();
              console.log("[배송지] 검색 버튼 클릭");
              await delay(2000);
            } else {
              // Enter 키로 검색
              await searchInput.press("Enter");
              console.log("[배송지] Enter 키로 검색");
              await delay(2000);
            }

            // 검색 결과에서 우편번호 일치하는 도로명 주소 선택
            const targetFrame = zipcodeFrame || pickerFrame;
            const resultItems = await targetFrame.$$("._zipcodeResultSendTrigger.zipcode__result__item--road");
            console.log(`[배송지 디버그] 검색 결과 개수: ${resultItems.length}`);

            let addressSelected = false;
            for (const item of resultItems) {
              const dataResult = await item.evaluate((el) => el.getAttribute("data-result"));
              if (dataResult) {
                try {
                  const resultData = JSON.parse(dataResult);
                  console.log(`[배송지 디버그] 결과 우편번호: ${resultData.zipcode}, 찾는 우편번호: ${postalCode}`);
                  if (resultData.zipcode === postalCode) {
                    await item.click();
                    console.log(`[배송지] 우편번호 ${postalCode} 일치하는 주소 선택: ${resultData.roadAddress}`);
                    addressSelected = true;
                    await delay(1500);
                    break;
                  }
                } catch (e) {
                  console.log(`[배송지 디버그] JSON 파싱 실패: ${e.message}`);
                }
              }
            }

            if (!addressSelected && resultItems.length > 0) {
              // 일치하는 우편번호가 없으면 첫 번째 결과 선택
              console.log("[배송지] 일치하는 우편번호 없음, 첫 번째 결과 선택");
              await resultItems[0].click();
              await delay(1500);
              addressSelected = true;
            }

            if (addressSelected) {
              filledFields.push({ field: "roadAddress", value: searchQuery, postalCode });
            } else {
              console.log("[배송지] 검색 결과 없음");
              errors.push({ field: "roadAddress", error: "검색 결과 없음" });
            }
          } else {
            console.log("[배송지] 검색 입력 필드 찾을 수 없음");
            errors.push({ field: "roadAddress", error: "검색 입력 필드 찾을 수 없음" });
          }
        }
      } else {
        console.log("[배송지] 우편번호 검색 버튼 찾을 수 없음 - 기존 주소 유지");
        filledFields.push({ field: "roadAddress", value: "no_trigger", skipped: true });
      }
    } catch (e) {
      console.log("[배송지] 주소 검색 실패:", e.message);
      errors.push({ field: "roadAddress", error: e.message });
    }
  } else {
    console.log("[배송지] 주소 정보 없음 - 기존 주소 유지");
    filledFields.push({ field: "roadAddress", value: "no_data", skipped: true });
  }

  // 상세주소 (addressDetail) 입력 - streetAddress2 또는 addressDetail 사용
  // 주의: 주소 검색 후 상세주소가 초기화되므로 주소 선택 완료 후에 입력해야 함
  const addressDetail = shippingAddress.streetAddress2 || shippingAddress.addressDetail;
  if (addressDetail) {
    try {
      // pickerFrame 다시 찾기 (주소 검색 후 변경되었을 수 있음)
      let currentPickerFrame = null;
      const pickerIframe = await page.$("iframe[src*='addressbook/picker']");
      if (pickerIframe) {
        currentPickerFrame = await pickerIframe.contentFrame();
      }
      const targetFrame = currentPickerFrame || addressFrame;

      const detailInput = await targetFrame.$("#addressbookAddressDetail");
      if (detailInput) {
        // 기존 값 지우고 새 값 입력 (iframe 내에서 직접 설정)
        await detailInput.click();
        await delay(100);
        await detailInput.evaluate((el, val) => {
          el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }, addressDetail);
        filledFields.push({
          field: "addressDetail",
          value: addressDetail,
        });
        console.log("[배송지] 상세주소 입력 완료:", addressDetail);
      } else {
        errors.push({
          field: "addressDetail",
          error: "input[name='addressDetail'] 찾을 수 없음",
        });
      }
    } catch (e) {
      errors.push({ field: "addressDetail", error: e.message });
    }
  }

  // 저장 버튼 클릭
  try {
    // pickerFrame 다시 찾기
    let saveFrame = null;
    const pickerIframe = await page.$("iframe[src*='addressbook/picker']");
    if (pickerIframe) {
      saveFrame = await pickerIframe.contentFrame();
    }
    const targetFrame = saveFrame || addressFrame;

    const saveBtn = await targetFrame.$("div.addressbook__button-fixer > button");
    if (saveBtn) {
      await saveBtn.click();
      console.log("[배송지] 저장 버튼 클릭");
      await delay(2000);
      filledFields.push({ field: "save", value: "clicked" });
    } else {
      console.log("[배송지] 저장 버튼 찾을 수 없음");
      errors.push({ field: "save", error: "저장 버튼 찾을 수 없음" });
    }
  } catch (e) {
    console.log("[배송지] 저장 버튼 클릭 실패:", e.message);
    errors.push({ field: "save", error: e.message });
  }

  // 수정한 배송지 선택 버튼 클릭
  try {
    await delay(2000);  // UI 갱신 대기

    // 버튼이 나타날 때까지 대기
    const pickSelector = "form.address-card__form.address-card__form--pick._addressBookAddressCardPickForm > button";
    await addressFrame.waitForSelector(pickSelector, { timeout: 5000 });

    const pickBtn = await addressFrame.$(pickSelector);
    if (pickBtn) {
      await pickBtn.click();
      console.log("[배송지] 배송지 선택 버튼 클릭");
      await delay(2000);
      filledFields.push({ field: "pickAddress", value: "clicked" });
    } else {
      console.log("[배송지] 배송지 선택 버튼 찾을 수 없음");
      errors.push({ field: "pickAddress", error: "배송지 선택 버튼 찾을 수 없음" });
    }
  } catch (e) {
    console.log("[배송지] 배송지 선택 버튼 클릭 실패:", e.message);
    errors.push({ field: "pickAddress", error: e.message });
  }

  // 배송지 선택 완료 - iframe이 닫혔을 수 있으므로 상태 확인 생략
  return {
    success: errors.length === 0,
    filledFields,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * 장바구니 상품 검증
 * - 선택된 상품이 주문할 상품과 일치하는지 확인
 * - 수량이 맞는지 확인
 * - 예상치 못한 상품이 선택되어 있는지 확인
 */
async function verifyCartItems(page, expectedProducts) {
  console.log("[장바구니 검증] 시작...");
  console.log(
    `[장바구니 검증] 기대 상품 ${expectedProducts.length}개:`,
    expectedProducts
      .map((p) => `${p.productName || "unknown"} x${p.quantity}`)
      .join(", ")
  );

  // 장바구니에서 선택된 상품 정보 추출
  const cartItems = await page.evaluate(() => {
    const items = [];
    // 쿠팡 장바구니: div[id^="item_"] with data-selected, data-vid attributes
    const cartItemElements = document.querySelectorAll('div[id^="item_"]');

    for (const item of cartItemElements) {
      // 체크박스 상태 확인 - data-selected 속성 또는 checkbox checked
      const dataSelected = item.getAttribute("data-selected");
      const checkbox = item.querySelector('input[type="checkbox"]');
      const isSelected =
        dataSelected === "true" || (checkbox ? checkbox.checked : false);

      if (!isSelected) {
        continue; // 선택되지 않은 상품은 스킵
      }

      // 상품 정보 추출
      const nameEl = item.querySelector(
        '[class*="product-name"], [class*="name"], .product-title, a[href*="products"]'
      );
      const name = nameEl ? nameEl.textContent?.trim() : "";

      // 수량 추출 - 쿠팡 장바구니 수량 input 셀렉터
      const qtyInput = item.querySelector(
        'input.cart-quantity-input, input[type="number"], input[type="text"][class*="quantity"], input[class*="qty"], input[class*="quantity"], [class*="count"] input'
      );
      const qtyText = item.querySelector(
        '[class*="qty"], [class*="quantity"], [class*="count"]'
      );
      let quantity = 1;
      if (qtyInput) {
        quantity = parseInt(qtyInput.value, 10) || 1;
      } else if (qtyText) {
        const match = qtyText.textContent?.match(/\d+/);
        quantity = match ? parseInt(match[0], 10) : 1;
      }
      console.log(
        `[장바구니] 상품: ${name?.substring(0, 30)}... 수량: ${quantity}`
      );

      // vendorItemId 추출 - data-vid 속성 우선 사용 (쿠팡 HTML 구조)
      let vendorItemId = item.getAttribute("data-vid");
      if (!vendorItemId) {
        const link = item.querySelector('a[href*="coupang.com/vp/products"]');
        if (link) {
          const href = link.getAttribute("href") || "";
          const match = href.match(/vendorItemId=(\d+)/);
          vendorItemId = match ? match[1] : null;
        }
      }

      // 가격 추출
      const priceEl = item.querySelector(
        '[class*="price"], [class*="amount"], .sale-price'
      );
      const priceText = priceEl
        ? priceEl.textContent?.replace(/[^\d]/g, "")
        : "0";
      const price = parseInt(priceText, 10) || 0;

      items.push({
        name: name.substring(0, 100), // 이름 길이 제한
        quantity,
        vendorItemId,
        price,
        isSelected,
      });
    }

    return items;
  });

  console.log(
    `[장바구니 검증] 선택된 장바구니 상품 ${cartItems.length}개:`,
    cartItems
      .map((i) => `${i.name.substring(0, 30)}... x${i.quantity}`)
      .join(", ")
  );

  // 검증 결과
  const matchedItems = [];
  const quantityMismatches = [];
  const unexpectedItems = [];
  const missingItems = [];

  // 기대 상품 목록 복사
  const expectedCopy = [...expectedProducts];

  // 상품명 유사도 체크 함수
  function isNameSimilar(name1, name2) {
    if (!name1 || !name2) {
      return false;
    }
    const n1 = name1.toLowerCase().replace(/\s+/g, "");
    const n2 = name2.toLowerCase().replace(/\s+/g, "");
    // 하나가 다른 하나를 포함하거나, 앞 30자가 같으면 매칭
    return (
      n1.includes(n2) ||
      n2.includes(n1) ||
      n1.substring(0, 30) === n2.substring(0, 30)
    );
  }

  // 장바구니 상품과 기대 상품 매칭
  for (const cartItem of cartItems) {
    let matched = false;
    let matchMethod = null;

    for (let i = 0; i < expectedCopy.length; i++) {
      const expected = expectedCopy[i];

      // 1차: vendorItemId로 매칭 시도
      if (cartItem.vendorItemId && expected.vendorItemId) {
        if (cartItem.vendorItemId === expected.vendorItemId) {
          matched = true;
          matchMethod = "vendorItemId";
        }
      }

      // 2차: vendorItemId 없으면 상품명으로 매칭 시도
      if (!matched && cartItem.name && expected.productName) {
        if (isNameSimilar(cartItem.name, expected.productName)) {
          matched = true;
          matchMethod = "productName";
        }
      }

      if (matched) {
        // 수량 확인
        if (cartItem.quantity !== expected.quantity) {
          quantityMismatches.push({
            name: cartItem.name,
            vendorItemId: cartItem.vendorItemId || null,
            expected: expected.quantity,
            actual: cartItem.quantity,
            matchMethod,
          });
          console.log(
            `[수량 불일치] ${cartItem.name.substring(0, 30)}... 기대: ${
              expected.quantity
            }, 실제: ${cartItem.quantity}`
          );
        }

        matchedItems.push({
          name: cartItem.name,
          vendorItemId: cartItem.vendorItemId || null,
          quantity: cartItem.quantity,
          expectedQuantity: expected.quantity,
          matchMethod,
        });
        console.log(
          `[매칭 성공] ${cartItem.name.substring(0, 30)}... (${matchMethod})`
        );

        expectedCopy.splice(i, 1);
        break;
      }
    }

    // 매칭되지 않은 상품 = 예상치 못한 상품
    if (!matched) {
      unexpectedItems.push({
        name: cartItem.name,
        vendorItemId: cartItem.vendorItemId,
        quantity: cartItem.quantity,
        price: cartItem.price,
      });
      console.log(
        `[예상외 상품] ${cartItem.name.substring(0, 30)}... 수량: ${
          cartItem.quantity
        }`
      );
    }
  }

  // 남은 기대 상품 = 장바구니에 없는 상품
  for (const remaining of expectedCopy) {
    missingItems.push({
      productName: remaining.productName,
      vendorItemId: remaining.vendorItemId,
      quantity: remaining.quantity,
    });
  }

  const isValid =
    matchedItems.length === expectedProducts.length &&
    quantityMismatches.length === 0 &&
    unexpectedItems.length === 0;

  return {
    isValid,
    totalSelected: cartItems.length,
    totalExpected: expectedProducts.length,
    matchedItems,
    quantityMismatches,
    unexpectedItems,
    missingItems,
    summary: isValid
      ? "✅ 장바구니 검증 통과"
      : `⚠️ 검증 실패: 매칭 ${matchedItems.length}/${expectedProducts.length}, 수량불일치 ${quantityMismatches.length}, 예상외상품 ${unexpectedItems.length}`,
  };
}

/**
 * 장바구니 수량 조정
 */
async function adjustCartQuantity(page, vendorItemId, targetQuantity) {
  console.log(
    `[수량 조정] vendorItemId: ${vendorItemId}, 목표 수량: ${targetQuantity}`
  );

  const adjusted = await page.evaluate(
    (vendorItemId, targetQuantity) => {
      const cartItems = document.querySelectorAll('div[id^="item_"]');

      for (const item of cartItems) {
        const link = item.querySelector('a[href*="coupang.com/vp/products"]');
        if (!link) {
          continue;
        }

        const href = link.getAttribute("href") || "";
        if (!href.includes(vendorItemId)) {
          continue;
        }

        // 수량 입력 필드 찾기 - 쿠팡 장바구니 셀렉터
        const qtyInput = item.querySelector(
          'input.cart-quantity-input, input[type="number"], input[type="text"][class*="quantity"], input[class*="qty"], input[class*="quantity"]'
        );

        if (qtyInput) {
          qtyInput.value = targetQuantity;
          qtyInput.dispatchEvent(new Event("input", { bubbles: true }));
          qtyInput.dispatchEvent(new Event("change", { bubbles: true }));

          // 포커스 해제로 변경 적용
          qtyInput.blur();

          return {
            success: true,
            method: "input",
            vendorItemId,
            targetQuantity,
          };
        }

        // + / - 버튼으로 조정
        const currentQtyEl = item.querySelector(
          '[class*="qty"], [class*="quantity"], [class*="count"]'
        );
        const currentQty = currentQtyEl
          ? parseInt(currentQtyEl.textContent?.match(/\d+/)?.[0] || "1", 10)
          : 1;

        const plusBtn = item.querySelector(
          '[class*="plus"], [class*="increase"], button[aria-label*="증가"]'
        );
        const minusBtn = item.querySelector(
          '[class*="minus"], [class*="decrease"], button[aria-label*="감소"]'
        );

        if (plusBtn && minusBtn) {
          const diff = targetQuantity - currentQty;
          const btn = diff > 0 ? plusBtn : minusBtn;
          const clicks = Math.abs(diff);

          for (let i = 0; i < clicks; i++) {
            btn.click();
          }

          return {
            success: true,
            method: "buttons",
            vendorItemId,
            targetQuantity,
            clicks,
          };
        }
      }

      return { success: false, error: "상품을 찾을 수 없음" };
    },
    vendorItemId,
    targetQuantity
  );

  console.log(`[수량 조정] 결과:`, JSON.stringify(adjusted));
  return adjusted;
}

/**
 * 쿠팡페이 키패드 존재 여부 확인
 * - 비밀번호 입력 후 키패드가 아직 존재하면 입력 실패로 판단
 * @param {Page} page - Puppeteer 페이지 인스턴스
 * @returns {Promise<boolean>} 키패드가 존재하면 true
 */
async function checkKeypadExists(page) {
  try {
    // iframe에서 키패드 확인
    const frames = page.frames();
    for (const frame of frames) {
      try {
        const url = frame.url();
        if (
          url.includes("payment.coupang.com") ||
          url.includes("coupay") ||
          url.includes("pay.coupang") ||
          url.includes("rocketpay")
        ) {
          const hasKeypad = await frame.evaluate(() => {
            const padKeys = document.querySelectorAll(".pad-key[data-key]");
            const padCnt = document.querySelectorAll(".pad-cnt");
            // 키패드 버튼이 10개 이상 있거나 PIN 입력 UI(6칸)가 있으면 키패드 존재
            return padKeys.length >= 10 || padCnt.length === 6;
          });

          if (hasKeypad) {
            return true;
          }
        }
      } catch (e) {
        // 프레임 접근 실패 - 무시
      }
    }

    // 메인 페이지에서도 확인
    const hasKeypadInMain = await page.evaluate(() => {
      const padKeys = document.querySelectorAll(".pad-key[data-key]");
      const padCnt = document.querySelectorAll(".pad-cnt");
      return padKeys.length >= 10 || padCnt.length === 6;
    });

    return hasKeypadInMain;
  } catch (e) {
    console.log(`[쿠팡페이] 키패드 존재 확인 실패: ${e.message}`);
    return false; // 확인 실패 시 false 반환 (재시도 안함)
  }
}

/**
 * 쿠팡페이 비밀번호 입력 (OCR 기반 스크램블 키패드 지원)
 * - 보안 키패드: 버튼 위치는 고정, 표시 숫자는 랜덤
 * - 각 버튼 스크린샷 → OCR로 숫자 인식 → 매핑 후 클릭
 * - OCR 재시도: 필요한 숫자가 누락되면 최대 3번 재스캔
 */
async function enterCoupangPayPin(page, pin) {
  console.log("[쿠팡페이] 비밀번호 입력 시작 (OCR 모드)...");

  // PIN에 필요한 고유 숫자 목록
  const requiredDigits = [...new Set(pin.split(""))];
  console.log(`[쿠팡페이] 필요한 숫자: ${requiredDigits.join(", ")}`);

  // 임시 스크린샷 디렉토리
  const tempDir = path.join(__dirname, "../../temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // 비밀번호 입력 UI가 나타날 때까지 대기 (최대 1분)
  let pinFrame = null;
  let attempts = 0;
  const maxAttempts = 60;

  while (!pinFrame && attempts < maxAttempts) {
    attempts++;
    await delay(1000);

    // iframe에서 비밀번호 입력 UI 찾기
    const frames = page.frames();
    console.log(
      `[쿠팡페이] 프레임 ${frames.length}개 검색 중... (시도 ${attempts}/${maxAttempts})`
    );

    for (const frame of frames) {
      try {
        const url = frame.url();
        if (
          url.includes("payment.coupang.com") ||
          url.includes("coupay") ||
          url.includes("pay.coupang") ||
          url.includes("rocketpay")
        ) {
          const hasPinKeypad = await frame.evaluate(() => {
            const padKeys = document.querySelectorAll(".pad-key[data-key]");
            const padCnt = document.querySelectorAll(".pad-cnt");
            return padKeys.length >= 10 || padCnt.length === 6;
          });

          if (hasPinKeypad) {
            pinFrame = frame;
            console.log(
              `[쿠팡페이] 비밀번호 키패드 프레임 발견: ${url.substring(0, 80)}`
            );
            break;
          }
        }
      } catch (e) {
        console.log(`[쿠팡페이] 프레임 접근 실패: ${e.message}`);
      }
    }

    // 메인 페이지에서 비밀번호 입력 UI 찾기
    if (!pinFrame) {
      const hasPinInMain = await page.evaluate(() => {
        const padKeys = document.querySelectorAll(".pad-key[data-key]");
        const padCnt = document.querySelectorAll(".pad-cnt");
        return padKeys.length >= 10 || padCnt.length === 6;
      });

      if (hasPinInMain) {
        pinFrame = page;
        console.log("[쿠팡페이] 메인 페이지에서 비밀번호 키패드 발견");
      }
    }
  }

  if (!pinFrame) {
    console.log("[쿠팡페이] 비밀번호 입력 UI를 찾을 수 없음");
    return { success: false, error: "비밀번호 입력 UI를 찾을 수 없음" };
  }

  // 키패드 버튼 정보 가져오기 (위치, 셀렉터)
  const buttonInfo = await pinFrame.evaluate(() => {
    const keypadSelectors = [
      ".pad-key[data-key]",
      '[class*="keypad"] [class*="key"]',
      '[class*="pad"] [class*="key"]',
      'button[class*="pad"]',
    ];

    let padKeys = [];
    let usedSelector = "";

    for (const sel of keypadSelectors) {
      const found = document.querySelectorAll(sel);
      if (found.length >= 10) {
        padKeys = Array.from(found);
        usedSelector = sel;
        break;
      }
    }

    if (padKeys.length < 10) {
      return {
        success: false,
        error: "키패드 버튼을 찾을 수 없음",
        count: padKeys.length,
      };
    }

    // 각 버튼의 위치 정보 수집
    const buttons = padKeys.map((btn, index) => {
      const rect = btn.getBoundingClientRect();
      return {
        index,
        dataKey: btn.getAttribute("data-key") || index.toString(),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        centerX: rect.x + rect.width / 2,
        centerY: rect.y + rect.height / 2,
      };
    });

    return { success: true, buttons, usedSelector, count: buttons.length };
  });

  console.log(`[쿠팡페이] 버튼 정보:`, JSON.stringify(buttonInfo));

  if (!buttonInfo.success) {
    return { success: false, error: buttonInfo.error };
  }

  // OCR로 각 버튼의 숫자 인식 (재시도 포함)
  let digitMap = {}; // { "1": buttonIndex, "2": buttonIndex, ... }
  let ocrResults = [];
  let buttonHandles = [];
  const maxOcrRetries = 12;
  // 각 재시도마다 다른 설정 사용 (threshold, negate, PSM, blur, gamma, size)
  // 개선된 전처리 설정 - 다양한 조합으로 인식률 향상
  const ocrConfigs = [
    // 기본 설정들 (blur 추가)
    {
      threshold: 128,
      negate: true,
      psm: "10",
      blur: 0.5,
      gamma: 1.0,
      size: 200,
    },
    {
      threshold: 140,
      negate: true,
      psm: "10",
      blur: 0.3,
      gamma: 1.2,
      size: 200,
    },
    {
      threshold: 100,
      negate: true,
      psm: "10",
      blur: 0.7,
      gamma: 1.0,
      size: 200,
    },
    // 높은 대비 설정
    {
      threshold: 160,
      negate: true,
      psm: "10",
      blur: 0.5,
      gamma: 1.5,
      size: 200,
    },
    {
      threshold: 180,
      negate: true,
      psm: "10",
      blur: 0.3,
      gamma: 1.3,
      size: 200,
    },
    // 낮은 threshold + 높은 gamma
    {
      threshold: 80,
      negate: true,
      psm: "10",
      blur: 0.8,
      gamma: 1.8,
      size: 250,
    },
    {
      threshold: 90,
      negate: true,
      psm: "10",
      blur: 0.6,
      gamma: 2.0,
      size: 250,
    },
    // negate 없이 (어두운 배경에 밝은 글자)
    {
      threshold: 128,
      negate: false,
      psm: "10",
      blur: 0.5,
      gamma: 1.2,
      size: 200,
    },
    {
      threshold: 150,
      negate: false,
      psm: "10",
      blur: 0.4,
      gamma: 1.0,
      size: 200,
    },
    // PSM 변경
    {
      threshold: 128,
      negate: true,
      psm: "7",
      blur: 0.5,
      gamma: 1.0,
      size: 200,
    },
    {
      threshold: 128,
      negate: true,
      psm: "8",
      blur: 0.5,
      gamma: 1.2,
      size: 200,
    },
    // 극단적 설정 (마지막 시도)
    {
      threshold: 200,
      negate: true,
      psm: "10",
      blur: 0.3,
      gamma: 2.2,
      size: 300,
    },
  ];

  for (let ocrAttempt = 1; ocrAttempt <= maxOcrRetries; ocrAttempt++) {
    const config = ocrConfigs[ocrAttempt - 1] || ocrConfigs[0];
    console.log(
      `[쿠팡페이] OCR 스캔 시작... (시도 ${ocrAttempt}/${maxOcrRetries}, th:${config.threshold}, neg:${config.negate}, psm:${config.psm}, blur:${config.blur}, gamma:${config.gamma}, size:${config.size})`
    );
    // 첫 시도에서만 초기화, 이후에는 기존 결과 유지
    if (ocrAttempt === 1) {
      digitMap = {};
      ocrResults = [];
    }

    // 전체 스크린샷 (디버깅용)
    const keypadScreenshot = path.join(
      tempDir,
      `keypad_full_${Date.now()}.png`
    );
    try {
      await page.screenshot({ path: keypadScreenshot, fullPage: false });
      console.log(`[쿠팡페이] 전체 스크린샷 저장: ${keypadScreenshot}`);
    } catch (e) {
      console.log(`[쿠팡페이] 전체 스크린샷 실패: ${e.message}`);
    }

    // iframe에서 버튼 ElementHandle 가져오기
    buttonHandles = await pinFrame.$$(buttonInfo.usedSelector);
    console.log(`[쿠팡페이] 버튼 ElementHandle ${buttonHandles.length}개 획득`);

    // 이미 매핑된 버튼 인덱스 목록
    const mappedButtonIndices = new Set(Object.values(digitMap));

    // 각 버튼 요소를 직접 캡처해서 OCR
    for (let i = 0; i < buttonHandles.length && i < 10; i++) {
      // 재시도 시 이미 매핑된 버튼은 건너뛰기
      if (ocrAttempt > 1 && mappedButtonIndices.has(i)) {
        continue;
      }

      try {
        const btnHandle = buttonHandles[i];
        const screenshotPath = path.join(tempDir, `btn_${i}_${Date.now()}.png`);
        const processedPath = path.join(
          tempDir,
          `btn_${i}_processed_${Date.now()}.png`
        );

        // 버튼 요소 직접 스크린샷 (iframe 좌표 문제 해결)
        await btnHandle.screenshot({ path: screenshotPath });

        // 이미지 전처리 (sharp 사용) - 개선된 파이프라인
        // 새로운 설정: blur, gamma, size 추가로 인식률 향상
        const imgSize = config.size || 200;
        let sharpPipeline = sharp(screenshotPath)
          .grayscale()
          .resize({ width: imgSize, height: imgSize, fit: "cover" }); // 더 큰 크기로 리사이즈

        // gamma 보정 (대비 개선)
        if (config.gamma && config.gamma !== 1.0) {
          sharpPipeline = sharpPipeline.gamma(config.gamma);
        }

        // 가우시안 블러 (노이즈 제거)
        if (config.blur && config.blur > 0) {
          sharpPipeline = sharpPipeline.blur(config.blur);
        }

        // normalize와 sharpen
        sharpPipeline = sharpPipeline
          .normalize()
          .sharpen({ sigma: 1.2 })
          .threshold(config.threshold); // 이진화

        // negate 설정에 따라 색상 반전 적용
        if (config.negate) {
          sharpPipeline = sharpPipeline.negate();
        }

        await sharpPipeline.toFile(processedPath);

        // Tesseract OCR 실행 - 설정에 따른 PSM 모드
        const {
          data: { text, confidence },
        } = await Tesseract.recognize(processedPath, "eng", {
          logger: () => {},
          tessedit_char_whitelist: "0123456789",
          tessedit_pageseg_mode: config.psm, // PSM: 설정에 따라 변경
        });

        // 인식된 텍스트에서 숫자만 추출
        const cleanText = text.replace(/[^0-9]/g, "").trim();
        const recognizedDigit = cleanText.length === 1 ? cleanText : null;

        if (ocrAttempt === 1) {
          ocrResults.push({
            index: i,
            dataKey: buttonInfo.buttons[i]?.dataKey,
            rawText: text.trim(),
            recognizedDigit,
            confidence,
          });
        }

        if (recognizedDigit) {
          // 이미 매핑된 숫자가 아닐 때만 추가 (중복 방지)
          if (!digitMap.hasOwnProperty(recognizedDigit)) {
            digitMap[recognizedDigit] = i;
            console.log(
              `[쿠팡페이] ✅ 버튼 ${i}: "${recognizedDigit}" (신뢰도: ${confidence.toFixed(
                1
              )}%)`
            );
          } else {
            console.log(
              `[쿠팡페이] 버튼 ${i}: 중복 숫자 "${recognizedDigit}" 무시`
            );
          }
        } else {
          console.log(
            `[쿠팡페이] ❌ 버튼 ${i}: 인식 실패 - raw: "${text.trim()}"`
          );
        }

        // 임시 파일 삭제
        try {
          fs.unlinkSync(screenshotPath);
        } catch (e) {}
        try {
          fs.unlinkSync(processedPath);
        } catch (e) {}
      } catch (e) {
        console.log(`[쿠팡페이] 버튼 ${i} OCR 실패: ${e.message}`);
        if (ocrAttempt === 1) {
          ocrResults.push({ index: i, error: e.message });
        }
      }
    }

    console.log(`[쿠팡페이] OCR 완료. 매핑:`, JSON.stringify(digitMap));
    console.log(
      `[쿠팡페이] 인식된 숫자: ${Object.keys(digitMap).sort().join(", ")}`
    );

    // 필요한 모든 숫자가 인식되었는지 확인
    const missingDigits = requiredDigits.filter(
      (d) => !digitMap.hasOwnProperty(d)
    );
    if (missingDigits.length === 0) {
      console.log(`[쿠팡페이] 모든 필요 숫자 인식 완료`);
      break;
    } else {
      console.log(`[쿠팡페이] 누락된 숫자: ${missingDigits.join(", ")}`);

      // 추론 로직: 미인식 버튼과 누락 숫자가 각각 1개면 자동 매핑
      const unmappedButtonIndices = [];
      for (let i = 0; i < Math.min(buttonHandles.length, 10); i++) {
        if (!Object.values(digitMap).includes(i)) {
          unmappedButtonIndices.push(i);
        }
      }

      if (unmappedButtonIndices.length === 1 && missingDigits.length === 1) {
        const inferredBtn = unmappedButtonIndices[0];
        const inferredDigit = missingDigits[0];
        digitMap[inferredDigit] = inferredBtn;
        console.log(
          `[쿠팡페이] 🎯 추론: 버튼 ${inferredBtn} = 숫자 "${inferredDigit}" (유일하게 남은 버튼/숫자)`
        );
        break;
      }

      if (ocrAttempt < maxOcrRetries) {
        console.log(
          `[쿠팡페이] ${ocrAttempt + 1}번째 재시도 준비 중... (500ms 대기)`
        );
        await delay(500);
      } else {
        // 마지막 시도 후에도 추론 시도
        if (
          unmappedButtonIndices.length > 0 &&
          unmappedButtonIndices.length === missingDigits.length
        ) {
          console.log(
            `[쿠팡페이] 🎯 최종 추론 시도: ${unmappedButtonIndices.length}개 버튼 ↔ ${missingDigits.length}개 숫자`
          );
          // 순서대로 매핑 (완벽하지 않지만 시도)
          for (let idx = 0; idx < unmappedButtonIndices.length; idx++) {
            digitMap[missingDigits[idx]] = unmappedButtonIndices[idx];
            console.log(
              `[쿠팡페이] 🎯 추론 매핑: 버튼 ${unmappedButtonIndices[idx]} = 숫자 "${missingDigits[idx]}"`
            );
          }
        }
        console.log(`[쿠팡페이] 최대 재시도 횟수 도달.`);
      }
    }
  }

  // PIN 입력 - ElementHandle 직접 클릭 (iframe 좌표 문제 해결)
  const pinResults = [];
  const pinDigits = pin.split("");

  for (const digit of pinDigits) {
    const btnIndex = digitMap[digit];

    if (btnIndex === undefined) {
      console.log(`[쿠팡페이] 숫자 ${digit} 버튼을 찾을 수 없음`);
      pinResults.push({
        digit,
        clicked: false,
        error: `숫자 ${digit} 버튼 없음`,
      });
      continue;
    }

    // ElementHandle 직접 클릭
    try {
      if (buttonHandles[btnIndex]) {
        await buttonHandles[btnIndex].click();
        console.log(`[쿠팡페이] 숫자 ${digit} 클릭 (버튼 ${btnIndex})`);
        pinResults.push({ digit, clicked: true, buttonIndex: btnIndex });
        await delay(300); // 클릭 간 안정적인 딜레이
      } else {
        console.log(`[쿠팡페이] 숫자 ${digit} 버튼 핸들 없음`);
        pinResults.push({ digit, clicked: false, error: "버튼 핸들 없음" });
      }
    } catch (e) {
      console.log(`[쿠팡페이] 숫자 ${digit} 클릭 실패: ${e.message}`);
      pinResults.push({ digit, clicked: false, error: e.message });
    }
  }

  const successCount = pinResults.filter((r) => r.clicked).length;
  const pinResult = {
    success: successCount === 6,
    method: "ocr_keypad",
    clickedCount: successCount,
    results: pinResults,
    digitMap,
    ocrResults: ocrResults.slice(0, 12), // 디버깅 정보
  };

  console.log("[쿠팡페이] 비밀번호 입력 결과:", JSON.stringify(pinResult));

  // 확인/완료 버튼 클릭
  if (pinResult.success) {
    await delay(500);

    const confirmClicked = await pinFrame.evaluate(() => {
      const confirmBtns = document.querySelectorAll(
        "button, input[type='submit']"
      );
      for (const btn of confirmBtns) {
        const text = btn.textContent || btn.innerText || btn.value || "";
        if (
          (text.includes("확인") ||
            text.includes("완료") ||
            text.includes("결제") ||
            text.includes("다음")) &&
          btn.offsetParent !== null
        ) {
          btn.click();
          return { clicked: true, text: text.trim() };
        }
      }
      return { clicked: false };
    });

    console.log("[쿠팡페이] 확인 버튼:", JSON.stringify(confirmClicked));
  }

  // 임시 디렉토리 정리
  try {
    const files = fs.readdirSync(tempDir);
    for (const file of files) {
      if (file.startsWith("btn_") || file.startsWith("keypad_")) {
        fs.unlinkSync(path.join(tempDir, file));
      }
    }
  } catch (e) {}

  return pinResult;
}

/**
 * 장바구니 비우기
 * - 주문 시작 전 장바구니를 깨끗하게 비움
 * - 모든 상품 선택 후 삭제 버튼 클릭
 */
async function clearCart(page) {
  console.log("[장바구니 비우기] 시작...");

  // 다이얼로그 처리 상태 추적
  let dialogHandled = false;

  // 장바구니 페이지로 이동
  await page.goto("https://cart.coupang.com/cartView.pang", {
    waitUntil: "networkidle2",
    timeout: 30000,
  });
  await delay(2000);

  // 장바구니에 상품이 있는지 확인
  const cartStatus = await page.evaluate(() => {
    // 빈 장바구니 확인
    const emptyCart = document.querySelector(
      '[class*="empty-cart"], [class*="no-item"], .cart-empty'
    );
    if (emptyCart && emptyCart.offsetParent !== null) {
      return { isEmpty: true, itemCount: 0 };
    }

    // 장바구니 상품 개수 확인
    const cartItems = document.querySelectorAll('div[id^="item_"]');
    return { isEmpty: cartItems.length === 0, itemCount: cartItems.length };
  });

  console.log(`[장바구니 비우기] 현재 상태:`, JSON.stringify(cartStatus));

  if (cartStatus.isEmpty || cartStatus.itemCount === 0) {
    console.log("[장바구니 비우기] 이미 비어있음");
    return { success: true, alreadyEmpty: true };
  }

  // 전체 선택 체크박스 클릭
  const selectAllClicked = await page.evaluate(() => {
    // 쿠팡 전체 선택 체크박스 셀렉터 (HTML에서 확인)
    const selectAllSelectors = [
      'input[title="모든 상품을 결제상품으로 설정"]', // 쿠팡 실제 셀렉터
      'input[name="selectAll"]',
      'input[type="checkbox"][class*="select-all"]',
      "#selectAll",
      '.cart-select-all input[type="checkbox"]',
      '[class*="all-check"] input[type="checkbox"]',
    ];

    for (const selector of selectAllSelectors) {
      const checkbox = document.querySelector(selector);
      if (checkbox && checkbox.offsetParent !== null) {
        if (!checkbox.checked) {
          checkbox.click();
        }
        return { success: true, selector, checked: true };
      }
    }

    // fallback: "전체 선택" 텍스트가 있는 라벨 찾기
    const labels = document.querySelectorAll("label");
    for (const label of labels) {
      const span = label.querySelector("span");
      const text = span ? span.textContent : label.textContent || "";
      if (text.includes("전체선택") || text.includes("전체 선택")) {
        const checkbox = label.querySelector('input[type="checkbox"]');
        if (checkbox) {
          if (!checkbox.checked) {
            checkbox.click();
          }
          return { success: true, method: "label_checkbox", checked: true };
        }
      }
    }

    return { success: false };
  });

  console.log(`[장바구니 비우기] 전체 선택:`, JSON.stringify(selectAllClicked));
  await delay(1000);

  // 삭제 버튼 클릭 - Promise로 다이얼로그 대기하면서 클릭
  const dialogPromise = new Promise((resolve) => {
    const tempHandler = async (dialog) => {
      console.log(
        `[장바구니 비우기] 다이얼로그 감지: ${dialog.type()} - "${dialog.message()}"`
      );
      await dialog.accept();
      dialogHandled = true;
      console.log("[장바구니 비우기] 다이얼로그 자동 수락 완료");
      resolve({
        success: true,
        dialogType: dialog.type(),
        message: dialog.message(),
      });
    };
    page.once("dialog", tempHandler);
    // 3초 타임아웃 - 다이얼로그가 나타나지 않으면 타임아웃
    setTimeout(() => resolve({ success: false, timeout: true }), 3000);
  });

  const deleteClicked = await page.evaluate(() => {
    // 쿠팡 장바구니: "선택삭제" 버튼은 div로 되어 있음
    // <div class="...twc-border-[1px]...">선택삭제</div>
    const allElements = document.querySelectorAll("div, button, a, span");

    for (const el of allElements) {
      const text = (el.textContent || el.innerText || "").trim();
      // 정확히 "선택삭제"만 포함하는 요소 찾기
      if (text === "선택삭제" && el.offsetParent !== null) {
        console.log("[장바구니 비우기] 선택삭제 버튼 발견:", el.tagName);
        el.click();
        return {
          success: true,
          method: "exact_match",
          text,
          tagName: el.tagName,
        };
      }
    }

    // fallback: "선택삭제" 또는 "선택 삭제" 포함하는 요소
    for (const el of allElements) {
      const text = (el.textContent || el.innerText || "").trim();
      if (
        (text.includes("선택삭제") || text.includes("선택 삭제")) &&
        el.offsetParent !== null &&
        text.length < 20
      ) {
        // 짧은 텍스트만 (버튼일 가능성 높음)
        console.log(
          "[장바구니 비우기] 삭제 버튼 발견 (fallback):",
          el.tagName,
          text
        );
        el.click();
        return {
          success: true,
          method: "contains_match",
          text,
          tagName: el.tagName,
        };
      }
    }

    return { success: false };
  });

  console.log(`[장바구니 비우기] 삭제 버튼:`, JSON.stringify(deleteClicked));

  if (!deleteClicked.success) {
    console.log("[장바구니 비우기] 삭제 버튼을 찾을 수 없음");
    page.off("dialog", dialogHandler);
    return { success: false, error: "삭제 버튼을 찾을 수 없음" };
  }

  // 다이얼로그 대기 결과 확인
  const dialogResult = await dialogPromise;
  console.log(
    `[장바구니 비우기] 다이얼로그 처리 결과:`,
    JSON.stringify(dialogResult)
  );

  // 네이티브 다이얼로그가 처리되지 않았다면 커스텀 모달 확인
  if (!dialogHandled) {
    await delay(1000);

    // 확인 모달이 있으면 확인 클릭 (여러 번 시도)
    for (let attempt = 0; attempt < 3; attempt++) {
      const confirmClicked = await page.evaluate(() => {
        // 쿠팡 커스텀 모달/팝업에서 확인 버튼 찾기
        // 가능한 모든 모달/팝업 셀렉터
        const modalSelectors = [
          ".modal",
          ".popup",
          '[class*="modal"]',
          '[class*="dialog"]',
          '[role="dialog"]',
          '[class*="layer"]',
          '[class*="alert"]',
          '[class*="confirm"]',
          '[class*="popup"]',
          '[class*="toast"]',
          ".overlay",
          '[class*="overlay"]',
        ];

        // 먼저 화면에 보이는 모든 버튼 중에서 "확인", "삭제", "예" 버튼 찾기
        const allButtons = document.querySelectorAll(
          'button, [role="button"], a[class*="btn"], div[class*="btn"]'
        );
        for (const btn of allButtons) {
          const text = (btn.textContent || btn.innerText || "").trim();
          const isVisible = btn.offsetParent !== null;
          // 짧은 텍스트의 확인/삭제 버튼 (모달 확인 버튼일 가능성 높음)
          if (
            isVisible &&
            text.length < 10 &&
            (text === "확인" ||
              text === "삭제" ||
              text === "예" ||
              text === "OK" ||
              text === "Yes")
          ) {
            // 부모가 모달인지 확인
            let parent = btn.parentElement;
            let isInModal = false;
            while (parent) {
              const className = parent.className || "";
              if (
                className.includes("modal") ||
                className.includes("popup") ||
                className.includes("dialog") ||
                className.includes("layer") ||
                className.includes("alert") ||
                className.includes("confirm") ||
                parent.getAttribute("role") === "dialog"
              ) {
                isInModal = true;
                break;
              }
              parent = parent.parentElement;
            }

            if (isInModal || text === "확인" || text === "삭제") {
              console.log(
                "[장바구니 비우기] 확인 버튼 발견:",
                text,
                btn.tagName
              );
              btn.click();
              return {
                success: true,
                text,
                tagName: btn.tagName,
                inModal: isInModal,
              };
            }
          }
        }

        // 모달 내부에서 버튼 찾기
        for (const modalSel of modalSelectors) {
          const modals = document.querySelectorAll(modalSel);
          for (const modal of modals) {
            if (!modal || modal.offsetParent === null) {
              continue;
            }
            const buttons = modal.querySelectorAll(
              'button, [role="button"], a, div'
            );
            for (const btn of buttons) {
              const text = (btn.textContent || btn.innerText || "").trim();
              if (
                text.length < 15 &&
                (text.includes("확인") ||
                  text.includes("삭제") ||
                  text.includes("예") ||
                  text === "OK" ||
                  text === "Yes") &&
                !text.includes("취소") &&
                btn.offsetParent !== null
              ) {
                console.log(
                  "[장바구니 비우기] 모달 확인 버튼 발견:",
                  text,
                  btn.tagName
                );
                btn.click();
                return {
                  success: true,
                  text,
                  tagName: btn.tagName,
                  modalSelector: modalSel,
                };
              }
            }
          }
        }

        return { success: false, noModal: true };
      });

      console.log(
        `[장바구니 비우기] 확인 모달 (시도 ${attempt + 1}):`,
        JSON.stringify(confirmClicked)
      );

      if (confirmClicked.success) {
        break;
      }
      await delay(500);
    }
  }

  await delay(2000);

  // 삭제 완료 확인
  const finalStatus = await page.evaluate(() => {
    const emptyCart = document.querySelector(
      '[class*="empty-cart"], [class*="no-item"], .cart-empty'
    );
    // div[id^="item_"] 또는 data-bundle-id 속성 사용
    const cartItems = document.querySelectorAll(
      'div[id^="item_"], [data-bundle-id]'
    );
    return {
      isEmpty:
        (emptyCart && emptyCart.offsetParent !== null) ||
        cartItems.length === 0,
      remainingItems: cartItems.length,
    };
  });

  console.log(`[장바구니 비우기] 최종 상태:`, JSON.stringify(finalStatus));

  return {
    success: finalStatus.isEmpty,
    clearedCount: cartStatus.itemCount,
    remainingItems: finalStatus.remainingItems,
  };
}

module.exports = {
  processCoupangOrder,
  clickChangeAddressButton,
  clickEditAddressInList,
  verifyCartItems,
  adjustCartQuantity,
  enterCoupangPayPin,
  clearCart,
};
