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
      "[GraphQL] GRAPHQL_URL이 설정되지 않았습니다. setConfig() 또는 환경변수를 확인하세요.",
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
    JSON.stringify(products, null, 2),
  );

  const input = [];

  for (const p of products) {
    if (!p.openMallOrderNumber) continue;

    // orderLineIds (배열) 또는 orderLineId (단일) 처리
    const orderLineIdList =
      p.orderLineIds || (p.orderLineId ? [p.orderLineId] : []);

    for (const orderLineId of orderLineIdList) {
      input.push({
        orderLineId,
        openMallOrderNumber: p.openMallOrderNumber,
      });
    }
  }

  if (input.length === 0) {
    console.log(
      "[GraphQL] 업데이트할 주문번호 없음 - orderLineId(s) 또는 openMallOrderNumber가 없음",
    );
    console.log(
      "[GraphQL] products 상세:",
      products.map((p) => ({
        orderLineId: p.orderLineId,
        orderLineIds: p.orderLineIds,
        openMallOrderNumber: p.openMallOrderNumber,
      })),
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

  const result = await callGraphQL(authToken, query, { input });
  const orderErrors =
    result?.data?.orderLineBulkUpdateOpenMallOrderNumber?.orderErrors;
  if (orderErrors && orderErrors.length > 0) {
    console.error(
      "[GraphQL] 주문번호 업데이트 orderErrors:",
      JSON.stringify(orderErrors),
    );
  }
  return result;
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
    .filter((p) => {
      // 가격 차이 체크 (VAT 포함 기준으로 통일해서 비교)
      const vendorPriceWithVat = Math.round((p.vendorPriceExcludeVat || 0) * 1.1);
      const openMallPrice = p.openMallPrice || 0;
      const diff = Math.abs(vendorPriceWithVat - openMallPrice);
      if (diff <= 10) { // 10원 이하 차이는 반올림 오차 → 불일치 아님
        console.log(`[GraphQL] 가격 차이 ${diff}원 (≤10원) → 불일치 제외: ${p.productVariantVendorId} (협력사VAT포함=${vendorPriceWithVat}, 오픈몰=${openMallPrice})`);
        return false;
      }
      return true;
    })
    .map((p) => ({
      productVariantVendorId: p.productVariantVendorId,
      purchaseOrderId: purchaseOrderId,
      vendorPriceExcludeVat: p.vendorPriceExcludeVat || 0,
      openMallPrice: p.openMallPrice || 0,
      // openMallOrderNumber: p.openMallOrderNumber || "",  // TODO:DEPLOY - 배포 후 활성화
    }));

  if (input.length === 0) {
    console.log("[GraphQL] 저장할 가격 불일치 없음");
    return null;
  }

  console.log(
    `[GraphQL] 가격 불일치 저장: ${input.length}건`,
    JSON.stringify(input),
  );

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

  const result = await callGraphQL(authToken, query, { input });
  const productErrors =
    result?.data?.openMallPriceMismatchBulkCreate?.productErrors;
  if (productErrors && productErrors.length > 0) {
    console.error(
      "[GraphQL] 가격 불일치 저장 productErrors:",
      JSON.stringify(productErrors),
    );
  } else {
    const createdCount =
      result?.data?.openMallPriceMismatchBulkCreate?.createdCount;
    console.log(`[GraphQL] 가격 불일치 저장 완료: ${createdCount}건 생성`);
  }
  return result;
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

  console.log(
    `[GraphQL] 옵션 불일치 저장: ${input.length}건`,
    JSON.stringify(input),
  );

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

  const result = await callGraphQL(authToken, query, { input });
  const productErrors =
    result?.data?.openMallOptionsMismatchBulkCreate?.productErrors;
  if (productErrors && productErrors.length > 0) {
    console.error(
      "[GraphQL] 옵션 불일치 저장 productErrors:",
      JSON.stringify(productErrors),
    );
  } else {
    const createdCount =
      result?.data?.openMallOptionsMismatchBulkCreate?.createdCount;
    console.log(`[GraphQL] 옵션 불일치 저장 완료: ${createdCount}건 생성`);
  }
  return result;
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
 * 예상 결제금액 계산 (부가세 포함)
 * @param {Array} products - [{ costPriceExcludeVat, quantity }, ...]
 * @returns {number} 예상 결제금액 (VAT 포함)
 */
function calculateExpectedPaymentAmount(products) {
  return products.reduce((sum, p) => {
    return (
      sum + Math.round((p.costPriceExcludeVat || 0) * 1.1) * (p.quantity || 1)
    );
  }, 0);
}

/**
 * 결제 로그 저장
 * @param {string} authToken
 * @param {Array} payments - [{ vendor, paymentAmount, expectedAmount, purchaseOrderId, orderLineId, note }, ...]
 */
async function createPaymentLogs(authToken, payments) {
  if (!payments || payments.length === 0) {
    console.log("[GraphQL] 저장할 결제 로그 없음");
    return null;
  }

  // TODO:DEPLOY - 백엔드 배포 후 vendor 제거, paymentCard/openMallOrderNumber 활성화
  const input = payments
    .map((p) => ({
      vendor: p.vendor || "",  // 배포 전 필수 → 배포 후 제거
      purchaseOrderId: p.purchaseOrderId || null,
      // openMallOrderNumber: p.openMallOrderNumber || null,  // 배포 후 활성화
      paymentAmount: p.paymentAmount,
      // paymentCard: p.paymentCard || null,  // 배포 후 활성화
    }));

  if (input.length === 0) {
    console.log("[GraphQL] 유효한 결제 로그 없음 (금액 0 또는 누락)");
    return null;
  }

  console.log(
    `[GraphQL] 결제 로그 저장: ${input.length}건, 총액: ${input.reduce(
      (sum, p) => sum + p.paymentAmount,
      0,
    )}원, 카드: ${input[0]?.paymentCard || "미지정"}`,
  );

  const query = `
    mutation OpenMallPaymentLogBulkCreate($input: [OpenMallPaymentLogBulkCreateInput!]!) {
      openMallPaymentLogBulkCreate(input: $input) {
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
async function processFulfillment(authToken, targetOrderLineIds = []) {
  console.log("[GraphQL] 출고 처리 플로우 시작...");

  // 1. 출고 대상 조회
  const queryResult = await queryOrderLinesForFulfill(authToken);

  if (!queryResult?.data?.orderLines?.edges?.length) {
    console.log("[GraphQL] 출고 대상 없음");
    return null;
  }

  let edges = queryResult.data.orderLines.edges;

  // targetOrderLineIds가 있으면 해당 건만 필터
  if (targetOrderLineIds.length > 0) {
    const targetSet = new Set(targetOrderLineIds);
    edges = edges.filter((edge) => targetSet.has(edge.node.id));
    console.log(
      `[GraphQL] 출고 대상: 전체 ${queryResult.data.orderLines.edges.length}건 중 이번 주문 ${edges.length}건만 처리`,
    );
  } else {
    console.log(`[GraphQL] 출고 대상: ${edges.length}건 (전체)`);
  }

  if (edges.length === 0) {
    console.log("[GraphQL] 필터 후 출고 대상 없음");
    return null;
  }

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
      b2bDeliveryFeeExcludeVat: 0,
    });
  }

  // 3. FulfillOrderBulk 형식으로 변환
  // 위탁 출고: 각 상품을 1개씩 별도 Fulfillment로 처리 (개별 송장번호 부여 필요)
  const ordersToFulfill = [];
  for (const [orderId, lines] of orderMap) {
    for (const line of lines) {
      const quantity = line.stocks[0].quantity;

      // 수량만큼 반복해서 1개씩 출고 처리
      for (let i = 0; i < quantity; i++) {
        ordersToFulfill.push({
          orderId,
          input: {
            lines: [
              {
                orderLineId: line.orderLineId,
                stocks: [{ quantity: 1 }],
              },
            ],
            isFulfilledByVendor: false,
          },
        });
      }
    }
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
    poLineIds = [], // 대행접수용 PurchaseOrderLine ID 배열
    success = false, // 주문 성공 여부
    vendor = null, // 협력사명 (에러 로그용)
  } = data;

  console.log(`[GraphQL] 주문 결과 저장 시작... (success: ${success})`);

  // 디버그: 전달받은 데이터 구조 확인
  console.log(
    `[GraphQL] DEBUG products 구조:`,
    JSON.stringify(
      products.map((p) => ({
        orderLineIds: p.orderLineIds,
        orderLineId: p.orderLineId,
        openMallOrderNumber: p.openMallOrderNumber,
      })),
    ),
  );

  const summary = {
    orderNumbers: "SKIP",
    priceMismatch: "SKIP",
    optionsMismatch: "SKIP",
    errorLogs: "SKIP",
    receive: "SKIP",
    fulfill: "SKIP",
  };

  // ============================================
  // 주문번호 누락 체크 (성공한 주문에서만 — 실패 시 주문번호 없는 건 당연하므로 스킵)
  // ============================================
  const missingOrderNumberProducts = success
    ? products.filter(
        (p) =>
          (p.orderLineIds?.length > 0 || p.orderLineId) &&
          !p.openMallOrderNumber,
      )
    : [];

  if (missingOrderNumberProducts.length > 0) {
    console.log(
      `[GraphQL] ⚠️ 주문번호 누락 상품 ${missingOrderNumberProducts.length}건 발견 - 자동화 에러로 기록`,
    );

    const missingOrderNumberErrors = missingOrderNumberProducts.map(
      (p) => ({
        vendor: vendor,
        automationType: "ORDER",
        step: "ORDER_CONFIRMATION",
        errorCode: "ORDER_NUMBER_MISSING",
        errorMessage: `주문번호 누락: orderLineIds=${JSON.stringify(
          (p.orderLineIds || [p.orderLineId])
            .filter(Boolean)
            .map((id) => {
              try {
                return Buffer.from(id, "base64").toString("utf-8");
              } catch {
                return id;
              }
            }),
        )}`,
        purchaseOrderId,
        purchaseOrderLineId:
          p.orderLineIds?.[0] || p.orderLineId || null,
        productVariantVendorId: p.productVariantVendorId || null,
      }),
    );

    automationErrors.push(...missingOrderNumberErrors);
  }

  // 유효한 products만 필터링 (openMallOrderNumber가 있는 것만)
  const validProducts = products.filter((p) => p.openMallOrderNumber);

  if (success) {
    // ============================================
    // 성공 시: 주문번호 + 가격불일치 (병렬) → 대행접수 → 출고처리 (순차)
    // ============================================

    // priceMismatches에 openMallOrderNumber + openMallQtyPerUnit 매핑
    if (priceMismatches.length > 0 && products.length > 0) {
      const orderNumber = products[0]?.openMallOrderNumber || "";
      for (const pm of priceMismatches) {
        const matched = products.find(p => p.productVariantVendorId === pm.productVariantVendorId);
        if (!pm.openMallOrderNumber) {
          pm.openMallOrderNumber = matched?.openMallOrderNumber || orderNumber;
        }
        // 오픈몰 배수주문 적용: openMallPrice × qtyPerUnit
        const qtyPerUnit = matched?.openMallQtyPerUnit || pm.openMallQtyPerUnit || 1;
        if (qtyPerUnit > 1 && pm.openMallPrice) {
          console.log(`[GraphQL] 가격 불일치 배수주문 적용: ${pm.openMallPrice}원 × ${qtyPerUnit} = ${pm.openMallPrice * qtyPerUnit}원`);
          pm.openMallPrice = pm.openMallPrice * qtyPerUnit;
          pm.vendorPriceExcludeVat = (pm.vendorPriceExcludeVat || 0) * qtyPerUnit;
        }
      }
    }

    // 1단계: 주문번호 업데이트 + 가격 불일치 저장 (병렬)
    const successResults = await Promise.allSettled([
      updateOpenMallOrderNumbers(authToken, validProducts), // 유효한 products만
      createPriceMismatches(authToken, purchaseOrderId, priceMismatches),
    ]);

    summary.orderNumbers =
      successResults[0].status === "fulfilled" ? "OK" : "FAIL";
    summary.priceMismatch =
      successResults[1].status === "fulfilled" ? "OK" : "FAIL";

    // 주문번호 누락 에러가 있으면 에러 로그도 저장
    if (missingOrderNumberProducts.length > 0) {
      const errorResult = await createAutomationErrors(
        authToken,
        automationErrors,
      );
      summary.errorLogs = errorResult ? "OK" : "FAIL";
    }

    // 2단계: 대행접수 → 출고처리 (순차)
    // 주문번호가 없는 상품의 poLineIds는 대행접수/출고처리에서 제외
    let poLineIdsToProcess = poLineIds;
    let excludeCount = 0;

    // 디버그: 필터링 전 상태 확인
    console.log(
      `[GraphQL] DEBUG products count: ${products.length}, poLineIds count: ${poLineIds.length}`,
    );
    console.log(
      `[GraphQL] DEBUG missingOrderNumberProducts count: ${missingOrderNumberProducts.length}`,
    );

    if (missingOrderNumberProducts.length > 0) {
      if (products.length === poLineIds.length) {
        // 방법 1: products와 poLineIds 길이가 같으면 인덱스 기반 매칭
        const missingProductIndices = [];
        products.forEach((p, index) => {
          if (
            (p.orderLineIds?.length > 0 || p.orderLineId) &&
            !p.openMallOrderNumber
          ) {
            missingProductIndices.push(index);
          }
        });
        poLineIdsToProcess = poLineIds.filter(
          (_, index) => !missingProductIndices.includes(index),
        );
        excludeCount = missingProductIndices.length;
        console.log(
          `[GraphQL] DEBUG (인덱스 매칭) missingProductIndices:`,
          JSON.stringify(missingProductIndices),
        );
      } else if (products.length === 1 && !products[0].openMallOrderNumber) {
        // 방법 2: 개별 상품 처리 - 단일 상품이고 주문번호 없으면 전체 제외
        poLineIdsToProcess = [];
        excludeCount = poLineIds.length;
        console.log(
          `[GraphQL] DEBUG (개별처리) 단일 상품 주문번호 누락 - 전체 제외`,
        );
      } else if (products.length === 0) {
        // 방법 3: products가 비어있으면 전체 제외 (실패한 경우)
        poLineIdsToProcess = [];
        excludeCount = poLineIds.length;
        console.log(`[GraphQL] DEBUG (개별처리) products 비어있음 - 전체 제외`);
      } else {
        // 방법 4: 그 외 - 주문번호 있는 상품 수 기준으로 처리
        const validCount = products.filter((p) => p.openMallOrderNumber).length;
        poLineIdsToProcess = poLineIds.slice(0, validCount);
        excludeCount = poLineIds.length - validCount;
        console.log(
          `[GraphQL] DEBUG (기타) validCount: ${validCount}, 앞에서 ${validCount}개만 처리`,
        );
      }
    }

    console.log(
      `[GraphQL] 대행접수 대상: 전체 ${poLineIds.length}건, 유효 ${poLineIdsToProcess.length}건, 제외 ${excludeCount}건`,
    );

    if (poLineIdsToProcess.length > 0) {
      try {
        // 대행접수
        const receiveResult = await receivePurchaseOrderLines(
          authToken,
          poLineIdsToProcess,
        );
        summary.receive = receiveResult ? "OK" : "FAIL";

        // 출고처리 (대행접수 성공 후) - 이번 주문의 orderLineIds만 출고
        if (summary.receive === "OK") {
          const allOrderLineIds = products.flatMap(
            (p) => p.orderLineIds || (p.orderLineId ? [p.orderLineId] : []),
          );
          const fulfillResult = await processFulfillment(
            authToken,
            allOrderLineIds,
          );
          summary.fulfill = fulfillResult ? "OK" : "FAIL";
        }
      } catch (err) {
        console.error("[GraphQL] 대행접수/출고처리 에러:", err.message);
        summary.receive = "FAIL";
        summary.fulfill = "FAIL";
      }
    } else if (poLineIds.length > 0 && poLineIdsToProcess.length === 0) {
      console.log(
        "[GraphQL] ⚠️ 모든 상품의 주문번호가 누락되어 대행접수/출고처리 스킵",
      );
      summary.receive = "SKIP_NO_ORDER_NUMBER";
      summary.fulfill = "SKIP_NO_ORDER_NUMBER";
    }
  } else {
    // ============================================
    // 실패 시: 옵션 불일치 → 담당자 확인 필요 + 에러 로그 (병렬)
    // ============================================

    // 옵션 실패 → createNeedsManagerVerification으로 전환
    const optionVerificationItems = (optionFailedProducts || [])
      .filter(p => p.productVariantVendorId)
      .map(p => ({
        productVariantVendorId: p.productVariantVendorId,
        purchaseOrderId: purchaseOrderId,
        reason: p.reason || "옵션 선택 실패",
      }));

    const failResults = await Promise.allSettled([
      optionVerificationItems.length > 0
        ? createNeedsManagerVerification(authToken, optionVerificationItems)
        : Promise.resolve(null),
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
  createPaymentLogs,
  calculateExpectedPaymentAmount,
  receivePurchaseOrderLines,
  processFulfillment,
  saveOrderResults,
};
