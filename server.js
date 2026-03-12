/**
 * 협력사 자동 발주 서버 (리팩토링 버전)
 *
 * 구조:
 * - lib/browser.js: 브라우저 관리
 * - vendors/config.js: 협력사 설정
 * - vendors/{vendor}/index.js: 각 협력사별 모듈
 *
 * 환경변수: vendors/config.js의 getEnv() 사용
 * (dotenv 사용 금지 - 모듈 로드 순서 문제 발생)
 */

const express = require("express");

// 브라우저 관리
const {
  getBrowser,
  resetBrowser,
  isPageValid,
  recoverPage,
  getLoginStatus,
  delay,
} = require("./lib/browser");

// 협력사 설정
const {
  VENDORS,
  AUTOMATION_TYPES,
  getVendorByName,
} = require("./vendors/config");

// GraphQL 클라이언트
const { setConfig: setGraphQLConfig } = require("./lib/graphql-client");

// 협력사별 모듈
const { processCoupangOrder } = require("./vendors/coupang");
const { processNapkinOrder } = require("./vendors/napkin");
const { processBaeminOrder } = require("./vendors/baemin");
const { processNaverOrder } = require("./vendors/naver");
const { processWowpressOrder } = require("./vendors/wowpress");
const {
  router: swadpiaRouter,
  processSwadpiaOrder,
} = require("./vendors/swadpia");
const { processAdpiaOrder } = require("./vendors/adpia");

const app = express();
app.use(express.json());

// 협력사별 라우터
app.use("/api/swadpia", swadpiaRouter);

// ==================== 요청 큐 관리 ====================
let isProcessing = false;
const requestQueue = [];

async function processQueue() {
  if (isProcessing || requestQueue.length === 0) {
    return;
  }

  isProcessing = true;
  const { req, res, resolve, retryCount = 0 } = requestQueue.shift();

  try {
    await handleVendorOrder(req, res);
  } catch (error) {
    const isDetachedError =
      error.message &&
      (error.message.includes("detached") ||
        error.message.includes("Detached") ||
        error.message.includes("Target closed") ||
        error.message.includes("Session closed") ||
        error.message.includes("Protocol error"));

    if (isDetachedError && retryCount < 2) {
      console.log(
        `[복구] Detached Frame 에러 감지, 재시도 ${retryCount + 1}/2...`,
      );
      await recoverPage();
      requestQueue.unshift({ req, res, resolve, retryCount: retryCount + 1 });
    } else {
      console.error("[에러] 복구 불가:", error.message);
      await resetBrowser();
      res.status(500).json({ success: false, error: error.message });
    }
  } finally {
    isProcessing = false;
    resolve();

    if (requestQueue.length > 0) {
      // WAF 우회: 다음 주문 처리 전 딜레이 (5-10초 랜덤)
      const delayMs = 5000 + Math.random() * 5000;
      console.log(
        `[큐] 다음 주문까지 ${(delayMs / 1000).toFixed(1)}초 대기...`,
      );
      await delay(delayMs);
      processQueue();
    } else {
      // 큐가 비었으면 브라우저 종료
      console.log("[큐] 모든 주문 처리 완료, 브라우저 종료");
      await resetBrowser();
    }
  }
}

// ==================== API 엔드포인트 ====================

/**
 * 협력사 이름으로 발주 처리 (n8n에서 호출)
 */
app.post("/api/vendor/order", async (req, res) => {
  return new Promise((resolve) => {
    requestQueue.push({ req, res, resolve });
    console.log(`[큐] 요청 추가됨. 대기 중: ${requestQueue.length}건`);
    processQueue();
  });
});

/**
 * 실제 발주 처리 로직
 */
