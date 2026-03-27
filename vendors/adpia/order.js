/**
 * 애드피아몰 주문 모듈
 *
 * 처리 방식: 개별 (상품별 개별 주문/결제)
 *
 * 흐름:
 * 1. 로그인
 * 2. 디자인 파일 다운로드
 * 3. 각 상품별 루프:
 *    - 장바구니 비우기
 *    - favor 페이지에서 제품코드로 상품 찾기 → 주문하러 가기
 *    - 주문 페이지에서:
 *      - 수량 입력 (#holder_num)
 *      - 가격 확인
 *      - 파일 업로드
 *      - 교정확인 후 인쇄 체크박스 (#is_proof_file)
 *      - 장바구니 담기
 *    - 주문서 이동
 *    - 배송지 입력
 *    - 결제 (ISP/페이북)
 *    - saveOrderResults 호출 (상품별)
 *
 * 데이터 흐름:
 * - 입력: { products, shippingAddress, poLineIds, purchaseOrderId }
 * - poLineIds: PurchaseOrderLine ID 배열 (대행접수용) - n8n에서 전달
 * - products[].orderLineIds: OrderLine ID 배열 (주문번호 업데이트용)
 *
 * saveOrderResults 호출 시 (상품별):
 * - success: true/false → 해당 상품의 처리 결과
 * - products[].orderLineIds: 주문번호 업데이트에 사용
 * - poLineIds: poLineIds[productIndex]를 배열로 감싸서 전달
 *   예: poLineIds: poLineIds?.[productIndex] ? [poLineIds[productIndex]] : []
 *
 * 특이사항:
 * - 디자인 파일 업로드 필수
 * - ISP 결제: automateISPPaymentWithAlertHandler() 사용 (alert 처리 포함)
 * - 결제 성공 시 createPaymentLogs() 호출
 */

const fs = require("fs");
const path = require("path");
const {
  createOrderErrorCollector,
  ORDER_STEPS,
  ERROR_CODES,
} = require("../../lib/automation-error");
const {
  saveOrderResults,
  createPaymentLogs,
  createAutomationErrors,
  createNeedsManagerVerification,
} = require("../../lib/graphql-client");
const { automateISPPayment } = require("../../lib/isp-payment");
const { processShinhanCardPayment } = require("../../lib/shinhan-payment");
const { getEnv } = require("../config");
const { findDaumFrameViaCDP, cleanupCDPFrame, searchAddressInFrame, selectAddressResult } = require("../../lib/daum-address");
const { searchAddressWithKakao, normalizeAddress } = require("../../lib/address-verify");
const { alertPaymentParsingFailed } = require("../../lib/alert-mail");
const https = require("https");
const http = require("http");

// 임시 파일 저장 경로
const TEMP_DIR = path.join(__dirname, "../../temp");

// 딜레이 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ISP/페이북 결제 래퍼 함수 (adpia 전용)
 * - 결제창에서 발생하는 alert를 처리하면서 공통 ISP 함수 호출
 */
async function automateISPPaymentWithAlertHandler(paymentPopup = null) {
  // alert 핸들러 (대기 루프 중 발생하는 alert 처리)
  const handledDialogs = new WeakSet();
  const ispLoopAlertHandler = async (dialog) => {
    if (handledDialogs.has(dialog)) return;
    handledDialogs.add(dialog);

    console.log("[ISP] Alert 발생:", dialog.type(), dialog.message());
    try {
      await dialog.accept();
    } catch (e) {
      if (!e.message.includes("already handled")) {
        console.log("[ISP] dialog accept 에러:", e.message);
      }
    }
  };

  let browser = null;
  const registeredPages = new Set();

  const registerHandlerOnPage = (p) => {
    if (!registeredPages.has(p)) {
      p.on("dialog", ispLoopAlertHandler);
      registeredPages.add(p);
    }
  };

  const targetCreatedHandler = async (target) => {
    if (target.type() === "page") {
      try {
        const newPage = await target.page();
        if (newPage) registerHandlerOnPage(newPage);
      } catch (e) {}
    }
  };

  // 결제창이 있으면 alert 핸들러 등록
  if (paymentPopup) {
    try {
      browser = paymentPopup.browser();
      browser.on("targetcreated", targetCreatedHandler);

      const allPages = await browser.pages();
      for (const p of allPages) {
        registerHandlerOnPage(p);
      }

      // alert/confirm 오버라이드
      try {
        await paymentPopup.evaluate(() => {
          window.alert = (msg) => console.log("[ISP Override] alert:", msg);
          window.confirm = (msg) => {
            console.log("[ISP Override] confirm:", msg);
            return true;
          };
        });
      } catch (e) {}

      // frame에도 오버라이드
      try {
        for (const frame of paymentPopup.frames()) {
          try {
            await frame.evaluate(() => {
              window.alert = (msg) =>
                console.log("[ISP Frame Override] alert:", msg);
              window.confirm = (msg) => {
                console.log("[ISP Frame Override] confirm:", msg);
                return true;
              };
            });
          } catch (e) {}
        }
      } catch (e) {}
    } catch (e) {
      paymentPopup.on("dialog", ispLoopAlertHandler);
      registeredPages.add(paymentPopup);
    }
  }

  try {
    // 공통 ISP 결제 함수 호출
    const result = await automateISPPayment();
    return result;
  } finally {
    // 핸들러 제거
    for (const p of registeredPages) {
      try {
        p.off("dialog", ispLoopAlertHandler);
      } catch (e) {}
    }
    if (browser) {
      try {
        browser.off("targetcreated", targetCreatedHandler);
      } catch (e) {}
    }
  }
}

// 셀렉터 상수
const SELECTORS = {
  // 로그인
  login: {
    idInput: "input.login_inputbox_id",
    pwInput: "input.login_inputbox_pw",
    submitBtn: "div.login_btn > a",
  },
  // 주문 페이지 (favor에서 주문하러 가기 클릭 후 이동하는 페이지)
  orderPage: {
    // 수량 입력 (트리플 클릭 후 타이핑)
    quantityInput: "#holder_num",
    // RTN-112326 등 일부 제품의 대체 수량 입력 필드
    quantityInputAlt: "input.input30[isnumber]",
    // 수량 선택 (select 방식 - #holder_num 없는 제품용)
    quantitySelect: "select#quantity",
    // 파일 업로드 (plupload - 동적 ID)
    fileInput: 'input[type="file"]',
    // 교정확인 후 인쇄 체크박스
    proofCheckbox: "#is_proof_file",
    // 장바구니 담기 버튼
    addToCartBtn:
      "#calcarea > div.order_list_re > div.ng-star-inserted > button.btn_m.or_white_02.ng-star-inserted",
    // RTN-112326 등 일부 제품의 대체 장바구니 담기 버튼
    addToCartBtnAlt:
      "#calcarea > div.order_list_re > div:nth-child(4) > button.btn_m.or_white_02",
    // 모달 확인 버튼 (alertify.js)
    modalConfirmBtn: ".ajs-modal button.ajs-button.btn_orange",
  },
  // 옵션 저장 페이지 (favor)
  favor: {
    url: "https://www.adpiamall.com/order/favor",
    table: "table.table01",
    row: "tbody tr.ng-star-inserted",
    productCode: 'span[style*="color: #4874db"]', // 제품코드 (RTN-XXXXXX)
    orderBtn: "button.btn_small.btn_grey_2019", // 주문하러 가기 버튼
    // 페이지네이션
    pagination: "ul.pagination",
    pageItem: "li.pagination-page a.page-link",
    activePage: "li.pagination-page.active",
    nextPage: "li.pagination-next:not(.disabled) a.page-link",
  },
  // 장바구니
  cart: {
    url: "https://www.adpiamall.com/cart",
    selectAll:
      "#sub_container > div > app-root > cartlist > div > div.list-str > div.list01 > div > div > a:nth-child(1)",
    deleteBtn:
      "#sub_container > div > app-root > cartlist > div > div.list-str > div.list01 > div > div > a.big_btn08.ng-star-inserted",
    orderBtn:
      "#sub_container > div > app-root > cartlist > div > div.list-str > div.cart_menu > div.list02 > button",
    // 상품 행: 체크박스가 있는 tr만 (빈 장바구니 메시지 제외)
    itemRow:
      "app-root cartlist table tbody tr.ng-star-inserted:has(input[type='checkbox'])",
    emptyMessage: "span.empty_cart", // "장바구니가 비었습니다"
  },
  // 주문서
  order: {
    // 배송 방법
    deliveryMethod: "#deliv_method",
    deliveryMethodValue: "DVM11", // 선불택배
    // 보내는 사람 - 주문자와 동일
    senderSameAsOrderer:
      "#ordersForm > div.list01 > div:nth-child(4) > table > tbody > tr:nth-child(1) > td:nth-child(2) > div:nth-child(1) > label > span",
    // 배송지 - 새로운 배송지
    newAddressBtn:
      "#ordersForm > div.list01 > div:nth-child(2) > table > tbody > tr.ng-star-inserted > td:nth-child(2) > div.lineinput.ml20.ml2 > label > span",
    // 주소 찾기 버튼
    addressSearchBtn:
      "#ordersForm > div.list01 > div:nth-child(2) > table > tbody > tr:nth-child(2) > td:nth-child(2) > div > daumpost > a",
    // 주소 입력 필드 (iframe 닫힌 후 상세주소 추가용)
    addressDetail: "#recv_addr_2",
    // 수령인
    receiverName: "#recv_name",
    // 배송지명
    deliveryName: "#deliv_name",
    // 휴대폰 (3개 필드)
    phoneFirst: "#recv_mobile_1", // select (010)
    phoneMiddle: "#recv_mobile_2", // input
    phoneLast: "#recv_mobile_3", // input
    // 결제수단 - 신용카드
    cardPayment: 'input[name="pay_method"][value="PYM20"]',
    // 카드사 선택
    cardType: "#LGD_CARDTYPE",
    cardTypeValue: "31", // 비씨
    // 전체 동의 체크박스
    agreeAll: "#agree_buy_all",
    // 결제하기 버튼
    payBtn: "#ordersForm > div.cart_menu > div > div.list02 > button",
    // 결제 확인 모달 버튼 (alertify.js)
    payConfirmBtn:
      "body > div.alertify.ajs-movable.ajs-closable.ajs-pinnable.ajs-fade > div.ajs-modal > div > div.ajs-footer > div.ajs-primary.ajs-buttons > button.ajs-button.btn.btn_orange",
    // 주문 완료 후 주문번호
    orderNumber:
      "#sub_container > div > app-root > orderresult > div > div.list-str > div > div:nth-child(1) > div > div > p > span",
  },
  // 다음 주소 검색 (iframe 내부)
  daumPostcode: {
    addressInput: "#region_name",
    searchButton: "#searchForm > fieldset > div > button.btn_search",
    resultItem: "li.list_post_item",
    roadAddress: "dd.info_address.main_road .txt_address button.link_post",
  },
};

/**
 * 요소 대기 헬퍼
 */
async function waitFor(page, selector, timeout = 10000) {
  try {
    await page.waitForSelector(selector, { timeout });
    return await page.$(selector);
  } catch (e) {
    return null;
  }
}

/**
 * URL에서 파일 다운로드 (이미 존재하면 스킵)
 */
