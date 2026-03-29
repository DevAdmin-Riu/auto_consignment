# n8n 워크플로우 분기 — consignment_po_type 기준

## 발주서 생성 시점 (백엔드)

| consignment_po_type | 발주서 초기 상태 | 설명 |
|---|---|---|
| AUTO_SHOPPING_MALL | DRAFT (작성중) | n8n 자동 플로우에서 주문 처리 |
| AUTO_EMAIL | 없음 (do nothing) | 발주서 생성 안 함 |
| MANUAL_KAKAO | PENDING (접수대기) | 발송 완료 상태로 바로 생성 |
| MANUAL_ETC | PENDING (접수대기) | 발송 완료 상태로 바로 생성 |

## n8n 워크플로우별 처리 대상

### 1) 자동 발주 워크플로우 (쇼핑몰 자동 주문)

- **필터**: `vendorConsignmentPoType: ["AUTO_SHOPPING_MALL"]`, `status: ["DRAFT"]`
- **대상**: 와우프레스, 애드피아몰 등 API/크롤링으로 자동 주문하는 벤더
- **플로우**:
```
발주 리스트 조회 (DRAFT + AUTO_SHOPPING_MALL)
  → 벤더 분기
    → 와우프레스 → wowPressPlaceOrder (주문+발송+접수+출고 자동)
    → 나머지 → 퍼펫티어 크롤링 주문
```

### 2) 수동 카톡 발주 워크플로우

- **필터**: `vendorConsignmentPoType: ["MANUAL_KAKAO"]`, `status: ["PENDING"]`
- **대상**: 카카오톡으로 수동 발주하는 벤더
- 발주서가 이미 PENDING(접수대기) 상태로 생성 → 벤더가 카톡으로 확인 후 접수 처리

### 3) 수동 기타 발주 워크플로우

- **필터**: `vendorConsignmentPoType: ["MANUAL_ETC"]`, `status: ["PENDING"]`
- **대상**: 기타 수동 처리 벤더
- PENDING 상태로 생성 → 수동으로 접수/출고 처리

### 4) 자동 이메일 발주

- `AUTO_EMAIL`은 발주서 자체를 생성하지 않으므로 n8n에서 별도 처리 불필요

## 핵심 차이

```
AUTO_SHOPPING_MALL → DRAFT로 생성 → n8n이 주문 후 DRAFT→PENDING→RECEIVED→출고
MANUAL_KAKAO/ETC  → PENDING으로 생성 → 이미 발송된 상태, 벤더가 접수하면 됨
AUTO_EMAIL        → 발주서 없음 → n8n 무관
```

## 삭제된 뮤테이션

- **PurchaseOrderLinesVendorOrdered** — 완전 삭제, n8n에서 제거해야 함

## 변경된 뮤테이션

- **PurchaseOrderLinesDeliveryConfirmed** — `before_status` 파라미터 필수 추가

## 사용할 뮤테이션 (워크플로우별)

### 자동 쇼핑몰 (AUTO_SHOPPING_MALL):

- `wowPressPlaceOrder(purchaseOrderId)` — 와우프레스 (주문+발송+접수+출고 한번에)
- `purchaseOrderLineUpdate(id, input: { n8nInfo: {...} })` — n8n_info 업데이트 (실패카운트 등)

### 수동 카톡/기타 (MANUAL_KAKAO, MANUAL_ETC):

- `PurchaseOrderLinesReceive` — 접수 (PENDING → RECEIVED)
- `PurchaseOrderLinesDeliveryConfirmed(before_status: "RECEIVED")` — 배송확정

### 공통 (배송추적):

- `WowPressUpdateTracking(ordnum)` — 와우프레스 송장번호 업데이트

### 결제:

- `WowPressCreatePaymentLog(ordnum, purchaseOrderId, purchaseOrderLineIds)` — 결제내역 생성

## n8n에서 제거/수정 필요

- `PurchaseOrderLinesVendorOrdered` 호출 → **제거**
- `PurchaseOrderLinesDeliveryConfirmed` → **before_status 파라미터 추가**
- `n8nInfo` → **GenericScalar** (JSON 객체 그대로, JSON.stringify 하지 말 것)