async function handleVendorOrder(req, res) {
  try {
    const {
      vendorName,
      productUrl,
      productName,
      quantity = 1,
      products, // 여러 상품 배열
      shippingAddress,
      orderData,
      poLineIds, // PurchaseOrderLine ID 배열 (대행접수용)
      purchaseOrderId: rawPurchaseOrderId, // 발주 ID (단일)
      purchaseOrderIds, // 발주 ID들 (배열, n8n에서 전달)
      graphqlUrl, // GraphQL API URL (n8n에서 전달)
    } = req.body;

    // purchaseOrderId 처리: purchaseOrderIds 배열 우선, 없으면 단일 값, 없으면 products에서 추출
    let purchaseOrderId =
      purchaseOrderIds && purchaseOrderIds.length > 0
        ? purchaseOrderIds[0]
        : rawPurchaseOrderId;

    if (!purchaseOrderId && products && products.length > 0) {
      purchaseOrderId = products[0].purchaseOrderId;
      if (purchaseOrderId) {
        console.log(
          `[발주ID] products[0]에서 purchaseOrderId 추출: ${purchaseOrderId}`,
        );
      }
    }

    // GraphQL URL 설정 (환경변수보다 요청에서 전달된 값 우선)
    if (graphqlUrl) {
      setGraphQLConfig({ graphqlUrl });
    }

    if (!vendorName) {
      return res.status(400).json({
        success: false,
        error: "vendorName이 필요합니다",
      });
    }

    // 협력사 설정 찾기
    const vendor = getVendorByName(vendorName);
    if (!vendor) {
      return res.json({
        success: false,
        automationType: "unknown",
        error: `등록되지 않은 협력사: ${vendorName}`,
        message: "수동 발주 필요",
      });
    }

    // products 배열이 있으면 사용, 없으면 단일 상품으로 배열 생성 (하위 호환성)
    const productsList = products || [{ productUrl, productName, quantity }];

    // shippingAddress 처리:
    // 1. 최상위 shippingAddress 사용
    // 2. 없으면 products 배열 첫 번째 요소에서 추출
    let resolvedShippingAddress = shippingAddress;
    if (!resolvedShippingAddress && products && products.length > 0) {
      resolvedShippingAddress = products[0].shippingAddress;
      if (resolvedShippingAddress) {
        console.log("[배송지] products[0]에서 shippingAddress 추출");
      }
    }

    // orderData에서 shippingAddress 추출 시도
    if (!resolvedShippingAddress && orderData && orderData.shippingAddress) {
      resolvedShippingAddress = orderData.shippingAddress;
      console.log("[배송지] orderData에서 shippingAddress 추출");
    }

    console.log(`\n========== [${vendor.name}] 발주 시작 ==========`);
    console.log(`자동화 타입: ${AUTOMATION_TYPES[vendor.automationType]}`);
    console.log(
      `발주 ID: ${purchaseOrderId || "없음"} (원본: purchaseOrderIds=${JSON.stringify(purchaseOrderIds)}, rawPurchaseOrderId=${rawPurchaseOrderId})`,
    );
    console.log(`상품 수: ${productsList.length}개`);
    if (resolvedShippingAddress) {
      console.log(
        `배송지: ${resolvedShippingAddress.firstName} / ${resolvedShippingAddress.phone} / ${resolvedShippingAddress.streetAddress1}`,
      );
    } else {
      console.log(`배송지: 없음 (장바구니만 담기)`);
    }
    productsList.forEach((p, i) => {
      console.log(
        `  상품 ${i + 1}: ${p.productName || p.productUrl} x ${p.quantity || 1}`,
      );
    });

    // authToken 추출 (GraphQL mutation 호출용)
    const authToken = req.headers.authorization;

    // 자동화 타입별 분기 처리
    switch (vendor.automationType) {
      case "product_search":
        return await handleProductSearchOrder(res, vendor, {
          products: productsList,
          shippingAddress: resolvedShippingAddress,
          orderData,
          poLineIds,
          purchaseOrderId,
          authToken,
        });

      case "reorder":
        return await handleReorder(res, vendor, {
          productName,
          quantity,
          orderData,
        });

      case "needs_confirmation":
        return res.json({
          success: false,
          automationType: vendor.automationType,
          vendor: vendor.name,
          message: `[${vendor.name}] 교정확인이 필요한 업체입니다. 수동 발주 필요.`,
          notes: vendor.hideSender ? "보내는분을 포장보스로 변경 필요" : null,
          siteUrl: vendor.siteUrl,
        });

      case "needs_kakao":
        return res.json({
          success: false,
          automationType: vendor.automationType,
          vendor: vendor.name,
          message: `[${vendor.name}] 카카오톡으로 협의가 필요한 업체입니다.`,
          notes: vendor.requiresKakaoDesign
            ? "카톡으로 디자인 확정 필요"
            : vendor.requiresKakaoFile
              ? "카톡으로 양식/디자인 파일 전달 필요"
              : null,
          siteUrl: vendor.siteUrl,
        });

      default:
        return res.json({
          success: false,
          automationType: "unknown",
          vendor: vendor.name,
          message: "알 수 없는 자동화 타입",
          siteUrl: vendor.siteUrl,
        });
    }
  } catch (error) {
    console.error("발주 처리 실패:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}

/**
 * 상품 검색 후 주문 처리
 */
async function handleProductSearchOrder(
  res,
  vendor,
  {
    products,
    shippingAddress,
    orderData,
    poLineIds,
    purchaseOrderId,
    authToken,
  },
) {
  let { browser, page } = await getBrowser(vendor.key);

  // 페이지 유효성 검사 및 복구
  if (!(await isPageValid(page))) {
    console.log("[주문 처리] 페이지 무효, 복구 시도...");
    const recovered = await recoverPage(vendor.key);
    page = recovered.page;
  }

  // 협력사별 주문 처리
  switch (vendor.key) {
    case "coupang":
      return await processCoupangOrder(
        res,
        page,
        vendor,
        {
          products,
          shippingAddress,
          poLineIds,
          purchaseOrderId,
        },
        authToken,
      );

    case "napkin":
      return await processNapkinOrder(
        res,
        page,
        vendor,
        {
          products,
          shippingAddress,
          poLineIds,
          purchaseOrderId,
        },
        authToken,
      );

    case "baemin":
      return await processBaeminOrder(
        res,
        page,
        vendor,
        {
          products,
          shippingAddress,
          poLineIds,
          purchaseOrderId,
        },
        authToken,
      );

    case "naver":
      return await processNaverOrder(
        res,
        page,
        vendor,
        {
          products,
          shippingAddress,
          poLineIds,
          purchaseOrderId,
        },
        authToken,
      );

    case "wowpress":
      return await processWowpressOrder(res, page, vendor, { browser });

    case "swadpia":
      return await processSwadpiaOrder(
        res,
        page,
        vendor,
        {
          products,
          shippingAddress,
          poLineIds,
          purchaseOrderId,
        },
        authToken,
      );

    case "adpia":
      return await processAdpiaOrder(
        res,
        page,
        vendor,
        {
          products,
          shippingAddress,
          poLineIds,
          purchaseOrderId,
        },
        authToken,
      );

    default:
      return res.json({
        success: false,
        vendor: vendor.name,
        message: `[${vendor.name}] 자동화 미구현. 수동 발주 필요.`,
        siteUrl: vendor.siteUrl,
      });
  }
}

/**
 * 재주문 처리 (마플)
 */
async function handleReorder(
  res,
  vendor,
  { productName, quantity, orderData },
) {
  return res.json({
    success: false,
    automationType: "reorder",
    vendor: vendor.name,
    message: `[${vendor.name}] 재주문 방식입니다. 과거 주문 내역 참고 필요.`,
    siteUrl: vendor.siteUrl,
    loginInfo: {
      email: vendor.email,
      note: "주문 내역에서 재주문으로 발주",
    },
  });
}

/**
 * 협력사 목록 조회 API
 */
app.get("/api/vendor/list", (req, res) => {
  const vendorList = Object.entries(VENDORS).map(([name, config]) => ({
    name,
    key: config.key,
    automationType: config.automationType,
    automationTypeText: AUTOMATION_TYPES[config.automationType],
    paymentMethod: config.paymentMethod,
    siteUrl: config.siteUrl,
    requiresProofing: config.requiresProofing || false,
    requiresKakao:
      config.requiresKakaoDesign || config.requiresKakaoFile || false,
    hideSender: config.hideSender || false,
  }));

  res.json({
    success: true,
    count: vendorList.length,
    vendors: vendorList,
  });
});

/**
 * 브라우저 상태 확인 API
 */
app.get("/api/browser/status", async (req, res) => {
  try {
    const { browser, page } = await getBrowser(); // 상태 확인용은 vendorKey 없이 호출
    const isValid = await isPageValid(page);

    res.json({
      success: true,
      browserConnected: !!browser,
      pageValid: isValid,
      currentUrl: isValid ? page.url() : null,
      loginStatus: {
        coupang: getLoginStatus("coupang"),
        napkin: getLoginStatus("napkin"),
        baemin: getLoginStatus("baemin"),
        naver: getLoginStatus("naver"),
      },
    });
  } catch (error) {
    res.json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * 브라우저 리셋 API
 */
app.post("/api/browser/reset", async (req, res) => {
  try {
    await resetBrowser();
    res.json({
      success: true,
      message: "브라우저가 리셋되었습니다",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * 헬스체크 API
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    queueLength: requestQueue.length,
    isProcessing,
  });
});

// ==================== 서버 시작 ====================
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`\n====================================`);
  console.log(`협력사 자동 발주 서버 (리팩토링 버전)`);
  console.log(`====================================`);
  console.log(`포트: ${PORT}`);
  console.log(`====================================\n`);
  console.log("사용 가능한 API:");
  console.log(`  POST /api/vendor/order - 협력사 발주`);
  console.log(`  GET  /api/vendor/list  - 협력사 목록`);
  console.log(`  GET  /api/browser/status - 브라우저 상태`);
  console.log(`  POST /api/browser/reset - 브라우저 리셋`);
  console.log(`  POST /api/swadpia/login - 성원애드피아 로그인`);
  console.log(`  GET  /health - 헬스체크`);
  console.log("");
});
