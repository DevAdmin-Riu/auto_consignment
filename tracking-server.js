/**
 * 송장번호 조회 서버
 *
 * - 포트: 3001
 * - 독립 브라우저 인스턴스 사용
 * - 오픈몰별 주문목록에서 송장번호 크롤링
 *
 * API:
 * - POST /api/vendor/tracking
 * - Body: { vendors: [{ vendor: "coupang", openMallOrderNumbers: [...], fulfillmentMap: {...} }, ...] }
 */

const express = require("express");
const { connect } = require("puppeteer-real-browser");
const { getVendorByKey } = require("./vendors/config");
const { setConfig: setGraphQLConfig, callGraphQL } = require("./lib/graphql-client");
const { normalizeCarrier } = require("./lib/carrier");

// 각 벤더별 tracking 모듈
const { getCoupangTrackingNumbers } = require("./vendors/coupang/tracking");
const { getSwadpiaTrackingNumbers } = require("./vendors/swadpia/tracking");
const { getNaverTrackingNumbers } = require("./vendors/naver/tracking");
const { getBaeminTrackingNumbers } = require("./vendors/baemin/tracking");
const { getNapkinTrackingNumbers } = require("./vendors/napkin/tracking");
const { getAdpiaTrackingNumbers } = require("./vendors/adpia/tracking");

const app = express();
app.use(express.json());

// 브라우저 인스턴스 (발주 서버와 독립)
let browserInstance = null;
let pageInstance = null;

// 딜레이 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 브라우저 시작
 */
async function getBrowser() {
  if (!browserInstance) {
    console.log("[tracking] 브라우저 연결 시작...");

    const { browser, page } = await connect({
      headless: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
      customConfig: {},
      connectOption: {
        defaultViewport: { width: 1920, height: 1080 },
      },
    });

    browserInstance = browser;
    pageInstance = page;
    console.log("[tracking] 브라우저 연결 완료!");
  }
  return { browser: browserInstance, page: pageInstance };
}

/**
 * 브라우저 초기화
 */
async function resetBrowser() {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (e) {
      // 이미 닫혀있을 수 있음
    }
  }
  browserInstance = null;
  pageInstance = null;
}

// ==================== 벤더별 Tracking 핸들러 ====================

/**
 * 벤더별 tracking 함수 매핑
 */
const trackingHandlers = {
  coupang: getCoupangTrackingNumbers,
  swadpia: getSwadpiaTrackingNumbers,
  naver: getNaverTrackingNumbers,
  baemin: getBaeminTrackingNumbers,
  napkin: getNapkinTrackingNumbers,
  adpia: getAdpiaTrackingNumbers,
};

/**
 * 지원되는 벤더 목록
 */
const supportedVendors = Object.keys(trackingHandlers);

// ==================== API 엔드포인트 ====================

// 택배사 리스트 캐시
let courierListCache = null;

/**
 * 택배사 리스트 조회 (캐싱 — 1회 조회 후 재사용)
 */
async function getCourierList(authToken) {
  if (courierListCache) return courierListCache;

  try {
    const result = await callGraphQL(authToken, `
      query CourierList($first: Int) {
        couriers(first: $first) {
          edges { node { id name code } }
        }
      }
    `, { first: 1000 });

    const edges = result?.data?.couriers?.edges || [];
    courierListCache = edges.map(e => e.node);
    console.log(`[tracking] 택배사 리스트 조회 완료: ${courierListCache.length}개`);
    return courierListCache;
  } catch (e) {
    console.log(`[tracking] 택배사 리스트 조회 실패: ${e.message}`);
    return [];
  }
}

/**
 * 송장번호 즉시 업데이트 (찾는 즉시 mutation 호출)
 */
