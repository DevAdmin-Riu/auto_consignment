# Vendor Automation Project Instructions

## 중요 규칙 (CRITICAL RULES)

### Git 관련
- **자동 커밋/푸시 금지**: 커밋이나 푸시는 반드시 사용자가 명시적으로 요청할 때만 수행
- 커밋 전 항상 사용자 확인 필요

### 코드 작성 규칙
- `orderLineIds` (배열) 사용: n8n에서 `orderLineIds` 배열로 전달하므로, `orderLineId` (단수) 대신 `orderLineIds` 사용
- GraphQL mutation 호출 시 항상 에러 핸들링 포함

## 프로젝트 구조

```
vendor-automation/
├── server.js                 # 메인 서버
├── lib/
│   ├── browser.js           # Puppeteer 브라우저 관리
│   └── graphql-client.js    # GraphQL 클라이언트 (Saleor 백엔드 연동)
└── vendors/
    ├── config.js            # 협력사 설정
    ├── naver/               # 네이버 스마트스토어
    ├── coupang/             # 쿠팡
    ├── napkin/              # 냅킨코리아
    ├── baemin/              # 배민상회
    ├── swadpia/             # 성원애드피아
    └── adpia/               # 애드피아
```

## graphql-client.js 주요 함수

### 개별 Mutation 함수

| 함수 | 용도 |
|------|------|
| `updateOpenMallOrderNumbers` | 주문번호 업데이트 |
| `createPriceMismatches` | 가격 불일치 저장 |
| `createOptionsMismatches` | 옵션 불일치 저장 |
| `createAutomationErrors` | 자동화 에러 로그 저장 |
| `createNeedsManagerVerification` | 담당자 확인 필요 저장 |
| `createPaymentLogs` | 결제 금액 로깅 |
| `receivePurchaseOrderLines` | 대행접수 처리 |
| `processFulfillment` | 출고 처리 (조회 → 변환 → 출고) |

### saveOrderResults - 핵심 함수

**주문 완료 후 모든 처리를 일괄 수행하는 함수**

```javascript
saveOrderResults(authToken, {
  purchaseOrderId,      // 발주 ID
  products,             // 주문 성공 상품 [{orderLineIds, openMallOrderNumber, ...}]
  priceMismatches,      // 가격 불일치 [{productVariantVendorId, vendorPriceExcludeVat, openMallPrice}]
  optionFailedProducts, // 옵션 실패 상품 [{productVariantVendorId, reason}]
  automationErrors,     // 에러 목록 (AutomationErrorCollector.getErrors())
  lineIds,              // 대행접수용 발주 라인 ID 배열
  success,              // 주문 성공 여부 (true/false) ⭐ 중요
  vendor                // 협력사명 (에러 로그용)
})
```

## 🔴 saveOrderResults 플로우 (중요!)

```
┌─────────────────────────────────────────────────────────────┐
│                    saveOrderResults                         │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 공통: 주문번호 누락 체크                              │  │
│  │   └─ openMallOrderNumber가 null인 상품 → 에러 로그    │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─────────────────────┐    ┌─────────────────────────┐   │
│  │  success: true      │    │  success: false         │   │
│  │                     │    │                         │   │
│  │  1단계 (병렬):      │    │  (병렬):                │   │
│  │   ├─ 주문번호 업데이트│   │   ├─ 옵션 불일치 저장   │   │
│  │   └─ 가격불일치 저장 │    │   └─ 에러 로그 저장     │   │
│  │                     │    │                         │   │
│  │  2단계 (순차):      │    │  ❌ 대행접수 안함       │   │
│  │   ├─ 대행접수       │    │  ❌ 출고처리 안함       │   │
│  │   └─ 출고처리       │    │                         │   │
│  └─────────────────────┘    └─────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 주문 성공 시 (success: true)
1. **1단계 (병렬 실행)**
   - `updateOpenMallOrderNumbers` - 오픈몰 주문번호 저장
   - `createPriceMismatches` - 가격 불일치 기록

2. **2단계 (순차 실행)**
   - `receivePurchaseOrderLines` - 대행접수 ✅
   - `processFulfillment` - 출고처리 ✅

### 주문 실패 시 (success: false)
- `createOptionsMismatches` - 옵션 불일치 기록
- `createAutomationErrors` - 에러 로그 기록
- **대행접수/출고처리 안함** ❌

### 주문번호 누락 시
- 에러 로그에 `ORDER_NUMBER_MISSING` 코드로 기록
- 해당 상품의 lineIds는 대행접수/출고처리에서 제외

## 데이터 흐름 (전체)

```
┌──────────────────────────────────────────────────────────────┐
│ n8n 워크플로우                                                │
│   └─ products[].orderLineIds = [line.orderLine.id]           │
│   └─ 자동화 서버 호출 (POST /vendors/:vendor/order)          │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────┐
│ server.js                                                     │
│   └─ vendors/:vendor/order.js 호출                           │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────┐
│ order.js (각 벤더별)                                          │
│                                                               │
│   1. 브라우저로 주문 진행                                     │
│   2. 결과 수집 (openMallOrderNumber, 에러 등)                 │
│   3. graphqlClient.saveOrderResults() 호출                   │
│      └─ success: 주문 성공 여부 전달                         │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────┐
│ graphql-client.js → saveOrderResults()                       │
│                                                               │
│   success=true  → 주문번호 + 가격불일치 → 대행접수 → 출고    │
│   success=false → 옵션불일치 + 에러로그 (대행접수/출고 없음)  │
└──────────────────────────────────────────────────────────────┘
```

## order.js에서 saveOrderResults 호출 예시

```javascript
// 주문 성공 시
await graphqlClient.saveOrderResults(authToken, {
  purchaseOrderId,
  products: successProducts.map(p => ({
    orderLineIds: p.orderLineIds,  // ⭐ 배열로 전달
    openMallOrderNumber: p.openMallOrderNumber,
    productVariantVendorId: p.productVariantVendorId
  })),
  priceMismatches,
  lineIds: successProducts.flatMap(p => p.orderLineIds),
  success: true,  // ⭐ 반드시 true 전달
  vendor: "naver"
});

// 주문 실패 시
await graphqlClient.saveOrderResults(authToken, {
  purchaseOrderId,
  optionFailedProducts: failedProducts,
  automationErrors: errorCollector.getErrors(),
  success: false,  // ⭐ 반드시 false 전달
  vendor: "naver"
});
```

## 협력사별 특이사항

### Naver
- iframe 내 주소 검색 처리 필요
- `--disable-web-security` 브라우저 옵션 필요

### Adpia
- 상품별 개별 주문 처리 (processIndividualOrders)
- 결제 금액 로깅 (createPaymentLogs)

### Napkin
- 세트 상품 박스별 수량 처리
- 2D 옵션 구조 지원
