/**
 * brand.naver.com 전용 상품 처리
 *
 * smartstore와의 차이는 상품 페이지 DOM 일부에만 있음:
 * - 옵션 선택 / 수량 input / 장바구니 버튼: data-shp-* 표준 selector 공통 → order.js 함수 재사용
 * - 가격 표시 영역: container depth + 라벨 텍스트("총 금액" vs "총 상품 금액") 다름 → 이 파일에서 별도 구현
 *
 * 결제/배송지/송장은 네이버페이 통합이라 smartstore와 100% 동일
 * (장바구니 진입 후의 흐름은 order.js의 processNaverOrder가 처리)
 *
 * 진입점: processBrandProduct(page, product)
 *   - order.js의 processProduct가 flow === "brand"일 때 위임 호출
 */

// lazy require로 order.js와의 순환 import 회피
function getOrderModule() {
  return require("./order");
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * brand 페이지: 수량 input 옆 금액 추출
 * smartstore와 달리 container depth가 한 단계 더 깊고 가격이 em 태그 안에 들어있음
 * DOM:
 *   div.B4d4UNorTT (← container)
 *   ├ div.yaZo97DmrM
 *   │ └ div[data-shp-area-id="optquantity"]
 *   │   └ input[type="number"]
 *   └ div.aLJRy_TPU9
 *     └ span.pYUX9XvjuC "20,700"
 */
async function getBrandProductPriceFromQtyInput(page) {
  try {
    const price = await page.evaluate(() => {
      const qtyInput = document.querySelector('input[type="number"]');
      if (!qtyInput) return null;
      const container =
        qtyInput.parentElement?.parentElement?.parentElement;
      if (!container) return null;
      const divs = container.querySelectorAll(":scope > div");
      for (const div of divs) {
        if (div.contains(qtyInput)) continue;
        const priceEl = div.querySelector("span, em");
        if (priceEl) {
          const text = priceEl.textContent.trim();
          const match = text.match(/([\d,]+)/);
          if (match) {
            const v = parseInt(match[1].replace(/,/g, ""), 10);
            if (v > 0) return v;
          }
        }
      }
      return null;
    });
    if (price && price > 0) {
      console.log(`[naver:brand] 수량 옆 금액 추출: ${price.toLocaleString()}원`);
    }
    return price;
  } catch (e) {
    console.log(`[naver:brand] 수량 옆 금액 추출 실패: ${e.message}`);
    return null;
  }
}

/**
 * brand 페이지: "총 금액" 영역에서 가격 추출
 * smartstore의 "총 상품 금액" / "총 수량 N개" → brand는 "총 금액" / "총 N개"
 */
async function getBrandProductPrice(page) {
  try {
    const totalInfo = await page.evaluate(() => {
      const LABEL = "총 금액";
      const labelRe = new RegExp(`${LABEL}[\\s\\S]*?([\\d,]+)원`);
      const qtyRe = /총\s*(\d+)\s*개/;

      const allElements = document.querySelectorAll("*");
      for (const el of allElements) {
        if (el.children.length > 3) continue;
        const text = (el.textContent || "").trim();
        if (!text.includes(LABEL)) continue;

        let container = el.parentElement;
        for (let i = 0; i < 5 && container; i++) {
          const containerText = container.textContent || "";
          const priceMatch = containerText.match(labelRe);
          if (priceMatch) {
            const totalPrice =
              parseInt(priceMatch[1].replace(/,/g, ""), 10) || 0;
            let totalQty = 1;
            const qtyMatch = containerText.match(qtyRe);
            if (qtyMatch) totalQty = parseInt(qtyMatch[1], 10) || 1;
            if (totalPrice > 0) {
              return {
                totalPrice,
                totalQty,
                debug: containerText.substring(0, 200),
              };
            }
          }
          container = container.parentElement;
        }
        break;
      }
      return null;
    });

    if (totalInfo && totalInfo.totalPrice > 0) {
      console.log(
        `[naver:brand] 총 금액: ${totalInfo.totalPrice}원 (수량 ${totalInfo.totalQty}개)`,
      );
      if (totalInfo.debug) {
        console.log(`[naver:brand] 가격 추출 컨텍스트: "${totalInfo.debug}"`);
      }
      return totalInfo.totalPrice;
    }
    console.log(`[naver:brand] 가격 추출 실패 - 라벨("총 금액") 못찾음`);
    return null;
  } catch (error) {
    console.error("[naver:brand] 가격 추출 실패:", error.message);
    return null;
  }
}

/**
 * brand.naver.com 상품 처리 (장바구니 담기까지)
 * 흐름은 smartstore의 processProduct와 동일, 가격 추출 단계만 brand 전용
 */
async function processBrandProduct(page, product) {
  const {
    productUrl,
    productName,
    quantity,
    openMallOptions,
    openMallAdditionalOptions,
  } = product;

  const orderModule = getOrderModule();
  const { selectOptions, selectAdditionalOptions, setQuantity, addToCart, withNlAu } =
    orderModule;

  console.log(`\n[naver:brand] 상품 처리: ${productName || productUrl}`);
  console.log(`[naver:brand] URL: ${productUrl}`);
  console.log(`[naver:brand] 수량: ${quantity}`);
  if (openMallOptions) {
    console.log(
      `[naver:brand] 옵션: ${Array.isArray(openMallOptions) ? openMallOptions.length + "개" : "없음"}`,
    );
  }
  if (openMallAdditionalOptions) {
    console.log(
      `[naver:brand] 추가옵션: ${Array.isArray(openMallAdditionalOptions) ? openMallAdditionalOptions.length + "개" : "없음"}`,
    );
  }

  // 1. 상품 페이지로 이동
  const navUrl = withNlAu(productUrl);
  if (navUrl !== productUrl) {
    console.log(`[naver:brand] URL nl-au 부여: ${navUrl}`);
  }
  await page.goto(navUrl, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(2000);

  // 2. 수량 계산 (openMallQtyPerUnit 적용)
  const baseQuantity = quantity || 1;
  const qtyPerUnit = product.openMallQtyPerUnit || 1;
  const actualQuantity = baseQuantity * qtyPerUnit;
  if (qtyPerUnit > 1) {
    console.log(
      `[naver:brand] 수량 변환: ${baseQuantity}개 × ${qtyPerUnit} = ${actualQuantity}개`,
    );
  }

  // 3. 옵션 선택 (공용)
  const optionResult = await selectOptions(page, openMallOptions, actualQuantity);
  if (!optionResult.success) {
    console.log(
      `[naver:brand] ⚠️ 상품 스킵 (옵션 선택 실패) → 담당자 확인 필요: ${optionResult.reason}`,
    );
    return {
      success: false,
      productName,
      quantity,
      openMallPrice: null,
      priceMismatch: false,
      optionFailed: true,
      optionFailReason: optionResult.reason,
      needsManagerVerification: true,
    };
  }
  await delay(1000);

  // 4. 수량 설정 (옵션에서 처리 안 한 경우만)
  if (!optionResult.quantityHandled) {
    console.log(`[naver:brand] 수량 설정: ${actualQuantity}개`);
    const qtyResult = await setQuantity(page, actualQuantity);
    if (!qtyResult) {
      console.log(`[naver:brand] ❌ 수량 설정 실패 - 상품 스킵`);
      return { success: false, error: `수량 설정 실패: 기대=${actualQuantity}` };
    }
    await delay(500);
  } else {
    console.log(`[naver:brand] 수량 설정 스킵 (그룹화 옵션에서 이미 처리됨)`);
  }

  // 5. 추가상품 옵션 (공용)
  if (openMallAdditionalOptions) {
    const additionalResult = await selectAdditionalOptions(
      page,
      openMallAdditionalOptions,
      actualQuantity,
    );
    if (!additionalResult.success) {
      console.log(
        `[naver:brand] ❌ 상품 스킵 (추가옵션 선택 실패): ${additionalResult.reason}`,
      );
      return {
        success: false,
        productName,
        quantity,
        openMallPrice: null,
        priceMismatch: false,
        optionFailed: true,
        optionFailReason: additionalResult.reason,
      };
    }
  }

  // 6. 가격 추출 (brand 전용)
  await delay(500);
  const openMallPrice =
    (await getBrandProductPriceFromQtyInput(page)) ||
    (await getBrandProductPrice(page));

  // 7. 장바구니에 담기 (공용)
  const cartResult = await addToCart(page);
  if (!cartResult.success) {
    console.log(`[naver:brand] ❌ 장바구니 담기 실패: ${cartResult.error}`);
    return {
      success: false,
      productName,
      quantity,
      openMallPrice: null,
      priceMismatch: false,
      cartFailed: true,
      cartFailReason: cartResult.error,
    };
  }

  // 8. 가격 비교
  const vendorPriceExcludeVat = product.vendorPriceExcludeVat || 0;
  const expectedPrice = Math.round(vendorPriceExcludeVat * 1.1);
  const ourQuantity = product.quantity || 1;
  const openMallUnitPrice = Math.round(openMallPrice / ourQuantity);
  let priceMismatch = false;
  if (!openMallPrice) {
    console.error(
      `[naver:brand] ❌ 가격 추출 실패: 총 금액을 찾을 수 없음 (URL: ${product.productUrl})`,
    );
    priceMismatch = true;
  } else if (expectedPrice > 0) {
    if (ourQuantity > 1) {
      console.log(
        `[naver:brand] 가격 비교: 총액 ${openMallPrice}원 / 우리수량 ${ourQuantity} = 단가 ${openMallUnitPrice}원`,
      );
    }
    if (openMallUnitPrice !== expectedPrice) {
      console.log(
        `[naver:brand] ⚠️ 가격 불일치: 오픈몰 단가 ${openMallUnitPrice}원 vs 예상가 ${expectedPrice}원 (VAT별도 ${vendorPriceExcludeVat}원)`,
      );
      priceMismatch = true;
    } else {
      console.log(`[naver:brand] ✅ 가격 일치: ${openMallUnitPrice}원`);
    }
  }

  console.log("[naver:brand] 장바구니 담기 완료");
  return {
    success: true,
    productName,
    quantity,
    openMallPrice,
    vendorPriceExcludeVat,
    priceMismatch,
  };
}

module.exports = {
  processBrandProduct,
  getBrandProductPriceFromQtyInput,
  getBrandProductPrice,
};
