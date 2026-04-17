/**
 * 쿠팡 로켓배송 배송완료 자동 처리
 *
 * Sweet Tracker가 쿠팡 로켓배송(courier.code="99998")을 지원 안 해서
 * 직접 coupangls.com 페이지를 파싱해서 배송완료 상태 확인 후
 * fulfillmentBulkTrackingCompleted mutation으로 일괄 배송완료 처리.
 *
 * 플로우:
 * 1. n8n이 GraphQL로 쿠팡 미배송완료 fulfillment 목록 조회 (slim query)
 * 2. n8n이 courier.code === "99998" 필터링 후 [{fulfillmentId, trackingNumber}] 배열로 전달
 * 3. 서버에서 각 송장번호 → coupangls.com fetch → "배송완료" 파싱
 * 4. 완료된 fulfillmentId 모아서 bulk mutation 호출
 */

const BULK_TRACKING_COMPLETED_MUTATION = `
  mutation FulfillmentBulkTrackingCompleted($ids: [ID]!) {
    fulfillmentBulkTrackingCompleted(ids: $ids) {
      count
      errors: orderErrors {
        field
        message
        code
      }
    }
  }
`;

const COUPANGLS_URL = "https://www.coupangls.com/web/modal/invoice/";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/**
 * 쿠팡LS 송장 페이지 조회 + 배송완료 여부 파싱
 * @param {string} trackingNumber
 * @returns {Promise<{ok: boolean, delivered: boolean, lastStatus: string|null, error?: string}>}
 */
async function checkDeliveryStatus(trackingNumber) {
  try {
    const res = await fetch(`${COUPANGLS_URL}${trackingNumber}`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return { ok: false, delivered: false, lastStatus: null, error: `HTTP ${res.status}` };
    }
    const html = await res.text();

    // <tbody>...</tbody> 안의 마지막 <tr> 마지막 <td>가 최신 상태
    // 쿠팡LS는 bold로 강조된 현재 상태 row가 항상 마지막
    const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    if (!tbodyMatch) {
      return { ok: false, delivered: false, lastStatus: null, error: "tbody 없음" };
    }
    const tbody = tbodyMatch[1];
    const rows = [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)];
    if (rows.length === 0) {
      return { ok: true, delivered: false, lastStatus: null };
    }
    const lastRow = rows[rows.length - 1][1];
    const tds = [...lastRow.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      m[1].replace(/<[^>]*>/g, "").trim(),
    );
    const lastStatus = tds[tds.length - 1] || null;
    const delivered = lastStatus === "배송완료";
    return { ok: true, delivered, lastStatus };
  } catch (e) {
    return { ok: false, delivered: false, lastStatus: null, error: e.message };
  }
}

/**
 * fulfillmentBulkTrackingCompleted mutation 호출
 * @param {string} authToken
 * @param {string} graphqlUrl
 * @param {string[]} ids - fulfillment ID 배열
 */
async function bulkMarkCompleted(authToken, graphqlUrl, ids) {
  if (!ids.length) return { count: 0, errors: [] };
  const res = await fetch(graphqlUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authToken,
    },
    body: JSON.stringify({
      query: BULK_TRACKING_COMPLETED_MUTATION,
      variables: { ids },
    }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json();
  if (data.errors) {
    throw new Error(`GraphQL 에러: ${JSON.stringify(data.errors)}`);
  }
  return (
    data?.data?.fulfillmentBulkTrackingCompleted || { count: 0, errors: [] }
  );
}

/**
 * 전체 플로우 실행
 * @param {object} params
 * @param {string} params.authToken
 * @param {string} params.graphqlUrl
 * @param {Array<{fulfillmentId: string, trackingNumber: string}>} params.fulfillments
 * @returns {Promise<object>} summary
 */
async function confirmRocketDeliveries({ authToken, graphqlUrl, fulfillments }) {
  const start = Date.now();
  console.log(`[rocket-confirm] 시작: ${fulfillments.length}건`);

  if (!fulfillments.length) {
    return {
      total: 0,
      checked: 0,
      delivered: 0,
      completedCount: 0,
      completedIds: [],
      skipped: [],
      errors: [],
      elapsedMs: 0,
    };
  }

  const delivered = [];
  const skipped = [];
  const errors = [];

  for (const item of fulfillments) {
    const { fulfillmentId, trackingNumber } = item;
    if (!trackingNumber) {
      skipped.push({ fulfillmentId, reason: "trackingNumber 없음" });
      continue;
    }
    const result = await checkDeliveryStatus(trackingNumber);
    if (!result.ok) {
      errors.push({ fulfillmentId, trackingNumber, reason: result.error });
      console.log(
        `[rocket-confirm] ❌ ${trackingNumber} 조회 실패: ${result.error}`,
      );
      continue;
    }
    if (result.delivered) {
      delivered.push({ fulfillmentId, trackingNumber });
      console.log(`[rocket-confirm] ✅ ${trackingNumber} 배송완료`);
    } else {
      skipped.push({
        fulfillmentId,
        trackingNumber,
        reason: `상태: ${result.lastStatus || "(없음)"}`,
      });
    }
  }

  // 배송완료 건 일괄 mutation 호출
  let completedCount = 0;
  let mutationErrors = [];
  if (delivered.length) {
    console.log(
      `[rocket-confirm] 일괄 배송완료 처리: ${delivered.length}건`,
    );
    try {
      const result = await bulkMarkCompleted(
        authToken,
        graphqlUrl,
        delivered.map((d) => d.fulfillmentId),
      );
      completedCount = result.count || 0;
      mutationErrors = result.errors || [];
      console.log(
        `[rocket-confirm] mutation 결과: count=${completedCount}, errors=${mutationErrors.length}`,
      );
    } catch (e) {
      console.error(`[rocket-confirm] mutation 실패: ${e.message}`);
      errors.push({ reason: `bulk mutation 실패: ${e.message}` });
    }
  }

  const summary = {
    total: fulfillments.length,
    checked: fulfillments.length - skipped.filter((s) => s.reason === "trackingNumber 없음").length,
    delivered: delivered.length,
    completedCount,
    completedIds: delivered.map((d) => d.fulfillmentId),
    skipped,
    errors: [...errors, ...mutationErrors],
    elapsedMs: Date.now() - start,
  };

  console.log(
    `[rocket-confirm] 완료: total=${summary.total}, delivered=${summary.delivered}, completed=${summary.completedCount}, skipped=${summary.skipped.length}, errors=${summary.errors.length} (${summary.elapsedMs}ms)`,
  );

  return summary;
}

module.exports = {
  confirmRocketDeliveries,
  checkDeliveryStatus,
  bulkMarkCompleted,
};
