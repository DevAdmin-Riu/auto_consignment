/**
 * GraphQL 클라이언트 모듈
 *
 * Automation에서 직접 백엔드 mutation 호출용
 * - 주문번호 업데이트
 * - 가격 불일치 저장
 * - 옵션 불일치 저장
 * - 에러 로그 저장
 * - 담당자 확인 필요 저장
 * - 대행접수/출고처리
 */

const { getEnv } = require("../vendors/config");

// setConfig로 설정된 URL (우선순위 높음)
let _configuredUrl = null;

/**
 * GraphQL 설정 (GRAPHQL_URL 등)
 * @param {Object} config - { graphqlUrl }
 */
function setConfig(config) {
  if (config.graphqlUrl) {
    _configuredUrl = config.graphqlUrl;
  }
}

/**
 * GraphQL URL 동적으로 가져오기
 * host.docker.internal → localhost 변환 (로컬 실행 시)
 */
function getGraphQLUrl() {
  let url = _configuredUrl || getEnv("GRAPHQL_URL") || null;
  if (url && url.includes("host.docker.internal")) {
    url = url.replace("host.docker.internal", "localhost");
  }
  return url;
}

async function callGraphQL(authToken, query, variables = {}) {
  const graphqlUrl = getGraphQLUrl();

  if (!graphqlUrl) {
    console.error(
      "[GraphQL] GRAPHQL_URL이 설정되지 않았습니다. setConfig() 또는 환경변수를 확인하세요."
    );
    return null;
  }

  try {
    console.log("[GraphQL] 요청 URL:", graphqlUrl);
    console.log("[GraphQL] authToken 존재:", !!authToken);

    const response = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    const data = await response.json();

    if (data.errors) {
      console.error("[GraphQL] 에러:", JSON.stringify(data.errors));
    }

    return data;
  } catch (error) {
    console.error("[GraphQL] 요청 실패:", error.message);
    console.error("[GraphQL] 에러 상세:", error);
    return null;
  }
}

/**
 * 오픈몰 주문번호 업데이트
 * @param {string} authToken
 * @param {Array} products - [{ orderLineId 또는 orderLineIds, openMallOrderNumber }, ...]
 */
async function updateOpenMallOrderNumbers(authToken, products) {
  console.log(
    "[GraphQL] 주문번호 업데이트 입력:",
    JSON.stringify(products, null, 2)
  );

  const input = [];

  for (const p of products) {
    if (!p.openMallOrderNumber) continue;

    // orderLineIds (배열) 또는 orderLineId (단일) 처리
    const lineIds = p.orderLineIds || (p.orderLineId ? [p.orderLineId] : []);

    for (const orderLineId of lineIds) {
      input.push({
        orderLineId,
        openMallOrderNumber: p.openMallOrderNumber,
      });
    }
  }

  if (input.length === 0) {
    console.log(
      "[GraphQL] 업데이트할 주문번호 없음 - orderLineId(s) 또는 openMallOrderNumber가 없음"
    );
    console.log(
      "[GraphQL] products 상세:",
      products.map((p) => ({
        orderLineId: p.orderLineId,
        orderLineIds: p.orderLineIds,
        openMallOrderNumber: p.openMallOrderNumber,
      }))
    );
    return null;
  }

  console.log(`[GraphQL] 주문번호 업데이트: ${input.length}건`);

  const query = `
    mutation OrderLineBulkUpdateOpenMallOrderNumber($input: [OrderLineBulkUpdateOpenMallOrderNumberInput!]!) {
      orderLineBulkUpdateOpenMallOrderNumber(input: $input) {
        orderErrors {
          field
          message
        }
      }
    }
  `;

  return callGraphQL(authToken, query, { input });
}

/**
 * 가격 불일치 저장
 * @param {string} authToken
 * @param {string} purchaseOrderId
 * @param {Array} mismatches - [{ productVariantVendorId, vendorPriceExcludeVat, openMallPrice }, ...]
 */
