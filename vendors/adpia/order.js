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
const https = require("https");
const http = require("http");

// 임시 파일 저장 경로
const TEMP_DIR = path.join(__dirname, "../../temp");

// 딜레이 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    addToCartBtn: "#calcarea > div.order_list_re > div.ng-star-inserted > button.btn_m.or_white_02.ng-star-inserted",
    // 모달 확인 버튼 (alertify.js)
    modalConfirmBtn: ".ajs-modal button.ajs-button.btn_orange",
  },
  // 옵션 저장 페이지 (favor)
  favor: {
    url: "https://www.adpiamall.com/order/favor",
    table: "table.table01",
    row: "tbody tr.ng-star-inserted",
    productCode: 'span[style*="color: #4874db"]',  // 제품코드 (RTN-XXXXXX)
    orderBtn: "button.btn_small.btn_grey_2019",   // 주문하러 가기 버튼
    // 페이지네이션
    pagination: "ul.pagination",
    pageItem: "li.pagination-page a.page-link",
    activePage: "li.pagination-page.active",
    nextPage: "li.pagination-next:not(.disabled) a.page-link",
  },
  // 장바구니
  cart: {
    url: "https://www.adpiamall.com/cart",
    selectAll: "#sub_container > div > app-root > cartlist > div > div.list-str > div.list01 > div > div > a:nth-child(1)",
    deleteBtn: "#sub_container > div > app-root > cartlist > div > div.list-str > div.list01 > div > div > a.big_btn08.ng-star-inserted",
    orderBtn: "#sub_container > div > app-root > cartlist > div > div.list-str > div.cart_menu > div.list02 > button",
    // 상품 행: 체크박스가 있는 tr만 (빈 장바구니 메시지 제외)
    itemRow: "app-root cartlist table tbody tr.ng-star-inserted:has(input[type='checkbox'])",
    emptyMessage: "span.empty_cart",  // "장바구니가 비었습니다"
  },
  // 주문서
  order: {
    // 배송 방법
    deliveryMethod: "#deliv_method",
    deliveryMethodValue: "DVM11", // 선불택배
    // 보내는 사람 - 주문자와 동일
    senderSameAsOrderer: "#ordersForm > div.list01 > div:nth-child(4) > table > tbody > tr:nth-child(1) > td:nth-child(2) > div:nth-child(1) > label > span",
    // 배송지 - 새로운 배송지
    newAddressBtn: "#ordersForm > div.list01 > div:nth-child(2) > table > tbody > tr.ng-star-inserted > td:nth-child(2) > div.lineinput.ml20.ml2 > label > span",
    // 주소 찾기 버튼
    addressSearchBtn: "#ordersForm > div.list01 > div:nth-child(2) > table > tbody > tr:nth-child(2) > td:nth-child(2) > div > daumpost > a",
    // 주소 입력 필드 (iframe 닫힌 후 상세주소 추가용)
    addressDetail: "#recv_addr_2",
    // 수령인
    receiverName: "#recv_name",
    // 배송지명
    deliveryName: "#deliv_name",
    // 휴대폰 (3개 필드)
    phoneFirst: "#recv_mobile_1",   // select (010)
    phoneMiddle: "#recv_mobile_2",  // input
    phoneLast: "#recv_mobile_3",    // input
    // 결제수단 - 신용카드
    cardPayment: 'input[name="pay_method"][value="PYM20"]',
    // 카드사 선택
    cardType: "#LGD_CARDTYPE",
    cardTypeValue: "31", // 비씨
    // 전체 동의 체크박스
    agreeAll: "#ordersForm > div.list01 > div:nth-child(6) > div.table03_wrap.ng-star-inserted > table > tbody > tr:nth-child(1) > td:nth-child(3) > div > label",
    // 결제하기 버튼
    payBtn: "#ordersForm > div.cart_menu > div > div.list02 > button",
    // 결제 확인 모달 버튼 (alertify.js)
    payConfirmBtn: "body > div.alertify.ajs-movable.ajs-closable.ajs-pinnable.ajs-fade > div.ajs-modal > div > div.ajs-footer > div.ajs-primary.ajs-buttons > button.ajs-button.btn.btn_orange",
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
async function processOrderPage(page, product, downloadedFile) {
  console.log(`[adpia] 주문 페이지 처리: ${product.productSku}`);

  // 1. 수량 입력 (트리플 클릭 후 타이핑)
  console.log(`[adpia] 수량 입력: ${product.quantity}`);
  const quantityInput = await waitFor(page, SELECTORS.orderPage.quantityInput, 10000);
  if (quantityInput) {
    await quantityInput.click({ clickCount: 3 });
    await delay(300);
    await quantityInput.type(String(product.quantity), { delay: 50 });
    await delay(500);
  } else {
    console.log("[adpia] 수량 입력 필드를 찾을 수 없음");
  }

  // 2. 파일 업로드
  if (downloadedFile?.filePath) {
    console.log(`[adpia] 파일 업로드: ${downloadedFile.filePath}`);
    const fileInput = await page.$(SELECTORS.orderPage.fileInput);
    if (fileInput) {
      await fileInput.uploadFile(downloadedFile.filePath);
      console.log("[adpia] 파일 업로드 완료");
      await delay(2000); // 업로드 완료 대기
    } else {
      console.log("[adpia] 파일 입력 필드를 찾을 수 없음");
    }
  }

  // 3. 교정확인 후 인쇄 체크박스 체크
  console.log("[adpia] 교정확인 후 인쇄 체크박스 체크");
  const proofCheckbox = await page.$(SELECTORS.orderPage.proofCheckbox);
  if (proofCheckbox) {
    const isChecked = await page.$eval(SELECTORS.orderPage.proofCheckbox, el => el.checked);
    if (!isChecked) {
      await proofCheckbox.click();
      await delay(500);
    }
  } else {
    console.log("[adpia] 교정확인 체크박스를 찾을 수 없음");
  }

  // 4. 장바구니 담기 버튼 클릭
  console.log("[adpia] 장바구니 담기 버튼 클릭");
  const addToCartBtn = await waitFor(page, SELECTORS.orderPage.addToCartBtn, 10000);
  if (addToCartBtn) {
    await addToCartBtn.click();
    await delay(2000);

    // 5. 모달 확인 버튼 클릭 (alertify.js)
    const modalConfirmBtn = await page.$(SELECTORS.orderPage.modalConfirmBtn);
    if (modalConfirmBtn) {
      console.log("[adpia] 모달 확인 버튼 클릭");
      await modalConfirmBtn.click();
      await delay(1500);
    }

    // 페이지 이동 또는 알림 대기
    await page
      .waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 })
      .catch(() => {});
    await delay(1500);

    console.log("[adpia] 장바구니 담기 완료");
    return { success: true, message: "장바구니 담기 완료" };
  } else {
    console.log("[adpia] 장바구니 담기 버튼을 찾을 수 없음");
    return { success: false, message: "장바구니 담기 버튼을 찾을 수 없음" };
  }
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
    const cartItems = await page.$$("app-root cartlist table tbody tr.ng-star-inserted input[type='checkbox']");
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
    const result = await page.evaluate((selectors, targetCode) => {
      const rows = document.querySelectorAll(selectors.row);

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const codeEl = row.querySelector(selectors.productCode);

        if (codeEl) {
          const code = codeEl.textContent.trim();
          if (code === targetCode) {
            // 가격 추출
            const priceCell = row.querySelector('td:nth-child(4)');
            const priceText = priceCell ? priceCell.textContent.trim() : '';
            const price = parseInt(priceText.replace(/[^0-9]/g, ''), 10) || 0;

            return {
              found: true,
              rowIndex: i,
              price,
            };
          }
        }
      }

      return { found: false };
    }, SELECTORS.favor, productCode);

    if (result.found) {
      console.log(`[adpia] 제품 찾음! (${currentPage}페이지, ${result.rowIndex + 1}번째 행, 가격: ${result.price}원)`);

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
            .waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 })
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
    const nextPageBtn = await page.$('li.pagination-next:not(.disabled) a.page-link');

    if (!nextPageBtn) {
      console.log(`[adpia] 마지막 페이지 도달 (${currentPage}페이지)`);
      break;
    }

    // 5. 다음 페이지로 이동
    // "›" 버튼 (바로 다음 페이지) 클릭
    const nextBtns = await page.$$('li.pagination-next a.page-link');
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

    const cartItems = await page.$$("app-root cartlist table tbody tr.ng-star-inserted input[type='checkbox']");
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
      .waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 })
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
async function fillShippingInfo(page, shippingInfo) {
  console.log("[adpia] 배송지 입력...");

  if (!shippingInfo) {
    console.log("[adpia] 배송지 정보 없음");
    return { success: false, message: "배송지 정보 없음" };
  }

  try {
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
    const recipientName = shippingInfo.firstName || shippingInfo.receiverName || "";
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
        const first = phoneDigits.substring(0, 3);   // 010
        const middle = phoneDigits.substring(3, 7);  // XXXX
        const last = phoneDigits.substring(7, 11);   // XXXX

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
    const addressSearchBtn = await page.$(SELECTORS.order.addressSearchBtn);
    if (addressSearchBtn) {
      await addressSearchBtn.click();
      await delay(1500);

      // 6. 다음 주소 검색 iframe 찾기
      console.log("[adpia] 6. 주소 검색 iframe 찾기...");
      let frame = null;
      for (let i = 0; i < 30; i++) {
        const allFrames = page.frames();
        for (const f of allFrames) {
          try {
            const hasInput = await f.$(SELECTORS.daumPostcode.addressInput);
            if (hasInput) {
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
        // 7. 주소 검색어 입력
        const searchAddress = shippingInfo.streetAddress1 || shippingInfo.address || "";
        if (searchAddress) {
          console.log(`[adpia] 7. 주소 검색어: ${searchAddress}`);
          const addressInput = await frame.$(SELECTORS.daumPostcode.addressInput);
          if (addressInput) {
            await addressInput.click();
            await addressInput.type(searchAddress, { delay: 50 });
            await delay(300);

            // 검색 버튼 클릭
            const searchBtn = await frame.$(SELECTORS.daumPostcode.searchButton);
            if (searchBtn) {
              await searchBtn.click();
            } else {
              await frame.keyboard.press("Enter");
            }
            await delay(1500);

            // 8. 검색 결과 첫 번째 항목 클릭 (도로명 주소)
            console.log("[adpia] 8. 주소 검색 결과 선택...");
            try {
              await frame.waitForSelector(SELECTORS.daumPostcode.resultItem, { timeout: 5000 });
              await delay(500);
              await frame.evaluate((selectors) => {
                const firstItem = document.querySelector(selectors.resultItem);
                if (firstItem) {
                  // 도로명 주소 버튼 클릭
                  const roadAddrBtn = firstItem.querySelector(".main_road .link_post");
                  if (roadAddrBtn) {
                    roadAddrBtn.click();
                  } else {
                    firstItem.click();
                  }
                }
              }, SELECTORS.daumPostcode);
              console.log("[adpia] 주소 선택 완료");
              await delay(1500);
            } catch (e) {
              console.log("[adpia] 주소 검색 결과 없음:", e.message);
            }
          }
        }
      } else {
        console.log("[adpia] 주소 검색 iframe 못찾음");
      }
    }

    // 9. 상세주소 입력 (#recv_addr_2 클릭 후 End 키 → 스페이스 → 상세주소)
    const detailAddress = shippingInfo.streetAddress2 || shippingInfo.addressDetail || "";
    if (detailAddress) {
      console.log(`[adpia] 9. 상세주소 입력: ${detailAddress}`);
      await delay(1000);

      const addrDetail = await page.$(SELECTORS.order.addressDetail);
      if (addrDetail) {
        await addrDetail.click();
        await delay(200);
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
      await page.select(SELECTORS.order.deliveryMethod, SELECTORS.order.deliveryMethodValue);
      await delay(500);
    }

    // 11. 결제수단 선택 - 신용카드
    console.log("[adpia] 11. 신용카드 결제 선택...");
    const cardPayment = await page.$(SELECTORS.order.cardPayment);
    if (cardPayment) {
      await cardPayment.click();
      await delay(500);
    }

    // 12. 카드사 선택 (비씨)
    console.log("[adpia] 12. 카드사 선택 (비씨)...");
    const cardType = await page.$(SELECTORS.order.cardType);
    if (cardType) {
      await page.select(SELECTORS.order.cardType, SELECTORS.order.cardTypeValue);
      await delay(500);
    }

    // 13. 전체 동의 체크박스 클릭
    console.log("[adpia] 13. 전체 동의 체크박스 클릭...");
    const agreeAll = await page.$(SELECTORS.order.agreeAll);
    if (agreeAll) {
      await agreeAll.click();
      await delay(500);
    }

    // 14. 결제하기 버튼 클릭 전 - 현재 페이지 목록 저장
    const payBrowser = page.browser();
    const pagesBeforePay = await payBrowser.pages();
    const pagesBeforePaySet = new Set(pagesBeforePay);

    console.log("[adpia] 14. 결제하기 버튼 클릭...");
    const payBtn = await page.$(SELECTORS.order.payBtn);
    if (payBtn) {
      await payBtn.click();
      await delay(2000);

      // 15. 결제 확인 모달 버튼 클릭
      console.log("[adpia] 15. 결제 확인 모달 버튼 클릭...");
      const payConfirmBtn = await waitFor(page, SELECTORS.order.payConfirmBtn, 5000);
      if (payConfirmBtn) {
        await payConfirmBtn.click();
        await delay(3000);

        // 16. 새로 열린 결제창 찾기
        console.log("[adpia] 16. BC카드 결제창 찾는 중...");
        const pagesAfterPay = await payBrowser.pages();
        let paymentPopup = null;
        for (const p of pagesAfterPay) {
          if (!pagesBeforePaySet.has(p)) {
            const url = p.url();
            if (!url.startsWith("devtools://")) {
              paymentPopup = p;
              console.log("[adpia] 결제창 찾음:", url);
              break;
            }
          }
        }

        if (paymentPopup) {
          // 결제창 dialog 핸들러 등록 (ISP 안내 등 alert 자동 처리)
          const paymentDialogHandler = async (dialog) => {
            console.log("[adpia] 결제창 Dialog:", dialog.type(), dialog.message());
            await dialog.accept();
          };
          paymentPopup.on("dialog", paymentDialogHandler);

          // 결제창 로드 대기
          await delay(2000);

          // 17. 기타결제 버튼 클릭
          console.log("[adpia] 17. 기타결제 버튼 클릭...");
          const otherPaymentBtn = "#inapppay-dap1 > div.block2 > div.left > a";

          try {
            await paymentPopup.waitForSelector(otherPaymentBtn, { timeout: 60000 });
            await paymentPopup.click(otherPaymentBtn);
            console.log("[adpia] ✅ 기타결제 버튼 클릭 완료");
            await delay(3000);

            // 18. 인증서 등록/결제 버튼 클릭
            console.log("[adpia] 18. 인증서 등록/결제 버튼 클릭...");
            const certPaymentBtn = "#inapppay-dap2 > div.block1 > div.left > a.pay-item-s.pay-ctf";

            try {
              await paymentPopup.waitForSelector(certPaymentBtn, { timeout: 60000 });
              await paymentPopup.click(certPaymentBtn);
              console.log("[adpia] ✅ 인증서 등록/결제 버튼 클릭 완료");
              await delay(3000);

              // ISP/페이북 네이티브 창은 수동 처리 필요
              console.log("[adpia] ISP 비밀번호 입력 대기 중...");

            } catch (certError) {
              console.log("[adpia] ⚠️ 인증서 등록/결제 버튼 클릭 실패:", certError.message);
            }
          } catch (e) {
            console.log("[adpia] ⚠️ 기타결제 버튼 클릭 실패:", e.message);
          }
        } else {
          console.log("[adpia] ⚠️ BC카드 결제창 팝업을 찾을 수 없음");
        }

        // 결제 완료 대기
        await delay(10000);
      }
    }

    console.log("[adpia] 주문서 입력 완료");
    return { success: true, message: "주문서 입력 완료" };
  } catch (error) {
    console.error("[adpia] 배송지 입력 실패:", error.message);
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
async function processAdpiaOrder(page, vendor, products, shippingInfo, res) {
  console.log(`[adpia] 주문 시작: ${products.length}개 상품`);

  const results = [];
  const downloadedFiles = []; // 다운로드한 파일 경로들
  let purchaseOrderId = null;
  let purchaseOrderLineIds = [];

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
          console.error(`[adpia] 디자인 파일 다운로드 실패 (${product.productSku}):`, err.message);
        }
      }
    }
    console.log("[adpia] 준비된 파일 수:", downloadedFiles.length);

    // 1. 로그인
    const loginResult = await loginToAdpia(page, vendor);
    if (!loginResult.success) {
      return res.json({
        success: false,
        message: "로그인 실패",
        vendor: vendor.name,
      });
    }

    // 2. 장바구니 비우기
    await clearCart(page);

    // 3. 각 상품 처리
    for (const product of products) {
      console.log(`[adpia] 상품 처리: ${product.productName}`);

      // purchaseOrderId/LineId 저장
      if (!purchaseOrderId && product.purchaseOrderId) {
        purchaseOrderId = product.purchaseOrderId;
      }
      if (product.orderLineId) {
        purchaseOrderLineIds.push(product.orderLineId);
      }

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
          continue;
        }

        // 3-2. 협력사 가격 확인 (favor 페이지에서 가져온 가격)
        const openMallPrice = findResult.price;
        const expectedPrice = product.vendorPriceExcludeVat; // 시스템 가격 (VAT 제외)

        // 가격 비교 로직
        // TODO: VAT 포함/미포함 처리 필요 시 여기서
        const priceMismatch = false; // 가격 불일치 여부

        if (priceMismatch) {
          results.push({
            lineId: product.orderLineId,
            productVariantVendorId: product.productVariantVendorId,
            productSku: product.productSku,
            productName: product.productName,
            success: false,
            message: "가격 불일치",
            priceInfo: {
              priceMismatch: true,
              unitPrice: openMallPrice,
              expectedUnitPrice: expectedPrice,
              difference: openMallPrice - expectedPrice,
            },
          });
          continue;
        }

        // 3-3. 주문 페이지에서 처리 (수량 입력, 파일 업로드, 장바구니 담기)
        const downloadedFile = downloadedFiles.find(f => f.productSku === product.productSku);
        const orderPageResult = await processOrderPage(page, product, downloadedFile);

        results.push({
          lineId: product.orderLineId,
          productVariantVendorId: product.productVariantVendorId,
          productSku: product.productSku,
          productName: product.productName,
          quantity: product.quantity,
          price: openMallPrice,
          success: orderPageResult.success,
          message: orderPageResult.message,
        });

      } catch (error) {
        console.error(`[adpia] 상품 처리 에러:`, error.message);
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
    const successProducts = results.filter(r => r.success);
    if (successProducts.length > 0) {
      const orderFormResult = await goToOrderForm(page);
      if (!orderFormResult.success) {
        console.log("[adpia] 주문서 이동 실패:", orderFormResult.message);
      } else {
        // 5. 배송지 입력
        if (shippingInfo) {
          const shippingResult = await fillShippingInfo(page, shippingInfo);
          if (!shippingResult.success) {
            console.log("[adpia] 배송지 입력 실패:", shippingResult.message);
          }
        }

        // 6. 결제 처리
        const paymentResult = await processPayment(page);
        if (!paymentResult.success) {
          console.log("[adpia] 결제 처리 실패:", paymentResult.message);
        }
      }
    } else {
      console.log("[adpia] 장바구니에 담긴 상품이 없어 주문서 이동 스킵");
    }

    // 7. 주문번호 추출
    let vendorOrderNumber = null;
    // TODO: 주문 완료 페이지에서 주문번호 추출

    // 가격 불일치 목록
    const priceMismatchList = results.filter(r => r.priceInfo?.priceMismatch);
    const priceMismatches = priceMismatchList.map(r => ({
      purchaseOrderLineId: r.lineId,
      productVariantVendorId: r.productVariantVendorId || null,
      productCode: r.productSku,
      productName: r.productName,
      quantity: r.quantity,
      openMallPrice: r.priceInfo?.unitPrice,
      expectedPrice: r.priceInfo?.expectedUnitPrice,
      difference: r.priceInfo?.difference,
    }));

    // 옵션 실패 목록
    const optionFailedProducts = results
      .filter(r => !r.success && r.message?.includes('옵션'))
      .map(r => ({
        purchaseOrderLineId: r.lineId,
        productVariantVendorId: r.productVariantVendorId,
        productSku: r.productSku,
        productName: r.productName,
        reason: r.message,
      }));

    return res.json({
      success: true,
      message: `${products.length}개 상품 처리 완료`,
      vendor: vendor.name,
      purchaseOrderId: purchaseOrderId || null,
      purchaseOrderLineIds: purchaseOrderLineIds || [],
      products: products.map((p) => ({
        orderLineId: p.orderLineId,
        openMallOrderNumber: vendorOrderNumber || null,
        productName: p.productName,
        productSku: p.productSku,
        quantity: p.quantity,
        vendorPriceExcludeVat: p.vendorPriceExcludeVat,
      })),
      orderResult: {
        placed: !!vendorOrderNumber,
        vendorOrderNumber: vendorOrderNumber || null,
      },
      hasPriceMismatch: priceMismatchList.length > 0,
      priceMismatchCount: priceMismatchList.length,
      priceMismatches,
      optionFailedCount: optionFailedProducts.length,
      optionFailedProducts,
    });

  } catch (error) {
    console.error("[adpia] 주문 처리 에러:", error);
    return res.json({
      success: false,
      vendor: vendor.name,
      message: `주문 처리 에러: ${error.message}`,
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