async function downloadFile(url, filename) {
  // Docker 내부 호스트명을 localhost로 변환
  url = url.replace("host.docker.internal", "localhost");

  // temp 폴더 확인
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  const filePath = path.join(TEMP_DIR, filename);

  // 이미 파일이 존재하면 다운로드 스킵
  if (fs.existsSync(filePath)) {
    console.log("[adpia] 파일 이미 존재, 다운로드 스킵:", filePath);
    return filePath;
  }

  const protocol = url.startsWith("https") ? https : http;

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);

    protocol
      .get(url, (response) => {
        // 리다이렉트 처리
        if (response.statusCode === 301 || response.statusCode === 302) {
          downloadFile(response.headers.location, filename)
            .then(resolve)
            .catch(reject);
          return;
        }

        response.pipe(file);
        file.on("finish", () => {
          file.close();
          console.log("[adpia] 파일 다운로드 완료:", filePath);
          resolve(filePath);
        });
      })
      .on("error", (err) => {
        fs.unlink(filePath, () => {}); // 실패시 파일 삭제
        reject(err);
      });
  });
}

/**
 * 파일명 생성 (고정된 이름으로 재사용 가능하게)
 */
function getStableFilename(designFileUrl, productSku) {
  const urlParts = designFileUrl.split("/");
  const originalFilename = decodeURIComponent(urlParts[urlParts.length - 1]);
  // productSku와 원본 파일명으로 고정된 파일명 생성
  return `${productSku}_${originalFilename}`;
}

/**
 * 임시 파일 삭제
 */
function cleanupTempFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log("[adpia] 임시 파일 삭제:", filePath);
    }
  } catch (e) {
    console.error("[adpia] 임시 파일 삭제 실패:", e.message);
  }
}

/**
 * 주문 페이지에서 상품 처리 (수량 입력, 파일 업로드, 장바구니 담기)
 */
async function processOrderPage(page, product, downloadedFile, retryCount = 0) {
  const MAX_RETRIES = 3;
  console.log(
    `[adpia] 주문 페이지 처리: ${product.productSku}${
      retryCount > 0 ? ` (재시도 ${retryCount}/${MAX_RETRIES})` : ""
    }`,
  );

  // 페이지 로딩 대기
  await delay(2000);

  // 1. 수량 입력 (트리플 클릭 후 타이핑) - 재시도가 아닐 때만
  if (retryCount === 0) {
    // openMallQtyPerUnit 적용: 우리 1개 → 오픈몰 N개
    const baseQuantity = product.quantity || 1;
    const qtyPerUnit = product.openMallQtyPerUnit || 1;
    const actualQuantity = baseQuantity * qtyPerUnit;
    if (qtyPerUnit > 1) {
      console.log(
        `[adpia] 수량 변환: ${baseQuantity}개 × ${qtyPerUnit} = ${actualQuantity}개`,
      );
    }
    console.log(`[adpia] 수량 입력: ${actualQuantity}`);
    // select#quantity 먼저 체크 (드롭다운 방식)
    const quantitySelect = await waitFor(
      page,
      SELECTORS.orderPage.quantitySelect,
      3000,
    );
    if (quantitySelect) {
      await page.select(
        SELECTORS.orderPage.quantitySelect,
        String(actualQuantity),
      );
      console.log(`[adpia] 수량 select 선택: ${actualQuantity}`);
      await delay(1000);
      // 즉시 검증 (읽기 실패 시 경고만)
      try {
        const actualVal = await page.$eval(SELECTORS.orderPage.quantitySelect, el => el.value);
        if (actualVal && parseInt(actualVal, 10) !== actualQuantity) {
          console.log(`[adpia] ⚠️ 수량 검증 실패: 기대=${actualQuantity}, 실제=${actualVal}`);
          return { success: false, message: `수량 불일치: 기대=${actualQuantity}, 실제=${actualVal}` };
        }
        console.log(`[adpia] 수량 검증 OK: ${actualVal || actualQuantity}개`);
      } catch (e) {
        console.log(`[adpia] 수량 검증 스킵 (읽기 실패): ${e.message}`);
      }
    } else {
      // input 방식 시도
      let quantityInput = await waitFor(
        page,
        SELECTORS.orderPage.quantityInput,
        5000,
      );
      let usedSelector = SELECTORS.orderPage.quantityInput;
      // 기본 셀렉터 없으면 대체 셀렉터 시도 (RTN-112326 등)
      if (!quantityInput) {
        console.log("[adpia] 기본 수량 필드 없음, 대체 셀렉터 시도...");
        quantityInput = await waitFor(
          page,
          SELECTORS.orderPage.quantityInputAlt,
          5000,
        );
        usedSelector = SELECTORS.orderPage.quantityInputAlt;
      }
      if (quantityInput) {
        await quantityInput.click({ clickCount: 3 });
        await delay(500);
        await quantityInput.type(String(actualQuantity), { delay: 100 });
        await delay(1000);
        // 즉시 검증
        const actualVal = await page.$eval(usedSelector, el => el.value);
        if (parseInt(actualVal, 10) !== actualQuantity) {
          console.log(`[adpia] ⚠️ 수량 검증 실패: 기대=${actualQuantity}, 실제=${actualVal}`);
          return { success: false, message: `수량 불일치: 기대=${actualQuantity}, 실제=${actualVal}` };
        }
        console.log(`[adpia] 수량 검증 OK: ${actualVal}개`);
      } else {
        console.log(`[adpia] 수량 입력/선택 필드를 찾을 수 없음 (상품코드: ${product.productSku})`);
        return {
          success: false,
          message: "수량 선택 UI를 찾을 수 없음 (#holder_num, input.input30[isnumber], select#quantity 모두 없음)",
        };
      }
    }
  }

  // 2. 파일 선택 (업로드는 장바구니 담기 버튼 클릭 후 시작됨)
  if (downloadedFile?.filePath) {
    console.log(`[adpia] 파일 선택: ${downloadedFile.filePath}`);
    const fileInput = await page.$(SELECTORS.orderPage.fileInput);
    if (fileInput) {
      await fileInput.uploadFile(downloadedFile.filePath);
      console.log("[adpia] 파일 선택 완료");
      await delay(1000);
    } else {
      console.log(`[adpia] 파일 입력 필드를 찾을 수 없음 (상품코드: ${product.productSku}, 셀렉터: ${SELECTORS.orderPage.fileInput})`);
      return {
        success: false,
        message: "파일 입력 필드를 찾을 수 없음",
      };
    }
  }

  // 3. 교정확인 후 인쇄 체크박스 체크 (일부 제품에는 없을 수 있음)
  await delay(1000);
  console.log("[adpia] 교정확인 후 인쇄 체크박스 체크");
  try {
    const proofCheckbox = await page.$(SELECTORS.orderPage.proofCheckbox);
    if (proofCheckbox) {
      // 체크박스가 보이는지 확인
      const isVisible = await page.$eval(
        SELECTORS.orderPage.proofCheckbox,
        (el) => {
          const style = window.getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden";
        },
      );
      if (isVisible) {
        const isChecked = await page.$eval(
          SELECTORS.orderPage.proofCheckbox,
          (el) => el.checked,
        );
        if (!isChecked) {
          await proofCheckbox.click();
          await delay(1000);
        }
      } else {
        console.log("[adpia] 교정확인 체크박스가 숨겨져 있음 (스킵)");
      }
    } else {
      console.log("[adpia] 교정확인 체크박스 없음 (스킵)");
    }
  } catch (checkboxError) {
    console.log("[adpia] 교정확인 체크박스 처리 스킵:", checkboxError.message);
  }

  // 4. 장바구니 담기 버튼 클릭 → 업로드 시작 → 업로드 완료 후 모달 뜸
  // 파일 업로드 실패 시 최대 3회 재시도
  const MAX_UPLOAD_RETRIES = 3;

  for (let retryCount = 0; retryCount < MAX_UPLOAD_RETRIES; retryCount++) {
    if (retryCount > 0) {
      console.log(
        `[adpia] 파일 업로드 재시도 (${retryCount}/${MAX_UPLOAD_RETRIES - 1})...`,
      );
      await delay(2000);

      // 재시도 시 파일 다시 선택
      if (downloadedFile?.filePath) {
        console.log(`[adpia] 파일 재선택: ${downloadedFile.filePath}`);
        const fileInput = await page.$(SELECTORS.orderPage.fileInput);
        if (fileInput) {
          await fileInput.uploadFile(downloadedFile.filePath);
          console.log("[adpia] 파일 재선택 완료");
          await delay(1000);
        }
      }
    }

    await delay(1000);
    console.log("[adpia] 장바구니 담기 버튼 클릭");
    // 기본 셀렉터 시도
    let addToCartBtn = await waitFor(
      page,
      SELECTORS.orderPage.addToCartBtn,
      5000,
    );
    // 기본 셀렉터 없으면 대체 셀렉터 시도 (RTN-112326 등)
    if (!addToCartBtn) {
      console.log("[adpia] 기본 장바구니 버튼 없음, 대체 셀렉터 시도...");
      addToCartBtn = await waitFor(
        page,
        SELECTORS.orderPage.addToCartBtnAlt,
        5000,
      );
    }

    if (!addToCartBtn) {
      console.log(`[adpia] 장바구니 담기 버튼을 찾을 수 없음 (상품코드: ${product.productSku}, URL: ${page.url()})`);
      return { success: false, message: "장바구니 담기 버튼을 찾을 수 없음" };
    }

    try {
      await addToCartBtn.click();
    } catch (clickErr) {
      // "Node is not clickable" 등 → evaluate로 직접 클릭 폴백
      console.log(`[adpia] 장바구니 버튼 click 실패 (${clickErr.message}), evaluate 폴백...`);
      await page.evaluate((sel) => {
        const btn = document.querySelector(sel);
        if (btn) btn.click();
      }, SELECTORS.orderPage.addToCartBtn);
    }
    console.log("[adpia] 파일 업로드 진행 중...");
    await delay(3000); // 업로드 시작 대기

    // 5. 업로드 완료 대기 (진행률이 90% 이상 도달 후 떨어지면 완료로 간주, 최대 120초)
    // 빠른 업로드 시 진행률 1%인데 모달이 떠있는 경우도 처리
    let maxProgress = 0;
    let modalFoundEarly = false;
    let uploadRetryCount = 0;
    for (let i = 0; i < 120; i++) {
      await delay(1000);

      // 모달이 이미 떠있는지 확인 (업로드 완료 시 "장바구니" 포함 모달)
      const hasModal = await page.$(SELECTORS.orderPage.modalConfirmBtn);
      if (hasModal) {
        const modalText = await page.evaluate(() => {
          const content = document.querySelector(".ajs-modal .ajs-content");
          return content ? content.textContent?.trim() || "" : "";
        });
        if (modalText.includes("장바구니")) {
          console.log("[adpia] 파일 업로드 완료 (장바구니 모달 감지)");
          modalFoundEarly = true;
          break;
        } else if (modalText.includes("실패")) {
          // 업로드 실패 모달 → 3초 대기 후 닫고 장바구니 버튼 재클릭
          await delay(3000); // 모달 내용 확인 대기
          // 대기 후 모달 텍스트 재확인 (업로드 완료로 바뀔 수 있음)
          const recheckedText = await page.evaluate(() => {
            const content = document.querySelector(".ajs-modal .ajs-content");
            return content ? content.textContent?.trim() || "" : "";
          });
          if (recheckedText.includes("장바구니")) {
            console.log("[adpia] 파일 업로드 완료 (대기 후 장바구니 모달 감지)");
            modalFoundEarly = true;
            break;
          }
          uploadRetryCount++;
          console.log(`[adpia] ❌ 파일 업로드 실패 (${uploadRetryCount}/3): "${recheckedText}"`);
          await page.evaluate(() => {
            const btn = document.querySelector(".ajs-modal button.ajs-button.btn_orange");
            if (btn) btn.click();
          });
          await delay(2000);
          if (uploadRetryCount >= 3) {
            console.error("[adpia] 파일 업로드 3회 실패 - 중단");
            return { success: false, message: `파일 업로드 3회 실패: ${product.productSku} (${product.productName}) - 파일 형식 또는 용량 확인 필요`, needsManagerVerification: true };
          }
          // 장바구니 담기 버튼 다시 클릭
          const retryBtn = await page.$(SELECTORS.orderPage.addToCartBtn);
          if (retryBtn) {
            await retryBtn.click();
            console.log("[adpia] 장바구니 담기 버튼 재클릭");
          }
          await delay(3000);
        } else {
          // 빈 모달이나 알 수 없는 모달 → 3초 대기 후 재확인
          await delay(3000);
          const recheckedText2 = await page.evaluate(() => {
            const content = document.querySelector(".ajs-modal .ajs-content");
            return content ? content.textContent?.trim() || "" : "";
          });
          if (recheckedText2.includes("장바구니")) {
            console.log("[adpia] 파일 업로드 완료 (빈 모달 대기 후 장바구니 감지)");
            modalFoundEarly = true;
            break;
          }
          console.log(`[adpia] 모달 감지되었으나 업로드 완료가 아님: "${recheckedText2}" → 확인 후 계속 대기`);
          await page.evaluate(() => {
            const btn = document.querySelector(".ajs-modal button.ajs-button.btn_orange");
            if (btn) btn.click();
          });
          await delay(1000);
        }
      }

      const progress = await page.evaluate(() => {
        const barEl = document.querySelector("#pluprogress #bar");
        if (!barEl) return null;
        const width = barEl.style?.width || "0%";
        return parseInt(width.replace("%", ""), 10) || 0;
      });

      if (progress !== null) {
        if ((i + 1) % 10 === 0 || progress >= 90) {
          console.log(`[adpia] 업로드 진행률 (${i + 1}초): ${progress}%`);
        }

        // 최대 진행률 갱신
        if (progress > maxProgress) {
          maxProgress = progress;
        }

        // 90% 이상 도달 후 진행률이 크게 떨어지면 완료로 간주 (리셋됨)
        if (maxProgress >= 90 && progress < 50) {
          console.log("[adpia] 파일 업로드 완료 (진행률 리셋 감지)");
          break;
        }

        if (progress === 100) {
          console.log("[adpia] 파일 업로드 완료 (100%)");
          break;
        }
      }
    }

    // 6. 업로드 완료 후 모달 대기 (빠른 업로드로 이미 감지된 경우 즉시 처리, 최대 30초)
    if (!modalFoundEarly) {
      console.log("[adpia] 모달 대기 중...");
    }
    const modalConfirmBtn = await waitFor(
      page,
      SELECTORS.orderPage.modalConfirmBtn,
      modalFoundEarly ? 5000 : 30000, // 빠른 업로드 시 대기 시간 단축
    );

    let uploadFailed = false;

    if (modalConfirmBtn) {
      // 모달 메시지 확인
      await delay(500);
      let modalText = "";
      try {
        const modalContent = await page.$(".ajs-modal .ajs-content");
        if (modalContent) {
          modalText = await page.$eval(
            ".ajs-modal .ajs-content",
            (el) => el.textContent?.trim() || "",
          );
          console.log(`[adpia] 모달 메시지: ${modalText}`);
        }
      } catch (e) {
        console.log("[adpia] 모달 메시지 확인 중 에러 (무시):", e.message);
      }

      // 업로드 실패 메시지 확인
      if (
        modalText.includes("업로드에 실패") ||
        modalText.includes("업로드 실패")
      ) {
        console.log(`[adpia] ⚠️ 파일 업로드 실패 감지 (파일: ${downloadedFile?.filePath || "unknown"}, 모달메시지: ${modalText})`);
        uploadFailed = true;
      }

      // 모달 확인 버튼 클릭 전 딜레이 (너무 빠르면 사용자가 확인 어려움)
      await delay(1000);
      console.log("[adpia] 모달 확인 버튼 클릭");
      // page.evaluate로 직접 클릭 (Node detached 에러 방지)
      await page.evaluate(() => {
        const btn = document.querySelector(
          ".ajs-modal button.ajs-button.btn_orange",
        );
        if (btn) btn.click();
      });
      await delay(3000);

      // 업로드 실패 시 재시도
      if (uploadFailed) {
        if (retryCount < MAX_UPLOAD_RETRIES - 1) {
          console.log("[adpia] 파일 업로드 재시도 준비...");
          continue; // 다음 재시도
        } else {
          console.log(
            "[adpia] ❌ 파일 업로드 최대 재시도 횟수 초과 - 옵션 페이지에서 재시작 필요",
          );
          return {
            success: false,
            message: "파일 업로드 실패",
            needsRestart: true,
          };
        }
      }
    } else {
      console.log("[adpia] 모달이 나타나지 않음");
    }

    await delay(1500);

    // 현재 URL 확인
    const currentUrl = page.url();
    console.log(`[adpia] 현재 URL: ${currentUrl}`);

    // 장바구니 페이지로 이동했는지 확인
    if (currentUrl.includes("/cart")) {
      console.log("[adpia] 장바구니 페이지로 이동됨");
    }

    console.log("[adpia] 장바구니 담기 완료");
    return { success: true, message: "장바구니 담기 완료" };
  }

  // 여기까지 오면 모든 재시도 실패
  return { success: false, message: "파일 업로드 실패" };
}

