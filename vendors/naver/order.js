/**
 * 네이버 스마트스토어 주문 모듈
 *
 * 처리 방식: 배치 (여러 상품 장바구니 → 일괄 결제)
 *
 * 흐름:
 * 1. 상품 페이지 이동
 * 2. 옵션 선택 (openMallOptions - 2D 구조 지원)
 * 3. 수량 설정 (openMallQtyPerUnit 적용)
 * 4. 추가상품 옵션 선택 (openMallAdditionalOptions)
 * 5. 장바구니 담기
 * 6. 모든 상품 담은 후 → 주문/결제 (네이버페이)
 * 7. saveOrderResults 호출
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
 */

const { login } = require("./login");
const Tesseract = require("tesseract.js");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
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
const { getEnv } = require("../config");
const { verifyShippingAddressOnPage } = require("../../lib/address-verify");

// 딜레이 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 통관정보 동적으로 가져오기
function getCustomsInfo() {
  return {
    code: getEnv("CUSTOMS_CODE"),
    name: getEnv("CUSTOMS_NAME"),
    phone: getEnv("CUSTOMS_PHONE"),
  };
}

// 임시 디렉토리
const tempDir = "/tmp/naver_ocr";

// 셀렉터 상수
const SELECTORS = {
  // 상품 페이지
  product: {
    // 옵션 선택
    optionSelect: "select._combination_option",
    optionSelectByIndex: (i) =>
      `select._combination_option:nth-of-type(${i + 1})`,
    optionItem: (value) => `option[value*="${value}"]`,
    // 수량 (data attribute 기반 - styled-components 클래스 변경 대응)
    quantityInput: '[data-shp-area-id="optquantity"] input[type="number"]',
    quantityPlus: '[data-shp-area-id="optquantity"] button:last-child',
    quantityMinus: '[data-shp-area-id="optquantity"] button:first-child',
    // 버튼
    buyNowBtn: "a._naver_pay_btn, button._naver_pay_btn, a.npay_btn_pay",
    addToCartBtn: "a._basket, button._basket, a.npay_btn_cart",
    // 가격
    totalPrice: "strong._total_price, span._total_price",
    // 상품 가격 (옵션 선택 후)
    productPrice: "strong span.e1DMQNBPJ_",
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
 * 개인통관고유부호 입력 처리 (해외직배송 상품)
 * @param {Page} page - 메인 페이지 또는 팝업 페이지
 * @returns {Object} { success: boolean, reason?: string, handled?: boolean }
 */
async function handleCustomsCode(page) {
  console.log("[naver] 통관고유부호 처리 확인...");

  // 통관정보 동적으로 가져오기
  const customsInfo = getCustomsInfo();

  // 통관정보가 없으면 스킵
  if (!customsInfo.code) {
    console.log("[naver] 통관정보 환경변수가 설정되지 않음 (CUSTOMS_CODE)");
    return {
      success: false,
      reason: "customs_info_not_configured",
      handled: false,
    };
  }

  // 1. 개인통관고유부호 섹션 내 "입력" 버튼 찾기 (재시도 포함)
  // 섹션 헤더 h3에 "통관" 텍스트가 있고, 버튼은 "입력"만 있는 구조
  // ContentSection_article > SectionHeader_article(h3) + ContentWrapper_article(button)
  let customsBtn = null;
  for (let retry = 0; retry < 5; retry++) {
    // 디버깅: 페이지에 통관 관련 요소가 있는지 확인
    const debugInfo = await page.evaluate(() => {
      const h3s = [...document.querySelectorAll("h3")].map(h => h.textContent?.trim());
      const customsH3 = h3s.find(t => t && t.includes("통관"));
      let sectionInfo = null;
      if (customsH3) {
        const h3El = [...document.querySelectorAll("h3")].find(h => (h.textContent || "").includes("통관"));
        const csSection = h3El?.closest("div[class*='ContentSection']");
        const parentClasses = [];
        let p = h3El?.parentElement;
        for (let i = 0; i < 5 && p; i++) {
          parentClasses.push(p.className?.split(" ")[0] || p.tagName);
          const btn = p.querySelector("button");
          if (btn) {
            sectionInfo = { level: i, class: p.className?.split(" ")[0], btnText: btn.textContent?.trim() };
            break;
          }
          p = p.parentElement;
        }
        if (!sectionInfo) sectionInfo = { parentClasses, csSection: !!csSection };
      }
      return { h3s: h3s.filter(Boolean), customsH3, sectionInfo };
    });
    console.log(`[naver] 통관 디버깅 (${retry + 1}/5):`, JSON.stringify(debugInfo));

    customsBtn = await page.evaluateHandle(() => {
      // 방법 1: "통관" h3 → ContentSection 래퍼 → 그 안의 button
      const headings = document.querySelectorAll("h3");
      for (const h3 of headings) {
        if ((h3.textContent || "").includes("통관")) {
          // ContentSection_article이 h3와 button을 모두 감싸는 최상위 래퍼
          const section = h3.closest("div[class*='ContentSection']");
          if (section) {
            const btn = section.querySelector("button");
            if (btn) return btn;
          }
          // 폴백: h3 기준으로 충분히 위로 올라가서 button 탐색
          let parent = h3.parentElement;
          for (let i = 0; i < 5 && parent; i++) {
            const btn = parent.querySelector("button");
            if (btn) return btn;
            parent = parent.parentElement;
          }
        }
      }
      // 방법 2: 버튼 텍스트에 "통관" + "입력" 둘 다 포함
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = (btn.textContent || "").trim();
        if (text.includes("통관") && text.includes("입력")) {
          return btn;
        }
      }
      return null;
    });

    const isValid = await page.evaluate((el) => el instanceof HTMLElement, customsBtn);
    if (isValid) {
      console.log("[naver] 통관 버튼 찾기 성공");
      break;
    }
    customsBtn = null;
    console.log(`[naver] 통관 버튼 탐색 중... (${retry + 1}/5)`);
    await delay(1000);
  }

  if (!customsBtn) {
    console.log("[naver] 통관고유부호 입력 버튼 없음 (해외직배송 상품 아님)");
    return { success: true, handled: false };
  }

  console.log("[naver] 통관고유부호 입력 버튼 발견 - 해외직배송 상품");
  await customsBtn.click();
  await delay(2000);

  // 2. 새 팝업 대기 (통관 입력은 팝업에서 진행)
  const browser = page.browser();
  const customsPopupPromise = new Promise((resolve) => {
    browser.once("targetcreated", async (target) => {
      if (target.type() === "page") {
        const newPage = await target.page();
        console.log("[naver] 통관 팝업 감지:", target.url());
        resolve(newPage);
      }
    });
    setTimeout(() => resolve(null), 5000);
  });

  const customsPopup = await customsPopupPromise;
  const targetPage = customsPopup || page; // 팝업이 없으면 메인 페이지에서 진행

  if (customsPopup) {
    console.log("[naver] 통관 팝업 열림");
    await delay(2000);
  }

  // 3. 통관부호 입력 (input 필드 - 텍스트 기반 탐색)
  const customsInput = await targetPage.evaluateHandle(() => {
    // CSS 셀렉터 폴백
    const cssInput = document.querySelector("#content input[type='text'], #content input:not([type])");
    if (cssInput) return cssInput;
    // 모든 input 중 통관 관련 섹션 내 input
    const inputs = document.querySelectorAll("input");
    for (const input of inputs) {
      const section = input.closest("div[class*='CustomsModal'], div[class*='PersonalCustoms']");
      if (section) return input;
    }
    return null;
  });

  const hasCustomsInput = await targetPage.evaluate((el) => el instanceof HTMLElement, customsInput);
  if (hasCustomsInput) {
    await customsInput.click({ clickCount: 3 });
    await customsInput.type(customsInfo.code, { delay: 30 });
    console.log(`[naver] 통관부호 입력: ${customsInfo.code}`);
    await delay(500);
  } else {
    console.log("[naver] 통관부호 입력 필드를 찾을 수 없음");
    return { success: false, reason: "customs_input_not_found", handled: true };
  }

  // 4. "동의하고 입력하기" 버튼 클릭 (정확한 텍스트 매칭)
  const agreeClicked = await targetPage.evaluate(() => {
    const buttons = document.querySelectorAll("button");
    for (const btn of buttons) {
      const text = (btn.textContent || "").trim();
      if (text === "동의하고 입력하기") {
        btn.click();
        return text;
      }
    }
    // 폴백: "입력하기" 포함
    for (const btn of buttons) {
      const text = (btn.textContent || "").trim();
      if (text.includes("입력하기")) {
        btn.click();
        return text;
      }
    }
    return null;
  });

  if (agreeClicked) {
    console.log(`[naver] 동의하고 입력하기 버튼 클릭: "${agreeClicked}"`);
    await delay(2000);
  } else {
    console.log("[naver] 동의하고 입력하기 버튼을 찾을 수 없음");
    return { success: false, reason: "agree_button_not_found", handled: true };
  }

  // 4-1. 개인정보 제3자 제공 동의 모달 처리 (#CENTER_MODAL > button "확인")
  for (let i = 0; i < 5; i++) {
    const modalClicked = await targetPage.evaluate(() => {
      const modalBtn = document.querySelector("#CENTER_MODAL > button");
      if (modalBtn) {
        modalBtn.click();
        return (modalBtn.textContent || "").trim();
      }
      return null;
    });
    if (modalClicked) {
      console.log(`[naver] 개인정보 동의 모달 확인 클릭: "${modalClicked}"`);
      await delay(2000);
      break;
    }
    await delay(500);
  }

  // 5. 관세청 정보 불일치 - CheckInfo 영역 내 "수정" 버튼 클릭
  // evaluate 내부에서 scrollIntoView + click (evaluateHandle 외부 click은 에러 발생 가능)
  let editClicked = false;
  for (let i = 0; i < 5; i++) {
    const result = await targetPage.evaluate(() => {
      // 방법 1: CheckInfo 영역 내 수정 버튼
      const checkInfoBtn = document.querySelector("div[class*='CheckInfo_area-button'] button");
      if (checkInfoBtn && checkInfoBtn.textContent?.trim() === "수정") {
        checkInfoBtn.scrollIntoView({ block: "center" });
        checkInfoBtn.click();
        return "수정";
      }
      // 방법 2: 텍스트 기반 폴백
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        if ((btn.textContent || "").trim() === "수정") {
          btn.scrollIntoView({ block: "center" });
          btn.click();
          return "수정";
        }
      }
      return null;
    });
    if (result) {
      console.log("[naver] 관세청 정보 불일치 - 수정 버튼 클릭");
      editClicked = true;
      await delay(2000);
      break;
    }
    await delay(500);
  }

  if (editClicked) {
    // 6. 이름 변경 - CheckInfo 영역에서 "이름" 라벨 옆 input 찾기
    if (customsInfo.name) {
      const nameChanged = await targetPage.evaluate((newName) => {
        // "이름" 라벨이 있는 li → 그 안의 input
        const labels = document.querySelectorAll("div[class*='CheckInfo'] span[class*='CheckInfo_label']");
        for (const label of labels) {
          if ((label.textContent || "").trim() === "이름") {
            const li = label.closest("li");
            if (li) {
              const input = li.querySelector("input[type='text']");
              if (input && !input.disabled && !input.readOnly) {
                // 삭제 버튼으로 기존 값 클리어
                const delBtn = li.querySelector("button[class*='button-delete']");
                if (delBtn) delBtn.click();
                // nativeInputValueSetter로 값 설정
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeSetter.call(input, newName);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return { old: input.defaultValue, new: newName };
              }
            }
          }
        }
        return null;
      }, customsInfo.name);

      if (nameChanged) {
        console.log(`[naver] 받는 이 변경: ${customsInfo.name}`);
      } else {
        console.log("[naver] 이름 input 필드를 찾을 수 없음");
      }
    }

    // 6-1. 연락처 변경 - "연락처" 라벨 옆 input[type='tel'] 찾기
    if (customsInfo.phone) {
      const phoneChanged = await targetPage.evaluate((newPhone) => {
        const labels = document.querySelectorAll("div[class*='CheckInfo'] span[class*='CheckInfo_label']");
        for (const label of labels) {
          if ((label.textContent || "").trim() === "연락처") {
            const li = label.closest("li");
            if (li) {
              const input = li.querySelector("input[type='tel']");
              if (input && !input.disabled && !input.readOnly) {
                const delBtn = li.querySelector("button[class*='button-delete']");
                if (delBtn) delBtn.click();
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeSetter.call(input, newPhone);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
            }
          }
        }
        return null;
      }, customsInfo.phone);

      if (phoneChanged) {
        console.log(`[naver] 연락처 변경: ${customsInfo.phone}`);
      } else {
        console.log("[naver] 연락처 input 필드를 찾을 수 없음");
      }
    }
    await delay(500);

    // 6-1. 저장 버튼 클릭 (수정 → 저장으로 변경됨)
    const saveClicked = await targetPage.evaluate(() => {
      // CheckInfo 영역 내 저장 버튼
      const checkInfoBtn = document.querySelector("div[class*='CheckInfo_area-button'] button");
      if (checkInfoBtn) {
        const text = (checkInfoBtn.textContent || "").trim();
        if (text === "저장" || text === "완료") {
          checkInfoBtn.scrollIntoView({ block: "center" });
          checkInfoBtn.click();
          return text;
        }
      }
      // 텍스트 기반 폴백
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = (btn.textContent || "").trim();
        if (text === "저장" || text === "완료") {
          btn.scrollIntoView({ block: "center" });
          btn.click();
          return text;
        }
      }
      return null;
    });
    if (saveClicked) {
      console.log(`[naver] 받는 분 정보 저장: "${saveClicked}"`);
      await delay(2000);
    }
  }

  // 7. 최종 "확인" 버튼 클릭 (CustomsModal 하단 녹색 확인 버튼)
  const confirmClicked = await targetPage.evaluate(() => {
    // 방법 1: CustomsModal 하단 확인 버튼
    const modalBtn = document.querySelector("div[class*='CustomsModal_area-button'] button");
    if (modalBtn) {
      modalBtn.scrollIntoView({ block: "center" });
      modalBtn.click();
      return (modalBtn.textContent || "").trim();
    }
    // 방법 2: primary 스타일 확인 버튼
    const buttons = document.querySelectorAll("button");
    for (const btn of buttons) {
      const text = (btn.textContent || "").trim();
      if (text === "확인" && btn.className?.includes("primary")) {
        btn.scrollIntoView({ block: "center" });
        btn.click();
        return text;
      }
    }
    return null;
  });
  if (confirmClicked) {
    console.log(`[naver] 통관 최종 확인 버튼 클릭: "${confirmClicked}"`);
    await delay(2000);
  }

  console.log("[naver] 통관고유부호 처리 완료");
  return { success: true, handled: true };
}