async function updateTrackingImmediate(authToken, fulfillmentId, trackingNumber, carrier) {
  if (!authToken || !fulfillmentId || !trackingNumber) return null;

  const courierList = await getCourierList(authToken);

  // 택배사 매칭
  const courierMatch = courierList.find(c => c.name === carrier);
  if (!courierMatch) {
    console.log(`[tracking] ⚠️ 택배사 매칭 실패: ${carrier} → 스킵`);
    return null;
  }

  try {
    const result = await callGraphQL(authToken, `
      mutation FulfillmentUpdateTracking($id: ID!, $input: FulfillmentUpdateTrackingInput!) {
        fulfillmentUpdateTracking(id: $id, input: $input) {
          fulfillment { id trackingNumber }
          errors: orderErrors { code message field }
        }
      }
    `, {
      id: fulfillmentId,
      input: { trackingNumber, courierId: courierMatch.id },
      isPoLineDeliveryConfirmed: true,
    });

    if (result?.data?.fulfillmentUpdateTracking?.errors?.length > 0) {
      console.log(`[tracking] ⚠️ 송장 업데이트 에러: ${fulfillmentId} → ${JSON.stringify(result.data.fulfillmentUpdateTracking.errors)}`);
      return { success: false, errors: result.data.fulfillmentUpdateTracking.errors };
    }

    console.log(`[tracking] ✅ 송장 즉시 업데이트: ${fulfillmentId} → ${trackingNumber} (${carrier})`);
    return { success: true };
  } catch (e) {
    console.log(`[tracking] ⚠️ 송장 업데이트 실패 (무시): ${fulfillmentId} → ${e.message}`);
    return { success: false, error: e.message };
  }
}