async function createPriceMismatches(authToken, purchaseOrderId, mismatches) {
  const input = mismatches
    .filter((p) => p.productVariantVendorId)
    .map((p) => ({
      productVariantVendorId: p.productVariantVendorId,
      purchaseOrderId: purchaseOrderId,
      vendorPriceExcludeVat: p.vendorPriceExcludeVat || 0,
      openMallPrice: p.openMallPrice || 0,
    }));

  if (input.length === 0) {
    console.log("[GraphQL] 저장할 가격 불일치 없음");
    return null;
  }

  console.log(`[GraphQL] 가격 불일치 저장: ${input.length}건`);

  const query = `
    mutation OpenMallPriceMismatchBulkCreate($input: [OpenMallPriceMismatchBulkCreateInput!]!) {
      openMallPriceMismatchBulkCreate(input: $input) {
        createdCount
        productErrors {
          field
          message
        }
      }
    }
  `;

  return callGraphQL(authToken, query, { input });
}

/**
 * 옵션 불일치 저장
 * @param {string} authToken
 * @param {string} purchaseOrderId
 * @param {Array} mismatches - [{ productVariantVendorId, reason }, ...]
 */
async function createOptionsMismatches(authToken, purchaseOrderId, mismatches) {
  const input = mismatches
    .filter((p) => p.productVariantVendorId)
    .map((p) => ({
      productVariantVendorId: p.productVariantVendorId,
      purchaseOrderId: purchaseOrderId,
      reason: p.reason || "옵션 선택 실패",
    }));

  if (input.length === 0) {
    console.log("[GraphQL] 저장할 옵션 불일치 없음");
    return null;
  }

  console.log(`[GraphQL] 옵션 불일치 저장: ${input.length}건`);

  const query = `
    mutation OpenMallOptionsMismatchBulkCreate($input: [OpenMallOptionsMismatchBulkCreateInput!]!) {
      openMallOptionsMismatchBulkCreate(input: $input) {
        createdCount
        productErrors {
          field
          message
        }
      }
    }
  `;

  return callGraphQL(authToken, query, { input });
}

/**
 * 자동화 에러 로그 저장
 * @param {string} authToken
 * @param {Array} errors - AutomationErrorCollector.getErrors() 결과
 */
async function createAutomationErrors(authToken, errors) {
  if (!errors || errors.length === 0) {
    console.log("[GraphQL] 저장할 에러 로그 없음");
    return null;
  }

  console.log(`[GraphQL] 에러 로그 저장: ${errors.length}건`);

  const query = `
    mutation AutomationErrorLogBulkCreate($input: [AutomationErrorLogBulkCreateInput!]!) {
      automationErrorLogBulkCreate(input: $input) {
        createdCount
        productErrors {
          field
          message
        }
      }
    }
  `;

  return callGraphQL(authToken, query, { input: errors });
}

/**
 * 담당자 확인 필요 상품 저장
 * @param {string} authToken
 * @param {Array} items - [{ productVariantVendorId, purchaseOrderId, reason }, ...]
 */
async function createNeedsManagerVerification(authToken, items) {
  const input = items
    .filter((p) => p.productVariantVendorId)
    .map((p) => ({
      productVariantVendorId: p.productVariantVendorId,
      purchaseOrderId: p.purchaseOrderId || null,
      reason: p.reason || "담당자 확인 필요",
    }));

  if (input.length === 0) {
    console.log("[GraphQL] 저장할 담당자 확인 필요 항목 없음");
    return null;
  }

  console.log(`[GraphQL] 담당자 확인 필요 저장: ${input.length}건`);

  const query = `
    mutation OpenMallNeedsManagerVerificationBulkCreate($input: [OpenMallNeedsManagerVerificationBulkCreateInput!]!) {
      openMallNeedsManagerVerificationBulkCreate(input: $input) {
        createdCount
        productErrors {
          field
          message
        }
      }
    }
  `;

  return callGraphQL(authToken, query, { input });
}

/**
 * 대행접수 처리 (PurchaseOrderLinesReceive)
 * @param {string} authToken
 * @param {Array} purchaseOrderLineIds - 처리할 발주 라인 ID 배열
 */
