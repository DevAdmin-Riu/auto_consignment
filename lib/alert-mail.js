const nodemailer = require("nodemailer");
const { getEnv } = require("../vendors/config");

const ALERT_EMAIL = "xdswwwj@riupack.com";

let transporter = null;

function getTransporter() {
  if (!transporter) {
    const smtpPassword = getEnv("SMTP_PASSWORD");
    if (!smtpPassword) {
      console.log("[alert-mail] SMTP_PASSWORD 미설정 → 메일 알림 비활성화");
      return null;
    }
    transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: "xdswwwj@gmail.com", pass: smtpPassword },
    });
  }
  return transporter;
}

/**
 * 개발자 알림 메일 (fire-and-forget, 비동기)
 * 주문 흐름에 영향 없음
 */
function sendAlertMail({ subject, body, vendor, purchaseOrderId }) {
  try {
    const t = getTransporter();
    if (!t) return;

    const fullSubject = `[자동화 알림] ${vendor ? `[${vendor}] ` : ""}${subject}`;
    const html = `
      <h3>${fullSubject}</h3>
      ${purchaseOrderId ? `<p><b>발주 ID:</b> ${purchaseOrderId}</p>` : ""}
      <p>${body}</p>
      <hr>
      <p style="color:#888;">자동 발송 메일입니다. (${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })})</p>
    `;

    t.sendMail({
      from: "xdswwwj@gmail.com",
      to: ALERT_EMAIL,
      subject: fullSubject,
      html,
    }).catch((e) => {
      console.log(`[alert-mail] 메일 발송 실패 (무시): ${e.message}`);
    });
  } catch (e) {
    console.log(`[alert-mail] 메일 생성 실패 (무시): ${e.message}`);
  }
}

/**
 * 결제금액 파싱 실패 알림
 */
function alertPaymentParsingFailed({ vendor, purchaseOrderId, openMallOrderNumber, paymentAmount }) {
  const issues = [];
  if (!paymentAmount || paymentAmount === 0) issues.push("결제금액 파싱 실패 (0원)");
  if (!openMallOrderNumber) issues.push("오픈몰 주문번호 파싱 실패");

  if (issues.length === 0) return;

  sendAlertMail({
    subject: `결제 정보 파싱 실패 (${issues.join(", ")})`,
    body: `
      <b>협력사:</b> ${vendor}<br>
      <b>발주 ID:</b> ${purchaseOrderId || "없음"}<br>
      <b>오픈몰 주문번호:</b> ${openMallOrderNumber || "없음"}<br>
      <b>결제금액:</b> ${paymentAmount || 0}원<br>
      <br>
      <b>문제:</b> ${issues.join(", ")}<br>
      <b>조치:</b> 대시보드에서 수동 확인/수정 필요
    `,
    vendor,
    purchaseOrderId,
  });
}

module.exports = { sendAlertMail, alertPaymentParsingFailed };
