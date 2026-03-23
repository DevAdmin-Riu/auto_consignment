# Vendor Automation TODO

---

## 결제 로그 구조 변경 (백엔드 API 변경 대응)

- [x] graphql-client.js: `createPaymentLogs` → `openMallPaymentLogBulkCreate` mutation 변경 (d785f14)
  - `orderLineId` 제거 → `openMallOrderNumber`으로 대체
  - `paymentCard` 필드 추가 (SHINHAN / BC)
- [x] ~~graphql-client.js: `openMallPaymentLogUpdatePaymentCard` mutation 추가~~ (대시보드 전용, 자동화 불필요)
- [x] ~~graphql-client.js: `openMallPaymentLogManualUpdate` mutation 추가~~ (대시보드 전용, 자동화 불필요)
- [x] ~~graphql-client.js: `openMallPaymentAmountLogBulkCreate` mutation 추가~~ (대시보드 전용, 자동화 불필요)
- [x] paymentCard 매핑: `.env` PAYMENT_CARD_TYPE(shinhan/bc) → SHINHAN/BC enum 변환 (d785f14)

### 새 Mutation 스펙

```graphql
# 1. 결제 내역 일괄 생성
mutation OpenMallPaymentLogBulkCreate($input: [OpenMallPaymentLogBulkCreateInput!]!) {
  openMallPaymentLogBulkCreate(input: $input) {
    openMallPaymentLogs { id }
    errors { field, message, code }
  }
}
# Input: purchaseOrderId(필수), openMallOrderNumber, paymentAmount(필수), paymentCard(SHINHAN/BC)

# 2. 결제카드 일괄 변경
mutation OpenMallPaymentLogUpdatePaymentCard($ids: [ID!]!, $paymentCard: OpenMallPaymentCardTypeEnum!) {
  openMallPaymentLogUpdatePaymentCard(ids: $ids, paymentCard: $paymentCard) {
    updatedCount
    productErrors { field, message }
  }
}

# 3. 수동 수정 (단건)
mutation OpenMallPaymentLogManualUpdate($id: ID!, $input: OpenMallPaymentLogManualUpdateInput!) {
  openMallPaymentLogManualUpdate(id: $id, input: $input) {
    productErrors { field, message }
  }
}
# Input: openMallOrderNumber, paymentAmount, paymentCard (partial update)

# 4. 금액 차감 로그
mutation OpenMallPaymentAmountLogBulkCreate($input: [OpenMallPaymentAmountLogCreateInput!]!) {
  openMallPaymentAmountLogBulkCreate(input: $input) {
    createdCount
    productErrors { field, message }
  }
}
# Input: paymentLogId(필수), type(CANCEL/PARTIAL_CANCEL/REFUND), amount(음수), note
```

---

## 결제금액 파싱 확인 (벤더별)

- [ ] 배민: 네이버페이 결제금액 파싱 정상 여부 확인
- [ ] 네이버: 결제 완료 페이지 금액 파싱 확인
- [ ] 쿠팡: 후불이라 별도 처리 필요 여부 확인
- [ ] 애드피아: 주문서 결제금액 파싱 확인
- [ ] 냅킨: 주문서 결제금액 파싱 확인
- [ ] 성원애드피아: 주문서 결제금액 파싱 확인

---

## 배송지 검증

- [x] 네이버: 주소 검색 첫 번째 선택 + 카카오 매칭 검증 (6c63324)
- [x] adpia: 배송지 입력 후 카카오 더블체킹 `#recv_addr_1` (056e981)
- [x] napkin: 배송지 입력 후 카카오 더블체킹 `#raddr1` (056e981)
- [x] swadpia: 배송지 입력 후 카카오 더블체킹 `#recv_addr_1` + `#recv_addr_1_new` (eae84a2)

---

## 버그 수정

- [x] adpia 파일 업로드 실패 모달 → 장바구니 버튼 재클릭 최대 3회 (7a7b054)
- [x] 신한카드 결제 입력 딜레이 증가 (d20af50)
- [x] napkin 다음 주소 iframe CDP 방식 적용
- [x] adpia `#recv_name` 20byte 초과 시 자르기 (d570e8c)

---

## n8n 관련

- [x] 디자인 파일 없는 상품 → createNeedsManagerVerification + 스킵 (cf077f3)
  - n8n 필터링 제거 → 서버에서 처리
- [ ] 발주서 생성: 담을 협력사 추가 (`fill담을`) + vendor code 기반 매칭 → 코드 완성, 적용 대기

---

## 로그 개선

- [x] 전체 벤더 에러 로그 컨텍스트 보강 (0c1cb89)
- [x] 반복 로그 간격 조정 1초→5~10초 (7eb8c7b)
- [x] DEBUG 로그 제거 + prefix 통일 (6292580)

---

## 알림

- [ ] 결제금액/주문번호 파싱 실패 시 메일 알림 기능 추가

---

## 기타 TODO

- [ ] 송장 조회 테스트: 네이버 + 성원애드피아 + 배민 협력사 그룹핑 테스트 필요 (후순위)

---

## 완료된 항목

- [x] 옵션 선택 실패 처리 (전 벤더: 네이버/배민/냅킨/쿠팡/성원애드피아)
- [x] 송장 조회 기능 (네이버/배민)
- [x] 배민 배송지 각 단계 에러처리 + TODO 정리
- [x] 배민 수정 버튼 SVG 폴백 + 쿠폰 4만원 변경
- [x] 다음 주소 iframe 공통 모듈화 (lib/daum-address.js)
- [x] 네이버 수량 입력 검증 (3회 재시도)
- [x] 네이버 배송지 방어코드 추가
- [x] 신한/BC 결제 분기 처리 + 런처 카드 선택 UI
- [x] 쿠팡 주문번호 regex 추출 + 무한대기
- [x] PM2 로그 로테이션 (30일 보관)
- [x] Docker GENERIC_TIMEZONE=Asia/Seoul 설정
- [x] adpia 수령인 이름 20byte 자르기
- [x] fix/baemin 브랜치 → main 머지 완료