async function receivePurchaseOrderLines(authToken, purchaseOrderLineIds) {
  if (!purchaseOrderLineIds || purchaseOrderLineIds.length === 0) {
    console.log("[GraphQL] 대행접수할 라인 없음");
    return null;
  }

  console.log(`[GraphQL] 대행접수 처리: ${purchaseOrderLineIds.length}건`);

  const query = `
    mutation PurchaseOrderLinesReceive($purchaseOrderLineIds: [ID]!) {
      purchaseOrderLinesReceive(purchaseOrderLineIds: $purchaseOrderLineIds) {
        errors: purchaseOrderErrors {
          code
          message
          field
        }
      }
    }
  `;

  return callGraphQL(authToken, query, { purchaseOrderLineIds });
}

/**
 * 출고 대상 주문 라인 조회
 * @param {string} authToken
 */
async function queryOrderLinesForFulfill(authToken) {
  console.log("[GraphQL] 출고 대상 주문 라인 조회...");

  const query = `
    fragment PageInfoFragment on PageInfo {
      endCursor
      hasNextPage
    }

    query OrderLineListForFulfill($first: Int, $filter: OrderLineFilterInput, $sort: OrderLineSortingInput) {
      orderLines(first: $first, filter: $filter, sortBy: $sort) {
        edges {
          node {
            id
            orderedOrFulfillQty
            order {
              id
            }
          }
        }
        pageInfo {
          ...PageInfoFragment
        }
      }
    }
  `;

  const variables = {
    first: 500,
    filter: {
      orderStatus: ["READY_TO_FULFILL_PLUS_BEING_APPROVED"],
      orderType: [
        "BY_STAFF_FOR_BAD_STOCK",
        "BY_STAFF_FOR_BRAND",
        "BY_HQ_STAFF_FOR_BRAND",
        "BY_STAFF_FOR_ETC",
        "BY_USER",
      ],
      useDelegatedManagementForPo: true,
      purchaseOrderEventType: ["CONSIGNMENT", "CONSIGNMENT_TAKE_BACK"],
      deliveryMethods: ["BY_COURIER"],
      existPurchaseOrderLine: true,
      fulfilled: false,
      purchaseOrderLineStatus: ["RECEIVED"],
      isAdjustPrice: false,
      isB2b: false,
      isFulfilledByVendor: false,
    },
    sort: {
      direction: "DESC",
      field: "NUMBER",
    },
  };

  return callGraphQL(authToken, query, variables);
}

/**
 * 출고 처리 (FulfillOrderBulk)
 * @param {string} authToken
 * @param {Array} ordersToFulfill - [{ orderId, input: { lines: [{ orderLineId, stocks: [{ quantity }] }], isFulfilledByVendor } }]
 */
async function fulfillOrderBulk(authToken, ordersToFulfill) {
  if (!ordersToFulfill || ordersToFulfill.length === 0) {
    console.log("[GraphQL] 출고 처리할 주문 없음");
    return null;
  }

  console.log(`[GraphQL] 출고 처리: ${ordersToFulfill.length}건`);

  const query = `
    mutation FulfillOrderBulk($ordersToFulfill: [OrderFulfillBulkInput]!) {
      orderFulfillBulk(ordersToFulfill: $ordersToFulfill) {
        errors: orderErrors {
          code
          message
          field
          warehouse
          orderLine
        }
      }
    }
  `;

  return callGraphQL(authToken, query, { ordersToFulfill });
}

/**
 * 출고 처리 전체 플로우 (조회 → 변환 → 출고)
 * @param {string} authToken
 */
