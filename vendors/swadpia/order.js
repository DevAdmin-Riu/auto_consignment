const { getPage, closeBrowser } = require("../../lib/browser");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

// 임시 파일 저장 경로
const TEMP_DIR = path.join(__dirname, "../../temp");

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
    console.log("[swadpia] 파일 이미 존재, 다운로드 스킵:", filePath);
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
          console.log("[swadpia] 파일 다운로드 완료:", filePath);
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
      console.log("[swadpia] 임시 파일 삭제:", filePath);
    }
  } catch (e) {
    console.error("[swadpia] 임시 파일 삭제 실패:", e.message);
  }
}

// 셀렉터 정의
const SELECTORS = {
  login: {
    id: "#mem_login_id",
    password: "#mem_login_pw",
    submit: "#icon_member_login",
  },
  optionList: {
    startDate: "#sdate",
    searchInput: "#search_value",
    searchButton:
      "#option_search > table > tbody > tr:nth-child(1) > td:nth-child(4) > a",
    orderButton:
      "#contents > table > tbody > tr:nth-child(2) > td:nth-child(4) > a",
  },
  orderPage: {
    quantity: "#order_count",
    fileUploadIframe: "#iframe_InnoDS",
    fileUploadButton: "#uploader_browse",
    cartButton: "#btn_cart",
    cartSaveButton: "#btn_cart_save",
  },
  // 장바구니 페이지 셀렉터
  cartPage: {
    url: "https://www.swadpia.co.kr/order/order_cart",
    // 상품 행: 체크박스가 있는 tr (input[name="sel_cart_order_key[]"])
    cartRow: 'tr[align="center"][height="50"]',
    // 각 td 위치 (1-indexed)
    checkbox: 'input[name="sel_cart_order_key[]"]', // td:nth-child(1)
    productName: "td:nth-child(4) .blue2", // 상품명 (파란색 굵은 글씨)
    quantity: "td:nth-child(6)", // 수량 (예: "2,000 매")
    count: "td:nth-child(7)", // 건수 (예: "1건")
    price: "td:nth-child(8) b", // 금액 (예: "22,660원")
    // 전체 선택 체크박스
    selectAllCheckbox: "#cart_all_check",
    // 장바구니 비우기 버튼 (선택 상품 삭제)
    deleteSelectedBtn: "#cart_list_result > table > tbody > tr:nth-child(7) > td > table > tbody > tr > td:nth-child(1) > a:nth-child(1)",
    // 전체 주문하기 버튼
    orderAllBtn: "#cart_list_result > table > tbody > tr:nth-child(7) > td > table > tbody > tr > td:nth-child(2) > a:nth-child(3)",
  },
  // 주문서 작성 페이지 셀렉터
  orderForm: {
    // 주문자 정보 선택
    senderCheckbox: "#send_user_chk", // 주문자 정보 체크
    sameAsMember: "#send_is_member_same", // 회원 정보와 동일
    // 배송지 정보
    deliveryInfoSelect: "#sel_deliv_info", // 배송지 선택 (먼저 클릭해야 초기화 안됨)
    deliveryMethod: "#deliv_method", // 배송방법 선택
    deliveryName: "#deliv_name", // 배송지명
    recipientName: "#recv_name", // 수령인
    // 전화번호 (3분할)
    phonePrefix: "#recv_phone_1", // 전화번호 앞자리 (select)
    phoneMiddle: "#recv_phone_2", // 전화번호 중간 (input)
    phoneSuffix: "#recv_phone_3", // 전화번호 뒷자리 (input)
    // 휴대전화 (3분할)
    mobilePrefix: "#recv_mobile_1", // 휴대전화 앞자리 (select)
    mobileMiddle: "#recv_mobile_2", // 휴대전화 중간 (input)
    mobileSuffix: "#recv_mobile_3", // 휴대전화 뒷자리 (input)
    // 주소
    addressSearchBtn: "#tr_addr_area > td.leftmargin10 > p:nth-child(1) > a > img", // 우편번호/주소 검색 버튼
    // 상세주소 입력
    addressDetail: "#recv_addr_2", // 상세주소 input
    // 결제 관련
    paymentAgreeCheckbox: "#chk_order_info_agree", // 주문 정보 동의 체크박스
    submitOrderBtn: "#sp_btn_order_pay > table > tbody > tr > td:nth-child(2) > input[type=image]", // 주문확인 버튼
  },
  // 결제 페이지 셀렉터
  paymentPage: {
    onlineCardCheckbox: "#pay_method_online_card > input[type=checkbox]", // 온라인 카드 결제 체크박스
    cardTypeSelect: "#LGD_CARDTYPE", // 카드 종류 선택
    agreeAllBtn: "#agree_buy_all", // 전체 동의 버튼
    paySubmitBtn: "#btn_pay_submit", // 결제하기 버튼
  },
  // 다음 우편번호 팝업 셀렉터
  daumPostcode: {
    searchInput: "#region_name", // 주소 검색 input
    resultList: "ul.list_post", // 검색 결과 리스트
    resultItem: "li.list_post_item", // 검색 결과 아이템
    roadAddressBtn: "dd.main_road .txt_address button.link_post", // 도로명 주소 선택 버튼
  },
};

/**
 * 장바구니 비우기 (전체 선택 후 일괄 삭제)
 */
