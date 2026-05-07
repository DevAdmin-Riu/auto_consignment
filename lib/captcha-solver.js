/**
 * 네이버 캡챠 자동 풀이 (Google Gemini Vision)
 *
 * 영수증 이미지 + 질문 텍스트를 Gemini에 보내서 답을 받아 자동 입력.
 *
 * 캡챠 DOM:
 *   [data-component="cpt_main"]
 *     #rcpt_img        - 영수증 이미지 (base64 src)
 *     #rcpt_info       - 질문 텍스트
 *     #rcpt_answer     - 답 입력 필드
 *     #rcpt_reload     - 새로고침 버튼
 *     #cpt_confirm     - 확인 버튼
 *
 * 환경변수:
 *   GEMINI_API_KEY  - Google Gemini API 키
 */

const { GoogleGenAI } = require("@google/genai");
const { getEnv } = require("../vendors/config");

const CAPTCHA_SELECTORS = {
  container: '[data-component="cpt_main"]',
  image: "#rcpt_img",
  question: "#rcpt_info",
  answer: "#rcpt_answer",
  reload: "#rcpt_reload",
  submit: "#cpt_confirm",
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let _ai = null;
function getAI() {
  if (!_ai) {
    const apiKey = getEnv("GEMINI_API_KEY") || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY 환경변수 미설정");
    _ai = new GoogleGenAI({ apiKey });
  }
  return _ai;
}

/**
 * 페이지에 캡챠가 떠 있는지 확인
 */
async function detectCaptcha(page) {
  try {
    return await page.evaluate((sel) => {
      return !!document.querySelector(sel);
    }, CAPTCHA_SELECTORS.container);
  } catch (e) {
    return false;
  }
}

/**
 * Gemini Vision으로 캡챠 답 받기
 */
async function askGemini(imageBase64, mimeType, question) {
  const ai = getAI();

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        parts: [
          { inlineData: { mimeType, data: imageBase64 } },
          {
            text: `다음은 네이버 캡챠 영수증 이미지입니다. 영수증을 보고 아래 질문의 빈 칸([?])에 들어갈 정확한 값만 출력하세요.\n\n질문: "${question}"\n\n답만 출력. 설명/문장/따옴표 없이 단어 또는 숫자만.`,
          },
        ],
      },
    ],
  });

  return (response.text || "").trim();
}

/**
 * 캡챠 풀이 시도
 * @returns {Promise<{solved: boolean, answer?: string, error?: string}>}
 */
async function solveCaptcha(page, options = {}) {
  const { logPrefix = "[captcha]", maxRetries = 2 } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (!(await detectCaptcha(page))) {
      return { solved: true };
    }

    console.log(`${logPrefix} 캡챠 풀이 시도 ${attempt}/${maxRetries}...`);

    // 1. 질문 텍스트 추출
    const questionText = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.textContent.trim() : "";
    }, CAPTCHA_SELECTORS.question);

    if (!questionText) {
      console.log(`${logPrefix} 질문 텍스트 추출 실패`);
      return { solved: false, error: "질문 텍스트 없음" };
    }
    console.log(`${logPrefix} 질문: ${questionText}`);

    // 2. 이미지 base64 추출 (data URL)
    const imageInfo = await page.evaluate((sel) => {
      const img = document.querySelector(sel);
      if (!img) return null;
      const src = img.getAttribute("src") || "";
      const match = src.match(/^data:image\/(\w+);base64,(.+)$/);
      return match ? { mimeType: `image/${match[1]}`, data: match[2] } : null;
    }, CAPTCHA_SELECTORS.image);

    let imageData = imageInfo?.data;
    let mimeType = imageInfo?.mimeType;

    // data URL에서 추출 실패 시 스크린샷 폴백
    if (!imageData) {
      const imgEl = await page.$(CAPTCHA_SELECTORS.image);
      if (!imgEl) {
        console.log(`${logPrefix} 캡챠 이미지를 찾을 수 없음`);
        return { solved: false, error: "이미지 없음" };
      }
      imageData = await imgEl.screenshot({ encoding: "base64" });
      mimeType = "image/png";
    }

    // 3. Gemini API 호출
    let answer;
    try {
      answer = await askGemini(imageData, mimeType, questionText);
      console.log(`${logPrefix} Gemini 답변: "${answer}"`);
    } catch (e) {
      console.log(`${logPrefix} Gemini API 호출 실패: ${e.message}`);
      return { solved: false, error: `API 실패: ${e.message}` };
    }

    if (!answer) {
      console.log(`${logPrefix} 빈 답변, 새로고침 후 재시도`);
      try {
        await page.click(CAPTCHA_SELECTORS.reload);
        await delay(1500);
      } catch (e) {}
      continue;
    }

    // 4. 답 입력
    try {
      await page.click(CAPTCHA_SELECTORS.answer);
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.value = "";
      }, CAPTCHA_SELECTORS.answer);
      await page.type(CAPTCHA_SELECTORS.answer, answer, { delay: 50 });
      await delay(300);

      // 5. 제출
      await page.click(CAPTCHA_SELECTORS.submit);
    } catch (e) {
      console.log(`${logPrefix} 입력/제출 실패: ${e.message}`);
      return { solved: false, error: `입력 실패: ${e.message}` };
    }

    // 6. 결과 대기
    await delay(3500);

    // 7. 캡챠 사라졌는지 확인
    if (!(await detectCaptcha(page))) {
      console.log(`${logPrefix} ✅ 캡챠 풀이 성공`);
      return { solved: true, answer };
    }

    console.log(`${logPrefix} 캡챠 여전히 표시됨, 재시도`);
    try {
      await page.click(CAPTCHA_SELECTORS.reload);
      await delay(1500);
    } catch (e) {}
  }

  return { solved: false, error: `${maxRetries}회 시도 모두 실패` };
}

module.exports = {
  detectCaptcha,
  solveCaptcha,
  CAPTCHA_SELECTORS,
};
