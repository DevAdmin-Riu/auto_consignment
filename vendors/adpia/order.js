/**
 * 애드피아몰 주문 모듈
 *
 * 흐름:
 * 1. 로그인
 * 2. 장바구니 비우기
 * 3. favor 페이지에서 제품코드로 상품 찾기 → 주문하러 가기
 * 4. 주문 페이지에서:
 *    - 수량 입력 (#holder_num)
 *    - 결제금액에서 가격 확인
 *    - 파일 업로드 (input[type="file"])
 *    - 교정확인 후 인쇄 체크박스 (#is_proof_file)
 *    - 장바구니 버튼 클릭
 * 5. 장바구니 → 주문서 이동
 * 6. 배송지 입력
 * 7. 결제수단 선택
 * 8. 결제하기
 */

const { getEnv } = require("../config");
const fs = require("fs");
const path = require("path");
const {
  createOrderErrorCollector,
  ORDER_STEPS,
  ERROR_CODES,
} = require("../../lib/automation-error");
const { saveOrderResults } = require("../../lib/graphql-client");
const { automateISPPayment } = require("../../lib/isp-payment");
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
async function automateISPPaymentWithAlertHandler(ispPassword, paymentPopup = null) {
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
          window.alert = (msg) => console.log('[ISP Override] alert:', msg);
          window.confirm = (msg) => { console.log('[ISP Override] confirm:', msg); return true; };
        });
      } catch (e) {}

      // frame에도 오버라이드
      try {
        for (const frame of paymentPopup.frames()) {
          try {
            await frame.evaluate(() => {
              window.alert = (msg) => console.log('[ISP Frame Override] alert:', msg);
              window.confirm = (msg) => { console.log('[ISP Frame Override] confirm:', msg); return true; };
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
    const result = await automateISPPayment(ispPassword);
    return result;
  } finally {
    // 핸들러 제거
    for (const p of registeredPages) {
      try { p.off("dialog", ispLoopAlertHandler); } catch (e) {}
    }
    if (browser) {
      try { browser.off("targetcreated", targetCreatedHandler); } catch (e) {}
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
    // 결제금액 (가격 확인용)
    totalPrice: "", // TODO: 결제금액 셀렉터
    // 파일 업로드 (plupload - 동적 ID)
    fileInput: 'input[type="file"]',
    // 교정확인 후 인쇄 체크박스
    proofCheckbox: "#is_proof_file",
    // 장바구니 담기 버튼
    addToCartBtn:
      "#calcarea > div.order_list_re > div.ng-star-inserted > button.btn_m.or_white_02.ng-star-inserted",
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
    agreeAll:
      "#ordersForm > div.list01 > div:nth-child(6) > div.table03_wrap.ng-star-inserted > table > tbody > tr:nth-child(1) > td:nth-child(3) > div > label",
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
    }`
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
      console.log(`[adpia] 수량 변환: ${baseQuantity}개 × ${qtyPerUnit} = ${actualQuantity}개`);
    }
    console.log(`[adpia] 수량 입력: ${actualQuantity}`);
    const quantityInput = await waitFor(
      page,
      SELECTORS.orderPage.quantityInput,
      10000
    );
    if (quantityInput) {
      await quantityInput.click({ clickCount: 3 });
      await delay(500);
      await quantityInput.type(String(actualQuantity), { delay: 100 });
      await delay(1000);
    } else {
      console.log("[adpia] 수량 입력 필드를 찾을 수 없음");
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
      console.log("[adpia] 파일 입력 필드를 찾을 수 없음");
    }
  }

  // 3. 교정확인 후 인쇄 체크박스 체크
  await delay(1000);
  console.log("[adpia] 교정확인 후 인쇄 체크박스 체크");
  const proofCheckbox = await page.$(SELECTORS.orderPage.proofCheckbox);
  if (proofCheckbox) {
    const isChecked = await page.$eval(
      SELECTORS.orderPage.proofCheckbox,
      (el) => el.checked
    );
    if (!isChecked) {
      await proofCheckbox.click();
      await delay(1000);
    }
  } else {
    console.log("[adpia] 교정확인 체크박스를 찾을 수 없음");
  }

  // 4. 장바구니 담기 버튼 클릭 → 업로드 시작 → 업로드 완료 후 모달 뜸
  // 파일 업로드 실패 시 최대 3회 재시도
  const MAX_UPLOAD_RETRIES = 3;

  for (let retryCount = 0; retryCount < MAX_UPLOAD_RETRIES; retryCount++) {
    if (retryCount > 0) {
      console.log(
        `[adpia] 파일 업로드 재시도 (${retryCount}/${MAX_UPLOAD_RETRIES - 1})...`
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
    const addToCartBtn = await waitFor(
      page,
      SELECTORS.orderPage.addToCartBtn,
      10000
    );

    if (!addToCartBtn) {
      console.log("[adpia] 장바구니 담기 버튼을 찾을 수 없음");
      return { success: false, message: "장바구니 담기 버튼을 찾을 수 없음" };
    }

    await addToCartBtn.click();
    console.log("[adpia] 파일 업로드 진행 중...");
    await delay(3000); // 업로드 시작 대기

    // 5. 업로드 완료 대기 (진행률이 90% 이상 도달 후 떨어지면 완료로 간주, 최대 120초)
    let maxProgress = 0;
    for (let i = 0; i < 120; i++) {
      await delay(1000);
      const progress = await page.evaluate(() => {
        const barEl = document.querySelector("#pluprogress #bar");
        if (!barEl) return null;
        const width = barEl.style?.width || "0%";
        return parseInt(width.replace("%", ""), 10) || 0;
      });

      if (progress !== null) {
        console.log(`[adpia] 업로드 진행률 (${i + 1}초): ${progress}%`);

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

    // 6. 업로드 완료 후 모달 대기 (최대 30초)
    console.log("[adpia] 모달 대기 중...");
    const modalConfirmBtn = await waitFor(
      page,
      SELECTORS.orderPage.modalConfirmBtn,
      30000
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
            (el) => el.textContent?.trim() || ""
          );
          console.log(`[adpia] 모달 메시지: ${modalText}`);
        }
      } catch (e) {
        console.log("[adpia] 모달 메시지 확인 중 에러 (무시):", e.message);
      }

      // 업로드 실패 메시지 확인
      if (modalText.includes("업로드에 실패") || modalText.includes("업로드 실패")) {
        console.log("[adpia] ⚠️ 파일 업로드 실패 감지");
        uploadFailed = true;
      }

      // 모달 확인 버튼 클릭 전 딜레이 (너무 빠르면 사용자가 확인 어려움)
      await delay(1000);
      console.log("[adpia] 모달 확인 버튼 클릭");
      // page.evaluate로 직접 클릭 (Node detached 에러 방지)
      await page.evaluate(() => {
        const btn = document.querySelector(
          ".ajs-modal button.ajs-button.btn_orange"
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
          console.log("[adpia] ❌ 파일 업로드 최대 재시도 횟수 초과 - 옵션 페이지에서 재시작 필요");
          return { success: false, message: "파일 업로드 실패", needsRestart: true };
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

  // 1. 로그인 페이지 이동
  console.log("[adpia] 1. 로그인 페이지 이동...");
  await page.goto(vendor.loginUrl, {
    waitUntil: "networkidle2",
    timeout: 30000,
  });
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
      "app-root cartlist table tbody tr.ng-star-inserted input[type='checkbox']"
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
      productCode
    );

    if (result.found) {
      console.log(
        `[adpia] 제품 찾음! (${currentPage}페이지, ${
          result.rowIndex + 1
        }번째 행, 가격: ${result.price}원)`
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
      "li.pagination-next:not(.disabled) a.page-link"
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
 * 상품 가격 추출
 */
async function getProductPrice(page) {
  // TODO: SELECTORS.product.price
  // 가격 텍스트에서 숫자만 추출
  // VAT 포함/미포함 여부 확인 필요
  return null;
}

/**
 * 옵션 선택
 */
async function selectOption(page, optionValue) {
  console.log(`[adpia] 옵션 선택: ${optionValue}`);

  // 1. 옵션 select 박스 찾기
  // TODO: SELECTORS.product.optionSelect

  // 2. 옵션 값으로 선택
  // - 정확히 일치하는 옵션 찾기
  // - 부분 일치로 찾기 (공백 제거 후 비교)

  return { success: false, message: "옵션 선택 미구현" };
}

/**
 * 수량 설정
 */
async function setQuantity(page, quantity) {
  console.log(`[adpia] 수량 설정: ${quantity}`);

  // 1. 수량 입력 필드 찾기
  // TODO: SELECTORS.product.quantityInput

  // 2. 기존 값 지우고 새 값 입력
  // 또는 +/- 버튼으로 수량 조절
  // TODO: SELECTORS.product.quantityPlus / quantityMinus

  return { success: false, message: "수량 설정 미구현" };
}

/**
 * 장바구니 담기
 */
async function addToCart(page) {
  console.log("[adpia] 장바구니 담기...");

  // 1. 장바구니 담기 버튼 클릭
  // TODO: SELECTORS.product.addToCartBtn

  // 2. 확인 팝업 처리 (있는 경우)
  // TODO: SELECTORS.product.confirmPopup

  return { success: false, message: "장바구니 담기 미구현" };
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
      "app-root cartlist table tbody tr.ng-star-inserted input[type='checkbox']"
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
    const recipientName =
      shippingInfo.firstName || shippingInfo.receiverName || "";
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

    // 5. 주소 검색 버튼 클릭
    console.log("[adpia] 5. 주소 찾기 버튼 클릭...");
    await delay(1000); // 주소 찾기 버튼 클릭 전 딜레이
    const addressSearchBtn = await page.$(SELECTORS.order.addressSearchBtn);
    if (addressSearchBtn) {
      await addressSearchBtn.click();
      await delay(3000); // Windows에서 iframe 로딩이 느릴 수 있음

      // 6. 다음 주소 검색 iframe 찾기
      console.log("[adpia] 6. 주소 검색 iframe 찾기...");
      await delay(1000); // iframe 찾기 전 딜레이

      // 방법 1: #__daum__layer_1 안의 iframe을 직접 찾기
      let frame = null;
      for (let i = 0; i < 30; i++) {
        // 15초 대기 (30 * 500ms)
        if (i % 5 === 0) {
          console.log(`[adpia] iframe 검색 ${i + 1}회...`);
        }

        try {
          // 페이지에서 다음 주소 레이어 iframe 요소를 찾기
          const iframeElement = await page.$("#__daum__layer_1 iframe");
          if (iframeElement) {
            const iframeSrc = await page.$eval(
              "#__daum__layer_1 iframe",
              (el) => el.src
            );
            console.log(
              `[adpia] iframe 요소 발견, src: ${
                iframeSrc?.substring(0, 50) || "about:blank"
              }...`
            );

            // iframe이 로드될 때까지 대기 (src가 about:blank가 아닐 때)
            if (iframeSrc && iframeSrc !== "about:blank") {
              frame = await iframeElement.contentFrame();
              if (frame) {
                console.log(`[adpia] 주소 검색 iframe 발견 (${i + 1}회)`);
                break;
              }
            }
          }
        } catch (e) {
          // 무시
        }

        // 방법 2: page.frames()에서 postcode URL로 찾기 (백업)
        const allFrames = page.frames();
        for (const f of allFrames) {
          try {
            const frameUrl = f.url();
            if (
              frameUrl.includes("postcode.map.daum.net") ||
              frameUrl.includes("postcode.v2.map.daum.net")
            ) {
              console.log(
                `[adpia] 다음 주소 iframe URL 발견: ${frameUrl.substring(
                  0,
                  80
                )}...`
              );
              frame = f;
              console.log(`[adpia] 주소 검색 iframe 발견 (${i + 1}회)`);
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
        // iframe 내부 DOM 로딩 대기 (더 오래 대기)
        console.log("[adpia] iframe 내부 DOM 로딩 대기...");
        await delay(5000);

        // 디버깅: frame URL 확인
        try {
          const frameUrl = frame.url();
          console.log(`[adpia] frame URL: ${frameUrl}`);
        } catch (e) {
          console.log("[adpia] frame URL 확인 실패");
        }

        // 7. 주소 검색어 입력
        const searchAddress =
          shippingInfo.streetAddress1 || shippingInfo.address || "";
        if (searchAddress) {
          console.log(`[adpia] 7. 주소 검색어: ${searchAddress}`);
          await delay(2000); // 주소 검색어 입력 전 딜레이 증가

          let addressInput = null;
          let addressSearchSuccess = false;

          // 먼저 frame.$()로 직접 시도
          console.log("[adpia] frame에서 #region_name 찾기 시도...");
          try {
            addressInput = await frame.$('#region_name');
            console.log(`[adpia] frame.$('#region_name') 결과: ${addressInput ? '찾음!' : '없음'}`);

            if (addressInput) {
              // input 클릭하고 값 입력
              await addressInput.click();
              await delay(300);
              await addressInput.type(searchAddress, { delay: 50 });
              console.log(`[adpia] ✅ 주소 입력 완료: ${searchAddress}`);
              await delay(500);

              // 검색 버튼 클릭
              const searchBtn = await frame.$('button.btn_search');
              console.log(`[adpia] 검색 버튼: ${searchBtn ? '찾음!' : '없음'}`);
              if (searchBtn) {
                await searchBtn.click();
                console.log("[adpia] 검색 버튼 클릭");
              } else {
                await addressInput.press('Enter');
                console.log("[adpia] Enter 키 입력");
              }
              await delay(3000);

              // 검색 결과 선택
              const resultItem = await frame.$('li.list_post_item .link_post');
              console.log(`[adpia] 검색 결과: ${resultItem ? '찾음!' : '없음'}`);
              if (resultItem) {
                await resultItem.click();
                console.log("[adpia] ✅ 주소 선택 완료");
                addressSearchSuccess = true;
              }
            }
          } catch (frameError) {
            console.log(`[adpia] frame.$() 에러: ${frameError.message.substring(0, 50)}`);
          }

          // frame.$()가 실패하면 CDP 방식으로 fallback
          if (!addressSearchSuccess) {
            console.log("[adpia] CDP 방식으로 fallback...");

            for (let attempt = 1; attempt <= 3; attempt++) {
            console.log(`[adpia] 주소 검색 시도 ${attempt}/3...`);

            try {
              // CDP 세션 생성
              const client = await page.target().createCDPSession();

              // 모든 frame 정보 가져오기
              const { frameTree } = await client.send("Page.getFrameTree");

              // postcode iframe의 frameId 찾기
              let postcodeFrameId = null;
              const findPostcodeFrame = (node) => {
                if (node.frame?.url?.includes("postcode")) {
                  postcodeFrameId = node.frame.id;
                  console.log(`[adpia] postcode frame URL: ${node.frame.url.substring(0, 60)}...`);
                  return;
                }
                if (node.childFrames) {
                  for (const child of node.childFrames) {
                    findPostcodeFrame(child);
                    if (postcodeFrameId) return;
                  }
                }
              };
              findPostcodeFrame(frameTree);

              if (!postcodeFrameId) {
                console.log("[adpia] postcode frame 못찾음, 다음 시도...");
                await client.detach();
                await delay(2000);
                continue;
              }

              console.log(`[adpia] postcode frameId: ${postcodeFrameId}`);

              // 해당 frame에 isolated world 생성하여 JavaScript 실행
              const { executionContextId } = await client.send("Page.createIsolatedWorld", {
                frameId: postcodeFrameId,
                worldName: "addressSearch",
              });

              console.log(`[adpia] executionContextId: ${executionContextId}`);

              // 1단계: #region_name input 찾아서 값 입력
              const inputResult = await client.send("Runtime.evaluate", {
                expression: `
                  (function() {
                    const input = document.querySelector('#region_name');
                    if (input) {
                      input.focus();
                      input.value = '';
                      input.value = "${searchAddress.replace(/"/g, '\\"')}";
                      input.dispatchEvent(new Event('input', { bubbles: true }));
                      input.dispatchEvent(new Event('change', { bubbles: true }));
                      return { success: true, value: input.value };
                    }
                    // fallback
                    const inputs = document.querySelectorAll('input');
                    return { success: false, inputCount: inputs.length, firstInput: inputs[0]?.id };
                  })()
                `,
                contextId: executionContextId,
                returnByValue: true,
              });

              console.log(`[adpia] input 결과:`, JSON.stringify(inputResult.result?.value));

              if (!inputResult.result?.value?.success) {
                console.log("[adpia] #region_name 못찾음");
                await client.detach();
                await delay(2000);
                continue;
              }

              console.log(`[adpia] ✅ 주소 입력 완료: ${searchAddress}`);
              await delay(500);

              // 2단계: 검색 버튼 클릭
              const searchResult = await client.send("Runtime.evaluate", {
                expression: `
                  (function() {
                    const btn = document.querySelector('button.btn_search') || document.querySelector('#search_btn');
                    if (btn) {
                      btn.click();
                      return { clicked: 'button', selector: btn.className || btn.id };
                    }
                    // form submit
                    const form = document.querySelector('#region_name')?.closest('form');
                    if (form) {
                      form.submit();
                      return { clicked: 'form' };
                    }
                    return { clicked: null };
                  })()
                `,
                contextId: executionContextId,
                returnByValue: true,
              });

              console.log(`[adpia] 검색 버튼:`, JSON.stringify(searchResult.result?.value));
              await delay(3000); // 검색 결과 로딩 대기

              // 3단계: 검색 결과 첫 번째 항목 클릭
              const selectResult = await client.send("Runtime.evaluate", {
                expression: `
                  (function() {
                    // 결과 리스트 찾기
                    const items = document.querySelectorAll('li.list_post_item');
                    if (items.length > 0) {
                      // 첫 번째 결과의 클릭 가능한 요소 찾기
                      const link = items[0].querySelector('.link_post') || items[0].querySelector('a') || items[0];
                      if (link && link.click) {
                        link.click();
                        return { selected: true, count: items.length };
                      }
                    }
                    return { selected: false, count: items.length };
                  })()
                `,
                contextId: executionContextId,
                returnByValue: true,
              });

              console.log(`[adpia] 주소 선택:`, JSON.stringify(selectResult.result?.value));

              await client.detach();

              if (selectResult.result?.value?.selected) {
                addressSearchSuccess = true;
                console.log(`[adpia] ✅ 주소 검색 완료 (CDP 방식)`);
                break;
              } else if (selectResult.result?.value?.count === 0) {
                console.log("[adpia] 검색 결과 없음, 다음 시도...");
              }

            } catch (e) {
              console.log(`[adpia] CDP 방식 에러: ${e.message}`);
            }

              await delay(2000);
            }
          } // if (!addressSearchSuccess) 닫기

          if (addressSearchSuccess) {
            console.log("[adpia] 8. 주소 선택 완료");
            await delay(1000);
          } else {
            console.log("[adpia] ⚠️ 주소 검색 실패");
          }
        }
      } else {
        console.log("[adpia] 주소 검색 iframe 못찾음");
      }
    }

    // 9. 상세주소 입력 (#recv_addr_2 클릭 후 End 키 → 스페이스 → 상세주소)
    const detailAddress =
      shippingInfo.streetAddress2 || shippingInfo.addressDetail || "";
    if (detailAddress) {
      console.log(`[adpia] 9. 상세주소 입력: ${detailAddress}`);
      await delay(1000);

      await delay(1000); // 상세주소 입력 전 딜레이
      const addrDetail = await page.$(SELECTORS.order.addressDetail);
      if (addrDetail) {
        await addrDetail.click();
        await delay(1000); // 상세주소 입력창 클릭 후 딜레이
        // End 키로 커서를 맨 뒤로 이동
        await page.keyboard.press("End");
        await delay(100);
        // 스페이스 추가
        await page.keyboard.type(" ", { delay: 50 });
        // 상세주소 입력
        await page.keyboard.type(detailAddress, { delay: 50 });
        await delay(300);
      }
    }

    // 10. 배송 방법 선택 (선불택배) - 결제 선택 전에 해야 함 (안하면 결제 초기화됨)
    console.log("[adpia] 10. 배송 방법 선택 (선불택배)...");
    const deliveryMethod = await page.$(SELECTORS.order.deliveryMethod);
    if (deliveryMethod) {
      await page.select(
        SELECTORS.order.deliveryMethod,
        SELECTORS.order.deliveryMethodValue
      );
      await delay(1000);
    }

    // 11. 결제수단 선택 - 신용카드
    console.log("[adpia] 11. 신용카드 결제 선택...");
    const cardPayment = await page.$(SELECTORS.order.cardPayment);
    if (cardPayment) {
      await cardPayment.click();
      await delay(1000);
    }

    // 12. 카드사 선택 (비씨)
    console.log("[adpia] 12. 카드사 선택 (비씨)...");
    const cardType = await page.$(SELECTORS.order.cardType);
    if (cardType) {
      await page.select(
        SELECTORS.order.cardType,
        SELECTORS.order.cardTypeValue
      );
      await delay(1000);
    }

    // 13. 전체 동의 체크박스 클릭
    console.log("[adpia] 13. 전체 동의 체크박스 클릭...");
    const agreeAll = await page.$(SELECTORS.order.agreeAll);
    if (agreeAll) {
      await agreeAll.click();
      await delay(3000);
    }

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
        5000
      );
      if (payConfirmBtn) {
        await payConfirmBtn.click();
        await delay(3000);

        // 16. 새로 열린 결제창 찾기 (이미 targetcreated에서 잡았을 수 있음)
        console.log("[adpia] 16. BC카드 결제창 찾는 중...");
        if (!paymentPopup) {
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
        }

        if (paymentPopup) {
          // 결제창 로드 대기
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
              if (ispPassword) {
                // dialog 핸들러 먼저 등록 (버튼 클릭 전에!)
                const ispAlertHandler = async (dialog) => {
                  console.log("[adpia] ISP Alert 감지:", dialog.type(), dialog.message());
                  try {
                    await dialog.accept();
                    console.log("[adpia] ISP Alert 자동 닫힘");
                  } catch (e) {
                    // 이미 처리됨
                  }
                };
                page.on("dialog", ispAlertHandler);
                paymentPopup.on("dialog", ispAlertHandler);
                console.log("[adpia] ✅ dialog 핸들러 등록 완료");

                // 메인 페이지와 결제창에 window.alert 오버라이드
                try {
                  await page.evaluate(() => {
                    window.alert = (msg) => {
                      console.log("[Main Page Override] alert:", msg);
                    };
                    window.confirm = (msg) => {
                      console.log("[Main Page Override] confirm:", msg);
                      return true;
                    };
                  });
                  console.log("[adpia] ✅ 메인 페이지 alert 오버라이드 완료");
                } catch (e) {
                  console.log("[adpia] 메인 페이지 오버라이드 실패:", e.message);
                }

                try {
                  await paymentPopup.evaluate(() => {
                    window.alert = (msg) => {
                      console.log("[Payment Popup Override] alert:", msg);
                    };
                    window.confirm = (msg) => {
                      console.log("[Payment Popup Override] confirm:", msg);
                      return true;
                    };
                  });
                  console.log("[adpia] ✅ 결제창 alert 오버라이드 완료");
                } catch (e) {
                  console.log("[adpia] 결제창 오버라이드 실패:", e.message);
                }

                // 인증서 버튼 클릭 (alert 핸들러 등록 후)
                await paymentPopup.click(certPaymentBtn);
                console.log("[adpia] ✅ 인증서 등록/결제 버튼 클릭 완료");
                await delay(3000);

                console.log("[adpia] ISP 네이티브 결제창 자동화 시작...");
                const ispResult = await automateISPPaymentWithAlertHandler(ispPassword, paymentPopup);

                // 핸들러 제거
                page.off("dialog", ispAlertHandler);
                paymentPopup.off("dialog", ispAlertHandler);

                if (ispResult.success) {
                  console.log("[adpia] ✅ ISP 결제 자동화 완료");

                  // 20. 결제 완료 대기 - 결제창이 닫힐 때까지 대기
                  console.log("[adpia] 20. 결제 완료 대기 중...");
                  for (let i = 0; i < 60; i++) {
                    await delay(1000);
                    // 결제창이 닫혔는지 확인
                    try {
                      const isClosed = paymentPopup.isClosed();
                      if (isClosed) {
                        console.log("[adpia] 결제창 닫힘 확인");
                        break;
                      }
                    } catch (e) {
                      // 창이 닫히면 에러 발생할 수 있음
                      console.log("[adpia] 결제창 닫힘 확인 (에러)");
                      break;
                    }
                    if (i % 10 === 0) {
                      console.log(`[adpia] 결제 완료 대기 중... ${i}초`);
                    }
                  }

                  // 메인 페이지 결제 완료 확인
                  await delay(3000);
                  const currentUrl = page.url();
                  console.log("[adpia] 결제 후 URL:", currentUrl);

                  // 21. 주문번호 추출
                  console.log("[adpia] 21. 주문번호 추출 시도...");
                  let vendorOrderNumber = null;
                  try {
                    // 주문 완료 페이지로 이동했는지 확인
                    if (
                      currentUrl.includes("orderresult") ||
                      currentUrl.includes("order/result")
                    ) {
                      await page.waitForSelector(SELECTORS.order.orderNumber, {
                        timeout: 10000,
                      });
                      vendorOrderNumber = await page.$eval(
                        SELECTORS.order.orderNumber,
                        (el) => el.textContent?.trim()
                      );
                      console.log("[adpia] ✅ 주문번호:", vendorOrderNumber);
                    } else {
                      // 페이지 이동 대기 후 재시도
                      await delay(3000);
                      const orderNumberEl = await page.$(
                        SELECTORS.order.orderNumber
                      );
                      if (orderNumberEl) {
                        vendorOrderNumber = await page.$eval(
                          SELECTORS.order.orderNumber,
                          (el) => el.textContent?.trim()
                        );
                        console.log("[adpia] ✅ 주문번호:", vendorOrderNumber);
                      }
                    }
                  } catch (e) {
                    console.log("[adpia] 주문번호 추출 실패:", e.message);
                  }

                  // targetcreated 핸들러 제거
                  payBrowser.off("targetcreated", targetCreatedHandler);

                  return {
                    success: true,
                    message: "결제 완료",
                    vendorOrderNumber,
                  };
                } else {
                  console.log(
                    "[adpia] ⚠️ ISP 결제 자동화 실패:",
                    ispResult.error
                  );
                  console.log("[adpia] 수동 결제가 필요합니다.");
                }
              } else {
                // ISP 비밀번호 없으면 버튼만 클릭하고 수동 대기
                await paymentPopup.click(certPaymentBtn);
                console.log("[adpia] ✅ 인증서 등록/결제 버튼 클릭 완료");
                console.log("[adpia] ISP 비밀번호 미설정 - 수동 결제 필요");
              }
            } catch (certError) {
              console.log(
                "[adpia] ⚠️ 인증서 등록/결제 버튼 클릭 실패:",
                certError.message
              );
            }
          } catch (e) {
            console.log("[adpia] ⚠️ 기타결제 버튼 클릭 실패:", e.message);
          }
        } else {
          console.log("[adpia] ⚠️ BC카드 결제창 팝업을 찾을 수 없음");
        }

        // 결제 완료 추가 대기
        await delay(5000);
      }
    }

    // targetcreated 핸들러 제거
    payBrowser.off("targetcreated", targetCreatedHandler);

    console.log("[adpia] 주문서 입력 완료");
    return { success: true, message: "주문서 입력 완료" };
  } catch (error) {
    console.error("[adpia] 배송지 입력 실패:", error.message);
    // 에러 시에도 핸들러 제거
    payBrowser.off("targetcreated", targetCreatedHandler);
    return { success: false, message: error.message };
  }
}

/**
 * 결제 처리
 * TODO: 셀렉터 제공 후 구현 예정
 */
async function processPayment(page) {
  console.log("[adpia] 결제 처리...");

  // TODO: 사용자가 셀렉터 제공 후 구현
  // SELECTORS.order 에 셀렉터 필요:
  // - cardPayment: 카드 결제 선택
  // - agreeAll: 전체 동의 체크박스
  // - payBtn: 결제하기 버튼
  //
  // SELECTORS.payment 에 셀렉터 필요 (PG사 iframe):
  // - iframe: 결제 iframe
  // - cardSelect: 카드사 선택
  // - agreeBtn: 동의 버튼
  // - nextBtn: 다음 버튼

  console.log("[adpia] 결제 처리 미구현 (셀렉터 필요)");
  return { success: false, message: "결제 처리 미구현 - 셀렉터 필요" };
}

/**
 * 애드피아몰 주문 처리 메인 함수
 */
async function processAdpiaOrder(
  res,
  page,
  vendor,
  { products, shippingAddress, lineIds, purchaseOrderId },
  authToken
) {
  console.log(`[adpia] 주문 시작: ${products.length}개 상품`);

  const errorCollector = createOrderErrorCollector("adpia");
  const shippingInfo = shippingAddress; // 기존 코드와 호환을 위해 alias

  // ISP 비밀번호 (환경변수에서 가져옴 - BC카드 ISP 공용)
  const ispPassword = vendor.ispPassword || getEnv("BC_ISP_PASSWORD") || "";
  console.log(
    `[adpia] ISP 비밀번호 설정 확인: ${ispPassword ? "있음" : "없음"}`
  );

  const results = [];
  const downloadedFiles = []; // 다운로드한 파일 경로들
  const addedProducts = []; // 장바구니에 추가된 상품들
  const optionFailedProducts = []; // 옵션 실패 상품들
  const priceMismatches = []; // 가격 불일치 상품들

  try {
    // 0. 디자인 파일 미리 다운로드
    for (const product of products) {
      const designFileUrl = product.designFileUrl;
      if (designFileUrl && product.productSku) {
        try {
          const filename = getStableFilename(designFileUrl, product.productSku);
          console.log(`[adpia] 디자인 파일 준비: ${filename}`);
          const filePath = await downloadFile(designFileUrl, filename);
          downloadedFiles.push({
            productSku: product.productSku,
            filePath,
          });
        } catch (err) {
          console.error(
            `[adpia] 디자인 파일 다운로드 실패 (${product.productSku}):`,
            err.message
          );
        }
      }
    }
    console.log("[adpia] 준비된 파일 수:", downloadedFiles.length);

    // 1. 로그인
    const loginResult = await loginToAdpia(page, vendor);
    if (!loginResult.success) {
      errorCollector.addError(ORDER_STEPS.LOGIN, ERROR_CODES.LOGIN_FAILED, loginResult.message || "로그인 실패", { purchaseOrderId });
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
        message: "로그인 실패",
        vendor: vendor.name,
        automationErrors: errorCollector.getErrors(),
      });
    }

    // 2. 장바구니 비우기
    await clearCart(page);

    // 3. 각 상품 처리
    for (const product of products) {
      console.log(`[adpia] 상품 처리: ${product.productName}`);

      try {
        // 3-1. 제품코드로 상품 찾기 (favor 페이지에서)
        const findResult = await findProductByCode(page, product.productSku);

        if (!findResult.success) {
          results.push({
            lineId: product.orderLineId,
            productVariantVendorId: product.productVariantVendorId,
            productSku: product.productSku,
            productName: product.productName,
            success: false,
            message: findResult.message,
          });
          // 옵션 실패로 추적
          if (findResult.message?.includes('옵션')) {
            optionFailedProducts.push({
              productVariantVendorId: product.productVariantVendorId,
              reason: findResult.message,
            });
          }
          continue;
        }

        // 3-2. 협력사 가격 확인 (favor 페이지에서 가져온 가격)
        const openMallPrice = findResult.price; // 오픈몰 가격 (VAT 포함)
        const expectedPrice = product.vendorPriceExcludeVat; // 시스템 가격 (VAT 제외)

        // 가격 비교 로직
        // 오픈몰 가격은 VAT 포함, 시스템 가격은 VAT 제외이므로 비교 시 VAT 제외로 통일
        const openMallPriceExcludeVat = Math.round(openMallPrice / 1.1); // VAT 제외 가격
        const priceDifference = Math.abs(openMallPriceExcludeVat - expectedPrice);
        const priceMismatch = expectedPrice > 0 && priceDifference > 10; // 10원 이상 차이나면 불일치

        console.log(`[adpia] 가격 비교: 오픈몰=${openMallPrice}(VAT제외=${openMallPriceExcludeVat}) vs 시스템=${expectedPrice}, 차이=${priceDifference}원, 불일치=${priceMismatch}`);

        // 가격 정보 저장 (불일치여도 주문은 계속 진행, 결과에만 표시)
        const priceInfo = {
          priceMismatch,
          unitPrice: openMallPrice,
          unitPriceExcludeVat: openMallPriceExcludeVat,
          expectedUnitPrice: expectedPrice,
          difference: openMallPriceExcludeVat - expectedPrice,
        };

        // 3-3. 주문 페이지에서 처리 (수량 입력, 파일 업로드, 장바구니 담기)
        const downloadedFile = downloadedFiles.find(
          (f) => f.productSku === product.productSku
        );

        // 파일 업로드 실패 시 최대 2회 재시작 (옵션 페이지에서 다시 시작)
        const MAX_PRODUCT_RETRIES = 2;
        let orderPageResult = null;

        for (let productRetry = 0; productRetry < MAX_PRODUCT_RETRIES; productRetry++) {
          if (productRetry > 0) {
            console.log(`[adpia] 상품 재시작 시도 ${productRetry}/${MAX_PRODUCT_RETRIES - 1}...`);
          }

          orderPageResult = await processOrderPage(
            page,
            product,
            downloadedFile
          );

          // 업로드 실패로 재시작 필요한 경우
          if (orderPageResult.needsRestart && productRetry < MAX_PRODUCT_RETRIES - 1) {
            console.log("[adpia] 🔄 옵션 페이지에서 상품 다시 찾기...");

            // 옵션 페이지로 이동하여 상품 다시 찾기
            const retryFindResult = await findProductByCode(page, product.productSku);
            if (!retryFindResult.success) {
              console.log("[adpia] 재시작 후 상품 찾기 실패:", retryFindResult.message);
              orderPageResult = { success: false, message: "재시작 후 상품 찾기 실패" };
              break;
            }
            // 다시 processOrderPage 시도
            continue;
          }

          // 성공하거나 재시작 불필요한 실패면 루프 종료
          break;
        }

        const resultEntry = {
          lineId: product.orderLineId,
          productVariantVendorId: product.productVariantVendorId,
          productSku: product.productSku,
          productName: product.productName,
          quantity: product.quantity,
          price: openMallPrice,
          success: orderPageResult.success,
          message: orderPageResult.message,
          priceInfo, // 가격 비교 정보 (priceMismatch 포함)
        };
        results.push(resultEntry);

        // addedProducts, optionFailedProducts, priceMismatches 추적
        if (orderPageResult.success) {
          addedProducts.push({
            orderLineId: product.orderLineId,
            productVariantVendorId: product.productVariantVendorId,
            productSku: product.productSku,
            productName: product.productName,
            quantity: product.quantity,
          });
        } else if (orderPageResult.message?.includes('옵션')) {
          optionFailedProducts.push({
            productVariantVendorId: product.productVariantVendorId,
            reason: orderPageResult.message,
          });
        }

        // 가격 불일치 추적
        if (priceInfo.priceMismatch) {
          priceMismatches.push({
            productVariantVendorId: product.productVariantVendorId,
            vendorPriceExcludeVat: priceInfo.unitPriceExcludeVat,
            openMallPrice: priceInfo.unitPrice,
          });
        }
      } catch (error) {
        console.error(`[adpia] 상품 처리 에러:`, error.message);
        errorCollector.addError(ORDER_STEPS.ADD_TO_CART, null, error.message, {
          purchaseOrderId,
          purchaseOrderLineId: product.orderLineId,
          productVariantVendorId: product.productVariantVendorId,
        });
        results.push({
          lineId: product.orderLineId,
          productSku: product.productSku,
          productName: product.productName,
          success: false,
          message: error.message,
        });
      }
    }

    // 4. 장바구니 → 주문서 이동
    let vendorOrderNumber = null;
    const successProducts = results.filter((r) => r.success);
    if (successProducts.length > 0) {
      const orderFormResult = await goToOrderForm(page);
      if (!orderFormResult.success) {
        console.log("[adpia] 주문서 이동 실패:", orderFormResult.message);
      } else {
        // 5. 배송지 입력 + 결제
        if (shippingInfo) {
          const shippingResult = await fillShippingInfo(
            page,
            shippingInfo,
            ispPassword
          );
          if (!shippingResult.success) {
            console.log("[adpia] 배송지 입력 실패:", shippingResult.message);
          } else if (shippingResult.vendorOrderNumber) {
            vendorOrderNumber = shippingResult.vendorOrderNumber;
            console.log("[adpia] 주문번호 확인:", vendorOrderNumber);
          }
        }

        // 6. 주문번호 없으면 재시도
        if (!vendorOrderNumber) {
          await delay(3000);
          try {
            const orderNumberEl = await page.$(SELECTORS.order.orderNumber);
            if (orderNumberEl) {
              vendorOrderNumber = await page.$eval(
                SELECTORS.order.orderNumber,
                (el) => el.textContent?.trim()
              );
              console.log("[adpia] 주문번호 재시도 성공:", vendorOrderNumber);
            }
          } catch (e) {
            console.log("[adpia] 주문번호 재시도 실패:", e.message);
          }
        }
      }
    } else {
      console.log("[adpia] 장바구니에 담긴 상품이 없어 주문서 이동 스킵");
    }

    // 가격 불일치 목록 (res.json용 상세 정보)
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

    // 옵션 실패 목록 (res.json용 상세 정보)
    const optionFailedProductsForRes = results
      .filter((r) => !r.success && r.message?.includes("옵션"))
      .map((r) => ({
        purchaseOrderLineId: r.lineId,
        productVariantVendorId: r.productVariantVendorId,
        productSku: r.productSku,
        productName: r.productName,
        reason: r.message,
      }));

    // saveOrderResults 호출 (성공)
    await saveOrderResults(authToken, {
      purchaseOrderId,
      products: addedProducts.map((p) => ({
        orderLineIds: p.orderLineIds,
        openMallOrderNumber: vendorOrderNumber || null,
      })),
      priceMismatches: priceMismatches.map((p) => ({
        productVariantVendorId: p.productVariantVendorId,
        vendorPriceExcludeVat: p.vendorPriceExcludeVat,
        openMallPrice: p.openMallPrice,
      })),
      optionFailedProducts: [],
      automationErrors: [],
      lineIds,
      success: true,
    });

    return res.json({
      success: true,
      message: `${products.length}개 상품 처리 완료`,
      vendor: vendor.name,
      purchaseOrderId: purchaseOrderId || null,
      purchaseOrderLineIds: lineIds || [],
      products: products.map((p) => ({
        orderLineId: p.orderLineId,
        openMallOrderNumber: vendorOrderNumber || null,
        productName: p.productName,
        productSku: p.productSku,
        quantity: p.quantity,
        vendorPriceExcludeVat: p.vendorPriceExcludeVat,
        needsManagerVerification: p.needsManagerVerification || false,
      })),
      orderResult: {
        placed: !!vendorOrderNumber,
        vendorOrderNumber: vendorOrderNumber || null,
      },
      hasPriceMismatch: priceMismatchList.length > 0,
      priceMismatchCount: priceMismatchList.length,
      priceMismatches: priceMismatchesForRes,
      optionFailedCount: optionFailedProductsForRes.length,
      optionFailedProducts: optionFailedProductsForRes,
    });
  } catch (error) {
    console.error("[adpia] 주문 처리 에러:", error);
    errorCollector.addError(ORDER_STEPS.ORDER_PLACEMENT, null, error.message, { purchaseOrderId });
    await saveOrderResults(authToken, {
      purchaseOrderId,
      products: addedProducts || [],
      priceMismatches: [],
      optionFailedProducts: optionFailedProducts?.map((p) => ({
        productVariantVendorId: p.productVariantVendorId,
        reason: p.reason,
      })) || [],
      automationErrors: errorCollector.getErrors(),
      lineIds,
      success: false,
    });
    return res.json({
      success: false,
      vendor: vendor.name,
      message: `주문 처리 에러: ${error.message}`,
      automationErrors: errorCollector.hasErrors() ? errorCollector.getErrors() : undefined,
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