async function clearCart(page) {
  console.log("[swadpia] 장바구니 비우기 시작...");

  try {
    // 이미 장바구니 페이지에 있으면 이동 스킵
    const currentUrl = page.url();
    if (!currentUrl.includes("/order/order_cart")) {
      await page.goto(SELECTORS.cartPage.url, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
    }

    // 장바구니에 상품이 있는지 확인
    const cartRows = await page.$$(SELECTORS.cartPage.cartRow);
    if (cartRows.length === 0) {
      console.log("[swadpia] 장바구니가 이미 비어있음");
      return true;
    }

    console.log(`[swadpia] 장바구니 상품 ${cartRows.length}개 일괄 삭제 중...`);

    // 1. 전체 선택 체크박스 클릭
    const selectAllCheckbox = await page.$(SELECTORS.cartPage.selectAllCheckbox);
    if (selectAllCheckbox) {
      await selectAllCheckbox.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // 2. confirm/alert 창 자동 확인 처리
    const dialogHandler = async (dialog) => {
      console.log("[swadpia] Dialog:", dialog.type(), dialog.message());
      await dialog.accept(); // 확인 버튼 클릭
    };
    page.on("dialog", dialogHandler);

    // 3. 선택 상품 삭제 버튼 클릭
    const deleteBtn = await page.$(SELECTORS.cartPage.deleteSelectedBtn);
    if (deleteBtn) {
      await deleteBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // 4. dialog 핸들러 제거
    page.off("dialog", dialogHandler);

    console.log("[swadpia] 장바구니 비우기 완료");
    return true;
  } catch (error) {
    console.error("[swadpia] 장바구니 비우기 실패:", error.message);
    return false;
  }
}

/**
 * 성원애드피아 로그인
 */
async function login(page, credentials) {
  const { email, password } = credentials;

  console.log("[swadpia] 로그인 페이지 이동...");
  await page.goto("https://www.swadpia.co.kr/member/re_login", {
    waitUntil: "networkidle2",
    timeout: 30000,
  });

  // 아이디 입력
  console.log("[swadpia] 아이디 입력...");
  await page.waitForSelector(SELECTORS.login.id, { timeout: 10000 });
  await page.type(SELECTORS.login.id, email, { delay: 50 });

  // 비밀번호 입력
  console.log("[swadpia] 비밀번호 입력...");
  await page.type(SELECTORS.login.password, password, { delay: 50 });

  // 로그인 버튼 클릭
  console.log("[swadpia] 로그인 버튼 클릭...");
  await page.click(SELECTORS.login.submit);

  // 로그인 완료 대기 (URL 변경 또는 특정 요소 대기)
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // 로그인 성공 확인
  const currentUrl = page.url();
  console.log("[swadpia] 현재 URL:", currentUrl);

  // 로그인 실패 시 re_login 페이지에 그대로 있음
  if (currentUrl.includes("/member/re_login")) {
    throw new Error("로그인 실패 - 아이디/비밀번호 확인 필요");
  }

  console.log("[swadpia] 로그인 성공!");
  return true;
}

/**
 * 장바구니 상품 검증
 * - 상품 수량 확인
 * - 가격 확인 (협력사 매입가와 비교)
 */
async function verifySwadpiaCartItems(page, expectedProducts) {
  console.log("[swadpia 장바구니 검증] 시작...");
  console.log(
    `[swadpia 장바구니 검증] 기대 상품 ${expectedProducts.length}개:`,
    expectedProducts
      .map((p) => `${p.productName || p.productSku} x${p.quantity}`)
      .join(", ")
  );

  // 장바구니 페이지로 이동
  await page.goto(SELECTORS.cartPage.url, {
    waitUntil: "networkidle2",
    timeout: 30000,
  });

  // 장바구니 페이지에서 상품 정보 추출
  // 구조: tr[align="center"][height="50"] = 상품 행
  //       td:nth-child(4) .blue2 = 상품명
  //       td:nth-child(6) = 수량 (예: "2,000 매")
  //       td:nth-child(7) = 건수 (예: "1건")
  //       td:nth-child(8) b = 금액 (예: "22,660원")
  const cartItems = await page.evaluate((selectors) => {
    const items = [];
    const rows = document.querySelectorAll(selectors.cartRow);

    for (const row of rows) {
      // 상품명 (.blue2 클래스)
      const nameEl = row.querySelector(selectors.productName);
      const name = nameEl ? nameEl.textContent?.trim() : "";

      // 건수 (예: "1건" -> 1) - 실제 주문 수량
      const countEl = row.querySelector(selectors.count);
      let quantity = 1;
      if (countEl) {
        const match = countEl.textContent?.match(/(\d+)/);
        quantity = match ? parseInt(match[1], 10) : 1;
      }

      // 금액 (예: "22,660원" -> 22660)
      const priceEl = row.querySelector(selectors.price);
      let unitPrice = 0;
      if (priceEl) {
        const text = priceEl.textContent?.replace(/,/g, "") || "";
        const match = text.match(/(\d+)/);
        unitPrice = match ? parseInt(match[1], 10) : 0;
      }

      if (name) {
        items.push({
          name,
          quantity, // 건수 = 실제 주문 수량
          unitPrice,
          totalPrice: unitPrice,
        });
      }
    }

    return items;
  }, SELECTORS.cartPage);

  console.log(
    `[swadpia 장바구니 검증] 장바구니 상품 ${cartItems.length}개:`,
    cartItems.map((i) => `${i.name.substring(0, 30)}... x${i.quantity} @${i.unitPrice}원`).join(", ")
  );

  // 검증 결과
  const matchedItems = [];
  const quantityMismatches = [];
  const priceMismatches = [];
  const missingItems = [];
  const unexpectedItems = []; // 예상 외 상품 (장바구니에 있지만 주문하지 않은 상품)

  // 기대 상품 목록 복사
  const expectedCopy = [...expectedProducts];

  // 장바구니 상품과 기대 상품 매칭 (productSku로 매칭)
  for (const cartItem of cartItems) {
    // 장바구니 주문제목에서 productSku 찾기
    const matchedIndex = expectedCopy.findIndex((expected) =>
      cartItem.name.includes(expected.productSku)
    );

    if (matchedIndex >= 0) {
      const matchedExpected = expectedCopy[matchedIndex];

      // 수량(건수) 비교
      if (cartItem.quantity !== matchedExpected.quantity) {
        quantityMismatches.push({
          productSku: matchedExpected.productSku,
          expected: matchedExpected.quantity,
          actual: cartItem.quantity,
        });
        console.log(
          `[수량 불일치] ${matchedExpected.productSku} - 기대: ${matchedExpected.quantity}, 실제: ${cartItem.quantity}`
        );
      } else {
        console.log(
          `[수량 일치] ${matchedExpected.productSku} - ${cartItem.quantity}건`
        );
      }

      // 가격 확인 (협력사 매입가와 비교)
      const expectedUnitPrice = matchedExpected.vendorPriceExcludeVat || matchedExpected.purchasePrice || 0;
      if (expectedUnitPrice > 0 && cartItem.unitPrice !== expectedUnitPrice) {
        const priceDiff = cartItem.unitPrice - expectedUnitPrice;
        const priceDiffPercent = ((priceDiff / expectedUnitPrice) * 100).toFixed(2);
        priceMismatches.push({
          productSku: matchedExpected.productSku,
          expectedPrice: expectedUnitPrice,
          actualPrice: cartItem.unitPrice,
          difference: priceDiff,
          differencePercent: priceDiffPercent,
        });
        console.log(
          `[가격 불일치] ${matchedExpected.productSku} - 기대: ${expectedUnitPrice}원, 실제: ${cartItem.unitPrice}원`
        );
      }

      matchedItems.push({
        productSku: matchedExpected.productSku,
        quantity: cartItem.quantity,
        unitPrice: cartItem.unitPrice,
      });

      expectedCopy.splice(matchedIndex, 1);
    } else {
      // 매칭 안됨 = 예상 외 상품 (이전 주문 잔여물 또는 중복)
      unexpectedItems.push({
        name: cartItem.name.substring(0, 50),
        quantity: cartItem.quantity,
      });
      console.log(`[예상외 상품] ${cartItem.name.substring(0, 40)}... - ${cartItem.quantity}건`);
    }
  }

  // 장바구니에 없는 기대 상품
  for (const remaining of expectedCopy) {
    missingItems.push({
      productSku: remaining.productSku,
      quantity: remaining.quantity,
    });
    console.log(`[누락 상품] ${remaining.productSku}`);
  }

  // 검증 통과 조건: 모든 상품 매칭 + 수량 일치 + 예상 외 상품 없음
  const isValid =
    matchedItems.length === expectedProducts.length &&
    quantityMismatches.length === 0 &&
    unexpectedItems.length === 0;

  // 가격 불일치 HTML 생성
  let priceMismatchEmailHtml = null;
  if (priceMismatches.length > 0) {
    const rows = priceMismatches
      .map((pm, i) => `
        <tr>
          <td style="border:1px solid #ddd;padding:8px;">${i + 1}</td>
          <td style="border:1px solid #ddd;padding:8px;">${pm.productSku}</td>
          <td style="border:1px solid #ddd;padding:8px;text-align:right;">${pm.expectedPrice.toLocaleString()}원</td>
          <td style="border:1px solid #ddd;padding:8px;text-align:right;">${pm.actualPrice.toLocaleString()}원</td>
          <td style="border:1px solid #ddd;padding:8px;text-align:right;color:${pm.difference > 0 ? "red" : "blue"};">${pm.difference > 0 ? "+" : ""}${pm.difference.toLocaleString()}원 (${pm.differencePercent}%)</td>
        </tr>
      `)
      .join("");

    priceMismatchEmailHtml = `
<div style="font-family:Arial,sans-serif;max-width:800px;">
  <div style="background:#ff9800;color:white;padding:15px;">
    <b>⚠️ 성원애드피아 가격 불일치 - ${priceMismatches.length}건</b>
  </div>
  <div style="border:1px solid #ddd;border-top:none;padding:15px;">
    <table style="width:100%;border-collapse:collapse;">
      <tr style="background:#f5f5f5;">
        <th style="border:1px solid #ddd;padding:8px;">#</th>
        <th style="border:1px solid #ddd;padding:8px;">상품코드</th>
        <th style="border:1px solid #ddd;padding:8px;">협력사매입가</th>
        <th style="border:1px solid #ddd;padding:8px;">성원애드피아</th>
        <th style="border:1px solid #ddd;padding:8px;">차이</th>
      </tr>
      ${rows}
    </table>
  </div>
</div>`;
  }

  return {
    isValid,
    totalInCart: cartItems.length,
    totalExpected: expectedProducts.length,
    matchedItems,
    quantityMismatches,
    priceMismatches,
    missingItems,
    unexpectedItems,
    hasPriceMismatch: priceMismatches.length > 0,
    priceMismatchCount: priceMismatches.length,
    priceMismatchEmailHtml,
    summary: isValid
      ? "✅ 장바구니 검증 통과"
      : `⚠️ 검증 실패: 매칭 ${matchedItems.length}/${expectedProducts.length}, 수량불일치 ${quantityMismatches.length}, 누락 ${missingItems.length}, 예상외 ${unexpectedItems.length}`,
  };
}

/**
 * 상품들을 장바구니에 추가 (2~8번 단계)
 * 재시도 시 이 함수만 다시 호출
 */
async function addProductsToCart(page, products, downloadedFiles) {
  // 각 상품별로 처리 (이미 옵션 목록 페이지에 있음)
  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    const productCode = product.productSku || "";

    if (!productCode) {
      console.log(`[swadpia] 상품 ${i + 1}: productSku 없음, 건너뜀`);
      continue;
    }

    console.log(
      `\n[swadpia] ===== 상품 ${i + 1}/${products.length} 처리 시작 =====`
    );
    console.log(
      `[swadpia] 상품코드: ${productCode}, 수량: ${product.quantity}`
    );

    // 옵션 목록 페이지로 이동 (두번째 상품부터)
    if (i > 0) {
      console.log("[swadpia] 옵션 목록 페이지로 이동...");
      await page.goto("https://www.swadpia.co.kr/mypage/option_list", {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
    }

    // 2. 시작일 설정 (2025-01-01) - readonly 속성이라 JS로 직접 설정
    console.log("[swadpia] 시작일 설정...");
    await page.waitForSelector(SELECTORS.optionList.startDate, {
      timeout: 10000,
    });
    await page.$eval(SELECTORS.optionList.startDate, (el) => {
      el.value = "2025-01-01";
      if (window.$ && $(el).datepicker) {
        $(el).datepicker("setDate", "2025-01-01");
      }
    });

    // 3. 제품 코드 검색
    console.log("[swadpia] 제품 코드 입력:", productCode);
    await page.waitForSelector(SELECTORS.optionList.searchInput, {
      timeout: 10000,
    });
    await page.$eval(
      SELECTORS.optionList.searchInput,
      (el) => (el.value = "")
    );
    await page.type(SELECTORS.optionList.searchInput, productCode, {
      delay: 30,
    });

    // 4. 조회 버튼 클릭
    console.log("[swadpia] 조회 버튼 클릭...");
    await page.waitForSelector(SELECTORS.optionList.searchButton, {
      timeout: 10000,
    });
    await page.click(SELECTORS.optionList.searchButton);

    // 검색 결과 대기
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 5. 상품 주문 버튼 클릭
    console.log("[swadpia] 상품 주문 버튼 클릭...");
    await page.waitForSelector(SELECTORS.optionList.orderButton, {
      timeout: 10000,
    });

    // alert 창 처리 (확인 클릭)
    page.once("dialog", async (dialog) => {
      console.log("[swadpia] Alert:", dialog.message());
      await dialog.accept();
    });

    await page.click(SELECTORS.optionList.orderButton);

    // 페이지 이동 대기 (주문 페이지 로드에 시간이 걸림)
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // 6. 주문 수량 선택 (select 드롭다운)
    const quantity = product.quantity || 1;
    console.log("[swadpia] 주문 수량 선택:", quantity);
    await page.waitForSelector(SELECTORS.orderPage.quantity, {
      timeout: 10000,
    });
    await page.select(SELECTORS.orderPage.quantity, String(quantity));

    // 7. 장바구니 담기 버튼 클릭 (파일 업로드 iframe이 나타남)
    console.log("[swadpia] 장바구니 담기 버튼 클릭...");
    await page.waitForSelector(SELECTORS.orderPage.cartButton, {
      timeout: 10000,
    });

    // alert 창 처리
    page.once("dialog", async (dialog) => {
      console.log("[swadpia] Alert:", dialog.message());
      await dialog.accept();
    });

    await page.click(SELECTORS.orderPage.cartButton);
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // 8. 디자인 파일 업로드 (iframe 내부)
    const downloadedFile = downloadedFiles.find(
      (f) => f.productSku === productCode
    );
    if (downloadedFile) {
      console.log("[swadpia] 디자인 파일 업로드 준비...");

      // iframe 로드 대기
      console.log("[swadpia] iframe 로드 대기...");
      await page.waitForSelector(SELECTORS.orderPage.fileUploadIframe, {
        timeout: 15000,
      });

      // iframe 콘텐츠 로드 대기
      await page.waitForFunction(
        (selector) => {
          const iframe = document.querySelector(selector);
          return (
            iframe &&
            iframe.contentDocument &&
            iframe.contentDocument.readyState === "complete"
          );
        },
        { timeout: 15000 },
        SELECTORS.orderPage.fileUploadIframe
      );
      console.log("[swadpia] iframe 로드 완료");

      const iframeElement = await page.$(
        SELECTORS.orderPage.fileUploadIframe
      );
      const iframe = await iframeElement.contentFrame();

      if (iframe) {
        // iframe 내부 버튼 대기 (plupload 초기화 확인)
        console.log("[swadpia] plupload 초기화 대기...");
        await iframe.waitForSelector(SELECTORS.orderPage.fileUploadButton, {
          timeout: 10000,
        });
        await new Promise((resolve) => setTimeout(resolve, 2000)); // plupload 완전 초기화 대기

        // plupload의 숨겨진 file input 찾기
        console.log("[swadpia] 파일 업로드:", downloadedFile.filePath);
        const fileInput = await iframe.$("input[type='file']");
        if (fileInput) {
          await fileInput.uploadFile(downloadedFile.filePath);
          console.log("[swadpia] 파일 업로드 완료");
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } else {
          console.log("[swadpia] iframe 내부 file input을 찾을 수 없음");
        }
      } else {
        console.log("[swadpia] iframe에 접근할 수 없음");
      }

      // 9. 장바구니 저장 버튼 클릭
      console.log("[swadpia] 장바구니 저장 버튼 클릭...");
      await page.waitForSelector(SELECTORS.orderPage.cartSaveButton, {
        timeout: 10000,
      });

      // alert 창 처리
      page.once("dialog", async (dialog) => {
        console.log("[swadpia] Alert:", dialog.message());
        await dialog.accept();
      });

      await page.click(SELECTORS.orderPage.cartSaveButton);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    console.log(
      `[swadpia] ===== 상품 ${i + 1}/${
        products.length
      } 장바구니 담기 완료 =====\n`
    );
  }

  console.log("[swadpia] 모든 상품 장바구니 담기 완료");
}

/**
 * 전화번호 파싱 (+821021678895 → { prefix: "010", middle: "2167", suffix: "8895" })
 */
function parsePhoneNumber(phone) {
  if (!phone) return { prefix: "", middle: "", suffix: "" };

  // +82 제거하고 0 추가
  let normalized = phone.replace(/^\+82/, "0").replace(/[^0-9]/g, "");

  // 앞자리 추출 (010, 02, 031 등)
  let prefix = "";
  let rest = normalized;

  // 휴대폰 번호 (010, 011, 016, 017, 018, 019)
  if (/^01[0-9]/.test(normalized)) {
    prefix = normalized.slice(0, 3);
    rest = normalized.slice(3);
  }
  // 서울 (02)
  else if (/^02/.test(normalized)) {
    prefix = "02";
    rest = normalized.slice(2);
  }
  // 지역번호 (031, 032, 033, ...)
  else if (/^0[3-6][0-9]/.test(normalized)) {
    prefix = normalized.slice(0, 3);
    rest = normalized.slice(3);
  }
  // 특수번호 (050, 070, 080, 0502, 0503, ...)
  else if (/^0[5-8]0[0-9]?/.test(normalized)) {
    if (/^050[2-8]/.test(normalized)) {
      prefix = normalized.slice(0, 4);
      rest = normalized.slice(4);
    } else {
      prefix = normalized.slice(0, 3);
      rest = normalized.slice(3);
    }
  }

  // 중간/뒷자리 분리 (4자리씩)
  const middle = rest.slice(0, 4);
  const suffix = rest.slice(4, 8);

  return { prefix, middle, suffix };
}

/**
 * 전체 주문하기 (장바구니에서 주문 실행)
 */
async function placeOrder(page, shippingAddress) {
  console.log("[swadpia] 전체 주문하기 시작...");

  try {
    // 이미 장바구니 페이지에 있는지 확인
    const currentUrl = page.url();
    if (!currentUrl.includes("/order/order_cart")) {
      await page.goto(SELECTORS.cartPage.url, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
    }

    // 전체 주문하기 버튼 대기
    await page.waitForSelector(SELECTORS.cartPage.orderAllBtn, {
      timeout: 10000,
    });

    // confirm/alert 창 자동 확인 처리
    const dialogHandler = async (dialog) => {
      console.log("[swadpia] Dialog:", dialog.type(), dialog.message());
      await dialog.accept();
    };
    page.on("dialog", dialogHandler);

    // 전체 주문하기 버튼 클릭
    console.log("[swadpia] 전체 주문하기 버튼 클릭...");
    await page.click(SELECTORS.cartPage.orderAllBtn);

    // 페이지 이동 대기 (주문서 작성 페이지로 이동)
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // dialog 핸들러 제거
    page.off("dialog", dialogHandler);

    const orderPageUrl = page.url();
    console.log("[swadpia] 주문서 작성 페이지 URL:", orderPageUrl);

    // 주문서 작성 페이지 처리
    // 1. 주문자 정보 체크박스 클릭
    console.log("[swadpia] 주문자 정보 체크박스 클릭...");
    await page.waitForSelector(SELECTORS.orderForm.senderCheckbox, {
      timeout: 10000,
    });
    await page.click(SELECTORS.orderForm.senderCheckbox);
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 2. 회원 정보와 동일 클릭
    console.log("[swadpia] 회원 정보와 동일 클릭...");
    await page.waitForSelector(SELECTORS.orderForm.sameAsMember, {
      timeout: 10000,
    });
    await page.click(SELECTORS.orderForm.sameAsMember);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    console.log("[swadpia] 주문자 정보 설정 완료");

    // 3. 배송지 선택 클릭 (먼저 해야 다른 필드가 초기화 안됨)
    console.log("[swadpia] 배송지 정보 선택...");
    await page.waitForSelector(SELECTORS.orderForm.deliveryInfoSelect, {
      timeout: 10000,
    });
    await page.click(SELECTORS.orderForm.deliveryInfoSelect);
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 4. 배송방법 선택 (선불택배 - DVM11)
    console.log("[swadpia] 배송방법 선택 (선불택배)...");
    await page.waitForSelector(SELECTORS.orderForm.deliveryMethod, {
      timeout: 10000,
    });
    await page.select(SELECTORS.orderForm.deliveryMethod, "DVM11");
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 5. 배송지명, 수령인 입력
    const recipientName = shippingAddress?.firstName || "";
    if (recipientName) {
      console.log("[swadpia] 배송지명/수령인 입력:", recipientName);

      // 배송지명
      await page.$eval(SELECTORS.orderForm.deliveryName, (el) => (el.value = ""));
      await page.type(SELECTORS.orderForm.deliveryName, recipientName, { delay: 30 });

      // 수령인
      await page.$eval(SELECTORS.orderForm.recipientName, (el) => (el.value = ""));
      await page.type(SELECTORS.orderForm.recipientName, recipientName, { delay: 30 });
    }

    // 6. 전화번호 입력 (휴대전화와 동일하게 입력)
    const phoneParts = parsePhoneNumber(shippingAddress?.phone);
    if (phoneParts.prefix) {
      console.log("[swadpia] 전화번호 입력:", phoneParts.prefix, phoneParts.middle, phoneParts.suffix);

      // 전화번호 (recv_phone)
      await page.select(SELECTORS.orderForm.phonePrefix, phoneParts.prefix);
      await page.$eval(SELECTORS.orderForm.phoneMiddle, (el) => (el.value = ""));
      await page.type(SELECTORS.orderForm.phoneMiddle, phoneParts.middle, { delay: 30 });
      await page.$eval(SELECTORS.orderForm.phoneSuffix, (el) => (el.value = ""));
      await page.type(SELECTORS.orderForm.phoneSuffix, phoneParts.suffix, { delay: 30 });

      // 휴대전화 (recv_mobile)
      await page.select(SELECTORS.orderForm.mobilePrefix, phoneParts.prefix);
      await page.$eval(SELECTORS.orderForm.mobileMiddle, (el) => (el.value = ""));
      await page.type(SELECTORS.orderForm.mobileMiddle, phoneParts.middle, { delay: 30 });
      await page.$eval(SELECTORS.orderForm.mobileSuffix, (el) => (el.value = ""));
      await page.type(SELECTORS.orderForm.mobileSuffix, phoneParts.suffix, { delay: 30 });
    }

    // 7. 우편번호/주소 검색 버튼 클릭 (팝업 열림)
    console.log("[swadpia] 우편번호/주소 검색 버튼 클릭...");
    await page.waitForSelector(SELECTORS.orderForm.addressSearchBtn, {
      timeout: 10000,
    });

    // 브라우저 인스턴스 가져오기
    const browser = page.browser();

    // 현재 페이지들 저장 (객체 참조로 비교)
    const pagesBefore = await browser.pages();
    const pagesBeforeSet = new Set(pagesBefore);
    console.log("[swadpia] 현재 페이지 수:", pagesBefore.length);

    // 버튼 클릭
    await page.click(SELECTORS.orderForm.addressSearchBtn);

    // 새 창이 열릴 때까지 대기
    await new Promise((r) => setTimeout(r, 2000));

    // 새로 열린 페이지 찾기
    const pagesAfter = await browser.pages();
    console.log("[swadpia] 클릭 후 페이지 수:", pagesAfter.length);

    // 새 창 찾기 - 페이지 객체 비교 (URL이 아닌 객체 참조로)
    let popup = null;
    for (const p of pagesAfter) {
      // 이전에 없던 페이지 객체 찾기
      if (!pagesBeforeSet.has(p)) {
        const url = p.url();
        // DevTools 제외
        if (url.startsWith("devtools://")) continue;

        popup = p;
        console.log("[swadpia] 새로 열린 팝업 찾음:", url);
        break;
      }
    }

    // 디버깅: 모든 페이지 URL 출력
    if (!popup) {
      console.log("[swadpia] 새 팝업 못찾음. 모든 페이지:");
      for (const p of pagesAfter) {
        const url = p.url();
        if (!url.startsWith("devtools://")) {
          console.log("[swadpia] - 페이지:", url);
        }
      }
    }

    // 팝업을 못 찾았으면 현재 페이지 내 iframe 확인
    if (!popup) {
      console.log("[swadpia] 별도 팝업 창 없음 - 현재 페이지 내 iframe 확인");

      // 현재 페이지 내에서 주소 검색 iframe/modal 찾기
      await new Promise((r) => setTimeout(r, 2000));

      // 다음 우편번호 검색 iframe 찾기 (보통 postcode iframe으로 삽입됨)
      const frames = page.frames();
      console.log("[swadpia] 현재 페이지 프레임 수:", frames.length);

      for (const frame of frames) {
        try {
          const frameUrl = frame.url();
          if (frameUrl && frameUrl !== "about:blank") {
            console.log("[swadpia] 프레임 URL:", frameUrl);
          }
          if (frameUrl.includes("postcode") || frameUrl.includes("daum") || frameUrl.includes("post.daum")) {
            console.log("[swadpia] Daum 우편번호 iframe 찾음");

            // iframe 내에서 주소 검색
            const streetAddress = shippingAddress?.streetAddress1 || "";
            if (streetAddress) {
              console.log("[swadpia] iframe 내 주소 검색:", streetAddress);

              // 검색창 찾기 (다양한 셀렉터 시도)
              const searchSelectors = [
                SELECTORS.daumPostcode.searchInput,
                "input.txt_search",
                "input[type='text']",
                "#search",
                ".input_search",
              ];

              for (const selector of searchSelectors) {
                try {
                  await frame.waitForSelector(selector, { timeout: 3000 });
                  await frame.click(selector);
                  await frame.type(selector, streetAddress, { delay: 50 });
                  console.log("[swadpia] 주소 입력 완료 (셀렉터:", selector, ")");

                  // Enter 키 입력
                  await frame.evaluate(() => {
                    const input = document.querySelector("input[type='text']");
                    if (input) {
                      const event = new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true });
                      input.dispatchEvent(event);
                    }
                  });
                  await new Promise((r) => setTimeout(r, 2000));

                  // 첫 번째 검색 결과 클릭 시도
                  const resultSelectors = [
                    ".list_post li:first-child",
                    ".addr:first-child",
                    "li.list_item:first-child",
                    "tbody tr:first-child",
                  ];

                  for (const resultSelector of resultSelectors) {
                    try {
                      const result = await frame.$(resultSelector);
                      if (result) {
                        await result.click();
                        console.log("[swadpia] 검색 결과 선택 완료");
                        break;
                      }
                    } catch (e) {}
                  }

                  break; // 성공하면 루프 종료
                } catch (e) {
                  // 다음 셀렉터 시도
                }
              }
            }
            break;
          }
        } catch (e) {}
      }
    } else {
      console.log("[swadpia] 주소 검색 창 열림");

      // 페이지가 완전히 로드될 때까지 대기 (about:blank에서 실제 콘텐츠로)
      let waitCount = 0;
      while (popup.url() === "about:blank" && waitCount < 10) {
        await new Promise((r) => setTimeout(r, 500));
        waitCount++;
        console.log("[swadpia] 팝업 로드 대기 중...", waitCount);
      }

      await new Promise((r) => setTimeout(r, 2000));

      // 현재 URL 확인
      const popupUrl = popup.url();
      console.log("[swadpia] 팝업 URL:", popupUrl);

      // 다음 우편번호 검색 창에서 주소 검색
      const streetAddress = shippingAddress?.streetAddress1 || "";
      const postalCode = shippingAddress?.postalCode || "";

      if (streetAddress) {
        console.log("[swadpia] 주소 검색:", streetAddress, "우편번호:", postalCode);

        try {
          // iframe이 있는지 확인
          const frames = popup.frames();
          console.log("[swadpia] 프레임 수:", frames.length);

          let targetFrame = popup; // 기본은 팝업 자체

          // iframe 찾기 (Daum postcode는 보통 iframe 안에 있음)
          if (frames.length > 1) {
            for (const frame of frames) {
              try {
                const frameUrl = frame.url();
                console.log("[swadpia] 프레임 URL:", frameUrl);
                if (frameUrl.includes("postcode") || frameUrl.includes("daum")) {
                  targetFrame = frame;
                  console.log("[swadpia] Daum 프레임 찾음");
                  break;
                }
              } catch (e) {}
            }
          }

          // 검색 입력창 대기
          console.log("[swadpia] 검색창 대기 중...");
          await targetFrame.waitForSelector(SELECTORS.daumPostcode.searchInput, {
            timeout: 15000,
          });
          console.log("[swadpia] 검색창 찾음");

          // 주소 입력
          await targetFrame.click(SELECTORS.daumPostcode.searchInput);
          await targetFrame.type(SELECTORS.daumPostcode.searchInput, streetAddress, { delay: 50 });
          console.log("[swadpia] 주소 입력 완료");

          // Enter 키 입력
          await popup.keyboard.press("Enter");
          await new Promise((r) => setTimeout(r, 3000)); // 검색 결과 대기

          // 검색 결과 리스트 대기
          console.log("[swadpia] 검색 결과 대기 중...");
          await targetFrame.waitForSelector(SELECTORS.daumPostcode.resultList, {
            timeout: 10000,
          });

          // 검색 결과에서 우편번호/주소 매칭하여 선택
          const selectedAddress = await targetFrame.evaluate((selectors, postalCode, streetAddress) => {
            const items = document.querySelectorAll(selectors.resultItem);
            console.log("검색 결과 수:", items.length);

            for (const item of items) {
              const zonecode = item.getAttribute("data-zonecode") || "";
              const addr = item.getAttribute("data-addr") || "";

              console.log("검색 결과:", zonecode, addr);

              // 우편번호 매칭 (우선) 또는 주소 포함 여부
              if ((postalCode && zonecode === postalCode) || addr.includes(streetAddress)) {
                // 도로명 주소 버튼 클릭
                const roadBtn = item.querySelector(selectors.roadAddressBtn);
                if (roadBtn) {
                  roadBtn.click();
                  return { success: true, zonecode, addr };
                }
              }
            }

            // 매칭 안되면 첫 번째 결과 선택
            if (items.length > 0) {
              const firstItem = items[0];
              const roadBtn = firstItem.querySelector(selectors.roadAddressBtn);
              if (roadBtn) {
                roadBtn.click();
                return {
                  success: true,
                  zonecode: firstItem.getAttribute("data-zonecode"),
                  addr: firstItem.getAttribute("data-addr"),
                  fallback: true,
                };
              }
            }

            return { success: false };
          }, SELECTORS.daumPostcode, postalCode, streetAddress);

          if (selectedAddress.success) {
            console.log("[swadpia] 주소 선택 완료:", selectedAddress.addr, "(우편번호:", selectedAddress.zonecode + ")");
            if (selectedAddress.fallback) {
              console.log("[swadpia] (매칭 실패로 첫 번째 결과 선택됨)");
            }
          } else {
            console.log("[swadpia] 검색 결과에서 주소 선택 실패");
          }

          // 팝업 닫힘 대기
          await new Promise((r) => setTimeout(r, 2000));

          // 팝업 닫기 (혹시 안닫혔으면)
          try {
            if (!popup.isClosed()) {
              await popup.close();
            }
          } catch (e) {}

        } catch (popupError) {
          console.error("[swadpia] 주소 검색 실패:", popupError.message);
          // 팝업 닫기 시도
          try {
            if (!popup.isClosed()) {
              await popup.close();
            }
          } catch (e) {}
        }
      }
    }

    // 8. 상세주소 입력 (팝업 닫힌 후)
    const streetAddress2 = shippingAddress?.streetAddress2 || "";
    if (streetAddress2) {
      console.log("[swadpia] 상세주소 입력:", streetAddress2);
      await new Promise((r) => setTimeout(r, 1000)); // 팝업 닫힘 대기

      await page.waitForSelector(SELECTORS.orderForm.addressDetail, {
        timeout: 10000,
      });
      await page.$eval(SELECTORS.orderForm.addressDetail, (el) => (el.value = ""));
      await page.type(SELECTORS.orderForm.addressDetail, streetAddress2, { delay: 30 });
    }

    console.log("[swadpia] 배송지 정보 입력 완료");

    // 9. 주문확인 버튼 클릭 (최종 주문)
    console.log("[swadpia] 주문확인 버튼 클릭...");
    await page.waitForSelector(SELECTORS.orderForm.submitOrderBtn, {
      timeout: 10000,
    });

    // confirm/alert 창 자동 확인 처리
    const orderDialogHandler = async (dialog) => {
      console.log("[swadpia] Order Dialog:", dialog.type(), dialog.message());
      await dialog.accept();
    };
    page.on("dialog", orderDialogHandler);

    await page.click(SELECTORS.orderForm.submitOrderBtn);

    // 주문 완료 대기
    await new Promise((r) => setTimeout(r, 5000));

    // dialog 핸들러 제거
    page.off("dialog", orderDialogHandler);

    // 주문확인 후 결제 페이지로 이동 확인
    const paymentPageUrl = page.url();
    console.log("[swadpia] 결제 페이지 URL:", paymentPageUrl);

    // 10. 온라인 카드 결제 선택
    console.log("[swadpia] 온라인 카드 결제 선택...");
    await page.waitForSelector(SELECTORS.paymentPage.onlineCardCheckbox, {
      timeout: 10000,
    });
    await page.click(SELECTORS.paymentPage.onlineCardCheckbox);
    await new Promise((r) => setTimeout(r, 500));

    // 11. 카드 종류 선택 (비씨카드 - 31)
    console.log("[swadpia] 카드 종류 선택 (비씨)...");
    await page.waitForSelector(SELECTORS.paymentPage.cardTypeSelect, {
      timeout: 10000,
    });
    await page.select(SELECTORS.paymentPage.cardTypeSelect, "31");
    await new Promise((r) => setTimeout(r, 500));

    // 12. 전체 동의 버튼 클릭
    console.log("[swadpia] 전체 동의 버튼 클릭...");
    await page.waitForSelector(SELECTORS.paymentPage.agreeAllBtn, {
      timeout: 10000,
    });
    await page.click(SELECTORS.paymentPage.agreeAllBtn);
    await new Promise((r) => setTimeout(r, 500));

    // 13. 결제하기 버튼 클릭
    console.log("[swadpia] 결제하기 버튼 클릭...");
    await page.waitForSelector(SELECTORS.paymentPage.paySubmitBtn, {
      timeout: 10000,
    });

    // confirm/alert 창 자동 확인 처리
    const payDialogHandler = async (dialog) => {
      console.log("[swadpia] Pay Dialog:", dialog.type(), dialog.message());
      await dialog.accept();
    };
    page.on("dialog", payDialogHandler);

    await page.click(SELECTORS.paymentPage.paySubmitBtn);

    // 결제 완료 대기
    await new Promise((r) => setTimeout(r, 5000));

    // dialog 핸들러 제거
    page.off("dialog", payDialogHandler);

    // 결제 완료 후 URL 확인
    const orderCompleteUrl = page.url();
    console.log("[swadpia] 결제 완료 URL:", orderCompleteUrl);

    return {
      success: true,
      orderPageUrl,
      paymentPageUrl,
      orderCompleteUrl,
    };
  } catch (error) {
    console.error("[swadpia] 전체 주문하기 실패:", error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * 성원애드피아 주문 처리 (메인 플로우)
 */
async function processSwadpiaOrder(
  res,
  page,
  vendor,
  { products, shippingAddress }
) {
  const downloadedFiles = []; // 다운로드한 파일 경로들
  const MAX_RETRY = 2; // 최대 재시도 횟수

  try {
    console.log("[swadpia] 주문 처리 시작...");
    console.log("[swadpia] 상품 수:", products.length);

    // 0. 디자인 파일 미리 다운로드 (고정 파일명으로 재사용 가능)
    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      const designFileUrl = product.designFileUrl;

      if (designFileUrl && product.productSku) {
        try {
          // 고정된 파일명 생성 (재사용 가능)
          const filename = getStableFilename(designFileUrl, product.productSku);

          console.log(
            `[swadpia] 디자인 파일 준비 (${i + 1}/${products.length}):`,
            filename
          );
          const filePath = await downloadFile(designFileUrl, filename);
          downloadedFiles.push({
            index: i,
            filePath,
            productSku: product.productSku,
          });
        } catch (err) {
          console.error(
            `[swadpia] 디자인 파일 다운로드 실패 (${product.productSku}):`,
            err.message
          );
        }
      }
    }

    console.log("[swadpia] 준비된 파일 수:", downloadedFiles.length);

    // 1. 로그인
    await login(page, {
      email: vendor.email,
      password: vendor.password,
    });

    // 2. 장바구니 비우기
    console.log("[swadpia] 장바구니 비우기...");
    await clearCart(page);

    // 3. 옵션 목록 페이지로 이동
    console.log("[swadpia] 옵션 목록 페이지로 이동...");
    await page.goto("https://www.swadpia.co.kr/mypage/option_list", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    console.log("[swadpia] 옵션 목록 페이지 도착");

    // 재시도 루프
    let cartVerification = null;
    let retryCount = 0;

    while (retryCount <= MAX_RETRY) {
      if (retryCount > 0) {
        console.log(`\n[swadpia] ========== 재시도 ${retryCount}/${MAX_RETRY} ==========`);
        // 재시도 시 장바구니 비우기 후 옵션 목록 페이지로 이동
        await clearCart(page);
        console.log("[swadpia] 옵션 목록 페이지로 이동...");
        await page.goto("https://www.swadpia.co.kr/mypage/option_list", {
          waitUntil: "networkidle2",
          timeout: 30000,
        });
      }

      // 상품들을 장바구니에 추가
      await addProductsToCart(page, products, downloadedFiles);

      // 10. 장바구니 검증
      console.log("[swadpia] 장바구니 검증 시작...");
      try {
        cartVerification = await verifySwadpiaCartItems(page, products);
        console.log("[swadpia] 장바구니 검증 결과:", cartVerification.summary);

        // 검증 통과 조건:
        // - 모든 상품 매칭됨 (productSku로 매칭)
        // - 수량(건수) 일치
        // - 예상 외 상품 없음
        // - 가격 불일치는 경고만 (재시도 안함)
        const needsRetry =
          cartVerification.missingItems.length > 0 ||
          cartVerification.quantityMismatches.length > 0 ||
          cartVerification.unexpectedItems.length > 0;

        if (!needsRetry) {
          console.log("[swadpia] 장바구니 검증 통과 (가격 불일치는 경고만)");
          break; // 검증 통과, 루프 종료
        }

        console.log("[swadpia] 장바구니 검증 실패 - 재시도 필요");
        retryCount++;

      } catch (verifyError) {
        console.error("[swadpia] 장바구니 검증 에러:", verifyError.message);
        cartVerification = {
          isValid: false,
          summary: `검증 실패: ${verifyError.message}`,
          hasPriceMismatch: false,
          priceMismatchCount: 0,
          missingItems: [],
          quantityMismatches: [],
          unexpectedItems: [],
        };
        retryCount++;
      }

      if (retryCount > MAX_RETRY) {
        console.log("[swadpia] 최대 재시도 횟수 초과");
      }
    }

    // 11. 전체 주문하기 (장바구니 검증 통과 시)
    let orderResult = null;
    if (cartVerification?.isValid) {
      console.log("[swadpia] 전체 주문하기 진행...");
      orderResult = await placeOrder(page, shippingAddress);
    } else {
      console.log("[swadpia] 장바구니 검증 실패 - 주문 진행 안함");
    }

    // 12. 임시 파일 정리
    console.log("[swadpia] 임시 파일 정리...");
    for (const file of downloadedFiles) {
      cleanupTempFile(file.filePath);
    }

    return res.json({
      success: true,
      message: orderResult?.success
        ? `${products.length}개 상품 주문 완료`
        : `${products.length}개 상품 장바구니 담기 완료`,
      vendor: vendor.name,
      retryCount,
      products: products.map((p) => ({
        productName: p.productName,
        productSku: p.productSku,
        quantity: p.quantity,
        purchasePrice: p.purchasePrice,
      })),
      // 장바구니 검증 결과
      cartVerification: {
        isValid: cartVerification?.isValid || false,
        summary: cartVerification?.summary || "",
        totalInCart: cartVerification?.totalInCart || 0,
        totalExpected: cartVerification?.totalExpected || 0,
        quantityMismatches: cartVerification?.quantityMismatches || [],
        priceMismatches: cartVerification?.priceMismatches || [],
        missingItems: cartVerification?.missingItems || [],
        unexpectedItems: cartVerification?.unexpectedItems || [],
      },
      // 주문 결과
      orderResult: {
        placed: orderResult?.success || false,
        orderPageUrl: orderResult?.orderPageUrl || null,
        paymentPageUrl: orderResult?.paymentPageUrl || null,
        orderCompleteUrl: orderResult?.orderCompleteUrl || null,
        error: orderResult?.error || null,
      },
      // 가격 불일치 관련
      hasPriceMismatch: cartVerification?.hasPriceMismatch || false,
      priceMismatchCount: cartVerification?.priceMismatchCount || 0,
      priceMismatchEmailHtml: cartVerification?.priceMismatchEmailHtml || null,
    });
  } catch (error) {
    console.error("[swadpia] 주문 처리 에러:", error);

    // 에러 발생 시에도 임시 파일 정리
    console.log("[swadpia] 임시 파일 정리 (에러)...");
    for (const file of downloadedFiles) {
      cleanupTempFile(file.filePath);
    }

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}

/**
 * 로그인 테스트 라우터
 */
function setupRoutes(router, wrapVendorConfig) {
  // 로그인 테스트
  router.post("/login", async (req, res) => {
    let browser = null;

    try {
      const vendorConfig = wrapVendorConfig(req.body.vendor || {});
      const credentials = {
        email: vendorConfig.email,
        password: vendorConfig.password,
      };

      if (!credentials.email || !credentials.password) {
        return res.status(400).json({
          success: false,
          error: "이메일과 비밀번호가 필요합니다.",
        });
      }

      const { browser: b, page } = await getPage({ headless: false });
      browser = b;

      await login(page, credentials);

      // 스크린샷 (디버깅용)
      const screenshot = await page.screenshot({ encoding: "base64" });

      return res.json({
        success: true,
        message: "로그인 성공",
        screenshot: `data:image/png;base64,${screenshot}`,
      });
    } catch (error) {
      console.error("[swadpia] 로그인 에러:", error);
      return res.status(500).json({
        success: false,
        error: error.message,
      });
    } finally {
      if (browser) {
        await closeBrowser(browser);
      }
    }
  });

  return router;
}

module.exports = { setupRoutes, login, processSwadpiaOrder };
