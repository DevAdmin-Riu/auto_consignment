/**
 * 쿠팡 주문 처리 모듈
 */

const { delay, getLoginStatus, setLoginStatus } = require("../../lib/browser");
const { coupangLogin } = require("./login");
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
  { products, shippingAddress, lineIds }
) {
  const steps = [];
  const addedProducts = []; // 장바구니에 담긴 상품들 추적

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
    const quantity = product.quantity || 1;
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
                  if (btn.textContent.includes("수량더하기") && !btn.disabled) {
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
            const input = await page.$('.product-quantity input[type="text"]');
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
        steps.push({ step: `product_${productIndex + 1}_cart`, success: true });

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
      }
    } catch (e) {
      console.log(`상품 ${productIndex + 1} 처리 실패:`, e.message);
      steps.push({
        step: `product_${productIndex + 1}_error`,
        success: false,
        error: e.message,
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
      steps.push({ step: "cart_verification", success: false, error: e.message });
      cartVerified = true; // 검증 실패해도 진행
    }
  } // while 루프 끝

  // 재시도 횟수 초과 시 에러 반환
  if (!cartVerified) {
    return res.json({
      success: false,
      vendor: vendor.name,
      error: `장바구니 검증 실패 - ${maxCartRetries}회 재시도 후에도 실패`,
      steps,
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
          const stepName = isAddNew ? "shipping_add_button" : "shipping_edit_button";
          const message = isAddNew ? "새 배송지 추가 폼 열림" : "배송지 수정 폼 열림";

          console.log(`[배송지] ${message} (action: ${editResult.action})`);

          steps.push({
            step: stepName,
            success: true,
            detail: editResult,
          });

          // 배송지 폼 열림 - 여기서 멈춤
          return res.json({
            success: true,
            vendor: vendor.name,
            message,
            action: editResult.action,
            addressCount: editResult.count,
            steps,
          });
        } else {
          console.log("배송지 버튼 클릭 실패:", editResult.error);
          steps.push({
            step: "shipping_address_button",
            success: false,
            error: editResult.error,
            addressCount: editResult.count,
          });
          // 배송지 처리 실패 - 여기서 멈춤
          return res.json({
            success: false,
            vendor: vendor.name,
            error: editResult.count === 0
              ? "배송지 추가 버튼 클릭 실패"
              : "배송지 수정 버튼 클릭 실패",
            addressCount: editResult.count,
            steps,
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
        return res.json({
          success: false,
          vendor: vendor.name,
          error: "배송지 변경 버튼 클릭 실패",
          steps,
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
      return res.json({
        success: false,
        vendor: vendor.name,
        error: e.message,
        steps,
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
      return { success: false, error: "#purchase > button 버튼을 찾을 수 없음" };
    });

    console.log("결제하기 버튼 결과:", JSON.stringify(paymentClicked));

    if (paymentClicked.success) {
      await delay(3000); // 쿠팡페이 팝업/결제 화면 로딩 대기
      steps.push({
        step: "payment_click",
        success: true,
        detail: paymentClicked,
      });

      // 쿠팡페이 비밀번호 입력
      if (vendor.paymentPin) {
        console.log("Step 7-1: 쿠팡페이 비밀번호 입력...");
        try {
          const pinEntered = await enterCoupangPayPin(page, vendor.paymentPin);
          console.log("비밀번호 입력 결과:", JSON.stringify(pinEntered));
          steps.push({
            step: "payment_pin",
            success: pinEntered.success,
            detail: pinEntered,
          });

          if (pinEntered.success) {
            await delay(3000); // 결제 처리 대기
          }
        } catch (e) {
          console.log("비밀번호 입력 실패:", e.message);
          steps.push({
            step: "payment_pin",
            success: false,
            error: e.message,
          });
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
          steps.push({
            step: "payment_complete",
            success: true,
            orderNumber: pageState.orderNumber,
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
    const quantity = product.quantity || 1;
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
      productUrl: product.productUrl,
      quantity: quantity,
      lineId: lineIds?.[i] || null,
      orderNumber: paymentStep?.orderNumber || null,
      orderAmount: paymentStep?.orderAmount || null,
      priceMismatch: priceMismatch,
    });
  }

  // 가격 불일치 목록
  const priceMismatchList = productResults.filter(
    (p) => p.priceMismatch?.detected
  );

  // 가격 불일치 HTML 생성 (n8n에서 바로 이메일로 사용 가능)
  let priceMismatchEmailHtml = null;
  if (priceMismatchList.length > 0) {
    const rows = priceMismatchList
      .map((item, i) => {
        const pm = item.priceMismatch;
        const diffColor = pm.difference > 0 ? "#d32f2f" : "#2e7d32";
        return `<tr style="background:${i % 2 ? "#f9f9f9" : "#fff"}">
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${
          pm.productName || "상품"
        }</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${
          item.quantity
        }개</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:#1976d2;font-weight:bold;">${pm.coupangPrice?.toLocaleString()}원</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${pm.expectedPrice?.toLocaleString()}원</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:${diffColor};font-weight:bold;">${
          pm.difference > 0 ? "+" : ""
        }${pm.difference?.toLocaleString()}원 (${pm.differencePercent}%)</td>
      </tr>`;
      })
      .join("");

    priceMismatchEmailHtml = `
<div style="font-family:Arial,sans-serif;max-width:700px;">
  <div style="background:#ff9800;color:white;padding:15px;">
    <b>⚠️ 쿠팡 가격 불일치 - ${priceMismatchList.length}건</b>
  </div>
  <div style="border:1px solid #ddd;border-top:none;padding:15px;">
    <p><b>주문번호:</b> ${paymentStep?.orderNumber || "-"}</p>
    <p><b>총 결제금액:</b> ${
      paymentStep?.orderAmount?.toLocaleString() || "-"
    }원</p>
    <table style="width:100%;border-collapse:collapse;margin-top:10px;">
      <tr style="background:#f0f0f0;">
        <th style="padding:8px 12px;text-align:left;">상품명</th>
        <th style="padding:8px 12px;text-align:right;">수량</th>
        <th style="padding:8px 12px;text-align:right;">쿠팡 가격</th>
        <th style="padding:8px 12px;text-align:right;">협력사 가격<br/><small>(VAT포함)</small></th>
        <th style="padding:8px 12px;text-align:right;">차이</th>
      </tr>
      ${rows}
    </table>
    <p style="margin-top:15px;color:#666;font-size:12px;">
      ※ 쿠팡 가격이 협력사 등록 가격과 다릅니다. 확인이 필요합니다.
    </p>
  </div>
</div>`;
  }

  // 응답 반환 (리스트 형태)
  return res.json({
    success: isPaymentComplete,
    vendor: vendor.name,
    automationType: "product_search",
    paymentMethod: vendor.paymentMethod,
    orderNumber: paymentStep?.orderNumber || null,
    orderAmount: paymentStep?.orderAmount || null,
    totalProducts: products.length,
    // 상품별 결과 리스트
    products: productResults,
    // 가격 불일치 관련
    hasPriceMismatch: priceMismatchList.length > 0,
    priceMismatchCount: priceMismatchList.length,
    priceMismatches: priceMismatchList,
    priceMismatchEmailHtml: priceMismatchEmailHtml,
    // 기존 호환성 유지
    lineIds,
    addedProducts,
    steps,
    currentUrl: page.url(),
    message: isPaymentComplete
      ? priceMismatchList.length > 0
        ? `쿠팡 결제 완료! (${priceMismatchList.length}개 상품 가격 불일치 감지)`
        : "쿠팡 결제 완료!"
      : shippingAddress
      ? "쿠팡 결제 페이지까지 진행됨. 결제 확인 필요."
      : "쿠팡 장바구니 담기 완료. 쿠팡페이로 결제 필요.",
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
        const title = card.querySelector(".address-card__title")?.textContent?.trim();
        const address = card.querySelector(".address-card__text--address")?.textContent?.trim();
        const phone = card.querySelector(".address-card__text--cellphone")?.textContent?.trim();
        const hasEditBtn = !!card.querySelector(".address-card__button--edit");
        return { index, title, address, phone, hasEditBtn };
      }),
    };
  });

  console.log(`[배송지] 배송지 목록: ${addressListInfo.count}개`);
  console.log("[배송지] 목록 상세:", JSON.stringify(addressListInfo.cards, null, 2));

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
  const editBtn = await addressFrame.$(".address-card .address-card__button--edit");
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

  // 비밀번호 입력 UI가 나타날 때까지 대기
  let pinFrame = null;
  let attempts = 0;
  const maxAttempts = 15;

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
      gamma: 0.8,
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
      blur: 0.2,
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
