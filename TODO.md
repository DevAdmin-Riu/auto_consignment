# Vendor Automation TODO

## 옵션 선택 실패 처리

### 배경
네이버, 배민, 냅킨코리아에서 옵션값이 있지만 매칭되는 옵션을 찾지 못했을 때,
Saleor에 "옵션 지정 필요" mutation을 날려서 수동 처리가 필요함을 알려야 함.

### 필요 작업
- [ ] n8n 워크플로우에 옵션 실패 처리 노드 추가
  - 응답에서 `optionFailed: true` 인 상품 필터링
  - Saleor mutation 호출하여 해당 주문라인에 "옵션 지정 필요" 상태 표시
  - 예: `updatePurchaseOrderLineStatus` 또는 별도 필드 업데이트

### 현재 구현 상태

#### 네이버 (완료)
- `selectOptions()` - 옵션 매칭 실패 시 `{ success: false, reason: "..." }` 반환
- `processProduct()` - 옵션 실패 시 `{ optionFailed: true, optionFailReason: "..." }` 반환
- `processNaverOrder()` - 옵션 실패 상품 필터링, 장바구니 담기 0건이면 주문 중단

#### 배민 (완료)
- [x] 옵션 선택 실패 처리 구현 ✅
- `selectOption()` - 옵션 매칭 실패 시 `{ success: false, reason: "..." }` 반환
- `processBaeminOrder()` - 옵션 실패 시 `optionFailed: true, optionFailReason: "..."` 반환
- 응답에 `optionFailedCount`, `optionFailedProducts` 포함

#### 냅킨코리아
- [ ] 옵션 선택 실패 처리 구현 필요

### 응답 예시 (옵션 실패 시)
```json
{
  "success": false,
  "message": "옵션 선택 실패로 주문 불가 (1건)",
  "optionFailedProducts": [
    {
      "orderLineId": "T3JkZXJMaW5lOjEyMzQ1Ng==",
      "purchaseOrderLineId": "UHVyY2hhc2VPcmRlckxpbmU6MTIz",
      "productName": "상품명",
      "reason": "옵션 값 매칭 실패: 색상 = 블랙"
    }
  ],
  "purchaseOrderId": "..."
}
```

### Saleor Mutation (예시)
```graphql
mutation UpdatePurchaseOrderLineOptionStatus($id: ID!, $needsOptionSelection: Boolean!) {
  updatePurchaseOrderLine(id: $id, input: { needsOptionSelection: $needsOptionSelection }) {
    purchaseOrderLine {
      id
      needsOptionSelection
    }
    errors {
      field
      message
    }
  }
}
```

---

## 기타 TODO

- [ ] 쿠팡 옵션 선택 실패 처리 확인
- [ ] 성원애드피아 옵션 선택 실패 처리 확인
- [x] 송장 조회 기능 네이버 구현 ✅
- [x] 송장 조회 기능 배민 구현 ✅
- [ ] 송장 조회 테스트: 네이버 + 성원애드피아 + 배민 협력사 그룹핑 테스트 필요