/**
 * 애드피아몰 로그인
 */
async function loginToAdpia(page, vendor) {
  console.log("[adpia] 로그인 시작...");

  // 1. 로그인 페이지 이동 (ERR_EMPTY_RESPONSE 등 네트워크 에러 시 재시도)
  console.log("[adpia] 1. 로그인 페이지 이동...");
  const MAX_GOTO_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_GOTO_RETRIES; attempt++) {
    try {
      await page.goto(vendor.loginUrl, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
      break;
    } catch (e) {
      console.log(`[adpia] 페이지 이동 실패 (시도 ${attempt}/${MAX_GOTO_RETRIES}): ${e.message}`);
      if (attempt === MAX_GOTO_RETRIES) throw e;
      await delay(5000);
    }
  }
  await delay(1500);

  // 2. 이미 로그인 되어있는지 확인
  const idInput = await page.$(SELECTORS.login.idInput);
  if (!idInput) {
    console.log("[adpia] 아이디 입력창 없음 - 이미 로그인됨");
    return { success: true, message: "이미 로그인됨" };
  }

  console.log("[adpia] 로그인 페이지 확인됨, 로그인 진행...");

  // 3. 아이디 입력
  console.log("[adpia] 2. 아이디 입력...");
  await idInput.click({ clickCount: 3 });
  await delay(300);
  await idInput.type(vendor.userId, { delay: 50 });

  // 4. 비밀번호 입력
  console.log("[adpia] 3. 비밀번호 입력...");
  const pwInput = await waitFor(page, SELECTORS.login.pwInput, 5000);
  if (!pwInput) {
    return { success: false, message: "비밀번호 입력창을 찾을 수 없음" };
  }
  await pwInput.click({ clickCount: 3 });
  await delay(300);
  await pwInput.type(vendor.password, { delay: 50 });

  // 5. 로그인 버튼 클릭
  console.log("[adpia] 4. 로그인 버튼 클릭...");
  const submitBtn = await page.$(SELECTORS.login.submitBtn);
  if (submitBtn) {
    await submitBtn.click();
  } else {
    await page.keyboard.press("Enter");
  }

  await delay(2000);

  // 페이지 이동 대기
  await page
    .waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 })
    .catch(() => {});
  await delay(1500);

  console.log("[adpia] 로그인 완료!");
  return { success: true, message: "로그인 완료" };
}

/**
 * 장바구니 비우기
 */
async function clearCart(page) {
  console.log("[adpia] 장바구니 비우기 시작...");

  try {
    // 1. 장바구니 페이지 이동
    const currentUrl = page.url();
    if (!currentUrl.includes("/cart")) {
      await page.goto(SELECTORS.cart.url, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
      await delay(2000);
    }

    // 2. confirm 다이얼로그 자동 수락 설정
    const dialogHandler = async (dialog) => {
      console.log("[adpia] 다이얼로그:", dialog.type(), dialog.message());
      await dialog.accept();
    };
    page.on("dialog", dialogHandler);

    // 3. 장바구니에 상품이 있는지 확인
    // 빈 장바구니 메시지 확인
    const emptyMessage = await page.$(SELECTORS.cart.emptyMessage);
    if (emptyMessage) {
      console.log("[adpia] 장바구니가 이미 비어있음 (메시지 확인)");
      page.off("dialog", dialogHandler);
      return { success: true, message: "장바구니 비어있음" };
    }

    // 상품 행 개수 확인
    const cartItems = await page.$$(
      "app-root cartlist table tbody tr.ng-star-inserted input[type='checkbox']",
    );
    if (cartItems.length === 0) {
      console.log("[adpia] 장바구니가 이미 비어있음");
      page.off("dialog", dialogHandler);
      return { success: true, message: "장바구니 비어있음" };
    }
    console.log(`[adpia] 장바구니 상품 ${cartItems.length}개 발견`);

    // 4. 전체 선택 클릭
    const selectAll = await waitFor(page, SELECTORS.cart.selectAll, 5000);
    if (selectAll) {
      await selectAll.click();
      console.log("[adpia] 전체 선택 클릭");
      await delay(500);
    }

    // 5. 선택삭제 클릭
    const deleteBtn = await waitFor(page, SELECTORS.cart.deleteBtn, 5000);
    if (deleteBtn) {
      await deleteBtn.click();
      console.log("[adpia] 선택삭제 클릭");
      await delay(2000);

      // alertify.js 확인 버튼 처리
      const confirmBtn = await page.$(SELECTORS.orderPage.modalConfirmBtn);
      if (confirmBtn) {
        await confirmBtn.click();
        console.log("[adpia] 모달 확인 클릭");
        await delay(1500);
      }
    }

    // 6. dialog 핸들러 제거
    page.off("dialog", dialogHandler);

    console.log("[adpia] 장바구니 비우기 완료");
    return { success: true, message: "장바구니 비우기 완료" };
  } catch (error) {
    console.error("[adpia] 장바구니 비우기 실패:", error.message);
    return { success: false, message: error.message };
  }
}

/**
 * 옵션 저장 페이지에서 제품코드로 상품 찾기
 * @param {Page} page - Puppeteer 페이지
 * @param {string} productCode - 제품코드 (RTN-XXXXXX)
 * @returns {Object} { success, message, price? }
 */
async function findProductByCode(page, productCode) {
  console.log(`[adpia] 제품코드 검색: ${productCode}`);

  // 1. 옵션 저장 페이지 이동
  await page.goto(SELECTORS.favor.url, {
    waitUntil: "networkidle2",
    timeout: 30000,
  });
  await delay(2000);

  let currentPage = 1;
  const maxPages = 100; // 무한 루프 방지

  while (currentPage <= maxPages) {
    console.log(`[adpia] ${currentPage}페이지 검색 중...`);

    // 2. 현재 페이지에서 제품코드 찾기
    const result = await page.evaluate(
      (selectors, targetCode) => {
        const rows = document.querySelectorAll(selectors.row);

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const codeEl = row.querySelector(selectors.productCode);

          if (codeEl) {
            const code = codeEl.textContent.trim();
            if (code === targetCode) {
              // 가격 추출
              const priceCell = row.querySelector("td:nth-child(4)");
              const priceText = priceCell ? priceCell.textContent.trim() : "";
              const price = parseInt(priceText.replace(/[^0-9]/g, ""), 10) || 0;

              return {
                found: true,
                rowIndex: i,
                price,
              };
            }
          }
        }

        return { found: false };
      },
      SELECTORS.favor,
      productCode,
    );

    if (result.found) {
      console.log(
        `[adpia] 제품 찾음! (${currentPage}페이지, ${
          result.rowIndex + 1
        }번째 행, 가격: ${result.price}원)`,
      );

      // 3. 해당 행의 "주문하러 가기" 버튼 클릭
      const rows = await page.$$(SELECTORS.favor.row);
      const targetRow = rows[result.rowIndex];

      if (targetRow) {
        const orderBtn = await targetRow.$(SELECTORS.favor.orderBtn);
        if (orderBtn) {
          await orderBtn.click();
          await delay(2000);

          // 페이지 이동 대기
          await page
            .waitForNavigation({ waitUntil: "networkidle2", timeout: 5000 })
            .catch(() => {});
          await delay(1500);

          console.log(`[adpia] 주문 페이지로 이동 완료`);
          return {
            success: true,
            message: "제품 찾음",
            price: result.price,
          };
        }
      }

      return {
        success: false,
        message: "주문하러 가기 버튼을 찾을 수 없음",
      };
    }

    // 4. 다음 페이지가 있는지 확인
    const nextPageBtn = await page.$(
      "li.pagination-next:not(.disabled) a.page-link",
    );

    if (!nextPageBtn) {
      console.log(`[adpia] 마지막 페이지 도달 (${currentPage}페이지)`);
      break;
    }

    // 5. 다음 페이지로 이동
    // "›" 버튼 (바로 다음 페이지) 클릭
    const nextBtns = await page.$$("li.pagination-next a.page-link");
    if (nextBtns.length > 0) {
      // 첫 번째 › 버튼 클릭
      await nextBtns[0].click();
      await delay(2000);
      currentPage++;
    } else {
      break;
    }
  }

  console.log(`[adpia] 제품을 찾을 수 없음: ${productCode}`);
  return {
    success: false,
    message: `제품을 찾을 수 없음: ${productCode}`,
  };
}

