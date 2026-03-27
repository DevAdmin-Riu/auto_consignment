# feature/new-mutation 작업 목록

> 백엔드 배포 후 적용할 변경사항 정리

## 1. n8n 워크플로우 변경

### 1-1. 발주서 생성 시 po_line.n8n_info 세팅
- [ ] 발주서 생성 n8n 노드에서 `Vendor.consignment_po_type` 조회
- [ ] 타입별 `n8n_info` 세팅:
  - `AUTO_SHOPPING_MALL` → `{ "type": "자동쇼핑몰발주" }` + POLine 상태: 작성중
  - `AUTO_EMAIL` → `{ "type": "자동이메일발주" }` + POLine 상태: 변경없음
  - `MANUAL_KAKAO` → `{ "type": "수동카톡발주" }` + POLine 상태: 접수대기
  - `MANUAL_ETC` → `{ "type": "수동기타발주" }` + POLine 상태: 접수대기
- [ ] `PurchaseOrderLineUpdate` mutation으로 `n8nInfo` 필드 업데이트

### 1-2. 메인 분기 처리 변경
- [ ] 기존: `vendor.use_auto_consignment_po` (boolean) 분기 제거
- [ ] 변경: `vendor.consignment_po_type` (enum) 4가지 분기
  - `AUTO_SHOPPING_MALL` → 쇼핑몰 자동 주문 (쿠팡/네이버/배민/와우프레스 등)
  - `AUTO_EMAIL` → 이메일 자동 발주 (자동 배송확정 처리)
  - `MANUAL_KAKAO` → 카톡 발주 (수동)
  - `MANUAL_ETC` → 기타 수동 발주
- [ ] 기존 "인터넷주문 크롤링 전 데이터 가공" 노드의 `INTERNET_ORDER_VENDORS` 배열 → `consignment_po_type` 기반으로 변경

### 1-3. 자동위탁발주 실패 시 retry + fail count
- [ ] `po_line.n8n_info`에 실패 카운트 관리:
  ```json
  { "type": "자동쇼핑몰발주", "fail_count": 2, "last_error": "..." }
  ```
- [ ] 재시도 횟수 초과 시 POLine 상태를 접수대기로 변경 (수동 처리)
- [ ] `PurchaseOrderLineUpdate` mutation으로 `n8nInfo` 업데이트
- [ ] 최대 재시도 횟수 결정 필요 (3회?)

### 1-4. 배송확정 mutation 변경
- [ ] `PurchaseOrderLinesDeliveryConfirmed`에 `beforeStatus` 파라미터 추가
  - 쇼핑몰 자동: `beforeStatus: DISPATCH_FULFILLMENT`
  - 카톡 발주 후: `beforeStatus: PENDING`
- [ ] n8n에서 이 mutation 호출하는 곳 전부 확인 + `beforeStatus` 추가

### 1-5. PurchaseOrderLinesVendorOrdered 삭제 대응
- [ ] n8n에서 이 mutation 호출하는 곳 찾기
- [ ] 호출 제거 (mutation 자체가 백엔드에서 삭제됨)

### 1-6. use_delegated_management_for_po 필터 확인
- [ ] n8n 쿼리에서 `useDelegatedManagementForPo: true` 필터 확인
- [ ] b2b가 아닌 일반 위탁도 대행으로 간주 → 필터 영향 없는지 확인
- [ ] 필요시 필터 조건 수정

## 2. 퍼펫티어 서버 변경

### 2-1. graphql-client.js TODO:DEPLOY 항목
- [ ] `createPaymentLogs`: `vendor` 필드 제거, `openMallOrderNumber` + `paymentCard` 활성화
- [ ] `createPriceMismatches`: `openMallOrderNumber` 필드 활성화
- [ ] mutation 응답: `createdCount` + `productErrors` → `openMallPaymentLogs { id }` + `errors { code }`

### 2-2. 출고처리 자동화 확인
- [ ] 위탁주문 출고 시 자체배송/1 자동 입력 확인 (OrderFulfill 내부)
- [ ] `is_consignment_po` → courier=자체배송, tracking_number=1 자동
- [ ] `is_dev_pv` → 배송완료 + 배송확정 자동 처리
- [ ] 퍼펫티어 서버에서 별도 처리 불필요한지 확인

### 2-3. 와우프레스 타입 확인
- [ ] 와우프레스 Vendor(id=41) `consignment_po_type` = `AUTO_SHOPPING_MALL` 확인
- [ ] 기존 와우프레스 플로우와 충돌 없는지 확인

## 3. 백엔드 확인 필요 사항

- [ ] `consignment_po_type` enum 값 확인 (AUTO_SHOPPING_MALL, AUTO_EMAIL, MANUAL_KAKAO, MANUAL_ETC)
- [ ] `PurchaseOrderLineUpdate` mutation의 `n8nInfo` 필드 타입 확인 (JSON?)
- [ ] `PurchaseOrderLinesDeliveryConfirmed`의 `beforeStatus` enum 값 확인
- [ ] 자동 재시도 최대 횟수 정책 확인

## 4. 작업 순서 (의존관계)

```
1단계: 백엔드 배포 확인
  ↓
2단계 (병렬):
  ├─ 2-1. graphql-client.js TODO:DEPLOY 적용
  ├─ 1-4. 배송확정 mutation beforeStatus 추가
  └─ 1-5. VendorOrdered mutation 제거
  ↓
3단계:
  ├─ 1-1. 발주서 생성 시 n8n_info 세팅
  └─ 1-2. 메인 분기 consignment_po_type으로 변경
  ↓
4단계:
  └─ 1-3. 실패 시 retry + fail count 구현
  ↓
5단계: 테스트 + 배포
```
