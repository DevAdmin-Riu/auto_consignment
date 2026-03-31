# 송장번호 상품별 매칭 TODO

## 공통 변경 (완료)
- [x] n8n query에 `openMallProductLink`, `openMallOptions` 추가
- [x] n8n 그룹핑에 `fulfillments[{ fulfillmentId, vendorItemId, productName, openMallOptions }]` 추가
- [x] tracking-server에 `fulfillmentMap` 전달 + 상품별 매칭 지원

## 쿠팡 (코드 완료, 배포 후 테스트)
- [x] 퍼펫티어 tracking.js 리팩토링
- 매칭 키: `vendorItemId` (URL의 `vendorItemId=xxx`)
- 분리/묶음 판단: "N개 중 M개" 파싱
  - "2개 중 1개" → 분리 (블록별 다른 송장)
  - "2개 중 2개" / "3개" → 묶음 (전부 같은 송장)
- [ ] 배포 후 실서버 테스트

## 냅킨코리아 (설계 완료, 코드 작업 필요)
- 매칭 키: `product_no` + 옵션 텍스트
- 페이지 구조:
  - 행별로 `[옵션: 용기) 1박스 1000개入 (개당 75원)]` + 송장번호
  - `delivery_trace.php` URL에 `product_no`, `opt_id`, `invoice_no` 포함
- 우리 데이터: `openMallOptions`의 value로 매칭
  - 예: `"용기) 1박스 1000개入 (개당 75원)"` ↔ 페이지 옵션 텍스트
- 핵심 키워드 포함 여부로 매칭 (가격 부분 약간 다를 수 있음)
- [ ] 퍼펫티어 napkin/tracking.js 수정
- [ ] 배포 후 테스트

## 배민상회 (설계 완료, 코드 작업 필요)
- 매칭 키: `goods ID` (URL `/goods/detail/669426`) + 옵션 텍스트
- 페이지 구조:
  - 블록별 goods 링크 + 옵션 텍스트 + 배송조회 버튼
  - 배송조회 버튼: `data-action-button-click-event-label="배송조회"`
  - 옵션: 해시 클래스 대신 배송조회 버튼에서 위로 탐색해서 찾기
- 우리 데이터: `openMallOptions`의 value로 매칭
  - 예: `"[초특가] 두꺼운 1.5mm 보온보냉팩 20x25 300장"` ↔ 페이지 옵션 텍스트
- 주의: 해시 클래스(sc-xxx) 사용 금지, data 속성/URL 구조 기반 셀렉터 사용
- [ ] 퍼펫티어 baemin/tracking.js 수정
- [ ] 배포 후 테스트

## 네이버 (설계 완료, 코드 작업 필요)
- 매칭 키: 옵션 텍스트 (또는 `prod-order-no`)
- 페이지 구조 (orders.pay.naver.com/order/status/xxx):
  - 블록별 상품명 + 옵션 + 배송조회 버튼
  - 고유 키: `data-nlog-prod-order-no="2026032547847251"` (블록마다 다름)
  - 배송조회 버튼: `data-nlog-click-code="trackDelivery"`
  - 옵션: `크기: 20X25 50장` / `크기: 25x35 50장`
- 우리 데이터: `openMallOptions`의 value로 매칭
- `prod-order-no`는 주문 시점에 저장하지 않으므로 옵션 텍스트 매칭 사용
- [ ] 퍼펫티어 naver/tracking.js 수정
- [ ] 배포 후 테스트

## 성원애드피아 (변경 없음)
- 박스 섞임, 제품별 매칭 불가
- 현재 상태 유지