/**
 * 장바구니에서 주문서로 이동
 */
async function goToOrderForm(page) {
  console.log("[adpia] 장바구니 → 주문서 이동...");

  try {
    // 1. 장바구니 페이지 이동
    const currentUrl = page.url();
    if (!currentUrl.includes("/cart")) {
      await page.goto(SELECTORS.cart.url, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
      await delay(2000);
    }

    // 2. 장바구니에 상품이 있는지 확인
    const emptyMessage = await page.$(SELECTORS.cart.emptyMessage);
    if (emptyMessage) {
      console.log("[adpia] 장바구니가 비어있음");
      return { success: false, message: "장바구니가 비어있음" };
    }

    const cartItems = await page.$$(
      "app-root cartlist table tbody tr.ng-star-inserted input[type='checkbox']",
    );
    if (cartItems.length === 0) {
      console.log("[adpia] 장바구니가 비어있음");
      return { success: false, message: "장바구니가 비어있음" };
    }
    console.log(`[adpia] 장바구니 상품 ${cartItems.length}개`);

    // 3. 전체 선택 클릭
    const selectAll = await waitFor(page, SELECTORS.cart.selectAll, 5000);
    if (selectAll) {
      await selectAll.click();
      console.log("[adpia] 전체 선택 클릭");
      await delay(500);
    }

    // 4. 주문하기 버튼 클릭
    const orderBtn = await waitFor(page, SELECTORS.cart.orderBtn, 5000);
    if (!orderBtn) {
      console.log("[adpia] 주문하기 버튼을 찾을 수 없음");
      return { success: false, message: "주문하기 버튼을 찾을 수 없음" };
    }
    await orderBtn.click();
    console.log("[adpia] 주문하기 버튼 클릭");

    await delay(2000);

    // 5. 페이지 이동 대기
    await page
      .waitForNavigation({ waitUntil: "networkidle2", timeout: 5000 })
      .catch(() => {});
    await delay(1500);

    console.log("[adpia] 주문서 페이지 이동 완료");
    return { success: true, message: "주문서 페이지 이동 완료" };
  } catch (error) {
    console.error("[adpia] 주문서 이동 실패:", error.message);
    return { success: false, message: error.message };
  }
}

// directAddressInput 제거 — 다음 주소 검색 iframe 방식으로 전환 (lib/daum-address.js)

/**
 * 배송지 입력
 */
async function fillShippingInfo(page, shippingInfo, ispPassword) {
  console.log("[adpia] 배송지 입력...");

  if (!shippingInfo) {
    console.log("[adpia] 배송지 정보 없음");
    return { success: false, message: "배송지 정보 없음" };
  }

  try {
    // 페이지 로딩 대기
    await delay(2000);

    // 1. 보내는 사람 - 주문자와 동일 클릭
    console.log("[adpia] 1. 보내는 사람 - 주문자와 동일 클릭...");
    const senderSame = await page.$(SELECTORS.order.senderSameAsOrderer);
    if (senderSame) {
      await senderSame.click();
      await delay(500);
    }

    // 2. 새로운 배송지 클릭
    console.log("[adpia] 2. 새로운 배송지 클릭...");
    const newAddressBtn = await page.$(SELECTORS.order.newAddressBtn);
    if (newAddressBtn) {
      await newAddressBtn.click();
      await delay(500);
    }

    // 3. 수령인, 배송지명 입력 (동일 값)
    let recipientName =
      shippingInfo.firstName || shippingInfo.receiverName || "";
    // 20byte 제한 (한글 2byte, 영문/숫자 1byte)
    const getByteLength = (str) => {
      let bytes = 0;
      for (const ch of str) {
        bytes += ch.charCodeAt(0) > 127 ? 2 : 1;
      }
      return bytes;
    };
    if (getByteLength(recipientName) > 20) {
      let trimmed = "";
      let bytes = 0;
      for (const ch of recipientName) {
        const charBytes = ch.charCodeAt(0) > 127 ? 2 : 1;
        if (bytes + charBytes > 20) break;
        trimmed += ch;
        bytes += charBytes;
      }
      console.log(`[adpia] 수령인 이름 20byte 초과 (${getByteLength(recipientName)}byte) → ${bytes}byte로 자름: ${trimmed}`);
      recipientName = trimmed;
    }
    if (recipientName) {
      console.log(`[adpia] 3. 수령인/배송지명 입력: ${recipientName}`);

      // 수령인
      const recvName = await page.$(SELECTORS.order.receiverName);
      if (recvName) {
        await recvName.click({ clickCount: 3 });
        await delay(100);
        await recvName.type(recipientName, { delay: 50 });
        await delay(300);
      }

      // 배송지명 (동일 값)
      const delivName = await page.$(SELECTORS.order.deliveryName);
      if (delivName) {
        await delivName.click({ clickCount: 3 });
        await delay(100);
        await delivName.type(recipientName, { delay: 50 });
        await delay(300);
      }
    }

    // 4. 휴대폰 번호 입력
    const phone = shippingInfo.phone || "";
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

        console.log(`[adpia] 4. 휴대폰 입력: ${first}-${middle}-${last}`);

        // 앞자리 select
        const phoneFirstSelect = await page.$(SELECTORS.order.phoneFirst);
        if (phoneFirstSelect) {
          await page.select(SELECTORS.order.phoneFirst, first);
          await delay(200);
        }

        // 중간
        const phoneMiddleInput = await page.$(SELECTORS.order.phoneMiddle);
        if (phoneMiddleInput) {
          await phoneMiddleInput.click({ clickCount: 3 });
          await delay(100);
          await phoneMiddleInput.type(middle, { delay: 30 });
          await delay(200);
        }

        // 뒷자리
        const phoneLastInput = await page.$(SELECTORS.order.phoneLast);
        if (phoneLastInput) {
          await phoneLastInput.click({ clickCount: 3 });
          await delay(100);
          await phoneLastInput.type(last, { delay: 30 });
          await delay(200);
        }
      }
    }

    // 5. 주소 찾기 버튼 클릭 → 다음 주소 iframe 검색/선택
    console.log("[adpia] 5. 주소 찾기 버튼 클릭...");
    const searchAddress =
      shippingInfo.streetAddress1 || shippingInfo.address || "";

    // 텍스트 기반으로 "주소 찾기" / "주소찾기" 버튼 찾기
    const addressSearchBtn = await page.evaluateHandle(() => {
      const links = document.querySelectorAll('a, button');
      for (const el of links) {
        const text = (el.textContent || '').trim();
        if (text === '주소 찾기' || text === '주소찾기') {
          return el;
        }
      }
      return null;
    });
    const isBtnFound = await page.evaluate((el) => !!el, addressSearchBtn);
    if (isBtnFound) {
      await addressSearchBtn.click();
      await delay(3000);

      // 6. 다음 주소 검색 iframe 찾기 (공통 모듈)
      console.log("[adpia] 6. 주소 검색 iframe 찾기...");
      let frame = null;

      // 먼저 일반 방식으로 iframe 찾기
      for (let i = 0; i < 20; i++) {
        const allFrames = page.frames();
        for (const f of allFrames) {
          const url = f.url();
          if (url.includes("postcode") || url.includes("daum.net/search")) {
            try {
              const hasInput = await f.$("#region_name");
              if (hasInput) {
                frame = f;
                console.log(`[adpia] 주소 iframe 발견 (일반, ${i + 1}회)`);
                break;
              }
            } catch (e) { /* OOPIF일 수 있음 */ }
          }
        }
        if (frame) break;
        await delay(500);
      }

      // 일반 방식 실패 시 OOPIF CDP 폴백
      if (!frame) {
        console.log("[adpia] 일반 방식 실패 → OOPIF CDP 폴백...");
        try {
          frame = await findDaumFrameViaCDP(page, "#region_name", "[adpia]");
        } catch (e) {
          console.log("[adpia] CDP 폴백 실패:", e.message);
        }
      }

      if (frame) {
        // 7. iframe 내 주소 검색
        console.log("[adpia] 7. iframe 내 주소 검색...");
        await delay(500);
        const searchResult = await searchAddressInFrame(
          frame, searchAddress, "#region_name", ".btn_search", "[adpia]"
        );

        if (searchResult.success) {
          // 8. 검색 결과 선택 (도로명 > 지번)
          console.log("[adpia] 8. 주소 검색 결과 선택...");
          const selectResult = await selectAddressResult(frame, "li.list_post_item", "[adpia]");
          if (selectResult.success) {
            console.log("[adpia] ✅ 주소 선택 완료");
          } else {
            console.log("[adpia] ❌ 주소 선택 실패:", selectResult.error);
            await cleanupCDPFrame(frame, "[adpia]");
            return { success: false, message: `주소 선택 실패: ${selectResult.error}` };
          }
        } else {
          console.log("[adpia] ❌ 주소 검색 실패:", searchResult.error);
          await cleanupCDPFrame(frame, "[adpia]");
          return { success: false, message: `주소 검색 실패: ${searchResult.error}` };
        }

        // CDP 세션 정리
        await cleanupCDPFrame(frame, "[adpia]");
        await delay(1000);
      } else {
        console.log("[adpia] ❌ 주소 검색 iframe 못찾음");
        return { success: false, message: "주소 검색 iframe 못찾음" };
      }
    } else {
      console.log("[adpia] ❌ 주소 찾기 버튼 못찾음");
      return { success: false, message: "주소 찾기 버튼 못찾음" };
    }

    // 9. 상세주소 입력 (#recv_addr_2)
    const detailAddress = shippingInfo.streetAddress2 || shippingInfo.addressDetail || "";
    if (detailAddress) {
      console.log(`[adpia] 9. 상세주소 입력: ${detailAddress}`);
      const result = await page.evaluate((val) => {
        const el = document.querySelector("#recv_addr_2");
        if (el) {
          el.readOnly = false;
          el.disabled = false;
          el.value = el.value ? el.value + " " + val : val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { success: true, value: el.value };
        }
        return { success: false };
      }, detailAddress);
      console.log("[adpia] 상세주소 결과:", result);
      await delay(300);
    }

    // 9-1. 주소 검증 (카카오 API vs #recv_addr_1)
    console.log("[adpia] 주소 검증 시작...");
    const addrToVerify = shippingInfo.streetAddress1 || shippingInfo.address || "";
    const kakaoVerifyResult = await searchAddressWithKakao(addrToVerify);
    if (!kakaoVerifyResult) {
      console.log("[adpia] 카카오 API 결과 없음 - 검증 스킵");
    } else {
      const addr1 = await page.$eval("#recv_addr_1", (el) => el.value).catch(() => "");
      console.log("[adpia] 화면 기본주소:", addr1);

      const normalizedAddr1 = normalizeAddress(addr1);
      const kakaoChecks = [
        kakaoVerifyResult.roadAddress,
        kakaoVerifyResult.jibunAddress,
        normalizeAddress(kakaoVerifyResult.roadAddress),
        normalizeAddress(kakaoVerifyResult.jibunAddress),
      ].filter(Boolean);

      const matched = kakaoChecks.some(k => addr1.includes(k) || normalizedAddr1.includes(k));

      if (matched) {
        console.log("[adpia] ✅ 주소 검증 성공");
      } else {
        console.error("[adpia] ❌ 주소 검증 실패!");
        console.error(`[adpia]   카카오 도로명: ${kakaoVerifyResult.roadAddress}`);
        console.error(`[adpia]   카카오 지번: ${kakaoVerifyResult.jibunAddress}`);
        console.error(`[adpia]   화면 주소: ${addr1}`);
        return { success: false, message: `주소 검증 실패 - 카카오: ${kakaoVerifyResult.roadAddress}, 화면: ${addr1}` };
      }
    }

    // 10~12. 배송방법 + 결제수단 선택 (서로 초기화시킬 수 있어서 재확인 필요)
    await delay(2000); // 주소 입력 후 렌더링 대기
    const paymentCardType = getEnv("PAYMENT_CARD_TYPE") || "shinhan";
    const cardTypeValue = paymentCardType === "bc" ? "31" : "41";

    // 선불택배 선택 헬퍼 (옵션 로드 대기 + 재시도)
    const selectDeliveryMethod = async () => {
      const targetValue = SELECTORS.order.deliveryMethodValue;
      const selector = SELECTORS.order.deliveryMethod;

      // 옵션이 로드될 때까지 대기 (최대 15초)
      console.log("[adpia] 배송방법 옵션 로드 대기...");
      for (let wait = 0; wait < 15; wait++) {
        const optionExists = await page.evaluate((sel, val) => {
          const select = document.querySelector(sel);
          if (!select) return { exists: false, options: [] };
          const options = Array.from(select.options).map(o => ({ value: o.value, text: o.text }));
          const found = options.some(o => o.value === val);
          return { exists: found, optionCount: options.length, options: options.slice(0, 5) };
        }, selector, targetValue).catch(() => ({ exists: false, options: [] }));

        if (optionExists.exists) {
          console.log(`[adpia] 선불택배 옵션 발견 (${wait + 1}초 대기, 총 ${optionExists.optionCount}개 옵션)`);
          break;
        }
        if (wait % 5 === 0) {
          console.log(`[adpia] 배송방법 옵션 대기 중... (${wait + 1}초, ${optionExists.optionCount || 0}개 옵션)`);
        }
        await delay(1000);
      }

      // 선택 시도 (3회)
      for (let attempt = 1; attempt <= 3; attempt++) {
        console.log(`[adpia] 배송 방법 선택 (선불택배) 시도 ${attempt}/3...`);
        const dm = await waitFor(page, selector, 5000);
        if (dm) {
          await page.select(selector, targetValue);
          await delay(1000);
          const selectedValue = await page.$eval(selector, (el) => el.value).catch(() => null);
          if (selectedValue === targetValue) {
            console.log(`[adpia] 선불택배 선택 확인 완료 (시도 ${attempt}/3)`);
            return;
          }
          console.log(`[adpia] 선불택배 선택 안됨 (value: ${selectedValue}), 재시도...`);
          await delay(2000);
        } else {
          console.log(`[adpia] ⚠️ 배송 방법 선택 요소 없음 (시도 ${attempt}/3)`);
          await delay(2000);
        }
      }
      console.log("[adpia] ⚠️ 선불택배 선택 실패");
    };
    // 결제수단 선택 헬퍼
    const selectPaymentMethod = async () => {
      console.log(`[adpia] 결제수단 선택 (${paymentCardType === "bc" ? "BC카드" : "신한카드"})...`);
      const cp = await waitFor(page, SELECTORS.order.cardPayment, 10000);
      if (cp) { await cp.click(); await delay(1000); }
      const ct = await waitFor(page, SELECTORS.order.cardType, 5000);
      if (ct) {
        await page.select(SELECTORS.order.cardType, cardTypeValue);
        await delay(1500);
      }
    };

    // 1차: 선불택배 → 결제수단
    await selectDeliveryMethod();
    await selectPaymentMethod();

    // 선불택배 확인 → 풀렸으면 다시 선불택배 → 결제수단
    const delivCheck = await page.$eval(
      SELECTORS.order.deliveryMethod, (el) => el.value,
    ).catch(() => null);
    if (delivCheck !== SELECTORS.order.deliveryMethodValue) {
      console.log(`[adpia] 선불택배 초기화 감지 (현재: ${delivCheck}) → 재설정`);
      await selectDeliveryMethod();
      await selectPaymentMethod();
    } else {
      console.log("[adpia] 선불택배 유지 확인 OK");
    }

    // 13. 전체 동의 체크박스 클릭
    console.log("[adpia] 13. 전체 동의 체크박스 클릭...");
    const agreeResult = await page.evaluate(() => {
      const checkbox = document.querySelector("#agree_buy_all");
      if (checkbox) {
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
        checkbox.dispatchEvent(new Event("click", { bubbles: true }));
        return { success: true, checked: checkbox.checked };
      }
      // label 클릭 시도
      const label = document.querySelector('label[for="agree_buy_all"]');
      if (label) {
        label.click();
        return { success: true, method: "label" };
      }
      return { success: false, error: "element not found" };
    });
    console.log("[adpia] 전체 동의 결과:", agreeResult);
    await delay(3000);

    // 14. 결제하기 버튼 클릭 전 - 현재 페이지 목록 저장
    const payBrowser = page.browser();
    const pagesBeforePay = await payBrowser.pages();
    const pagesBeforePaySet = new Set(pagesBeforePay);

    // 새 페이지 생성 시 즉시 dialog 핸들러 등록 (alert 놓치지 않도록)
    let paymentPopup = null;
    const paymentDialogHandler = async (dialog) => {
      console.log("[adpia] 결제창 Dialog:", dialog.type(), dialog.message());
      await dialog.accept();
    };
    const targetCreatedHandler = async (target) => {
      if (target.type() === "page") {
        const newPage = await target.page();
        if (newPage && !pagesBeforePaySet.has(newPage)) {
          const url = newPage.url();
          if (!url.startsWith("devtools://")) {
            console.log("[adpia] 새 결제창 감지:", url);
            paymentPopup = newPage;
            newPage.on("dialog", paymentDialogHandler);
          }
        }
      }
    };
    payBrowser.on("targetcreated", targetCreatedHandler);

    console.log("[adpia] 14. 결제하기 버튼 클릭...");
    const payBtn = await page.$(SELECTORS.order.payBtn);
    if (payBtn) {
      await payBtn.click();
      await delay(2000);

      // 15. 결제 확인 모달 버튼 클릭
      console.log("[adpia] 15. 결제 확인 모달 버튼 클릭...");
      const payConfirmBtn = await waitFor(
        page,
        SELECTORS.order.payConfirmBtn,
        5000,
      );
      if (payConfirmBtn) {
        await payConfirmBtn.click();
        await delay(3000);

        // ========== 카드타입별 결제 분기 ==========
        if (paymentCardType === "shinhan") {
          // ===== 신한카드: 토스페이먼츠 iframe 결제 =====
          console.log("[adpia] 토스페이먼츠 결제창 대기 (신한카드)...");

          let paymentFrame = null;
          for (let i = 0; i < 20; i++) {
            const allFrames = page.frames();
            for (const f of allFrames) {
              try {
                const hasPaymentUI = await f.evaluate(() => {
                  const tabs = document.querySelectorAll('a[role="tab"]');
                  for (const tab of tabs) {
                    if (tab.textContent?.includes("다른결제")) return true;
                  }
                  return !!document.querySelector("#cardNum1");
                });
                if (hasPaymentUI) {
                  paymentFrame = f;
                  console.log("[adpia] 결제 UI 프레임 발견");
                  break;
                }
              } catch (e) {}
            }
            if (paymentFrame) break;
            await delay(1000);
          }

          if (!paymentFrame) {
            payBrowser.off("targetcreated", targetCreatedHandler);
            return {
              success: false,
              message: "토스페이먼츠 결제 프레임을 찾을 수 없음",
            };
          }

          await delay(1000);
          console.log("[adpia] 신한카드 결제 자동화 시작...");
          const shinhanResult = await processShinhanCardPayment(paymentFrame, page, "phone", page);

          if (shinhanResult.success) {
            console.log("[adpia] ✅ 신한카드 결제 자동화 완료");
          } else {
            console.log("[adpia] ⚠️ 신한카드 결제 실패:", shinhanResult.error);
            payBrowser.off("targetcreated", targetCreatedHandler);
            return {
              success: false,
              message: `신한카드 결제 실패: ${shinhanResult.error}`,
            };
          }

          // 결제 완료 대기
          await delay(10000);
          const currentUrl = page.url();
          console.log("[adpia] 결제 후 URL:", currentUrl);

          // 주문번호 추출
          let vendorOrderNumber = null;
          try {
            if (
              currentUrl.includes("orderresult") ||
              currentUrl.includes("order/result")
            ) {
              await page.waitForSelector(SELECTORS.order.orderNumber, {
                timeout: 10000,
              });
              vendorOrderNumber = await page.$eval(
                SELECTORS.order.orderNumber,
                (el) => el.textContent?.trim(),
              );
              console.log("[adpia] ✅ 주문번호:", vendorOrderNumber);
            } else {
              await delay(3000);
              const orderNumberEl = await page.$(SELECTORS.order.orderNumber);
              if (orderNumberEl) {
                vendorOrderNumber = await page.$eval(
                  SELECTORS.order.orderNumber,
                  (el) => el.textContent?.trim(),
                );
                console.log("[adpia] ✅ 주문번호:", vendorOrderNumber);
              }
            }
          } catch (e) {
            console.log("[adpia] 주문번호 추출 실패:", e.message);
          }

          payBrowser.off("targetcreated", targetCreatedHandler);
          return {
            success: !!vendorOrderNumber,
            message: vendorOrderNumber ? "결제 완료" : "결제 완료 확인 필요",
            vendorOrderNumber,
          };
        } else {
          // ===== BC카드: ISP/페이북 결제 =====
          console.log("[adpia] 16. BC카드 결제창 찾는 중...");
          // 최대 20회 (약 60초) 대기하면서 팝업 탐색
          for (let popupRetry = 0; popupRetry < 20 && !paymentPopup; popupRetry++) {
            const pagesAfterPay = await payBrowser.pages();
            for (const p of pagesAfterPay) {
              if (!pagesBeforePaySet.has(p)) {
                const url = p.url();
                if (!url.startsWith("devtools://")) {
                  paymentPopup = p;
                  console.log("[adpia] 결제창 찾음:", url);
                  paymentPopup.on("dialog", paymentDialogHandler);
                  break;
                }
              }
            }
            if (!paymentPopup) {
              console.log(`[adpia] BC카드 결제창 대기 중... (${(popupRetry + 1) * 3}/60초)`);
              await delay(3000);
            }
          }

          if (paymentPopup) {
            await delay(2000);

            // 17. 기타결제 버튼 클릭
            console.log("[adpia] 17. 기타결제 버튼 클릭...");
            const otherPaymentBtn = "#inapppay-dap1 > div.block2 > div.left > a";

            try {
              await paymentPopup.waitForSelector(otherPaymentBtn, {
                timeout: 60000,
              });
              await paymentPopup.click(otherPaymentBtn);
              console.log("[adpia] ✅ 기타결제 버튼 클릭 완료");
              await delay(3000);

              // 18. 인증서 등록/결제 버튼 클릭
              console.log("[adpia] 18. 인증서 등록/결제 버튼 클릭...");
              const certPaymentBtn =
                "#inapppay-dap2 > div.block1 > div.left > a.pay-item-s.pay-ctf";

              try {
                await paymentPopup.waitForSelector(certPaymentBtn, {
                  timeout: 60000,
                });

                // 19. ISP/페이북 네이티브 윈도우 자동화
                const ispAlertHandler = async (dialog) => {
                  console.log(
                    "[adpia] ISP Alert 감지:",
                    dialog.type(),
                    dialog.message(),
                  );
                  try {
                    await dialog.accept();
                  } catch (e) {}
                };
                page.on("dialog", ispAlertHandler);
                paymentPopup.on("dialog", ispAlertHandler);

                try {
                  await page.evaluate(() => {
                    window.alert = (msg) => console.log("[Override] alert:", msg);
                    window.confirm = (msg) => { console.log("[Override] confirm:", msg); return true; };
                  });
                } catch (e) {}
                try {
                  await paymentPopup.evaluate(() => {
                    window.alert = (msg) => console.log("[Override] alert:", msg);
                    window.confirm = (msg) => { console.log("[Override] confirm:", msg); return true; };
                  });
                } catch (e) {}

                await paymentPopup.click(certPaymentBtn);
                console.log("[adpia] ✅ 인증서 등록/결제 버튼 클릭 완료");
                await delay(3000);

                console.log("[adpia] ISP 네이티브 결제창 자동화 시작...");
                const ispResult =
                  await automateISPPaymentWithAlertHandler(paymentPopup);

                page.off("dialog", ispAlertHandler);
                paymentPopup.off("dialog", ispAlertHandler);

                if (ispResult.success) {
                  console.log("[adpia] ✅ ISP 결제 자동화 완료");

                  // 결제 완료 대기
                  for (let i = 0; i < 60; i++) {
                    await delay(1000);
                    try {
                      if (paymentPopup.isClosed()) {
                        console.log("[adpia] 결제창 닫힘 확인");
                        break;
                      }
                    } catch (e) {
                      break;
                    }
                    if (i % 10 === 0) {
                      console.log(`[adpia] 결제 완료 대기 중... ${i}초`);
                    }
                  }

                  await delay(3000);
                  const currentUrl = page.url();
                  console.log("[adpia] 결제 후 URL:", currentUrl);

                  let vendorOrderNumber = null;
                  try {
                    if (
                      currentUrl.includes("orderresult") ||
                      currentUrl.includes("order/result")
                    ) {
                      await page.waitForSelector(SELECTORS.order.orderNumber, {
                        timeout: 10000,
                      });
                      vendorOrderNumber = await page.$eval(
                        SELECTORS.order.orderNumber,
                        (el) => el.textContent?.trim(),
                      );
                      console.log("[adpia] ✅ 주문번호:", vendorOrderNumber);
                    } else {
                      await delay(3000);
                      const orderNumberEl = await page.$(SELECTORS.order.orderNumber);
                      if (orderNumberEl) {
                        vendorOrderNumber = await page.$eval(
                          SELECTORS.order.orderNumber,
                          (el) => el.textContent?.trim(),
                        );
                        console.log("[adpia] ✅ 주문번호:", vendorOrderNumber);
                      }
                    }
                  } catch (e) {
                    console.log("[adpia] 주문번호 추출 실패:", e.message);
                  }

                  payBrowser.off("targetcreated", targetCreatedHandler);
                  return {
                    success: true,
                    message: "결제 완료",
                    vendorOrderNumber,
                  };
                } else {
                  console.log("[adpia] ⚠️ ISP 결제 실패:", ispResult.error);
                  if (ispResult.error === "페이북 창을 찾을 수 없음") {
                    payBrowser.off("targetcreated", targetCreatedHandler);
                    return {
                      success: false,
                      ispWindowNotFound: true,
                      message: "ISP 결제창을 찾을 수 없음",
                    };
                  }
                }
              } catch (certError) {
                console.log("[adpia] ⚠️ 인증서 버튼 실패:", certError.message);
              }
            } catch (e) {
              console.log("[adpia] ⚠️ 기타결제 버튼 실패:", e.message);
            }
          } else {
            console.log("[adpia] ⚠️ BC카드 결제창 팝업을 찾을 수 없음");
          }

          await delay(5000);
        }
        // ========== 카드타입별 결제 분기 끝 ==========
      }
    }

    payBrowser.off("targetcreated", targetCreatedHandler);

    console.log("[adpia] 주문서 입력 완료");
    return { success: true, message: "주문서 입력 완료" };
  } catch (error) {
    console.error("[adpia] 배송지 입력 실패:", error.message);
    return { success: false, message: error.message };
  }
}