async function processFulfillment(authToken) {
  console.log("[GraphQL] 출고 처리 플로우 시작...");

  // 1. 출고 대상 조회
  const queryResult = await queryOrderLinesForFulfill(authToken);

  if (!queryResult?.data?.orderLines?.edges?.length) {
    console.log("[GraphQL] 출고 대상 없음");
    return null;
  }

  const edges = queryResult.data.orderLines.edges;
  console.log(`[GraphQL] 출고 대상: ${edges.length}건`);

  // 2. orderId별로 그룹핑
  const orderMap = new Map();

  for (const edge of edges) {
    const node = edge.node;
    const orderId = node.order.id;
    const orderLineId = node.id;
    const quantity = node.orderedOrFulfillQty;

    if (!orderMap.has(orderId)) {
      orderMap.set(orderId, []);
    }

    orderMap.get(orderId).push({
      orderLineId,
      stocks: [{ quantity }],
    });
  }

  // 3. FulfillOrderBulk 형식으로 변환
  const ordersToFulfill = [];
  for (const [orderId, lines] of orderMap) {
    ordersToFulfill.push({
      orderId,
      input: {
        lines,
        isFulfilledByVendor: false,
      },
    });
  }

  // 4. 출고 처리
  return fulfillOrderBulk(authToken, ordersToFulfill);
}

/**
 * 그룹 처리 완료 후 모든 mutation 일괄 호출
 * @param {string} authToken
 * @param {Object} data - 처리 결과 데이터
 */
async function saveOrderResults(authToken, data) {
  const {
    purchaseOrderId,
    products = [],
    priceMismatches = [],
    optionFailedProducts = [],
    automationErrors = [],
    lineIds = [], // 대행접수용 발주 라인 ID
    success = false, // 주문 성공 여부
  } = data;

  console.log(`[GraphQL] 주문 결과 저장 시작... (success: ${success})`);

  const summary = {
    orderNumbers: "SKIP",
    priceMismatch: "SKIP",
    optionsMismatch: "SKIP",
    errorLogs: "SKIP",
    receive: "SKIP",
    fulfill: "SKIP",
  };

  if (success) {
    // ============================================
    // 성공 시: 주문번호 + 가격불일치 (병렬) → 대행접수 → 출고처리 (순차)
    // ============================================

    // 1단계: 주문번호 업데이트 + 가격 불일치 저장 (병렬)
    const successResults = await Promise.allSettled([
      updateOpenMallOrderNumbers(authToken, products),
      createPriceMismatches(authToken, purchaseOrderId, priceMismatches),
    ]);

    summary.orderNumbers =
      successResults[0].status === "fulfilled" ? "OK" : "FAIL";
    summary.priceMismatch =
      successResults[1].status === "fulfilled" ? "OK" : "FAIL";

    // 2단계: 대행접수 → 출고처리 (순차)
    if (lineIds.length > 0) {
      try {
        // 대행접수
        const receiveResult = await receivePurchaseOrderLines(
          authToken,
          lineIds
        );
        summary.receive = receiveResult ? "OK" : "FAIL";

        // 출고처리 (대행접수 성공 후)
        if (summary.receive === "OK") {
          const fulfillResult = await processFulfillment(authToken);
          summary.fulfill = fulfillResult ? "OK" : "FAIL";
        }
      } catch (err) {
        console.error("[GraphQL] 대행접수/출고처리 에러:", err.message);
        summary.receive = "FAIL";
        summary.fulfill = "FAIL";
      }
    }
  } else {
    // ============================================
    // 실패 시: 옵션 불일치 + 에러 로그 (병렬)
    // ============================================

    const failResults = await Promise.allSettled([
      createOptionsMismatches(authToken, purchaseOrderId, optionFailedProducts),
      createAutomationErrors(authToken, automationErrors),
    ]);

    summary.optionsMismatch =
      failResults[0].status === "fulfilled" ? "OK" : "FAIL";
    summary.errorLogs = failResults[1].status === "fulfilled" ? "OK" : "FAIL";
  }

  console.log("[GraphQL] 저장 완료:", JSON.stringify(summary));

  return summary;
}

module.exports = {
  setConfig,
  callGraphQL,
  updateOpenMallOrderNumbers,
  createPriceMismatches,
  createOptionsMismatches,
  createAutomationErrors,
  createNeedsManagerVerification,
  receivePurchaseOrderLines,
  processFulfillment,
  saveOrderResults,
};
