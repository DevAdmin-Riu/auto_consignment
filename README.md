# Vendor Automation Server

협력사 자동 발주 시스템 (쿠팡 등)

## 설치

```bash
npm install
```

## 서버 실행

| 명령어 | 설명 |
|--------|------|
| `npm start` | 서버 시작 (포그라운드, 브라우저 화면 표시) |
| `npm run start:headless` | Headless 모드 시작 (브라우저 화면 없음) |
| `npm run stop` | 서버 중지 |
| `npm run restart` | 서버 재시작 |
| `npm run restart:headless` | Headless 모드로 재시작 |
| `npm run start:bg` | 백그라운드 실행 (로그 파일 저장) |
| `npm run start:bg:headless` | Headless + 백그라운드 |
| `npm run logs` | 로그 실시간 보기 (`tail -f server.log`) |

### 예시

```bash
# 일반 실행 (브라우저 보임)
npm start

# 백그라운드 실행 + 로그 보기
npm run start:bg && npm run logs

# 재시작
npm run restart
```

## API 엔드포인트

서버 포트: `3002`

### POST /api/vendor/order

협력사 자동 발주 실행

**Request Body:**
```json
{
  "vendorName": "쿠팡",
  "purchaseOrderId": "UHVyY2hhc2VPcmRlcjoxMjM0NQ==",
  "products": [
    {
      "productSku": "RVF-108267",
      "productName": "샌드위치 포장 봉투 100매",
      "productUrl": "https://www.coupang.com/vp/products/6627303651?vendorItemId=82315867235",
      "quantity": 6,
      "vendorPriceExcludeVat": 6000
    }
  ],
  "shippingAddress": {
    "firstName": "홍길동",
    "phone": "+821012345678",
    "postalCode": "12345",
    "streetAddress1": "서울시 강남구 테헤란로 123",
    "streetAddress2": "101호 가게이름"
  },
  "lineIds": ["UHVyY2hhc2VPcmRlckxpbmU6MTIzNDU="]
}
```

**Response (성공):**
```json
{
  "success": true,
  "message": "주문 처리 완료",
  "orderNumber": "1234567890",
  "hasPriceMismatch": false,
  "priceMismatchCount": 0
}
```

**Response (가격 불일치):**
```json
{
  "success": true,
  "message": "주문 처리 완료",
  "orderNumber": "1234567890",
  "hasPriceMismatch": true,
  "priceMismatchCount": 1,
  "priceMismatches": [
    {
      "productName": "샌드위치 포장 봉투 100매",
      "quantity": 6,
      "coupangPrice": 7500,
      "expectedPrice": 6600,
      "vendorPriceExcludeVat": 6000
    }
  ]
}
```

### GET /api/vendor/list

지원하는 협력사 목록 조회

### GET /api/browser/status

브라우저 상태 확인

### POST /api/browser/reset

브라우저 리셋

### GET /health

헬스체크

## 가격 비교 로직

쿠팡 가격과 협력사 매입가를 비교하여 불일치 시 알림

```
예상가격 = 협력사 매입가(VAT 제외) × 1.1
```

- 쿠팡 가격 > 예상가격: 가격 불일치로 판단
- n8n 워크플로우와 연동하여 이메일 알림 발송

## 주요 기능

- **자동 로그인**: 쿠팡 계정 자동 로그인 (세션 유지)
- **장바구니 추가**: 상품 URL로 자동 장바구니 추가
- **수량 설정**: 지정된 수량으로 자동 설정
- **배송지 입력**: 주소록 자동 입력
- **PIN 입력**: OCR을 통한 PIN 키패드 자동 인식 및 입력
- **가격 비교**: 쿠팡 가격과 협력사 매입가 비교

## 기술 스택

- **Node.js** + **Express**: API 서버
- **puppeteer-real-browser**: 브라우저 자동화 (Cloudflare 우회)
- **tesseract.js**: OCR (PIN 키패드 인식)
- **sharp**: 이미지 처리

## 서버 배포 시 참고

### Headless 모드 제한

쿠팡은 WAF(Web Application Firewall)로 headless 브라우저를 탐지하여 차단합니다.

**Linux 서버에서 권장 방법:**
```bash
# Xvfb (가상 디스플레이) 설치
sudo apt-get install xvfb

# 가상 디스플레이로 실행 (headless=false지만 화면 없음)
xvfb-run -a node server.js
```

### PM2 사용

```bash
# PM2로 실행
pm2 start server.js --name vendor-automation

# Xvfb와 함께 사용
pm2 start "xvfb-run -a node server.js" --name vendor-automation

# 로그 보기
pm2 logs vendor-automation
```

## 파일 구조

```
vendor-automation/
├── server.js              # 메인 서버 (Express API)
├── lib/
│   └── browser.js         # 브라우저 관리 (puppeteer-real-browser)
├── vendors/
│   └── coupang/
│       ├── index.js       # 쿠팡 벤더 진입점
│       ├── login.js       # 로그인 처리
│       ├── order.js       # 주문 처리 (장바구니, 배송지, 결제)
│       └── pin.js         # PIN 입력 (OCR)
├── package.json
└── README.md
```

## n8n 연동

n8n 워크플로우에서 HTTP Request 노드로 API 호출

**설정:**
- Method: POST
- URL: `http://localhost:3002/api/vendor/order`
- Body Content Type: JSON
- Timeout: 300000 (5분)