/**
 * 애드피아몰 주문 처리 메인 함수
 */
async function processAdpiaOrder(
  res,
  page,
  vendor,
  { products, shippingAddress, poLineIds, purchaseOrderId },
  authToken,
) {
  console.log(`[adpia] 주문 시작: ${products.length}개 상품`);

  const errorCollector = createOrderErrorCollector("adpia");
  const shippingInfo = shippingAddress; // 기존 코드와 호환을 위해 alias
  const ispPassword = vendor.ispPassword || process.env.BC_ISP_PASSWORD || null;

  const results = [];
  const downloadedFiles = []; // 다운로드한 파일 경로들
  const addedProducts = []; // 장바구니에 추가된 상품들
  const optionFailedProducts = []; // 옵션 실패 상품들
  const priceMismatches = []; // 가격 불일치 상품들

  try {
    // 0. 디자인 파일 미리 다운로드 (없는 상품은 담당자 확인 필요로 표시 후 스킵)
    const skippedProducts = [];
    for (const product of products) {
      const designFileUrl = product.designFileUrl;
      if (!designFileUrl) {
        console.log(`[adpia] ⚠️ 디자인 파일 URL 없음 → 담당자 확인 필요: ${product.productSku}`);
        try {
          await createNeedsManagerVerification(authToken, [{
            productVariantVendorId: product.productVariantVendorId,
            purchaseOrderId,
            reason: `디자인 파일 URL 없음: ${product.productSku} (${product.productName})`,
          }]);
        } catch (e) {
          console.error(`[adpia] ⚠️ 담당자 확인 필요 저장 실패: ${e.message}`);
        }
        skippedProducts.push(product.productSku);
        continue;
      }
      try {
        const filename = getStableFilename(designFileUrl, product.productSku);
        console.log(`[adpia] 디자인 파일 준비: ${filename}`);
        const filePath = await downloadFile(designFileUrl, filename);
        downloadedFiles.push({
          productSku: product.productSku,
          filePath,
        });
      } catch (err) {
        console.log(`[adpia] ⚠️ 디자인 파일 다운로드 실패 → 담당자 확인 필요: ${product.productSku} - ${err.message}`);
        try {
          await createNeedsManagerVerification(authToken, [{
            productVariantVendorId: product.productVariantVendorId,
            purchaseOrderId,
            reason: `디자인 파일 다운로드 실패: ${product.productSku} - ${err.message}`,
          }]);
        } catch (e) {
          console.error(`[adpia] ⚠️ 담당자 확인 필요 저장 실패: ${e.message}`);
        }
        skippedProducts.push(product.productSku);
        continue;
      }
    }

    // 디자인 파일 있는 상품만 남기기
    if (skippedProducts.length > 0) {
      products = products.filter(p => !skippedProducts.includes(p.productSku));
      console.log(`[adpia] 디자인 파일 없는 상품 ${skippedProducts.length}건 스킵, 남은 상품: ${products.length}건`);
    }

    if (products.length === 0) {
      console.log("[adpia] 주문 가능한 상품 없음 (모두 디자인 파일 누락)");
      return { success: false, error: "모든 상품 디자인 파일 누락" };
    }

    console.log("[adpia] 준비된 파일 수:", downloadedFiles.length);

    // 1. 로그인
    const loginResult = await loginToAdpia(page, vendor);
    if (!loginResult.success) {
      errorCollector.addError(
        ORDER_STEPS.LOGIN,
        ERROR_CODES.LOGIN_FAILED,
        loginResult.message || "로그인 실패",
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
        vendor: "adpia",
      });
      return res.json({
        success: false,
        message: "로그인 실패",
        vendor: vendor.name,
        automationErrors: errorCollector.getErrors(),
      });
    }

    // 2. 각 상품 개별 처리 (애드피아: 상품별로 장바구니 → 주문 → 결제 → saveOrderResults)
    for (let productIndex = 0; productIndex < products.length; productIndex++) {
      const product = products[productIndex];
      console.log(
        `\n[adpia] ========== 상품 ${productIndex + 1}/${products.length}: ${product.productName} ==========`,
      );

      let vendorOrderNumber = null;
      let orderSuccess = false;
      let currentStep = ORDER_STEPS.ADD_TO_CART;

      try {
        // 2-1. 장바구니 비우기 (이전 상품 잔여분 제거)
        const clearResult = await clearCart(page);
        if (clearResult && !clearResult.success) {
          console.error("[adpia] ❌ 장바구니 비우기 실패:", clearResult.message);
          errorCollector.addError(ORDER_STEPS.CART_CLEARING, ERROR_CODES.CLICK_FAILED,
            `장바구니 비우기 실패: ${clearResult.message}`, { purchaseOrderId });
          continue; // 이 상품 중단, 다음 상품으로 (개별 주문)
        }

        // 2-2. 제품코드로 상품 찾기 (favor 페이지에서)
        const findResult = await findProductByCode(page, product.productSku);

        if (!findResult.success) {
          // 상품 못찾음 / 옵션 실패 → 담당자 확인 필요
          try {
            await createNeedsManagerVerification(authToken, [{
              productVariantVendorId: product.productVariantVendorId,
              purchaseOrderId,
              reason: findResult.message || `상품 처리 실패: ${product.productSku}`,
            }]);
            console.log(`[adpia] 담당자 확인 필요 저장: ${findResult.message}`);
          } catch (e) {
            console.error(`[adpia] ⚠️ 담당자 확인 필요 저장 실패: ${e.message}`);
          }
          results.push({
            lineId: poLineIds?.[productIndex],
            productVariantVendorId: product.productVariantVendorId,
            productSku: product.productSku,
            productName: product.productName,
            success: false,
            message: findResult.message,
          });
          if (findResult.message?.includes("옵션")) {
            optionFailedProducts.push({
              productVariantVendorId: product.productVariantVendorId,
              reason: findResult.message,
            });
          }
          await saveOrderResults(authToken, {
            purchaseOrderId,
            products: [],
            priceMismatches: [],
            optionFailedProducts: [
              {
                productVariantVendorId: product.productVariantVendorId,
                reason: findResult.message,
              },
            ],
            automationErrors: [],
            poLineIds: poLineIds?.[productIndex]
              ? [poLineIds[productIndex]]
              : [],
            success: false,
            vendor: "adpia",
          });
          continue;
        }

        // 2-3. 협력사 가격 확인 (favor 페이지에서 가져온 가격)
        const openMallPrice = findResult.price; // 오픈몰 가격 (VAT 포함)
        const expectedPrice = product.vendorPriceExcludeVat; // 시스템 가격 (VAT 제외)

        if (!openMallPrice) {
          console.error(`[adpia] ❌ 가격 추출 실패: ${product.productSku} 가격을 찾을 수 없음`);
        }

        // 가격 비교 로직
        const openMallPriceExcludeVat = openMallPrice ? Math.round(openMallPrice / 1.1) : 0;
        const priceDifference = Math.abs(
          openMallPriceExcludeVat - expectedPrice,
        );
        const priceMismatch = !openMallPrice || (expectedPrice > 0 && priceDifference > 10);

        console.log(
          `[adpia] 가격 비교: 오픈몰=${openMallPrice}(VAT제외=${openMallPriceExcludeVat}) vs 시스템=${expectedPrice}, 차이=${priceDifference}원, 불일치=${priceMismatch}`,
        );

        const priceInfo = {
          priceMismatch,
          unitPrice: openMallPrice,
          unitPriceExcludeVat: openMallPriceExcludeVat,
          expectedUnitPrice: expectedPrice,
          difference: openMallPriceExcludeVat - expectedPrice,
        };

        // 가격 체크: 오픈몰이 더 비싸면 STOP, 오픈몰이 더 싸면 진행
        const PRICE_DIFF_THRESHOLD = 5000;
        const priceDiff = openMallPriceExcludeVat - expectedPrice;
        if (!openMallPrice || (expectedPrice > 0 && priceDiff > PRICE_DIFF_THRESHOLD)) {
          const reason = !openMallPrice
            ? `가격 추출 실패로 결제 중단: ${product.productSku}`
            : `가격 차이 초과로 결제 중단: 오픈몰 ${openMallPriceExcludeVat}원 vs 시스템 ${expectedPrice}원 (차이 +${priceDiff}원, VAT별도)`;
          console.error(`[adpia] ❌ ${reason}`);
          try {
            await createNeedsManagerVerification(authToken, [{
              purchaseOrderId,
              productVariantVendorId: product.productVariantVendorId,
              reason,
            }]);
          } catch (e) {
            console.error(`[adpia] 담당자 확인 필요 저장 실패: ${e.message}`);
          }
          results.push({ lineId: poLineIds?.[productIndex], productSku: product.productSku, productName: product.productName, success: false, message: reason, priceInfo });
          continue;
        }

        // 2-4. 주문 페이지에서 처리 (수량 입력, 파일 업로드, 장바구니 담기)
        currentStep = ORDER_STEPS.ADD_TO_CART;
        const downloadedFile = downloadedFiles.find(
          (f) => f.productSku === product.productSku,
        );

        const MAX_PRODUCT_RETRIES = 2;
        let orderPageResult = null;

        for (
          let productRetry = 0;
          productRetry < MAX_PRODUCT_RETRIES;
          productRetry++
        ) {
          if (productRetry > 0) {
            console.log(
              `[adpia] 상품 재시작 시도 ${productRetry}/${MAX_PRODUCT_RETRIES - 1}...`,
            );
          }

          orderPageResult = await processOrderPage(
            page,
            product,
            downloadedFile,
          );

          if (
            orderPageResult.needsRestart &&
            productRetry < MAX_PRODUCT_RETRIES - 1
          ) {
            console.log("[adpia] 🔄 옵션 페이지에서 상품 다시 찾기...");
            const retryFindResult = await findProductByCode(
              page,
              product.productSku,
            );
            if (!retryFindResult.success) {
              console.log(
                "[adpia] 재시작 후 상품 찾기 실패:",
                retryFindResult.message,
              );
              orderPageResult = {
                success: false,
                message: "재시작 후 상품 찾기 실패",
              };
              break;
            }
            continue;
          }
          break;
        }

        // 장바구니 담기 실패 시
        if (!orderPageResult.success) {
          // 담당자 확인 필요 플래그 처리
          if (orderPageResult.needsManagerVerification) {
            try {
              await createNeedsManagerVerification(authToken, [{
                productVariantVendorId: product.productVariantVendorId,
                purchaseOrderId,
                reason: orderPageResult.message || `주문 실패: ${product.productSku}`,
              }]);
              console.log("[adpia] 담당자 확인 필요 저장 완료");
            } catch (e) {
              console.error(`[adpia] ⚠️ 담당자 확인 필요 저장 실패: ${e.message}`);
            }
          }
          // 에러 로그 기록
          errorCollector.addError(
            ORDER_STEPS.ADD_TO_CART,
            ERROR_CODES.ELEMENT_NOT_FOUND,
            orderPageResult.message || `주문 실패: ${product.productSku}`,
            { purchaseOrderId, productVariantVendorId: product.productVariantVendorId },
          );
          results.push({
            lineId: poLineIds?.[productIndex],
            productVariantVendorId: product.productVariantVendorId,
            productSku: product.productSku,
            productName: product.productName,
            quantity: product.quantity,
            price: openMallPrice,
            success: false,
            message: orderPageResult.message,
            priceInfo,
          });
          if (orderPageResult.message?.includes("옵션")) {
            optionFailedProducts.push({
              productVariantVendorId: product.productVariantVendorId,
              reason: orderPageResult.message,
            });
          }
          // 실패해도 saveOrderResults 호출
          await saveOrderResults(authToken, {
            purchaseOrderId,
            products: [],
            priceMismatches: priceInfo.priceMismatch
              ? [
                  {
                    productVariantVendorId: product.productVariantVendorId,
                    vendorPriceExcludeVat: priceInfo.unitPriceExcludeVat,
                    openMallPrice: priceInfo.unitPrice,
                  },
                ]
              : [],
            optionFailedProducts: orderPageResult.message?.includes("옵션")
              ? [
                  {
                    productVariantVendorId: product.productVariantVendorId,
                    reason: orderPageResult.message,
                  },
                ]
              : [],
            automationErrors: [],
            poLineIds: poLineIds?.[productIndex]
              ? [poLineIds[productIndex]]
              : [],
            success: false,
            vendor: "adpia",
          });
          continue;
        }

        // 2-5. 장바구니 → 주문서 이동
        currentStep = ORDER_STEPS.ORDER_PLACEMENT;
        const orderFormResult = await goToOrderForm(page);
        if (!orderFormResult.success) {
          console.log("[adpia] 주문서 이동 실패:", orderFormResult.message);
          results.push({
            lineId: poLineIds?.[productIndex],
            productVariantVendorId: product.productVariantVendorId,
            productSku: product.productSku,
            productName: product.productName,
            quantity: product.quantity,
            price: openMallPrice,
            success: false,
            message: orderFormResult.message,
            priceInfo,
          });
          await saveOrderResults(authToken, {
            purchaseOrderId,
            products: [],
            priceMismatches: priceInfo.priceMismatch
              ? [
                  {
                    productVariantVendorId: product.productVariantVendorId,
                    vendorPriceExcludeVat: priceInfo.unitPriceExcludeVat,
                    openMallPrice: priceInfo.unitPrice,
                  },
                ]
              : [],
            optionFailedProducts: [],
            automationErrors: [],
            poLineIds: poLineIds?.[productIndex]
              ? [poLineIds[productIndex]]
              : [],
            success: false,
            vendor: "adpia",
          });
          continue;
        }

        // 2-6. 배송지 입력 + 결제 (ISP 결제창 미출현 시 최대 5회 재시도)
        currentStep = ORDER_STEPS.PAYMENT;
        if (shippingInfo) {
          const MAX_ISP_RETRY = 5;
          let ispRetryCount = 0;
          let shippingResult = null;

          while (ispRetryCount <= MAX_ISP_RETRY) {
            if (ispRetryCount > 0) {
              console.log(
                `\n[adpia] ========== ISP 결제 재시도 ${ispRetryCount}/${MAX_ISP_RETRY} ==========`,
              );
              console.log("[adpia] 장바구니로 이동하여 재주문...");
              // 장바구니 → 주문서 이동
              const retryOrderForm = await goToOrderForm(page);
              if (!retryOrderForm.success) {
                console.log("[adpia] 주문서 재이동 실패 - 재시도 중단");
                shippingResult = {
                  success: false,
                  message: "주문서 재이동 실패",
                };
                break;
              }
            }

            shippingResult = await fillShippingInfo(
              page,
              shippingInfo,
              ispPassword,
            );

            if (shippingResult?.ispWindowNotFound) {
              ispRetryCount++;
              if (ispRetryCount <= MAX_ISP_RETRY) {
                console.log(
                  "[adpia] ISP 결제창 미출현 - 장바구니로 돌아가서 재시도...",
                );
                await delay(2000);
                continue;
              }
            }
            break;
          }

          if (!shippingResult?.success) {
            console.log(
              "[adpia] 배송지 입력/결제 실패:",
              shippingResult?.message,
            );
            results.push({
              lineId: poLineIds?.[productIndex],
              productVariantVendorId: product.productVariantVendorId,
              productSku: product.productSku,
              productName: product.productName,
              quantity: product.quantity,
              price: openMallPrice,
              success: false,
              message: shippingResult?.message,
              priceInfo,
            });
            await saveOrderResults(authToken, {
              purchaseOrderId,
              products: [],
              priceMismatches: priceInfo.priceMismatch
                ? [
                    {
                      productVariantVendorId: product.productVariantVendorId,
                      vendorPriceExcludeVat: priceInfo.unitPriceExcludeVat,
                      openMallPrice: priceInfo.unitPrice,
                    },
                  ]
                : [],
              optionFailedProducts: [],
              automationErrors: [],
              poLineIds: poLineIds?.[productIndex]
                ? [poLineIds[productIndex]]
                : [],
              success: false,
              vendor: "adpia",
            });
            continue;
          } else if (shippingResult.vendorOrderNumber) {
            vendorOrderNumber = shippingResult.vendorOrderNumber;
            console.log("[adpia] 주문번호 확인:", vendorOrderNumber);
          }
        }

        // 2-7. 주문번호 없으면 재시도
        if (!vendorOrderNumber) {
          await delay(3000);
          try {
            const orderNumberEl = await page.$(SELECTORS.order.orderNumber);
            if (orderNumberEl) {
              vendorOrderNumber = await page.$eval(
                SELECTORS.order.orderNumber,
                (el) => el.textContent?.trim(),
              );
              console.log("[adpia] 주문번호 재시도 성공:", vendorOrderNumber);
            }
          } catch (e) {
            console.log("[adpia] 주문번호 재시도 실패:", e.message);
          }
        }

        // 2-8. 결과 저장 및 saveOrderResults 호출
        currentStep = ORDER_STEPS.SAVE_RESULTS;
        orderSuccess = !!vendorOrderNumber;
        const resultEntry = {
          lineId: poLineIds?.[productIndex],
          productVariantVendorId: product.productVariantVendorId,
          productSku: product.productSku,
          productName: product.productName,
          quantity: product.quantity,
          price: openMallPrice,
          success: orderSuccess,
          message: orderSuccess ? "주문 완료" : "주문번호 추출 실패",
          vendorOrderNumber: vendorOrderNumber || null,
          priceInfo,
        };
        results.push(resultEntry);

        if (orderSuccess) {
          addedProducts.push({
            orderLineIds: product.orderLineIds,
            productVariantVendorId: product.productVariantVendorId,
            productSku: product.productSku,
            productName: product.productName,
            quantity: product.quantity,
            openMallOrderNumber: vendorOrderNumber,
          });
          console.log(
            `[adpia] ✅ 상품 ${productIndex + 1} 주문 완료: ${vendorOrderNumber}`,
          );
        }

        if (priceInfo.priceMismatch) {
          priceMismatches.push({
            productVariantVendorId: product.productVariantVendorId,
            vendorPriceExcludeVat: priceInfo.unitPriceExcludeVat,
            openMallPrice: priceInfo.unitPrice,
          });
        }

        // 상품별 saveOrderResults 호출
        await saveOrderResults(authToken, {
          purchaseOrderId,
          products: orderSuccess
            ? [
                {
                  orderLineIds: product.orderLineIds,
                  openMallOrderNumber: vendorOrderNumber,
                },
              ]
            : [],
          priceMismatches: priceInfo.priceMismatch
            ? [
                {
                  productVariantVendorId: product.productVariantVendorId,
                  vendorPriceExcludeVat: priceInfo.unitPriceExcludeVat,
                  openMallPrice: priceInfo.unitPrice,
                },
              ]
            : [],
          optionFailedProducts: [],
          automationErrors: [],
          poLineIds: poLineIds?.[productIndex] ? [poLineIds[productIndex]] : [],
          success: orderSuccess,
          vendor: "adpia",
        });

        // 결제 로그 저장 (2곳에서 파싱 + 교차 검증)
        if (orderSuccess) {
          const fromCalc = (priceInfo.unitPrice || 0) * (product.quantity || 1);
          // 주문서 페이지의 총 합계금액 파싱
          let fromPage = 0;
          try {
            fromPage = await page.evaluate(() => {
              // 1. 셀렉터 기반
              const selectorEl = document.querySelector("#ordersForm > div.cart_menu > div > div.list02 > div.list_menu03 > div .t3.t6");
              if (selectorEl) return parseInt((selectorEl.textContent || "").replace(/[^0-9]/g, ""), 10) || 0;
              // 2. "총 합계금액" 텍스트 기반 폴백
              const allElements = document.querySelectorAll("h6, div, span");
              for (const el of allElements) {
                if ((el.textContent || "").trim() === "총 합계금액") {
                  const parent = el.parentElement;
                  if (parent) {
                    const match = parent.textContent.match(/([\d,]+)\s*원/);
                    if (match) return parseInt(match[1].replace(/,/g, ""), 10) || 0;
                  }
                }
              }
              return 0;
            });
          } catch (e) {
            console.log(`[adpia] 주문서 결제금액 파싱 실패: ${e.message}`);
          }

          console.log(`[adpia] 결제금액 파싱 - 단가계산: ${fromCalc}원, 주문서: ${fromPage}원`);

          let paymentAmount = fromPage || fromCalc || 0;
          if (fromCalc > 0 && fromPage > 0 && fromCalc !== fromPage) {
            console.log(`[adpia] ⚠️ 결제금액 불일치! → 주문서 금액 사용`);
            paymentAmount = fromPage;
          }

          try {
            await createPaymentLogs(authToken, [
              {
                vendor: "adpia",  // TODO:DEPLOY - 배포 후 제거
                purchaseOrderId: purchaseOrderId,
                openMallOrderNumber: vendorOrderNumber || null,
                paymentAmount: paymentAmount,
                paymentCard: "SHINHAN",
              },
            ]);
            console.log(`[adpia] 결제 로그 저장: ${paymentAmount}원`);
            alertPaymentParsingFailed({ vendor: "애드피아몰", purchaseOrderId, openMallOrderNumber: vendorOrderNumber, paymentAmount: paymentAmount, parsingDetail: { 단가계산: fromCalc, 주문서: fromPage } });
          } catch (e) {
            console.error(`[adpia] ⚠️ 결제 로그 저장 실패: ${e.message}`);
          try { await createAutomationErrors(authToken, [{ vendor: "adpia", automationType: "ORDER", step: "ORDER_CONFIRMATION", errorCode: "UNEXPECTED_ERROR", errorMessage: `결제 로그 저장 실패: ${e.message}`, purchaseOrderId }]); } catch (e2) { console.error("[adpia] 에러 기록도 실패:", e2.message); }
          }
        }
      } catch (error) {
        console.error(`[adpia] 상품 처리 에러 (step: ${currentStep}):`, error.message);
        errorCollector.addError(currentStep, null, error.message, {
          purchaseOrderId,
          purchaseOrderLineId: poLineIds?.[productIndex],
          productVariantVendorId: product.productVariantVendorId,
        });
        results.push({
          lineId: poLineIds?.[productIndex],
          productSku: product.productSku,
          productName: product.productName,
          success: false,
          message: error.message,
        });
        // 에러 시에도 saveOrderResults 호출
        await saveOrderResults(authToken, {
          purchaseOrderId,
          products: [],
          priceMismatches: [],
          optionFailedProducts: [],
          automationErrors: errorCollector.getErrors(),
          poLineIds: poLineIds?.[productIndex] ? [poLineIds[productIndex]] : [],
          success: false,
          vendor: "adpia",
        });
      }
    }

    // 3. 최종 결과 요약
    const successProducts = results.filter((r) => r.success);
    const vendorOrderNumbers = addedProducts
      .map((p) => p.openMallOrderNumber)
      .filter(Boolean);

    console.log(
      `\n[adpia] ========== 주문 완료: ${successProducts.length}/${products.length}개 ==========`,
    );

    // 가격 불일치 목록 (res.json용)
    const priceMismatchList = results.filter((r) => r.priceInfo?.priceMismatch);
    const priceMismatchesForRes = priceMismatchList.map((r) => ({
      purchaseOrderLineId: r.lineId,
      productVariantVendorId: r.productVariantVendorId || null,
      productCode: r.productSku,
      productName: r.productName,
      quantity: r.quantity,
      openMallPrice: r.priceInfo?.unitPrice,
      expectedPrice: r.priceInfo?.expectedUnitPrice,
      difference: r.priceInfo?.difference,
    }));

    // 옵션 실패 목록 (res.json용)
    const optionFailedProductsForRes = results
      .filter((r) => !r.success && r.message?.includes("옵션"))
      .map((r) => ({
        purchaseOrderLineId: r.lineId,
        productVariantVendorId: r.productVariantVendorId,
        productSku: r.productSku,
        productName: r.productName,
        reason: r.message,
      }));

    return res.json({
      success: successProducts.length > 0,
      message: `${successProducts.length}/${products.length}개 상품 주문 완료`,
      vendor: vendor.name,
      purchaseOrderId: purchaseOrderId || null,
      purchaseOrderLineIds: poLineIds || [],
      products: results.map((r) => ({
        orderLineIds: products.find((p) => p.productSku === r.productSku)
          ?.orderLineIds,
        openMallOrderNumber: r.vendorOrderNumber || null,
        productName: r.productName,
        productSku: r.productSku,
        quantity: r.quantity,
        success: r.success,
      })),
      orderResult: {
        placed: vendorOrderNumbers.length > 0,
        vendorOrderNumbers: vendorOrderNumbers,
        vendorOrderNumber: vendorOrderNumbers[0] || null, // 하위 호환성
      },
      hasPriceMismatch: priceMismatchList.length > 0,
      priceMismatchCount: priceMismatchList.length,
      priceMismatches: priceMismatchesForRes,
      optionFailedCount: optionFailedProductsForRes.length,
      optionFailedProducts: optionFailedProductsForRes,
    });
  } catch (error) {
    console.error("[adpia] 주문 처리 에러:", error);
    errorCollector.addError(ORDER_STEPS.ORDER_PLACEMENT, null, error.message, {
      purchaseOrderId,
    });
    // 이미 처리된 상품들의 주문번호는 각 상품별 saveOrderResults에서 저장됨
    // 여기선 전체 에러 로그만 저장
    await saveOrderResults(authToken, {
      purchaseOrderId,
      products: (addedProducts || []).map((p) => ({
        orderLineIds: p.orderLineIds,
        openMallOrderNumber: p.openMallOrderNumber || null,
      })),
      priceMismatches: [],
      optionFailedProducts:
        optionFailedProducts?.map((p) => ({
          productVariantVendorId: p.productVariantVendorId,
          reason: p.reason,
        })) || [],
      automationErrors: errorCollector.getErrors(),
      poLineIds,
      success: false,
      vendor: "adpia",
    });
    return res.json({
      success: false,
      vendor: vendor.name,
      message: `주문 처리 에러: ${error.message}`,
      automationErrors: errorCollector.hasErrors()
        ? errorCollector.getErrors()
        : undefined,
    });
  } finally {
    // 임시 파일 정리
    for (const file of downloadedFiles) {
      if (file.filePath) {
        cleanupTempFile(file.filePath);
      }
    }
  }
}

module.exports = {
  processAdpiaOrder,
  loginToAdpia,
  findProductByCode,
};