/**
 * 상품 가격 추출
 * @param {Page} page - Puppeteer 페이지
 * @returns {number|null} 가격 (원)
 */
async function getProductPrice(page) {
  try {
    const priceText = await page.$eval(SELECTORS.product.productPrice, (el) =>
      el.textContent.trim(),
    );
    // "6,500" → 6500
    const price = parseInt(priceText.replace(/[^0-9]/g, ""), 10);
    console.log(`[naver] 상품 가격: ${priceText} → ${price}원`);
    return price;
  } catch (error) {
    console.error("[naver] 가격 추출 실패:", error.message);
    return null;
  }
}

/**
 * 단일 옵션 선택 (내부 헬퍼 함수)
 * @param {Page} page
 * @param {Object} option - { title: "상품선택", value: "..." }
 * @returns {Object} { success: boolean, reason?: string }
 */
async function selectSingleOption(page, option) {
  // 네이버 스마트스토어 옵션 버튼 찾기 (data-shp-contents-type 속성으로 매칭, 클래스명은 빌드마다 변경됨)
  const optionBtn = await page.$(`a[data-shp-contents-type="${option.title}"]`);

  if (optionBtn) {
    // 옵션 드롭다운 버튼 클릭
    await optionBtn.click();
    console.log(`[naver] 옵션 드롭다운 열기: ${option.title}`);
    await delay(1000);

    // 드롭다운에서 옵션 값 선택 (li 항목 중 텍스트 매칭 - 정확히 일치만 허용)
    const selected = await page.evaluate((targetValue) => {
      const items = document.querySelectorAll(
        "ul[role='listbox'] li a, div[role='listbox'] li a, .option_list li a",
      );
      for (const item of items) {
        const rawText = item.textContent?.trim() || "";
        // 가격 부분 제거: "무지긴팔 (-3,500원)" → "무지긴팔"
        const text = rawText.replace(/\s*\([+-]?[\d,]+원\)\s*$/, "").trim();
        // 띄어쓰기 모두 제거 후 비교
        const normalize = s => s.replace(/\s/g, '');
        if (normalize(text) === normalize(targetValue)) {
          item.click();
          return rawText;
        }
      }
      return null;
    }, option.value);

    if (selected) {
      console.log(`[naver] 옵션 선택됨: ${selected}`);
      await delay(1000);
      return { success: true, selectedValue: selected };
    } else {
      // 옵션 값 매칭 실패 → 실패 반환
      console.log(`[naver] ❌ 옵션 값 매칭 실패: ${option.value}`);
      return {
        success: false,
        reason: `옵션 값 매칭 실패: ${option.title} = ${option.value}`,
      };
    }
  } else {
    // 옵션 버튼 없음 → 실패 반환
    console.log(`[naver] ❌ 옵션 버튼 없음: ${option.title}`);
    return { success: false, reason: `옵션 버튼 없음: ${option.title}` };
  }
}

/**
 * 옵션 선택 (2D 세트 구조)
 * @param {Page} page
 * @param {Array} openMallOptions - [{options: [{title, value}, ...]}, ...]
 * @param {number} quantity - 수량 (각 세트 선택 후 설정)
 * @returns {Object} { success: boolean, reason?: string, groupsProcessed?: number }
 *
 * 2D 구조 예시:
 * [{options: [{title: "박스 옵션", value: "1"}, {title: "테이프 옵션", value: "1"}]},
 *  {options: [{title: "박스 옵션", value: "2"}, {title: "테이프 옵션", value: "2"}]}]
 *
 * → 세트1: 박스 옵션=1, 테이프 옵션=1 → 수량 설정
 * → 세트2: 박스 옵션=2, 테이프 옵션=2 → 수량 설정
 */
async function selectOptions(page, openMallOptions, quantity = 1) {
  // 옵션이 없으면 성공으로 처리 (옵션 선택 불필요)
  if (!openMallOptions || openMallOptions.length === 0) {
    console.log("[naver] 옵션 없음, 스킵");
    return { success: true, skipped: true, quantityHandled: false };
  }

  // 문자열이면 JSON 파싱
  let options = openMallOptions;
  if (typeof openMallOptions === "string") {
    try {
      options = JSON.parse(openMallOptions);
      console.log("[naver] 옵션 JSON 파싱 완료");
    } catch (e) {
      return { success: false, reason: `옵션 JSON 파싱 실패: ${e.message}` };
    }
  }

  // 파싱 후 빈 배열이면 옵션 없음 처리
  if (!options || (Array.isArray(options) && options.length === 0)) {
    console.log("[naver] 옵션 없음 (빈 배열), 스킵");
    return { success: true, skipped: true, quantityHandled: false };
  }

  // 2D 구조 검증: [{options: [{title, value}, ...]}, ...]
  const is2DStructure = options[0] && Array.isArray(options[0].options);

  if (is2DStructure) {
    console.log(`[naver] 옵션 세트 처리: ${options.length}개 세트`);

    for (let s = 0; s < options.length; s++) {
      const set = options[s];
      const setOptions = set.options || [];

      console.log(
        `[naver] --- 세트 ${s + 1}/${options.length} 처리 시작 (${setOptions.length}개 옵션) ---`,
      );

      // 세트 내 모든 옵션 선택
      for (let i = 0; i < setOptions.length; i++) {
        const option = setOptions[i];

        // 옵션 유효성 검사
        if (!option || !option.title || !option.value) {
          return {
            success: false,
            reason: `세트 ${s + 1} 옵션 ${i + 1} 데이터 오류: ${JSON.stringify(option)}`,
          };
        }

        console.log(
          `[naver] 세트 ${s + 1}, 옵션 ${i + 1}: ${option.title} = ${option.value}`,
        );
        await delay(500);

        const result = await selectSingleOption(page, option);
        if (!result.success) {
          return result;
        }
      }

      // 세트 내 모든 옵션 선택 후 수량 설정
      console.log(
        `[naver] 세트 ${s + 1} 옵션 선택 완료, 수량 설정: ${quantity}개`,
      );
      const qtyOk = await setQuantity(page, quantity);
      if (!qtyOk) {
        return { success: false, reason: `세트 ${s + 1} 수량 설정 실패: 기대=${quantity}` };
      }
      await delay(500);
    }

    return {
      success: true,
      groupsProcessed: options.length,
      quantityHandled: true,
    };
  }

  // 2D 구조가 아닌 경우 에러
  return {
    success: false,
    reason: "잘못된 옵션 구조: 2D 구조 [{options: [...]}] 형식이어야 합니다",
  };
}

/**
 * 추가상품 옵션 선택
 * @param {Page} page
 * @param {Array|string} openMallAdditionalOptions - [{type: "SELECT", title: "...", value: "..."}]
 * @param {number} quantity - 수량 (메인 상품과 동일)
 * @returns {Object} { success: boolean, reason?: string }
 */
async function selectAdditionalOptions(
  page,
  openMallAdditionalOptions,
  quantity = 1,
) {
  if (!openMallAdditionalOptions || openMallAdditionalOptions.length === 0) {
    return { success: true, skipped: true };
  }

  let options = openMallAdditionalOptions;
  if (typeof openMallAdditionalOptions === "string") {
    try {
      options = JSON.parse(openMallAdditionalOptions);
    } catch (e) {
      return {
        success: false,
        reason: `추가옵션 JSON 파싱 실패: ${e.message}`,
      };
    }
  }

  if (!options || (Array.isArray(options) && options.length === 0)) {
    return { success: true, skipped: true };
  }

  console.log(`[naver] 추가상품 옵션 처리: ${options.length}개`);

  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    if (!option || !option.title || !option.value) {
      return {
        success: false,
        reason: `추가옵션 ${i + 1} 데이터 오류: ${JSON.stringify(option)}`,
      };
    }

    console.log(`[naver] 추가옵션 ${i + 1}: ${option.title} = ${option.value}`);
    await delay(500);

    const result = await selectSingleOption(page, option);
    if (!result.success) {
      return { success: false, reason: `추가옵션 실패: ${result.reason}` };
    }

    // 추가상품은 prepend로 first-child에 생김 → 수량 설정
    if (quantity > 1) {
      console.log(`[naver] 추가상품 수량 설정: ${quantity}개`);
      const qtyOk = await setQuantity(page, quantity);
      if (!qtyOk) {
        return { success: false, reason: `추가상품 수량 설정 실패: 기대=${quantity}` };
      }
      await delay(500);
    }
  }

  console.log("[naver] 추가상품 옵션 선택 완료");
  return { success: true };
}

