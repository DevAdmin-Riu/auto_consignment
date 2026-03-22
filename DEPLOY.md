# 배포 가이드 (백엔드 → n8n 순서)

## 백엔드 배포 후 n8n에서 해야 할 작업

### 1. `createPaymentLogs` (openMallPaymentLogBulkCreate)

**현재 상태 (배포 전 호환):**
- `vendor` 필드 포함 (필수) ← 배포 후 제거
- `openMallOrderNumber` 주석 처리 ← 배포 후 활성화
- `paymentCard` 주석 처리 ← 배포 후 활성화

**배포 후 작업:**

`lib/graphql-client.js` 에서 `TODO:DEPLOY` 검색 후:

```javascript
// 변경 전 (현재)
const input = payments.map((p) => ({
  vendor: p.vendor || "",                    // ← 제거
  purchaseOrderId: p.purchaseOrderId || null,
  // openMallOrderNumber: p.openMallOrderNumber || null,  // ← 주석 해제
  paymentAmount: p.paymentAmount,
  // paymentCard: p.paymentCard || null,                  // ← 주석 해제
}));

// 변경 후
const input = payments.map((p) => ({
  purchaseOrderId: p.purchaseOrderId || null,
  openMallOrderNumber: p.openMallOrderNumber || null,
  paymentAmount: p.paymentAmount,
  paymentCard: p.paymentCard || null,
}));
```

### 2. `createPriceMismatches` (openMallPriceMismatchBulkCreate)

`lib/graphql-client.js` 에서 `TODO:DEPLOY` 검색 후:

```javascript
// 변경 전 (현재)
// openMallOrderNumber: p.openMallOrderNumber || "",  // ← 주석 해제

// 변경 후
openMallOrderNumber: p.openMallOrderNumber || "",
```

### 3. 각 벤더 `vendor` 필드 제거

`TODO:DEPLOY` 로 전체 검색하면 6개 벤더에서 찾을 수 있음:

- `vendors/baemin/order.js` — `vendor: "baemin"`
- `vendors/naver/order.js` — `vendor: "naver"`
- `vendors/coupang/order.js` — `vendor: "coupang"`
- `vendors/adpia/order.js` — `vendor: "adpia"`
- `vendors/napkin/order.js` — `vendor: "napkin"`
- `vendors/swadpia/order.js` — `vendor: "swadpia"`

각 파일에서 `vendor: "...",  // TODO:DEPLOY - 배포 후 제거` 라인 삭제.

## 요약

| 순서 | 작업 | 위치 |
|------|------|------|
| 1 | 백엔드 배포 | 서버 |
| 2 | graphql-client.js `TODO:DEPLOY` 3곳 수정 | lib/graphql-client.js |
| 3 | 6개 벤더 `vendor` 라인 제거 | vendors/*/order.js |
| 4 | 커밋 + 푸시 + PM2 재시작 | |
| 5 | n8n 스케줄 Active | n8n UI |
