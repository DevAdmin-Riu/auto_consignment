/**
 * 네이버 배송지연/발송지연 체크
 *
 * 주문상세 페이지에서 "배송지연" / "발송지연" 문구 감지 → 이메일 알림
 * 독립 실행 가능: node vendors/naver/delay-check.js
 */

const puppeteer = require("puppeteer");
const { login } = require("./login");
const { sendAlertMail } = require("../../lib/alert-mail");
const { getVendorByKey } = require("../config");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 네이버 주문상세에서 배송지연/발송지연 체크
 * @param {Page} page
 * @param {string[]} openMallOrderNumbers
 * @returns {Array} [{ openMallOrderNumber, state, productName, optionText, orderUrl }]
 */
async function checkDeliveryDelays(page, openMallOrderNumbers) {
  const allDelays = [];

  for (const orderNumber of openMallOrderNumbers) {
    try {
      const orderUrl = `https://orders.pay.naver.com/order/status/${orderNumber}`;
      console.log(`[naver 지연체크] ${orderNumber} 조회 중...`);

      await page.goto(orderUrl, { waitUntil: "networkidle2", timeout: 30000 });
      await delay(2000);

      const delays = await page.evaluate(() => {
        const results = [];
        // 상품 블록 찾기
        const items = document.querySelectorAll('li[class*="product-item"], li[class*="ProductInfoSection"]');

        for (const item of items) {
          // 상태 텍스트
          const stateEl = item.querySelector('strong[class*="DeliveryState_state"], strong[class*="state"]');
          const state = stateEl?.textContent?.trim() || "";

          if (state.includes("배송지연") || state.includes("발송지연")) {
            // 상품명
            const nameEl = item.querySelector('strong[class*="ProductDetail_name"], strong[class*="name"]');
            const productName = nameEl?.textContent?.trim()?.replace("상품명", "") || "알 수 없음";

            // 옵션
            const optionEls = item.querySelectorAll('span[class*="ProductDetail_text"]');
            const optionText = Array.from(optionEls).map(el => el.textContent?.trim()).filter(Boolean).join(" / ");

            // prod-order-no
            const btn = item.querySelector('[data-nlog-prod-order-no]');
            const prodOrderNo = btn?.getAttribute("data-nlog-prod-order-no") || "";

            results.push({ state, productName, optionText, prodOrderNo });
          }
        }

        return results;
      });

      if (delays.length > 0) {
        console.log(`[naver 지연체크] ⚠️ ${orderNumber}: 지연 ${delays.length}건 감지!`);
        for (const d of delays) {
          console.log(`  - [${d.state}] ${d.productName} ${d.optionText}`);
          allDelays.push({
            openMallOrderNumber: orderNumber,
            orderUrl: `https://orders.pay.naver.com/order/status/${orderNumber}`,
            ...d,
          });
        }
      } else {
        console.log(`[naver 지연체크] ${orderNumber}: 정상`);
      }

      await delay(1000);
    } catch (e) {
      console.error(`[naver 지연체크] ${orderNumber} 에러:`, e.message);
    }
  }

  return allDelays;
}

/**
 * 지연 감지 결과 이메일 발송
 */
function sendDelayAlert(delays) {
  if (delays.length === 0) return;

  const rows = delays.map(d =>
    `<tr>
      <td style="padding:6px 10px;border:1px solid #ddd;">${d.openMallOrderNumber}</td>
      <td style="padding:6px 10px;border:1px solid #ddd;color:red;font-weight:bold;">${d.state}</td>
      <td style="padding:6px 10px;border:1px solid #ddd;">${d.productName}</td>
      <td style="padding:6px 10px;border:1px solid #ddd;">${d.optionText}</td>
      <td style="padding:6px 10px;border:1px solid #ddd;"><a href="${d.orderUrl}">주문상세</a></td>
    </tr>`
  ).join("");

  const body = `
    <p>네이버 주문 중 배송지연/발송지연이 감지되었습니다. (${delays.length}건)</p>
    <table style="border-collapse:collapse;font-size:13px;">
      <tr style="background:#f0f0f0;">
        <th style="padding:6px 10px;border:1px solid #ddd;">주문번호</th>
        <th style="padding:6px 10px;border:1px solid #ddd;">상태</th>
        <th style="padding:6px 10px;border:1px solid #ddd;">상품명</th>
        <th style="padding:6px 10px;border:1px solid #ddd;">옵션</th>
        <th style="padding:6px 10px;border:1px solid #ddd;">링크</th>
      </tr>
      ${rows}
    </table>
  `;

  sendAlertMail({
    subject: `배송/발송 지연 감지 ${delays.length}건`,
    body,
    vendor: "네이버",
  });

  console.log(`[naver 지연체크] 이메일 발송 완료 (${delays.length}건)`);
}

// 독립 실행
if (require.main === module) {
  (async () => {
    // 테스트용 주문번호 (인자로 전달)
    const orderNumbers = process.argv.slice(2);
    if (orderNumbers.length === 0) {
      console.log("사용법: node vendors/naver/delay-check.js <주문번호1> <주문번호2> ...");
      process.exit(1);
    }

    const vendor = getVendorByKey("naver");
    const browser = await puppeteer.launch({
      headless: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-web-security"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    try {
      await login(page, vendor);
      console.log("[naver 지연체크] 로그인 완료");

      const delays = await checkDeliveryDelays(page, orderNumbers);

      if (delays.length > 0) {
        sendDelayAlert(delays);
      } else {
        console.log("[naver 지연체크] 지연 없음");
      }
    } catch (e) {
      console.error("[naver 지연체크] 에러:", e.message);
    } finally {
      await browser.close();
    }
  })();
}

module.exports = {
  checkDeliveryDelays,
  sendDelayAlert,
};