app.post("/api/vendor/tracking", async (req, res) => {
  const { vendors } = req.body;

  // vendors 배열 유효성 검사
  if (!vendors || !Array.isArray(vendors) || vendors.length === 0) {
    return res.status(400).json({
      success: false,
      error: "vendors 배열이 필요합니다",
    });
  }

  // authToken + graphqlUrl 추출
  const authToken = req.headers.authorization || req.body.authToken;
  const graphqlUrl = req.body.graphqlUrl;

  if (graphqlUrl) {
    setGraphQLConfig({ graphqlUrl });
  }

  const immediateUpdate = !!authToken;
  if (immediateUpdate) {
    console.log(`[tracking] 즉시 업데이트 모드`);
  }

  try {
    console.log(`[tracking] 송장 조회 요청: ${vendors.length}개 벤더`);

    const { browser, page } = await getBrowser();
    const trackingResults = [];
    let updatedCount = 0;

    // 각 vendor별로 순차 처리
    for (const v of vendors) {
      const { vendor, openMallOrderNumbers, fulfillmentMap } = v;

      // vendor 유효성 검사
      if (!vendor || !supportedVendors.includes(vendor)) {
        console.log(`[tracking] 지원하지 않는 벤더 스킵: ${vendor}`);
        continue;
      }

      // openMallOrderNumbers 유효성 검사
      if (
        !openMallOrderNumbers ||
        !Array.isArray(openMallOrderNumbers) ||
        openMallOrderNumbers.length === 0
      ) {
        console.log(`[tracking] ${vendor}: openMallOrderNumbers 없음, 스킵`);
        continue;
      }

      const vendorConfig = getVendorByKey(vendor);
      if (!vendorConfig) {
        console.log(`[tracking] ${vendor}: 설정 없음, 스킵`);
        continue;
      }

      console.log(
        `[tracking] ${vendor} 송장 조회: ${openMallOrderNumbers.length}건`,
      );

      // 벤더 전환 전 페이지 초기화 (Frame detach 방지)
      try {
        await page.goto("about:blank", {
          waitUntil: "domcontentloaded",
          timeout: 5000,
        });
        await delay(500);
      } catch (e) {
        console.log(`[tracking] 페이지 초기화 실패, 새 페이지 생성`);
        // 페이지가 완전히 망가진 경우 새 페이지 생성
        pageInstance = await browser.newPage();
        page = pageInstance;
      }

      // 즉시 업데이트 콜백 (1건 찾을 때마다 바로 mutation 호출)
      const onTrackingFound = immediateUpdate ? async (item) => {
        if (!item.trackingNumber || !item.fulfillmentId) return;
        trackingResults.push(item);
        await updateTrackingImmediate(authToken, item.fulfillmentId, item.trackingNumber, item.carrier);
        updatedCount++;
      } : null;

      // 벤더별 tracking 함수 호출 (fulfillmentMap + onTrackingFound 전달)
      const trackingHandler = trackingHandlers[vendor];
      const trackingResponse = await trackingHandler(
        page,
        vendorConfig,
        openMallOrderNumbers,
        fulfillmentMap,
        onTrackingFound,
      );

      // 즉시 업데이트 안 한 경우만 결과 병합
      if (!immediateUpdate) {
        const results = Array.isArray(trackingResponse)
          ? trackingResponse
          : trackingResponse?.results || [];

        for (const r of results) {
          if (!r.trackingNumber) continue;

          if (r.fulfillmentId) {
            trackingResults.push({
              openMallOrderNumber: r.openMallOrderNumber,
              trackingNumber: r.trackingNumber,
              carrier: r.carrier,
              fulfillmentId: r.fulfillmentId,
            });
          } else if (fulfillmentMap?.[r.openMallOrderNumber]) {
            const fm = fulfillmentMap[r.openMallOrderNumber];
            for (const fulfillmentId of (fm.fulfillmentIds || [])) {
              trackingResults.push({
                openMallOrderNumber: r.openMallOrderNumber,
                trackingNumber: r.trackingNumber,
                carrier: r.carrier,
                fulfillmentId,
              });
            }
          }
        }
      }
    }

    console.log(`[tracking] 송장번호 찾음: ${trackingResults.length}건${immediateUpdate ? `, 즉시 업데이트: ${updatedCount}건` : ''}`);

    // 조회 완료 후 브라우저 종료
    console.log("[tracking] 조회 완료, 브라우저 종료");
    await resetBrowser();

    return res.json({
      success: true,
      trackingResults,
    });
  } catch (error) {
    console.error(`[tracking] 에러:`, error);
    // 에러 시에도 브라우저 종료
    await resetBrowser();
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * 지원 벤더 목록 조회
 */
app.get("/api/vendor/tracking/list", (req, res) => {
  res.json({
    success: true,
    vendors: supportedVendors,
  });
});

/**
 * 상태 확인
 */
app.get("/api/vendor/tracking/status", async (req, res) => {
  try {
    const hasBrowser = !!browserInstance;
    res.json({
      success: true,
      status: hasBrowser ? "ready" : "no_browser",
      service: "tracking",
      port: 3001,
      supportedVendors,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 쿠팡 로켓배송 배송완료 자동 처리
 * - n8n에서 GraphQL로 쿠팡 미배송완료 fulfillment 조회 후
 *   { fulfillmentId, trackingNumber } 배열로 전달
 * - 각 송장번호를 coupangls.com에서 조회 → 배송완료건만 bulk mutation 호출
 *
 * Body:
 *   { authToken, graphqlUrl, fulfillments: [{ fulfillmentId, trackingNumber }] }
 */
app.post("/api/coupang/rocket-confirm", async (req, res) => {
  try {
    const { authToken, graphqlUrl, fulfillments } = req.body || {};
    if (!authToken || !graphqlUrl) {
      return res.status(400).json({
        success: false,
        error: "authToken, graphqlUrl 필수",
      });
    }
    if (!Array.isArray(fulfillments)) {
      return res.status(400).json({
        success: false,
        error: "fulfillments 배열 필수",
      });
    }

    const { confirmRocketDeliveries } = require("./lib/coupang-rocket-confirm");
    const summary = await confirmRocketDeliveries({
      authToken,
      graphqlUrl,
      fulfillments,
    });
    res.json({ success: true, summary });
  } catch (error) {
    console.error("[rocket-confirm] API 에러:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 브라우저 리셋
 */
app.post("/api/vendor/tracking/reset", async (req, res) => {
  try {
    await resetBrowser();
    res.json({ success: true, message: "브라우저 리셋 완료" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== 서버 시작 ====================
const PORT = process.env.TRACKING_PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  송장번호 조회 서버 시작`);
  console.log(`  포트: ${PORT}`);
  console.log(`  API: POST /api/vendor/tracking`);
  console.log(`  지원 벤더: ${supportedVendors.join(", ")}`);
  console.log(`========================================\n`);
});