/**
 * 수량 설정
 */
async function setQuantity(page, quantity) {
  if (quantity <= 1) return true;

  console.log(`[naver] 수량 설정: ${quantity}개`);

  // 수량 입력 필드 찾기 (data attribute 기반 - styled-components 대응)
  const quantityInput = await page.$(
    '[data-shp-area-id="optquantity"] input[type="number"]',
  );

  if (quantityInput) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await quantityInput.click({ clickCount: 3 });
      await delay(300);
      await page.keyboard.type(String(quantity), { delay: 50 });
      await delay(300);
      await page.keyboard.press('Tab');
      await delay(500);

      // 입력된 값 검증
      const actualValue = await page.evaluate(
        (sel) => {
          const input = document.querySelector(sel);
          return input ? Number(input.value) : null;
        },
        '[data-shp-area-id="optquantity"] input[type="number"]',
      );

      if (actualValue === quantity) {
        console.log(`[naver] 수량 입력 완료: ${quantity}개 (검증 OK)`);
        return true;
      }

      console.log(`[naver] ⚠️ 수량 불일치 (시도 ${attempt}/3): 입력=${quantity}, 실제=${actualValue}`);
      await delay(500);
    }
    console.log(`[naver] ❌ 수량 설정 3회 실패: 기대=${quantity}`);
    return false;
  }

  // 플러스 버튼으로 수량 증가 (blind 텍스트 기반)
  const plusBtn = await page.evaluateHandle(() => {
    const spans = document.querySelectorAll('span.blind');
    for (const span of spans) {
      if (span.textContent.includes('수량 추가')) {
        return span.closest('button');
      }
    }
    return null;
  });

  if (plusBtn && plusBtn.asElement()) {
    for (let i = 1; i < quantity; i++) {
      await plusBtn.click();
      await delay(300);
    }
    // 검증
    const actualValue = await page.evaluate(
      (sel) => {
        const input = document.querySelector(sel);
        return input ? Number(input.value) : null;
      },
      '[data-shp-area-id="optquantity"] input[type="number"]',
    );
    if (actualValue === quantity) {
      console.log(`[naver] 수량 증가 버튼 ${quantity - 1}회 클릭 완료 (검증 OK: ${actualValue}개)`);
      return true;
    }
    console.log(`[naver] ⚠️ 수량 불일치: 기대=${quantity}, 실제=${actualValue}`);
    return false;
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

  // 선택 삭제 버튼 찾기 (텍스트 기반)
  const deleteBtnHandle = await page.evaluateHandle(() => {
    const buttons = document.querySelectorAll("button");
    for (const btn of buttons) {
      const text = (btn.textContent || "").trim();
      if (text === "선택 삭제" || text === "선택삭제") {
        return btn;
      }
    }
    return null;
  });

  const isValid = await page.evaluate((el) => el instanceof HTMLElement, deleteBtnHandle);
  if (isValid) {
    await deleteBtnHandle.click();
    console.log("[naver] 선택 삭제 버튼 클릭");
    await delay(1000);

    // 커스텀 모달 확인 버튼 클릭
    const confirmed = await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = (btn.textContent || "").trim();
        if (text === "확인" && btn.closest("[class*='modal']")) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (confirmed) {
      console.log("[naver] 장바구니 삭제 확인 클릭");
    } else {
      console.log("[naver] 삭제 확인 모달을 찾을 수 없음");
    }
    await delay(2000);
    console.log("[naver] 장바구니 비우기 완료");
  } else {
    console.log("[naver] 장바구니가 비어있음 (삭제 버튼 없음)");
  }

  return true;
}

/**
 * 배송지 수정 (팝업에서 첫 번째 주소 수정)
 * @param {Page} popupPage - 팝업 페이지
 * @param {Object} shippingAddress - 배송지 정보
 * @returns {Object} { success: boolean, reason?: string }
 */
async function modifyDeliveryAddress(popupPage, shippingAddress) {
  console.log("[naver] 배송지 수정 시작...");

  try {
    // 1. 첫 번째 주소의 "수정" 버튼 클릭
    const editBtnSelector =
      "#content > div > ul > li:nth-child(1) > div > div.DeliveryList_area-button__RQrYY > button:nth-child(1)";

    // 대체 셀렉터들
    const editBtnSelectors = [
      editBtnSelector,
      "ul.DeliveryList_article__bH\\+FQ li:first-child button:first-child",
      "[class*='DeliveryList_item'] [class*='area-button'] button:first-child",
    ];

    let editBtn = null;
    for (const selector of editBtnSelectors) {
      try {
        editBtn = await popupPage.$(selector);
        if (editBtn) {
          console.log(
            `[naver] 수정 버튼 찾음: ${selector.substring(0, 50)}...`,
          );
          break;
        }
      } catch (e) {
        // 셀렉터 오류 무시
      }
    }

    // 텍스트 기반 폴백
    if (!editBtn) {
      console.log("[naver] 텍스트 기반으로 수정 버튼 검색...");
      editBtn = await popupPage.evaluateHandle(() => {
        const buttons = document.querySelectorAll("button");
        for (const btn of buttons) {
          if (btn.textContent?.trim() === "수정") {
            return btn;
          }
        }
        return null;
      });
    }

    if (!editBtn || !(await editBtn.asElement())) {
      console.log("[naver] 수정 버튼을 찾을 수 없음");
      return { success: false, reason: "edit_button_not_found" };
    }

    await editBtn.click();
    console.log("[naver] 수정 버튼 클릭");
    await delay(2000); // 폼 렌더링 대기

    // 2. 폼 필드 입력
    const receiverName = shippingAddress.firstName;
    const phone = shippingAddress.phone;

    // 배송지명 = 받는이 (동일하게)
    const deliveryName = receiverName || "배송지";

    // 전체 지우기 버튼 셀렉터
    const clearBtnSelectors = {
      receiver:
        "#content > div > div.InputAnimationWrapper_article__RjFjk.InputAnimationWrapper_show__835Gz > div > div.InputLineBasic_article__VC\\+ru.InputLineBasic_focus__BJYnn > button",
      contact:
        "#content > div > div.Contact_article__iwSg7 > div.InputAnimationWrapper_article__RjFjk.InputAnimationWrapper_show__835Gz > div > div.InputLineBasic_article__VC\\+ru > button",
      deliveryName:
        "#content > div > div.InputDeliveryName_article__DaSdG > div:nth-child(2) > div > div > button",
    };

    // 받는 이: 지우기 → 입력
    if (receiverName) {
      // 입력 필드 클릭 (focus)
      const receiverInput = await popupPage.$("#receiver");
      if (receiverInput) {
        await receiverInput.click();
        await delay(300);

        // 전체 지우기 버튼 클릭
        try {
          const clearBtn = await popupPage.$(clearBtnSelectors.receiver);
          if (clearBtn) {
            await clearBtn.click();
            console.log("[naver] 받는 이 지우기 버튼 클릭");
            await delay(300);
          }
        } catch (e) {
          console.log("[naver] 받는 이 지우기 버튼 없음, 직접 선택");
          await receiverInput.click({ clickCount: 3 });
        }

        // 입력
        await popupPage.type("#receiver", receiverName, { delay: 30 });
        console.log(`[naver] 받는 이 입력: ${receiverName}`);
      } else {
        console.log("[naver] ❌ #receiver 필드를 찾을 수 없음");
        return { success: false, reason: "receiver_input_not_found" };
      }
    }

    // 연락처: 지우기 → 입력
    if (phone) {
      const contactInput = await popupPage.$("#contact-1");
      if (contactInput) {
        await contactInput.click();
        await delay(300);

        // 전체 지우기 버튼 클릭
        try {
          const clearBtn = await popupPage.$(clearBtnSelectors.contact);
          if (clearBtn) {
            await clearBtn.click();
            console.log("[naver] 연락처 지우기 버튼 클릭");
            await delay(300);
          }
        } catch (e) {
          console.log("[naver] 연락처 지우기 버튼 없음, 직접 선택");
          await contactInput.click({ clickCount: 3 });
        }

        // 전화번호 정규화 (국가코드 제거, 하이픈 제거)
        let cleanPhone = phone.replace(/^\+82/, "0").replace(/[^0-9]/g, "");
        await popupPage.type("#contact-1", cleanPhone, { delay: 30 });
        console.log(`[naver] 연락처 입력: ${cleanPhone}`);
      } else {
        console.log("[naver] ❌ #contact-1 필드를 찾을 수 없음");
        return { success: false, reason: "contact_input_not_found" };
      }
    }

    // 배송지 명: 지우기 → 입력 (받는이와 동일)
    if (deliveryName) {
      const deliveryNameInput = await popupPage.$("#delivery-name");
      if (deliveryNameInput) {
        await deliveryNameInput.click();
        await delay(300);

        // 전체 지우기 버튼 클릭
        try {
          const clearBtn = await popupPage.$(clearBtnSelectors.deliveryName);
          if (clearBtn) {
            await clearBtn.click();
            console.log("[naver] 배송지 명 지우기 버튼 클릭");
            await delay(300);
          }
        } catch (e) {
          console.log("[naver] 배송지 명 지우기 버튼 없음, 직접 선택");
          await deliveryNameInput.click({ clickCount: 3 });
        }

        // 입력
        await popupPage.type("#delivery-name", deliveryName, { delay: 30 });
        console.log(`[naver] 배송지 명 입력: ${deliveryName}`);
      } else {
        console.log("[naver] ❌ #delivery-name 필드를 찾을 수 없음");
        return { success: false, reason: "delivery_name_input_not_found" };
      }
    }

    // 3. 주소 검색 (카카오 API로 정규화된 도로명 주소 사용)
    const postalCode = shippingAddress.postalCode;
    const streetAddress1 = shippingAddress.streetAddress1; // 원본 주소
    const streetAddress2 = shippingAddress.streetAddress2; // 상세 주소

    if (streetAddress1) {
      // 카카오 API로 도로명 주소 정규화
      const { searchAddressWithKakao } = require("../../lib/address-verify");
      const kakaoResult = await searchAddressWithKakao(streetAddress1);
      const searchQuery = kakaoResult?.roadAddress || streetAddress1;
      console.log(`[naver] 카카오 정규화 주소: ${searchQuery} (원본: ${streetAddress1})`);

      // 주소 검색 버튼 클릭 (텍스트 기반)
      const addressSearchBtn = await popupPage.evaluateHandle(() => {
        const buttons = document.querySelectorAll("button");
        for (const btn of buttons) {
          const text = (btn.textContent || "").trim();
          if (text === "주소검색" || text === "주소 검색" || text.includes("검색")) {
            // 주소 관련 섹션 내 버튼인지 확인
            const parent = btn.closest("[class*='Address'], [class*='address'], [class*='Delivery']");
            if (parent) return btn;
          }
        }
        // 폴백: input 근처 버튼
        const addrInput = document.querySelector("input[name='address'], input[placeholder*='주소']");
        if (addrInput) {
          const section = addrInput.closest("div");
          if (section) {
            const btn = section.querySelector("button");
            if (btn) return btn;
          }
        }
        return null;
      });

      if (!addressSearchBtn || !(await addressSearchBtn.asElement())) {
        console.log("[naver] 주소 검색 버튼을 찾을 수 없음");
        return { success: false, reason: "address_search_button_not_found" };
      }

      await addressSearchBtn.click();
      console.log("[naver] 주소 검색 버튼 클릭");
      await delay(2000);

      // 주소 검색 input (type=search 또는 placeholder 기반)
      const searchInput = await popupPage.evaluateHandle(() => {
        const inputs = document.querySelectorAll("input[type='search'], input[type='text']");
        for (const input of inputs) {
          const placeholder = (input.placeholder || "").toLowerCase();
          if (placeholder.includes("주소") || placeholder.includes("도로명") || placeholder.includes("검색")) {
            return input;
          }
        }
        // 폴백: 검색 영역 내 input
        const searchArea = document.querySelector("[class*='Search'], [class*='search']");
        if (searchArea) {
          const input = searchArea.querySelector("input");
          if (input) return input;
        }
        return null;
      });

      if (!searchInput || !(await searchInput.asElement())) {
        console.log("[naver] 주소 검색 input을 찾을 수 없음");
        return { success: false, reason: "address_search_input_not_found" };
      }

      await searchInput.type(searchQuery, { delay: 30 });
      console.log(`[naver] 주소 검색어 입력: ${searchQuery}`);
      await delay(500);

      // 검색 실행 버튼 (텍스트 기반)
      const searchBtn = await popupPage.evaluateHandle(() => {
        const buttons = document.querySelectorAll("button");
        for (const btn of buttons) {
          const text = (btn.textContent || "").trim();
          if (text === "검색" || text === "조회") {
            return btn;
          }
        }
        return null;
      });

      if (!searchBtn || !(await searchBtn.asElement())) {
        // Enter 키로 폴백
        console.log("[naver] 검색 버튼 못찾음, Enter 키로 검색");
        await popupPage.keyboard.press("Enter");
      } else {
        await searchBtn.click();
        console.log("[naver] 주소 검색 버튼 클릭");
      }
      await delay(2000);

      // 주소 검색 결과 첫 번째 항목 선택 → 카카오 도로명/지번 매칭 검증
      const addressSelected = await popupPage.evaluate(() => {
        const allLis = document.querySelectorAll("li");
        for (const li of allLis) {
          const text = (li.textContent || "").trim();
          if (text.length > 10 && (text.includes("로 ") || text.includes("길 ") || text.includes("동 ") || text.match(/\d{5}/))) {
            const btn = li.querySelector("button");
            if (btn) {
              btn.click();
              return { found: true, address: text.substring(0, 150) };
            }
          }
        }
        return { found: false };
      });

      // 선택 후 카카오 매칭 검증 (normalizeAddress로 "광역시/특별시" 등 제거 후 비교)
      if (addressSelected.found && kakaoResult) {
        const { normalizeAddress } = require("../../lib/address-verify");
        const rawSelected = addressSelected.address;
        const normalizedSelected = normalizeAddress(rawSelected);
        const kakaoChecks = [
          kakaoResult.roadAddress,
          kakaoResult.jibunAddress,
          normalizeAddress(kakaoResult.roadAddress),
          normalizeAddress(kakaoResult.jibunAddress),
        ].filter(Boolean);

        const matched = kakaoChecks.some(addr =>
          rawSelected.includes(addr) || normalizedSelected.includes(addr)
        );
        if (matched) {
          console.log(`[naver] ✅ 선택된 주소 카카오 매칭 성공`);
        } else {
          console.error(`[naver] ❌ 선택된 주소가 카카오 결과와 불일치`);
          console.error(`[naver]   선택된: ${addressSelected.address}`);
          console.error(`[naver]   카카오 도로명: ${kakaoResult.roadAddress}`);
          console.error(`[naver]   카카오 지번: ${kakaoResult.jibunAddress}`);
          return { success: false, reason: "address_mismatch_after_select" };
        }
      }

      if (!addressSelected.found) {
        console.log(`[naver] 주소 검색 결과에서 매칭 실패 (후보 ${addressSelected.candidateCount}개)`);
        return { success: false, reason: "address_match_failed" };
      }

      console.log(`[naver] 주소 선택됨: ${addressSelected.method} - ${addressSelected.address}`);
      await delay(1000);

      // 상세 주소 입력 (없으면 받는이 이름 사용)
      const detailText = (streetAddress2 || "").trim() || shippingAddress.firstName || "";
      if (detailText) {
        const detailInput = await popupPage.$("#address-detail");
        if (detailInput) {
          await detailInput.type(detailText, { delay: 30 });
          console.log(`[naver] 상세 주소 입력: ${detailText}`);
        } else {
          console.log("[naver] ❌ 상세주소 input 못찾음");
          return { success: false, reason: "detail_address_input_not_found" };
        }
      }

      // 확인/저장 버튼 클릭 (텍스트 기반)
      const confirmBtn = await popupPage.evaluateHandle(() => {
        const buttons = document.querySelectorAll("button");
        for (const btn of buttons) {
          const text = (btn.textContent || "").trim();
          if (text === "확인" || text === "저장" || text === "등록") {
            return btn;
          }
        }
        return null;
      });

      if (confirmBtn && (await confirmBtn.asElement())) {
        await confirmBtn.click();
        console.log("[naver] 주소 확인 버튼 클릭");
        await delay(1000);
      } else {
        console.log("[naver] ❌ 주소 확인 버튼 못찾음");
        return { success: false, reason: "address_confirm_button_not_found" };
      }
    }

    // 4. 저장 버튼 클릭
    await delay(500);
    const saveBtnSelector =
      "#content > div > div.ButtonRegister_article__W3rjR > button";
    const saveBtn = await popupPage.$(saveBtnSelector);
    if (saveBtn) {
      await saveBtn.click();
      console.log("[naver] 저장 버튼 클릭");
      await delay(1000);

      // 저장 버튼이 아직 있으면 (동일 데이터로 disabled 상태) 뒤로가기 버튼으로 목록 복귀
      const saveBtnStillExists = await popupPage.$(saveBtnSelector);
      if (saveBtnStillExists) {
        console.log(
          "[naver] 저장 버튼 아직 존재 (동일 주문자) - 뒤로가기 버튼 클릭",
        );
        const backBtnSelector =
          "#root > div > div.FlexibleLayout-module_row__P4p6X > header > div > div > button";
        const backBtn = await popupPage.$(backBtnSelector);
        if (backBtn) {
          await backBtn.click();
          console.log("[naver] 뒤로가기 버튼 클릭 - 배송지 목록으로 복귀");
          await delay(1500);
        } else {
          console.log("[naver] 뒤로가기 버튼을 찾을 수 없음");
        }
      } else {
        console.log("[naver] 저장 완료 - 배송지 목록으로 자동 이동");
        await delay(1000);
      }
    } else {
      console.log("[naver] 저장 버튼을 찾을 수 없음");
      return { success: false, reason: "save_button_not_found" };
    }

    return { success: true };
  } catch (error) {
    console.error("[naver] 배송지 수정 에러:", error.message);
    return { success: false, reason: error.message };
  }
}

/**
 * 배송지 모달에서 주소 선택
 * @param {Page} page
 * @param {Object} shippingAddress - 배송지 정보
 */
async function selectDeliveryAddress(page, shippingAddress) {
  console.log("[naver] 배송지 선택 시작...");

  // 페이지 로딩 대기
  await delay(2000);

  // 배송지 변경 버튼 셀렉터 (우선순위 순)
  const changeBtnSelectors = [
    // 클래스 기반 (더 안정적)
    "div.DeliveryContent_area-button__jrUnt > button",
    "[class*='DeliveryContent_area-button'] > button",
    "[class*='area-button'] > button",
    // ButtonBox 클래스로 직접 찾기
    "button[class*='ButtonBox-module'][class*='tertiary']",
  ];

  let changeBtn = null;

  // waitFor로 대기하면서 찾기
  for (const selector of changeBtnSelectors) {
    try {
      console.log(`[naver] 셀렉터 시도: ${selector.substring(0, 50)}...`);
      changeBtn = await waitFor(page, selector, 3000);
      if (changeBtn) {
        console.log(
          `[naver] 배송지 변경 버튼 찾음: ${selector.substring(0, 50)}...`,
        );
        break;
      }
    } catch (e) {
      // 타임아웃은 무시하고 다음 셀렉터 시도
    }
  }

  // 텍스트 기반 검색 폴백
  if (!changeBtn) {
    console.log("[naver] 텍스트 기반으로 변경 버튼 검색...");
    await delay(1000);
    const jsHandle = await page.evaluateHandle(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = btn.textContent || "";
        if (text.trim() === "변경") {
          return btn;
        }
      }
      return null;
    });
    // JSHandle을 ElementHandle로 변환
    changeBtn = jsHandle.asElement();
  }

  // 새 창(팝업) 대기 설정
  const browser = page.browser();
  const popupPromise = new Promise((resolve) => {
    browser.once("targetcreated", async (target) => {
      if (target.type() === "page") {
        const newPage = await target.page();
        console.log("[naver] 새 창(팝업) 감지:", target.url());
        resolve(newPage);
      }
    });
    // 5초 후 타임아웃 (팝업이 안 열리면 null)
    setTimeout(() => resolve(null), 5000);
  });

  // 버튼 클릭
  if (changeBtn) {
    await changeBtn.click();
    console.log("[naver] 배송지 변경 버튼 클릭");
  } else {
    console.log("[naver] 배송지 변경 버튼을 찾을 수 없음");
    return { success: false, reason: "change_button_not_found" };
  }

  // 팝업 창 대기
  console.log("[naver] 팝업 창 대기 중...");
  const popupPage = await popupPromise;

  if (popupPage) {
    console.log("[naver] 팝업 창 열림, 팝업에서 주소 선택 진행...");
    await delay(3000); // 팝업 로딩 대기

    // 스크린샷 저장 (디버깅용)
    try {
      await popupPage.screenshot({
        path: "/tmp/naver_popup_debug.png",
        fullPage: true,
      });
      console.log("[naver] 팝업 스크린샷 저장: /tmp/naver_popup_debug.png");
    } catch (e) {
      console.log("[naver] 스크린샷 실패:", e.message);
    }

    // 팝업 페이지에서 주소 리스트 확인
    const popupDebug = await popupPage.evaluate(() => {
      return {
        url: window.location.href,
        title: document.title,
        bodyLength: document.body.innerHTML.length,
        listItems: document.querySelectorAll("li").length,
        addressItems: document.querySelectorAll(
          "[class*='address'] li, [class*='Address'] li",
        ).length,
      };
    });
    console.log("[naver] 팝업 디버깅:", JSON.stringify(popupDebug, null, 2));

    // 팝업에서 주소 리스트 대기 (최대 10초)
    let addressListRendered = false;
    for (let i = 0; i < 10; i++) {
      await delay(1000);
      const listCount = await popupPage.evaluate(() => {
        const items = document.querySelectorAll("li");
        return items.length;
      });
      console.log(`[naver] 팝업 주소 리스트 확인 ${i + 1}/10: ${listCount}개`);
      if (listCount > 0) {
        addressListRendered = true;
        break;
      }
    }

    if (!addressListRendered) {
      console.log("[naver] 팝업에서 주소 리스트가 렌더링되지 않음");
      return { success: false, reason: "popup_address_list_not_rendered" };
    }

    // 주소 선택 - 첫 번째 주소 선택 후 수정
    console.log(
      "[naver] shippingAddress 객체:",
      JSON.stringify(shippingAddress, null, 2),
    );
    console.log("[naver] 첫 번째 주소 선택 후 수정 방식으로 진행...");

    // 먼저 첫 번째 주소의 "수정" 버튼 클릭하여 주소 수정 (최대 3회 재시도)
    let modifyResult = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[naver] 배송지 수정 시도 ${attempt}/3...`);
      modifyResult = await modifyDeliveryAddress(
        popupPage,
        shippingAddress,
      );

      if (modifyResult.success) {
        console.log(`[naver] 배송지 수정 성공 (시도 ${attempt}/3)`);
        break;
      }

      console.log(`[naver] 배송지 수정 실패 (시도 ${attempt}/3): ${modifyResult.reason}`);
      if (attempt < 3) {
        console.log("[naver] 재시도를 위해 대기 중...");
        await delay(2000);

        // 뒤로가기 버튼으로 배송지 목록으로 복귀 시도
        try {
          const backBtnSelector =
            "#root > div > div.FlexibleLayout-module_row__P4p6X > header > div > div > button";
          const backBtn = await popupPage.$(backBtnSelector);
          if (backBtn) {
            await backBtn.click();
            console.log("[naver] 뒤로가기 버튼 클릭 - 배송지 목록으로 복귀 후 재시도");
            await delay(2000);
          }
        } catch (e) {
          console.log("[naver] 뒤로가기 실패:", e.message);
        }
      }
    }

    if (!modifyResult.success) {
      console.log(`[naver] 배송지 수정 3회 모두 실패: ${modifyResult.reason}`);
      return { success: false, reason: modifyResult.reason };
    }

    console.log("[naver] 배송지 수정 완료, 첫 번째 주소 선택 버튼 클릭...");
    await delay(2000);

    // 디버깅: 저장 후 팝업 상태 스크린샷
    try {
      await popupPage.screenshot({
        path: "/tmp/naver_after_save.png",
        fullPage: true,
      });
      console.log("[naver] 저장 후 스크린샷 저장: /tmp/naver_after_save.png");
    } catch (e) {
      console.log("[naver] 스크린샷 실패:", e.message);
    }

    // 팝업 상태 확인
    try {
      const popupState = await popupPage.evaluate(() => ({
        url: window.location.href,
        listItems: document.querySelectorAll("li").length,
        buttons: document.querySelectorAll("button").length,
        bodyText: document.body.innerText.substring(0, 500),
      }));
      console.log(
        "[naver] 저장 후 팝업 상태:",
        JSON.stringify(popupState, null, 2),
      );
    } catch (e) {
      console.log("[naver] 팝업 상태 확인 실패 (팝업 닫힘?):", e.message);
      // 팝업이 닫혔다면 성공으로 처리 (저장 완료 후 자동으로 닫힌 경우)
      return { success: true, note: "popup_closed_after_save" };
    }

    // 첫 번째 주소 선택 버튼 클릭 (재시도 로직)
    const selectBtnSelector =
      "#content > div > ul > li:nth-child(1) > div > div.DeliveryList_area-address__oaMRW > button";

    let selectBtn = null;
    for (let retry = 0; retry < 5; retry++) {
      selectBtn = await popupPage.$(selectBtnSelector);
      if (selectBtn) {
        console.log(`[naver] 주소 선택 버튼 발견 (시도 ${retry + 1}/5)`);
        break;
      }
      console.log(`[naver] 주소 선택 버튼 대기 중... (시도 ${retry + 1}/5)`);
      await delay(1000);
    }

    if (selectBtn) {
      await selectBtn.click();
      console.log("[naver] 첫 번째 주소 선택 버튼 클릭 완료");
      await delay(3000);

      // 배송지 입력 직후 카카오 API로 즉시 검증
      console.log("[naver] 배송지 입력 직후 주소 검증...");
      const { searchAddressWithKakao, normalizeAddress } = require("../../lib/address-verify");
      const ourAddress = shippingAddress.streetAddress1 || "";
      const kakaoResult = await searchAddressWithKakao(ourAddress);

      if (kakaoResult) {
        // span.blind "주소" 기반으로 화면 주소 읽기
        const displayedAddress = await page.evaluate(() => {
          const blindSpans = document.querySelectorAll("span.blind");
          for (const span of blindSpans) {
            if (span.textContent.trim() === "주소") {
              const parent = span.parentElement;
              if (parent) return parent.textContent.replace("주소", "").trim();
            }
          }
          return null;
        });

        if (displayedAddress) {
          const kakaoAddresses = [
            kakaoResult.roadAddress,
            kakaoResult.jibunAddress,
            kakaoResult.roadAddressShort,
            kakaoResult.jibunAddressShort,
          ].filter(Boolean).map(a => normalizeAddress(a));

          const normalizedDisplay = normalizeAddress(displayedAddress);
          let matched = false;
          for (const kakaoAddr of kakaoAddresses) {
            if (normalizedDisplay.includes(kakaoAddr)) {
              matched = true;
              console.log(`[naver] ✅ 배송지 즉시 검증 통과: "${kakaoAddr}"`);
              break;
            }
          }

          if (!matched) {
            console.error(`[naver] ❌ 배송지 즉시 검증 실패!`);
            console.error(`[naver]   우리: ${ourAddress}`);
            console.error(`[naver]   카카오 도로명: ${kakaoResult.roadAddress}`);
            console.error(`[naver]   화면: ${displayedAddress}`);
            return { success: false, reason: "address_verification_failed_after_input" };
          }
        } else {
          console.log("[naver] 화면 주소 추출 실패 - 결제 전 검증에서 재확인");
        }
      } else {
        console.log("[naver] 카카오 API 결과 없음 - 검증 스킵");
      }

      return { success: true };
    }

    console.log("[naver] 첫 번째 주소 선택 버튼을 찾을 수 없음");
    return { success: false, reason: "first_address_select_button_not_found" };
  }

  // 팝업이 아닌 경우 (모달인 경우) - 기존 로직
  console.log("[naver] 팝업 없음, 모달 확인 중...");
  await delay(2000);

  // 주소 리스트가 렌더링될 때까지 대기 (최대 5초)
  let addressListRendered = false;
  for (let i = 0; i < 5; i++) {
    await delay(1000);
    const listCount = await page.evaluate(() => {
      const items = document.querySelectorAll("li");
      return items.length;
    });
    console.log(`[naver] 모달 주소 리스트 확인 ${i + 1}/5: ${listCount}개`);
    if (listCount > 0) {
      addressListRendered = true;
      break;
    }
  }

  if (!addressListRendered) {
    console.log("[naver] 주소 리스트가 렌더링되지 않음 - 수동 처리 필요");
    return { success: false, reason: "address_list_not_rendered" };
  }

  // 수령인 이름으로 주소 선택 (다양한 필드명 지원)
  const receiverName =
    shippingAddress.receiverName ||
    shippingAddress.name ||
    shippingAddress.recipient ||
    shippingAddress.receiver ||
    shippingAddress.customerName;
  console.log(`[naver] 수령인 이름으로 주소 검색: ${receiverName}`);

  const selected = await page.evaluate((name) => {
    const items = document.querySelectorAll("li");
    for (const item of items) {
      const text = item.textContent || "";
      if (text.includes(name)) {
        const selectBtn = item.querySelector("button, input[type='radio'], a");
        if (selectBtn) {
          selectBtn.click();
          return { found: true, text: text.substring(0, 100) };
        }
        item.click();
        return { found: true, text: text.substring(0, 100) };
      }
    }
    return { found: false };
  }, receiverName);

  if (selected.found) {
    console.log(`[naver] 주소 선택됨: ${selected.text}`);
    await delay(1000);

    const confirmBtn = await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = btn.textContent || "";
        if (
          text.includes("확인") ||
          text.includes("적용") ||
          text.includes("선택")
        ) {
          btn.click();
          return text;
        }
      }
      return null;
    });

    if (confirmBtn) {
      console.log(`[naver] 확인 버튼 클릭: ${confirmBtn}`);
    }

    return { success: true };
  }

  console.log("[naver] 일치하는 주소를 찾을 수 없음");
  return { success: false, reason: "address_not_found" };
}

/**
 * 장바구니에 상품 담기
 */
async function addToCart(page) {
  console.log("[naver] 장바구니 담기...");

  // 장바구니 버튼 클릭 (data 속성 + 텍스트 폴백)
  const cartClicked = await page.evaluate(() => {
    // 1) data-shp-area="pcs.cart" 속성으로 찾기 (가장 정확)
    const cartByAttr = document.querySelector('[data-shp-area="pcs.cart"], [data-shp-contents-type="cart"]');
    if (cartByAttr) {
      cartByAttr.click();
      return `attr: "${cartByAttr.tagName}"`;
    }
    // 2) 텍스트 폴백
    const allElements = document.querySelectorAll("a, button");
    for (const el of allElements) {
      const text = (el.textContent || "").trim();
      if (text.includes("장바구니") && !text.includes("이동") && !text.includes("비우")) {
        el.click();
        return `text: "${text}"`;
      }
    }
    return null;
  });

  if (!cartClicked) {
    console.log("[naver] 장바구니 버튼 없음");
    return false;
  }

  console.log(`[naver] 장바구니 버튼 클릭 (${cartClicked})`);
  await delay(1000);
  // 모달/레이어 무시 - 다음 상품 페이지로 직접 goto 하므로 처리 불필요

  return true;
}

/**
 * 상품 페이지에서 상품 담기
 */
async function processProduct(page, product) {
  const {
    productUrl,
    productName,
    quantity,
    openMallOptions,
    openMallAdditionalOptions,
  } = product;

  console.log(`\n[naver] 상품 처리: ${productName || productUrl}`);
  console.log(`[naver] URL: ${productUrl}`);
  console.log(`[naver] 수량: ${quantity}`);
  if (openMallOptions) {
    console.log(`[naver] 옵션:`, JSON.stringify(openMallOptions));
  }
  if (openMallAdditionalOptions) {
    console.log(`[naver] 추가옵션:`, JSON.stringify(openMallAdditionalOptions));
  }

  // 1. 상품 페이지로 이동
  await page.goto(productUrl, {
    waitUntil: "networkidle2",
    timeout: 30000,
  });
  await delay(2000);

  // 2. 수량 계산 (openMallQtyPerUnit 적용)
  const baseQuantity = quantity || 1;
  const qtyPerUnit = product.openMallQtyPerUnit || 1;
  const actualQuantity = baseQuantity * qtyPerUnit;
  if (qtyPerUnit > 1) {
    console.log(
      `[naver] 수량 변환: ${baseQuantity}개 × ${qtyPerUnit} = ${actualQuantity}개`,
    );
  }

  // 3. 옵션 선택 (그룹화 패턴인 경우 수량도 함께 처리)
  const optionResult = await selectOptions(
    page,
    openMallOptions,
    actualQuantity,
  );

  // 옵션 선택 실패 시 조기 반환
  if (!optionResult.success) {
    console.log(
      `[naver] ❌ 상품 스킵 (옵션 선택 실패): ${optionResult.reason}`,
    );
    return {
      success: false,
      productName,
      quantity,
      openMallPrice: null,
      priceMismatch: false,
      optionFailed: true,
      optionFailReason: optionResult.reason,
    };
  }

  await delay(1000);

  // 3.5. 가격 추출 (옵션 선택 후)
  const openMallPrice = await getProductPrice(page);

  // 4. 수량 설정 (옵션에서 수량 처리 안 한 경우에만)
  if (!optionResult.quantityHandled) {
    console.log(`[naver] 수량 설정: ${actualQuantity}개`);
    const qtyResult = await setQuantity(page, actualQuantity);
    if (!qtyResult) {
      console.log(`[naver] ❌ 수량 설정 실패 - 상품 스킵`);
      return { success: false, error: `수량 설정 실패: 기대=${actualQuantity}` };
    }
    await delay(500);
  } else {
    console.log(`[naver] 수량 설정 스킵 (그룹화 옵션에서 이미 처리됨)`);
  }

  // 4.5. 추가상품 옵션 선택 (메인 옵션/수량 설정 후, 장바구니 담기 전)
  if (openMallAdditionalOptions) {
    const additionalResult = await selectAdditionalOptions(
      page,
      openMallAdditionalOptions,
      actualQuantity,
    );
    if (!additionalResult.success) {
      console.log(
        `[naver] ❌ 상품 스킵 (추가옵션 선택 실패): ${additionalResult.reason}`,
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

  // 5. 장바구니에 담기
  const addedToCart = await addToCart(page);

  // 6. 가격 비교 (위탁가와 오픈몰 가격)
  // 부가세(10%) 추가하여 예상 단가 계산 (VAT 포함)
  const vendorPriceExcludeVat = product.vendorPriceExcludeVat || 0;
  const expectedPrice = Math.round(vendorPriceExcludeVat * 1.1); // VAT 포함
  let priceMismatch = false;
  if (openMallPrice && expectedPrice > 0) {
    if (openMallPrice !== expectedPrice) {
      console.log(
        `[naver] ⚠️ 가격 불일치: 오픈몰 ${openMallPrice}원 vs 예상가 ${expectedPrice}원 (VAT별도 ${vendorPriceExcludeVat}원)`,
      );
      priceMismatch = true;
    } else {
      console.log(`[naver] ✅ 가격 일치: ${openMallPrice}원`);
    }
  }

  console.log("[naver] 장바구니 담기 완료");
  return {
    success: addedToCart,
    productName,
    quantity,
    openMallPrice,
    vendorPriceExcludeVat, // 협력사 매입가 (VAT 별도)
    priceMismatch,
  };
}

/**
 * 네이버페이 키패드 OCR 비밀번호 입력
 * 초록 배경 + 흰색 숫자에 최적화
 * @param {Page} page - Puppeteer 페이지
 * @param {string} pin - 6자리 비밀번호
 * @returns {Object} { success, method, results }
 */
async function enterNaverPayPin(page, pin) {
  console.log("[네이버페이] 비밀번호 입력 시작...");

  // 임시 디렉토리 생성 (OCR용)
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // 필요한 숫자 추출
  const requiredDigits = [...new Set(pin.split(""))];
  console.log(`[네이버페이] 필요한 숫자: ${requiredDigits.join(", ")}`);

  // 키패드 버튼 찾기 - SecureKeyboard 클래스 사용
  const keypadSelectors = [
    "#keyboard button.SecureKeyboard_key__jGpA_",
    ".SecureKeyboard_article__9VAtS button",
    "#keyboard button",
    "[class*='SecureKeyboard'] button",
  ];

  let buttonHandles = [];
  for (const sel of keypadSelectors) {
    buttonHandles = await page.$$(sel);
    if (buttonHandles.length >= 10) {
      console.log(`[네이버페이] 키패드 버튼 발견: ${sel}`);
      break;
    }
  }

  if (buttonHandles.length === 0) {
    console.log("[네이버페이] 키패드 버튼을 찾을 수 없음");
  }

  console.log(`[네이버페이] 키패드 버튼 ${buttonHandles.length}개 발견`);

  if (buttonHandles.length < 10) {
    return { success: false, reason: "keypad_buttons_not_found" };
  }

  // OCR 설정 - 초록 배경 + 흰색 숫자에 최적화
  // 흰색은 grayscale 후 밝은 값, 초록은 어두운 값
  // negate: false로 설정 (흰색 숫자를 검정으로 변환)
  const ocrConfigs = [
    {
      threshold: 180,
      negate: false,
      psm: "10",
      blur: 0.3,
      gamma: 1.0,
      size: 200,
    },
    {
      threshold: 160,
      negate: false,
      psm: "10",
      blur: 0.5,
      gamma: 1.2,
      size: 200,
    },
    {
      threshold: 200,
      negate: false,
      psm: "10",
      blur: 0.3,
      gamma: 0.8,
      size: 200,
    },
    {
      threshold: 140,
      negate: false,
      psm: "10",
      blur: 0.7,
      gamma: 1.0,
      size: 200,
    },
    // negate 시도
    {
      threshold: 100,
      negate: true,
      psm: "10",
      blur: 0.5,
      gamma: 1.0,
      size: 200,
    },
    {
      threshold: 120,
      negate: true,
      psm: "10",
      blur: 0.3,
      gamma: 1.2,
      size: 200,
    },
  ];

  let digitMap = {}; // { "1": buttonIndex, ... }
  let ocrResults = [];
  const maxOcrRetries = ocrConfigs.length;

  for (let attempt = 1; attempt <= maxOcrRetries; attempt++) {
    const config = ocrConfigs[attempt - 1];
    console.log(
      `[네이버페이] OCR 시도 ${attempt}/${maxOcrRetries} (th:${config.threshold}, neg:${config.negate})`,
    );

    if (attempt === 1) {
      digitMap = {};
      ocrResults = [];
    }

    const mappedButtonIndices = new Set(Object.values(digitMap));

    for (let i = 0; i < buttonHandles.length && i < 12; i++) {
      if (attempt > 1 && mappedButtonIndices.has(i)) continue;

      try {
        const btnHandle = buttonHandles[i];
        const screenshotPath = path.join(tempDir, `btn_${i}_${Date.now()}.png`);
        const processedPath = path.join(
          tempDir,
          `btn_${i}_proc_${Date.now()}.png`,
        );

        await btnHandle.screenshot({ path: screenshotPath });

        // 이미지 전처리 (초록 배경 + 흰색 숫자)
        let pipeline = sharp(screenshotPath)
          .grayscale()
          .resize({ width: config.size, height: config.size, fit: "cover" });

        if (config.gamma !== 1.0) {
          pipeline = pipeline.gamma(config.gamma);
        }
        if (config.blur > 0) {
          pipeline = pipeline.blur(config.blur);
        }

        pipeline = pipeline
          .normalize()
          .sharpen({ sigma: 1.2 })
          .threshold(config.threshold);

        if (config.negate) {
          pipeline = pipeline.negate();
        }

        await pipeline.toFile(processedPath);

        // Tesseract OCR
        const {
          data: { text, confidence },
        } = await Tesseract.recognize(processedPath, "eng", {
          logger: () => {},
          tessedit_char_whitelist: "0123456789",
          tessedit_pageseg_mode: config.psm,
        });

        const cleanText = text.replace(/[^0-9]/g, "").trim();
        const recognizedDigit = cleanText.length === 1 ? cleanText : null;

        if (attempt === 1) {
          ocrResults.push({
            index: i,
            rawText: text.trim(),
            recognizedDigit,
            confidence,
          });
        }

        if (recognizedDigit && !digitMap.hasOwnProperty(recognizedDigit)) {
          digitMap[recognizedDigit] = i;
          console.log(
            `[네이버페이] ✅ 버튼 ${i}: "${recognizedDigit}" (신뢰도: ${confidence.toFixed(1)}%)`,
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
        console.log(`[네이버페이] 버튼 ${i} OCR 실패: ${e.message}`);
      }
    }

    // 필요한 숫자가 모두 인식되었는지 확인
    const missingDigits = requiredDigits.filter(
      (d) => !digitMap.hasOwnProperty(d),
    );
    if (missingDigits.length === 0) {
      console.log("[네이버페이] 모든 필요 숫자 인식 완료");
      break;
    } else {
      console.log(`[네이버페이] 누락된 숫자: ${missingDigits.join(", ")}`);

      // 추론: 미인식 버튼 1개 = 누락 숫자 1개면 자동 매핑
      const unmappedIndices = [];
      for (let i = 0; i < Math.min(buttonHandles.length, 10); i++) {
        if (!Object.values(digitMap).includes(i)) {
          unmappedIndices.push(i);
        }
      }

      if (unmappedIndices.length === 1 && missingDigits.length === 1) {
        digitMap[missingDigits[0]] = unmappedIndices[0];
        console.log(
          `[네이버페이] 🎯 추론: 버튼 ${unmappedIndices[0]} = "${missingDigits[0]}"`,
        );
        break;
      }

      if (attempt < maxOcrRetries) {
        await delay(300);
      }
    }
  }

  console.log("[네이버페이] 숫자 매핑:", JSON.stringify(digitMap));

  // PIN 입력
  const pinResults = [];
  for (const digit of pin.split("")) {
    const btnIndex = digitMap[digit];
    if (btnIndex !== undefined && buttonHandles[btnIndex]) {
      try {
        await buttonHandles[btnIndex].click();
        pinResults.push({ digit, index: btnIndex, clicked: true });
        console.log(`[네이버페이] 숫자 "${digit}" 클릭 (버튼 ${btnIndex})`);
        await delay(100);
      } catch (e) {
        pinResults.push({
          digit,
          index: btnIndex,
          clicked: false,
          error: e.message,
        });
      }
    } else {
      pinResults.push({
        digit,
        index: btnIndex,
        clicked: false,
        error: "not_mapped",
      });
      console.log(`[네이버페이] ❌ 숫자 "${digit}" 매핑 없음`);
    }
  }

  const successCount = pinResults.filter((r) => r.clicked).length;
  return {
    success: successCount === pin.length,
    clickedCount: successCount,
  };
}

/**
 * 네이버 스마트스토어 주문 처리
 */
async function processNaverOrder(
  res,
  page,
  vendor,
  { products, shippingAddress, poLineIds, purchaseOrderId },
  authToken,
) {
  const steps = [];
  const addedProducts = [];
  const errorCollector = createOrderErrorCollector("naver");

  try {
    console.log("[naver] 주문 처리 시작...");
    console.log("[naver] 상품 수:", products.length);

    // 1. 로그인 확인
    try {
      await login(page, vendor);
      steps.push({ step: "login", success: true });
    } catch (loginError) {
      errorCollector.addError(
        ORDER_STEPS.LOGIN,
        ERROR_CODES.LOGIN_FAILED,
        loginError.message,
        { purchaseOrderId },
      );
      steps.push({ step: "login", success: false, error: loginError.message });
      await saveOrderResults(authToken, {
        purchaseOrderId,
        products: [],
        priceMismatches: [],
        optionFailedProducts: [],
        automationErrors: errorCollector.getErrors(),
        poLineIds,
        success: false,
        vendor: "naver",
      });
      return res.json({
        success: false,
        message: `로그인 실패: ${loginError.message}`,
        purchaseOrderId,
        steps,
        automationErrors: errorCollector.getErrors(),
      });
    }

    // 2. 장바구니 비우기
    try {
      await clearCart(page);
      steps.push({ step: "clear_cart", success: true });
    } catch (cartError) {
      errorCollector.addError(
        ORDER_STEPS.CART_CLEARING,
        ERROR_CODES.CART_CLEAR_FAILED,
        cartError.message,
        { purchaseOrderId },
      );
      steps.push({
        step: "clear_cart",
        success: false,
        error: cartError.message,
      });
      // 장바구니 비우기 실패해도 계속 진행 (치명적이지 않음)
      console.log(
        "[naver] 장바구니 비우기 실패, 계속 진행:",
        cartError.message,
      );
    }

    // 3. 각 상품 처리 (장바구니에 담기)
    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      console.log(`\n[naver] === 상품 ${i + 1}/${products.length} ===`);

      try {
        const result = await processProduct(page, product);
        addedProducts.push({
          ...product, // 원본 product의 모든 필드 유지 (orderLineId, purchaseOrderLineId 등)
          openMallPrice: result.openMallPrice,
          priceMismatch: result.priceMismatch,
          addedToCart: result.success,
          // 옵션 선택 실패 정보
          optionFailed: result.optionFailed || false,
          optionFailReason: result.optionFailReason || null,
        });
        steps.push({
          step: `product_${i + 1}`,
          productName: product.productName,
          success: result.success,
          optionFailed: result.optionFailed || false,
        });
      } catch (error) {
        console.error(`[naver] 상품 처리 실패:`, error.message);
        errorCollector.addError(
          ORDER_STEPS.ADD_TO_CART,
          null, // 에러 메시지에서 추론
          error.message,
          {
            purchaseOrderId,
            purchaseOrderLineId: product.purchaseOrderLineId,
            productVariantVendorId: product.productVariantVendorId,
          },
        );
        steps.push({
          step: `product_${i + 1}`,
          productName: product.productName,
          success: false,
          error: error.message,
        });
      }
    }

    // 3.5. 장바구니에 담긴 상품이 있는지 확인
    const successfulProducts = addedProducts.filter((p) => p.addedToCart);
    const optionFailedProducts = addedProducts.filter((p) => p.optionFailed);

    if (successfulProducts.length === 0) {
      console.log("[naver] ❌ 장바구니에 담긴 상품이 없음 - 주문 중단");

      // 옵션 실패로 인한 전체 실패인지 확인
      if (optionFailedProducts.length > 0) {
        // 옵션 실패 에러 수집
        optionFailedProducts.forEach((p) => {
          errorCollector.addError(
            ORDER_STEPS.OPTION_SELECTION,
            ERROR_CODES.OPTION_SELECT_FAILED,
            p.optionFailReason,
            {
              purchaseOrderId,
              purchaseOrderLineId: p.purchaseOrderLineId,
              productVariantVendorId: p.productVariantVendorId,
            },
          );
        });

        await saveOrderResults(authToken, {
          purchaseOrderId,
          products: addedProducts,
          priceMismatches: [],
          optionFailedProducts: optionFailedProducts.map((p) => ({
            productVariantVendorId: p.productVariantVendorId,
            reason: p.optionFailReason,
          })),
          automationErrors: errorCollector.getErrors(),
          poLineIds,
          success: false,
          vendor: "naver",
        });
        return res.json({
          success: false,
          message: `옵션 선택 실패로 주문 불가 (${optionFailedProducts.length}건)`,
          optionFailedProducts: optionFailedProducts.map((p) => ({
            orderLineIds: p.orderLineIds,
            purchaseOrderLineId: p.purchaseOrderLineId,
            productVariantVendorId: p.productVariantVendorId,
            productSku: p.productSku,
            productName: p.productName,
            reason: p.optionFailReason,
          })),
          steps,
          addedProducts,
          purchaseOrderId,
          automationErrors: errorCollector.getErrors(),
        });
      }

      await saveOrderResults(authToken, {
        purchaseOrderId,
        products: addedProducts,
        priceMismatches: [],
        optionFailedProducts: [],
        automationErrors: errorCollector.getErrors(),
        poLineIds,
        success: false,
        vendor: "naver",
      });
      return res.json({
        success: false,
        message: "장바구니에 담긴 상품이 없음",
        steps,
        addedProducts,
        purchaseOrderId,
        automationErrors: errorCollector.getErrors(),
      });
    }

    console.log(
      `[naver] 장바구니 담기 완료: ${successfulProducts.length}/${products.length}건`,
    );
    if (optionFailedProducts.length > 0) {
      console.log(
        `[naver] ⚠️ 옵션 선택 실패: ${optionFailedProducts.length}건 (주문 제외)`,
      );
    }

    // 4. 장바구니 페이지로 이동 후 주문하기
    console.log("[naver] 장바구니 페이지로 이동...");
    await page.goto("https://shopping.naver.com/cart", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await delay(2000);

    console.log("[naver] 주문하기 버튼 클릭...");
    const orderBtnClicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = (btn.textContent || "").trim();
        if (text.startsWith("주문하기")) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (orderBtnClicked) {
      console.log("[naver] 주문하기 버튼 클릭 완료");
      await delay(3000);
      steps.push({ step: "order_button", success: true });
    } else {
      console.log("[naver] 주문하기 버튼 없음");
      steps.push({ step: "order_button", success: false });
    }

    // 5. 배송지 선택 + 검증 (최대 3회 재시도)
    if (shippingAddress) {
      const MAX_ADDRESS_ATTEMPTS = 3;
      let addressVerified = false;

      for (let addrAttempt = 1; addrAttempt <= MAX_ADDRESS_ATTEMPTS; addrAttempt++) {
        console.log(`[naver] 배송지 선택 시도 ${addrAttempt}/${MAX_ADDRESS_ATTEMPTS}...`);
        const addressResult = await selectDeliveryAddress(page, shippingAddress);
        steps.push({
          step: `address_selection_attempt_${addrAttempt}`,
          success: addressResult.success,
          reason: addressResult.reason,
        });

        if (!addressResult.success) {
          console.log(`[naver] 배송지 선택 실패 (시도 ${addrAttempt}): ${addressResult.reason}`);
          if (addrAttempt === MAX_ADDRESS_ATTEMPTS) {
            errorCollector.addError(
              ORDER_STEPS.ORDER_PLACEMENT,
              ERROR_CODES.ELEMENT_NOT_FOUND,
              `배송지 선택 ${MAX_ADDRESS_ATTEMPTS}회 실패: ${addressResult.reason}`,
              { purchaseOrderId },
            );
            await saveOrderResults(authToken, {
              purchaseOrderId,
              products: addedProducts,
              priceMismatches: [],
              optionFailedProducts: [],
              automationErrors: errorCollector.getErrors(),
              poLineIds,
              success: false,
              vendor: "naver",
            });
            return res.json({
              success: false,
              message: `배송지 선택 실패: ${addressResult.reason}`,
              steps,
              addedProducts,
              purchaseOrderId,
              needManualAddressSelection: true,
              automationErrors: errorCollector.getErrors(),
            });
          }
          await delay(2000);
          continue;
        }

        // 배송지 선택 후 검증 (span.blind "주소" 기반 + 카카오 API)
        console.log("[naver] 결제 전 배송지 검증...");
        await delay(2000);

        // span.blind "주소" 텍스트로 화면 주소 추출
        const displayedAddress = await page.evaluate(() => {
          const blindSpans = document.querySelectorAll("span.blind");
          for (const span of blindSpans) {
            if (span.textContent.trim() === "주소") {
              const parent = span.parentElement;
              if (parent) {
                const fullText = parent.textContent.replace("주소", "").trim();
                return fullText;
              }
            }
          }
          return null;
        });

        if (displayedAddress) {
          console.log(`[naver] 화면 배송지 (blind): ${displayedAddress}`);
        }

        const verifyResult = await verifyShippingAddressOnPage(page, shippingAddress, "naver");
        if (verifyResult.success) {
          console.log("[naver] ✅ 배송지 검증 통과");
          addressVerified = true;
          break;
        }

        console.log(`[naver] ❌ 배송지 검증 실패 (시도 ${addrAttempt}): ${verifyResult.message}`);
        if (addrAttempt < MAX_ADDRESS_ATTEMPTS) {
          console.log("[naver] 배송지 재입력을 위해 재시도...");
          await delay(2000);
        }
      }

      if (!addressVerified) {
        errorCollector.addError(
          ORDER_STEPS.ORDER_PLACEMENT,
          ERROR_CODES.ELEMENT_NOT_FOUND,
          `배송지 검증 ${MAX_ADDRESS_ATTEMPTS}회 실패`,
          { purchaseOrderId },
        );
        await saveOrderResults(authToken, {
          purchaseOrderId,
          products: addedProducts,
          priceMismatches: [],
          optionFailedProducts: [],
          automationErrors: errorCollector.getErrors(),
          poLineIds,
          success: false,
          vendor: "naver",
        });
        return res.json({
          success: false,
          message: "배송지 검증 실패 (주소 불일치)",
          steps,
          addedProducts,
          purchaseOrderId,
          automationErrors: errorCollector.getErrors(),
        });
      }
    }

    // 6. 해외직배송 통관 처리 (결제 전에 먼저 확인)
    await delay(2000);
    const customsResult = await handleCustomsCode(page);
    if (customsResult.handled) {
      steps.push({
        step: "customs_code",
        success: customsResult.success,
        reason: customsResult.reason,
      });

      if (!customsResult.success) {
        console.log(`[naver] 통관 처리 실패: ${customsResult.reason}`);
        errorCollector.addError(
          ORDER_STEPS.ORDER_PLACEMENT,
          ERROR_CODES.ELEMENT_NOT_FOUND,
          `통관 처리 실패: ${customsResult.reason}`,
          { purchaseOrderId },
        );
        await saveOrderResults(authToken, {
          purchaseOrderId,
          products: addedProducts,
          priceMismatches: [],
          optionFailedProducts: [],
          automationErrors: errorCollector.getErrors(),
          poLineIds,
          success: false,
          vendor: "naver",
        });
        return res.json({
          success: false,
          message: `통관 처리 실패: ${customsResult.reason}`,
          steps,
          addedProducts,
          purchaseOrderId,
          automationErrors: errorCollector.getErrors(),
        });
      }
    }

    // 6-1. 결제금액 파싱 (결제 버튼 클릭 전)
    let actualPaymentAmount = 0;
    try {
      const amountText = await page.evaluate(() => {
        const wrap = document.querySelector("#PAYMENT_WRAP");
        if (!wrap) return "";
        const em = wrap.querySelector("em");
        return em ? em.textContent?.trim() || "" : "";
      });
      actualPaymentAmount =
        parseInt(amountText.replace(/[^0-9]/g, ""), 10) || 0;
      console.log(
        `[naver] 결제금액 파싱: "${amountText}" → ${actualPaymentAmount}원`,
      );
    } catch (e) {
      console.log(
        "[naver] 결제금액 파싱 실패 (결제 진행에 영향 없음):",
        e.message,
      );
    }

    // 7. 결제하기 버튼 클릭 + 네이버페이 결제
    await delay(2000);
    const paymentBtnSelector =
      "#root > div > div.DoubleTemplate_container__5LG6a > div.SubmitButton_article__\\+7E3M.SubmitButton_type-pc__wc4Vy.SubmitButton_type-floating__VRJYZ.SubmitButton_floating__Plj-\\+ > div > div > div.SubmitButton_area-button__1RiID > button";

    let paymentBtn = await page.$(paymentBtnSelector);
    if (paymentBtn) {
      console.log("[naver] 결제하기 버튼 클릭...");
      await paymentBtn.click();
      steps.push({ step: "payment_button_click", success: true });

      // 새 창(팝업) 대기 설정 - 결제 키패드가 새 창으로 열림
      const browser = page.browser();
      const paymentPopupPromise = new Promise((resolve) => {
        browser.once("targetcreated", async (target) => {
          if (target.type() === "page") {
            const newPage = await target.page();
            console.log("[naver] 결제 팝업 감지:", target.url());
            resolve(newPage);
          }
        });
        // 10초 후 타임아웃
        setTimeout(() => resolve(null), 10000);
      });

      // 7-1. 네이버페이 결제 팝업 대기
      console.log("[naver] 네이버페이 결제 팝업 대기...");
      const paymentPopup = await paymentPopupPromise;

      if (!paymentPopup) {
        console.log("[naver] 결제 팝업이 열리지 않음");
        errorCollector.addError(
          ORDER_STEPS.PAYMENT,
          ERROR_CODES.TIMEOUT,
          "결제 팝업이 열리지 않음",
          { purchaseOrderId },
        );
        await saveOrderResults(authToken, {
          purchaseOrderId,
          products: addedProducts,
          priceMismatches: [],
          optionFailedProducts: [],
          automationErrors: errorCollector.getErrors(),
          poLineIds,
          success: false,
          vendor: "naver",
        });
        return res.json({
          success: false,
          message: "결제 팝업이 열리지 않음",
          steps,
          addedProducts,
          purchaseOrderId,
          automationErrors: errorCollector.getErrors(),
        });
      }

      console.log("[naver] 결제 팝업 열림, 키패드 로딩 대기...");
      await delay(3000);

      // 7-2. PIN 입력 (OCR 사용) - 팝업에서 실행
      const pin = vendor.naverPayPin;
      if (!pin) {
        console.log("[naver] 네이버페이 PIN이 설정되지 않음");
        errorCollector.addError(
          ORDER_STEPS.PAYMENT,
          ERROR_CODES.PAYMENT_FAILED,
          "네이버페이 PIN이 설정되지 않음 (NAVER_PAY_PIN)",
          { purchaseOrderId },
        );
        await saveOrderResults(authToken, {
          purchaseOrderId,
          products: addedProducts,
          priceMismatches: [],
          optionFailedProducts: [],
          automationErrors: errorCollector.getErrors(),
          poLineIds,
          success: false,
          vendor: "naver",
        });
        return res.json({
          success: false,
          message: "네이버페이 PIN이 설정되지 않음 (NAVER_PAY_PIN)",
          steps,
          addedProducts,
          purchaseOrderId,
          automationErrors: errorCollector.getErrors(),
        });
      }

      console.log(`[naver] 네이버페이 비밀번호 입력 시작 (${pin.length}자리)`);
      const pinResult = await enterNaverPayPin(paymentPopup, pin);

      steps.push({
        step: "naver_pay_pin",
        success: pinResult.success,
        method: pinResult.method,
        clickedCount: pinResult.clickedCount,
      });

      if (pinResult.success) {
        console.log("[naver] 네이버페이 비밀번호 입력 완료");
        await delay(5000); // 결제 처리 및 완료 페이지 로딩 대기

        // 7-3. 주문번호 추출
        let orderNumber = null;
        const orderNumberSelectors = [
          "button.OrderNumber_button-number__kM0LA",
          "[class*='OrderNumber_button-number']",
          "[class*='order-number'] button",
          "[class*='orderNumber'] button",
        ];

        // 주문번호가 메인 페이지에 있는지 확인 (최대 10초 대기)
        for (let retry = 0; retry < 10; retry++) {
          for (const sel of orderNumberSelectors) {
            try {
              const orderNumEl = await page.$(sel);
              if (orderNumEl) {
                orderNumber = await page.$eval(sel, (el) =>
                  el.textContent.replace("복사하기", "").trim(),
                );
                if (orderNumber && /^\d+$/.test(orderNumber)) {
                  console.log(`[naver] 주문번호 발견: ${orderNumber}`);
                  break;
                }
              }
            } catch (e) {}
          }
          if (orderNumber) break;
          console.log(`[naver] 주문번호 대기 중... (${retry + 1}/10)`);
          await delay(1000);
        }

        if (!orderNumber) {
          console.log("[naver] 주문번호를 찾지 못함 - URL에서 추출 시도");
          // URL에서 주문번호 추출 시도
          const currentUrl = page.url();
          const orderMatch = currentUrl.match(/orderNumber=(\d+)/);
          if (orderMatch) {
            orderNumber = orderMatch[1];
            console.log(`[naver] URL에서 주문번호 추출: ${orderNumber}`);
          }
        }

        steps.push({
          step: "order_complete",
          success: !!orderNumber,
          orderNumber,
        });

        // 가격 불일치 상세 데이터 (시스템 저장용)
        const priceMismatchList = addedProducts.filter((p) => p.priceMismatch);
        const priceMismatches = priceMismatchList.map((p) => {
          const vendorPriceExcludeVat = p.vendorPriceExcludeVat || 0;
          const expectedPrice = Math.round(vendorPriceExcludeVat * 1.1); // VAT 포함
          const priceDiff = p.openMallPrice - expectedPrice;
          const priceDiffPercent =
            expectedPrice > 0
              ? ((priceDiff / expectedPrice) * 100).toFixed(2)
              : 0;
          return {
            purchaseOrderLineId: p.purchaseOrderLineId || null, // PurchaseOrderLine ID (mutation용)
            productVariantVendorId: p.productVariantVendorId || null, // ProductVariantVendor ID
            productCode: p.productSku,
            productName: p.productName,
            quantity: p.quantity,
            openMallPrice: p.openMallPrice, // 오픈몰 현재 가격 (VAT 포함)
            expectedPrice: expectedPrice, // 예상 가격 (VAT 포함)
            vendorPriceExcludeVat: vendorPriceExcludeVat, // 협력사 매입가 (VAT 별도)
            difference: priceDiff,
            differencePercent: priceDiffPercent,
          };
        });

        // GraphQL mutations 호출 (성공: 주문번호 업데이트 + 가격불일치 + 대행접수 + 출고처리)
        await saveOrderResults(authToken, {
          purchaseOrderId,
          products: addedProducts.map((p) => ({
            orderLineIds: p.orderLineIds, // n8n에서 배열로 전달됨
            openMallOrderNumber: orderNumber,
          })),
          priceMismatches: priceMismatches.map((p) => ({
            productVariantVendorId: p.productVariantVendorId,
            vendorPriceExcludeVat: p.vendorPriceExcludeVat,
            openMallPrice: p.openMallPrice,
          })),
          optionFailedProducts: [],
          automationErrors: [],
          poLineIds,
          success: true,
          vendor: "naver",
        });

        // 결제 금액 로깅
        if (actualPaymentAmount > 0) {
          const expectedAmount = calculateExpectedPaymentAmount(addedProducts);
          try {
            await createPaymentLogs(authToken, [
              {
                vendor: "naver",
                paymentAmount: actualPaymentAmount,
                expectedAmount,
                purchaseOrderId,
              },
            ]);
          } catch (e) {
            console.log("[naver] 결제 로그 저장 실패 (무시):", e.message);
          }
        }

        // dialog 핸들러 제거 (다른 협력사와 충돌 방지)
        if (page._naverDialogHandler) {
          page.off("dialog", page._naverDialogHandler);
          delete page._naverDialogHandler;
          console.log("[naver] dialog 핸들러 제거 완료");
        }

        return res.json({
          success: true,
          message: orderNumber ? "결제 완료" : "결제 완료 (주문번호 확인 필요)",
          orderNumber,
          purchaseOrderId,
          purchaseOrderLineIds: poLineIds || [], // PurchaseOrderLinesReceive mutation용
          // 상품별 결과 (mutation용 orderLineIds 포함)
          products: addedProducts.map((p) => ({
            orderLineIds: p.orderLineIds, // n8n에서 배열로 전달됨
            openMallOrderNumber: orderNumber,
            productName: p.productName,
            productSku: p.productSku,
            quantity: p.quantity,
            openMallPrice: p.openMallPrice, // 오픈몰 현재 가격 (VAT 포함)
            vendorPriceExcludeVat: p.vendorPriceExcludeVat, // 협력사 매입가 (VAT 별도)
            priceMismatch: p.priceMismatch,
            needsManagerVerification: p.needsManagerVerification || false,
          })),
          // 가격 불일치 관련
          priceMismatchCount: priceMismatchList.length,
          priceMismatches: priceMismatches,
          // 옵션 실패 관련
          optionFailedCount: optionFailedProducts.length,
          optionFailedProducts: optionFailedProducts.map((p) => ({
            orderLineIds: p.orderLineIds,
            purchaseOrderLineId: p.purchaseOrderLineId,
            productVariantVendorId: p.productVariantVendorId,
            productSku: p.productSku,
            productName: p.productName,
            reason: p.optionFailReason,
          })),
        });
      } else {
        console.log("[naver] 네이버페이 비밀번호 입력 실패");
        errorCollector.addError(
          ORDER_STEPS.PAYMENT,
          ERROR_CODES.PAYMENT_FAILED,
          "네이버페이 비밀번호 입력 실패",
          { purchaseOrderId },
        );
        await saveOrderResults(authToken, {
          purchaseOrderId,
          products: addedProducts,
          priceMismatches: [],
          optionFailedProducts: [],
          automationErrors: errorCollector.getErrors(),
          poLineIds,
          success: false,
          vendor: "naver",
        });
        return res.json({
          success: false,
          message: "네이버페이 비밀번호 입력 실패",
          purchaseOrderId,
          automationErrors: errorCollector.getErrors(),
        });
      }
    } else {
      console.log("[naver] 결제하기 버튼을 찾을 수 없음");
      errorCollector.addError(
        ORDER_STEPS.PAYMENT,
        ERROR_CODES.ELEMENT_NOT_FOUND,
        "결제하기 버튼을 찾을 수 없음",
        { purchaseOrderId },
      );
      steps.push({
        step: "payment_button",
        success: false,
        reason: "button_not_found",
      });
      await saveOrderResults(authToken, {
        purchaseOrderId,
        products: addedProducts,
        priceMismatches: [],
        optionFailedProducts: [],
        automationErrors: errorCollector.getErrors(),
        poLineIds,
        success: false,
        vendor: "naver",
      });
      return res.json({
        success: false,
        message: "결제하기 버튼을 찾을 수 없음",
        steps,
        addedProducts,
        purchaseOrderId,
        automationErrors: errorCollector.getErrors(),
      });
    }
  } catch (error) {
    console.error("[naver] 주문 처리 실패:", error);

    // dialog 핸들러 제거 (에러 발생 시에도)
    if (page._naverDialogHandler) {
      page.off("dialog", page._naverDialogHandler);
      delete page._naverDialogHandler;
      console.log("[naver] dialog 핸들러 제거 완료 (에러 처리)");
    }

    errorCollector.addError(
      ORDER_STEPS.ORDER_PLACEMENT,
      ERROR_CODES.UNEXPECTED_ERROR,
      error.message,
      { purchaseOrderId },
    );
    await saveOrderResults(authToken, {
      purchaseOrderId,
      products: addedProducts,
      priceMismatches: [],
      optionFailedProducts: [],
      automationErrors: errorCollector.getErrors(),
      poLineIds,
      success: false,
      vendor: "naver",
    });
    return res.json({
      success: false,
      error: error.message,
      steps,
      addedProducts,
      purchaseOrderId,
      automationErrors: errorCollector.getErrors(),
    });
  }
}

module.exports = {
  processNaverOrder,
  selectOptions,
  setQuantity,
  addToCart,
  processProduct,
  selectDeliveryAddress,
  modifyDeliveryAddress,
  handleCustomsCode,
  enterNaverPayPin,
  getProductPrice,
  SELECTORS,
};
