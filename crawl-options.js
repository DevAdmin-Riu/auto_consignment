/**
 * 옵션 title 크롤링 스크립트
 *
 * 168건 상품 URL에서 옵션 title을 추출하여 Excel로 저장
 */

const { connect } = require("puppeteer-real-browser");
const XLSX = require("xlsx");
const path = require("path");
const { getVendorByName } = require("./vendors/config");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 입력/출력 파일 경로
const INPUT_FILE = path.join(__dirname, "n8n_옵션정리_크롤링용.xlsx");
const OUTPUT_FILE = path.join(__dirname, "n8n_옵션크롤링_결과.xlsx");

/**
 * waitForSelector 래퍼 - order.js 스타일
 */
async function waitFor(page, selector, timeout = 5000) {
  try {
    return await page.waitForSelector(selector, { timeout, visible: true });
  } catch (e) {
    return null;
  }
}

// ==================== 로그인 함수들 ====================

/**
 * 냅킨코리아 로그인
 */
async function loginNapkin(page, vendor) {
  console.log("[napkin] 로그인 시작...");

  try {
    console.log("[napkin] 1. 로그인 페이지 이동...");
    await page.goto("https://www.napkinkorea.co.kr/member/login.html", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await delay(1500);

    const currentUrl = page.url();
    console.log(`[napkin] 현재 URL: ${currentUrl}`);

    if (!currentUrl.includes("/member/login")) {
      console.log("[napkin] 이미 로그인됨");
      return { success: true };
    }

    console.log("[napkin] 로그인 페이지 확인됨, 로그인 진행...");

    // 아이디 입력
    console.log("[napkin] 2. 아이디 입력...");
    const idInput = await waitFor(page, "#member_id", 5000);
    if (!idInput) {
      return { success: false, message: "아이디 입력창 없음" };
    }
    await idInput.click({ clickCount: 3 });
    await idInput.type(vendor.userId, { delay: 50 });
    await delay(500);

    // 비밀번호 입력
    console.log("[napkin] 3. 비밀번호 입력...");
    const pwInput = await waitFor(page, "#member_passwd", 3000);
    if (!pwInput) {
      return { success: false, message: "비밀번호 입력창 없음" };
    }
    await pwInput.click({ clickCount: 3 });
    await pwInput.type(vendor.password, { delay: 50 });
    await delay(500);

    // 로그인 버튼 클릭
    console.log("[napkin] 4. 로그인 버튼 클릭...");
    const loginBtn = await page.$(
      "a.btnSubmit, .btn_login, button[type='submit']",
    );
    if (loginBtn) {
      await loginBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }

    await page
      .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 })
      .catch(() => {});
    await delay(1500);

    console.log("[napkin] 로그인 완료!");
    return { success: true };
  } catch (error) {
    console.error("[napkin] 로그인 에러:", error.message);
    return { success: false, message: error.message };
  }
}

/**
 * 배민상회 로그인
 */
async function loginBaemin(page, vendor) {
  console.log("[baemin] 로그인 시작...");

  try {
    console.log("[baemin] 1. 메인 페이지 이동...");
    await page.goto("https://mart.baemin.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await delay(1500);

    // 로그인 버튼 클릭
    const loginBtnSelector =
      "#root > div > div.sc-kKWCvc.jpWsxy > div.sc-hQxkJl.dZCqTc > div > ul:nth-child(2) > li:nth-child(2) > a";
    const loginBtn = await page.$(loginBtnSelector);

    if (loginBtn) {
      console.log("[baemin] 로그인 버튼 클릭...");
      await loginBtn.click();
      await delay(2000);
    } else {
      await page.goto("https://biz-member.baemin.com/login", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await delay(1500);
    }

    const currentUrl = page.url();
    console.log(`[baemin] 현재 URL: ${currentUrl}`);

    if (
      !currentUrl.includes("biz-member.baemin.com/login") &&
      !currentUrl.includes("/login")
    ) {
      console.log("[baemin] 이미 로그인됨");
      return { success: true };
    }

    // 아이디 입력
    const idInputSelector =
      "#root > div.style__LoginWrap-sc-145yrm0-0.hKiYRl > div > div > form > div:nth-child(1) > span > input[type=text]";
    const idInput = await waitFor(page, idInputSelector, 10000);
    if (!idInput) {
      return { success: false, message: "아이디 입력창 없음" };
    }
    await idInput.click({ clickCount: 3 });
    await idInput.type(vendor.userId, { delay: 50 });
    await delay(500);

    // 비밀번호 입력
    const pwInputSelector =
      "#root > div.style__LoginWrap-sc-145yrm0-0.hKiYRl > div > div > form > div.Input__InputWrap-sc-tapcpf-1.kjWnKT.mt-half-3 > span > input[type=password]";
    const pwInput = await waitFor(page, pwInputSelector, 5000);
    if (!pwInput) {
      return { success: false, message: "비밀번호 입력창 없음" };
    }
    await pwInput.click({ clickCount: 3 });
    await pwInput.type(vendor.password, { delay: 50 });
    await delay(500);

    // 로그인 버튼 클릭
    const submitBtnSelector =
      "#root > div.style__LoginWrap-sc-145yrm0-0.hKiYRl > div > div > form > button";
    const submitBtn = await waitFor(page, submitBtnSelector, 5000);
    if (submitBtn) {
      await submitBtn.click();
    }

    await page
      .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 })
      .catch(() => {});
    await delay(1500);

    console.log("[baemin] 로그인 완료!");
    return { success: true };
  } catch (error) {
    console.error("[baemin] 로그인 에러:", error.message);
    return { success: false, message: error.message };
  }
}

/**
 * 네이버 로그인
 */
async function loginNaver(page, vendor) {
  console.log("[naver] 로그인 시작...");

  try {
    console.log("[naver] 1. 네이버 메인 페이지 이동...");
    await page.goto("https://www.naver.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await delay(1500);

    // 로그인 버튼 클릭
    const loginLink = await page.$("a.MyView-module__link_login___HpHMW");
    if (loginLink) {
      console.log("[naver] 로그인 버튼 클릭...");
      await loginLink.click();
      await delay(2000);
    } else {
      await page.goto("https://nid.naver.com/nidlogin.login", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await delay(1500);
    }

    const currentUrl = page.url();
    console.log(`[naver] 현재 URL: ${currentUrl}`);

    if (!currentUrl.includes("nidlogin")) {
      console.log("[naver] 이미 로그인됨");
      return { success: true };
    }

    // 아이디 입력
    const idInput = await waitFor(page, "#id", 5000);
    if (!idInput) {
      return { success: false, message: "아이디 입력창 없음" };
    }
    await idInput.click({ clickCount: 3 });
    await idInput.type(vendor.userId, { delay: 100 });
    await delay(500);

    // 비밀번호 입력
    const pwInput = await waitFor(page, "#pw", 3000);
    if (!pwInput) {
      return { success: false, message: "비밀번호 입력창 없음" };
    }
    await pwInput.click({ clickCount: 3 });
    await pwInput.type(vendor.password, { delay: 100 });
    await delay(500);

    // 로그인 버튼 클릭
    const loginBtn = await page.$("#log\\.login");
    if (loginBtn) {
      await loginBtn.click();
    }

    await page
      .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 })
      .catch(() => {});
    await delay(2000);

    console.log("[naver] 로그인 완료!");
    return { success: true };
  } catch (error) {
    console.error("[naver] 로그인 에러:", error.message);
    return { success: false, message: error.message };
  }
}

// ==================== 옵션 추출 함수들 ====================

/**
 * 네이버 스마트스토어 옵션 추출 - order.js 스타일
 */
async function extractNaverOptions(page) {
  try {
    await delay(2000);

    // 네이버 스마트스토어 옵션 버튼 셀렉터 (data-shp-contents-type 속성)
    const optionBtnSelector = "a._yGBCMWCWu[data-shp-contents-type]";

    // 옵션 버튼들 찾기
    const optionBtns = await page.$$(optionBtnSelector);

    if (optionBtns.length === 0) {
      console.log("[naver] 옵션 버튼 없음 - 옵션이 없는 상품");
      return [];
    }

    console.log(`[naver] 옵션 버튼 ${optionBtns.length}개 발견`);

    // 각 버튼에서 옵션 title 추출 (data-shp-contents-type 속성값)
    const optionTitles = await page.evaluate((selector) => {
      const btns = document.querySelectorAll(selector);
      const titles = [];
      btns.forEach((btn) => {
        const title = btn.getAttribute("data-shp-contents-type");
        if (title && !titles.includes(title)) {
          titles.push(title);
        }
      });
      return titles;
    }, optionBtnSelector);

    console.log(`[naver] 옵션 titles: ${optionTitles.join(", ")}`);
    return optionTitles;
  } catch (e) {
    console.error("[naver] 옵션 추출 에러:", e.message);
    return [];
  }
}

/**
 * 배민상회 옵션 추출 - 버튼 텍스트에서 옵션명 추출
 * 예: "규격을 선택해주세요" → "규격"
 */
async function extractBaeminOptions(page) {
  const SELECTORS = {
    optionDropdownButton:
      "#root > div > div.sc-jCbqOc.iPvcFH > div.sc-jephDI.fmkuTR > section > div.sc-eAkcsE.jxnmef > div.sc-gtMvKj.EzUvH > div > button",
  };

  try {
    await delay(2000);

    // 드롭다운 버튼 찾기
    const dropdownBtn = await waitFor(
      page,
      SELECTORS.optionDropdownButton,
      3000,
    );
    await delay(1100);
    if (!dropdownBtn) {
      console.log("[baemin] 옵션 드롭다운 버튼 없음");
      return [];
    }

    // 버튼 텍스트 그대로 가져오기
    const btnText = await page.evaluate(
      (el) => el.textContent.trim(),
      dropdownBtn,
    );
    console.log(`[baemin] 옵션명: "${btnText}"`);

    if (btnText) {
      return [btnText];
    }

    return [];
  } catch (e) {
    console.error("[baemin] 옵션 추출 에러:", e.message);
    return [];
  }
}

/**
 * 냅킨코리아 옵션 추출 - order.js 스타일 (waitFor 사용)
 */
async function extractNapkinOptions(page) {
  try {
    await delay(2000);

    // 냅킨코리아 옵션 select 셀렉터
    const optionSelectSelector =
      'select[id^="product_option_id"], select[class*="ProductOption"]';

    // 옵션 셀렉트 박스 대기
    const optionSelects = await page.$$(optionSelectSelector);

    if (optionSelects.length === 0) {
      console.log("[napkin] 옵션 셀렉트 박스 없음 - 옵션이 없는 상품");
      return [];
    }

    console.log(`[napkin] 옵션 셀렉트 박스 ${optionSelects.length}개 발견`);

    // 각 셀렉트에서 옵션 title 추출
    const optionTitles = await page.evaluate((selector) => {
      const selects = document.querySelectorAll(selector);
      const titles = [];

      selects.forEach((select, idx) => {
        let title = "";

        // 1. th에서 제목 찾기 (테이블 구조)
        const row = select.closest("tr");
        if (row) {
          const th = row.querySelector("th");
          if (th) {
            // "필수"는 단어로, *와 공백은 개별 문자로 제거
            title = th.textContent
              ?.trim()
              ?.replace(/필수|\*|\s/g, "")
              .trim();
          }
        }

        // 2. 이전 label 찾기
        if (!title) {
          let prev = select.previousElementSibling;
          while (prev) {
            if (prev.tagName === "LABEL" || prev.classList.contains("title")) {
              title = prev.textContent?.trim();
              break;
            }
            prev = prev.previousElementSibling;
          }
        }

        // 3. 첫 번째 옵션에서 추출 (예: "사이즈 : L" → "사이즈")
        if (!title) {
          const firstOption = select.querySelector("option:not([value=''])");
          if (firstOption) {
            const optText = firstOption.textContent?.trim();
            const match = optText?.match(/^([^:]+):/);
            if (match) {
              title = match[1].trim();
            }
          }
        }

        // 4. 기본값
        if (!title) {
          title = `옵션${idx + 1}`;
        }

        if (title && !titles.includes(title)) {
          titles.push(title);
        }
      });

      return titles;
    }, optionSelectSelector);

    console.log(`[napkin] 옵션 titles: ${optionTitles.join(", ") || "(없음)"}`);
    return optionTitles;
  } catch (e) {
    console.error("[napkin] 옵션 추출 에러:", e.message);
    return [];
  }
}

// ==================== 유틸리티 ====================

/**
 * URL에서 도메인 판별
 */
function getDomainType(url) {
  if (url.includes("smartstore.naver.com")) return "naver";
  if (url.includes("mart.baemin.com")) return "baemin";
  if (url.includes("napkinkorea.co.kr")) return "napkin";
  return "unknown";
}

// ==================== 메인 ====================

async function main() {
  console.log("=== 옵션 크롤링 시작 ===\n");

  // Excel 읽기
  const workbook = XLSX.readFile(INPUT_FILE);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet);

  console.log(`총 ${data.length}건 크롤링 예정\n`);

  // 브라우저 연결
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-popup-blocking",
    "--disable-notifications",
    "--disable-web-security",
    "--allow-running-insecure-content",
  ];

  const { browser, page } = await connect({
    headless: false,
    args,
    customConfig: {},
    connectOption: {
      defaultViewport: { width: 1920, height: 1080 },
    },
  });

  // 도메인별로 그룹화
  const groupedData = {
    napkin: data.filter((r) => getDomainType(r.open_mall_url) === "napkin"),
    baemin: data.filter((r) => getDomainType(r.open_mall_url) === "baemin"),
    naver: data.filter((r) => getDomainType(r.open_mall_url) === "naver"),
  };

  console.log(
    `도메인별 분포: 냅킨 ${groupedData.napkin.length}건, 배민 ${groupedData.baemin.length}건, 네이버 ${groupedData.naver.length}건\n`,
  );

  const results = [];
  let successCount = 0;
  let errorCount = 0;

  // 로그인 상태
  const loginState = { napkin: false, baemin: false, naver: false };

  // 네이버만 처리
  const orderedData = [...groupedData.naver];

  for (let i = 0; i < orderedData.length; i++) {
    const row = orderedData[i];
    const url = row.open_mall_url;
    const domainType = getDomainType(url);

    console.log(
      `[${i + 1}/${orderedData.length}] ${domainType}: ${url.substring(0, 60)}...`,
    );

    try {
      // 도메인별 로그인 (한 번만)
      if (domainType === "napkin" && !loginState.napkin) {
        const vendor = getVendorByName("냅킨코리아");
        const result = await loginNapkin(page, vendor);
        loginState.napkin = result.success;
      } else if (domainType === "baemin" && !loginState.baemin) {
        const vendor = getVendorByName("배민상회");
        const result = await loginBaemin(page, vendor);
        loginState.baemin = result.success;
      } else if (domainType === "naver" && !loginState.naver) {
        const vendor = getVendorByName("네이버");
        const result = await loginNaver(page, vendor);
        loginState.naver = result.success;
      }

      // 상품 페이지 이동
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await delay(2000);

      // 옵션 추출
      let optionTitles = [];

      switch (domainType) {
        case "naver":
          optionTitles = await extractNaverOptions(page);
          break;
        case "baemin":
          optionTitles = await extractBaeminOptions(page);
          break;
        case "napkin":
          optionTitles = await extractNapkinOptions(page);
          break;
        default:
          console.log(`  [!] 알 수 없는 도메인: ${url}`);
      }

      console.log(
        `  옵션 ${optionTitles.length}개: ${optionTitles.join(", ") || "(없음)"}`,
      );

      if (optionTitles.length === 0) {
        // 옵션 없는 경우
        results.push({
          product_id: row.product_id,
          product_variant_vendor_id: row.product_variant_vendor_id,
          sku: row.sku,
          vendor_name: row.vendor_name,
          option_title: "",
          option_value: "",
          open_mall_url: row.open_mall_url,
          origin_url: row.origin_url,
          note: row.note,
          crawl_status: "옵션없음",
        });
      } else {
        // 옵션 있는 경우 - 옵션 개수만큼 행 생성
        for (const optTitle of optionTitles) {
          results.push({
            product_id: row.product_id,
            product_variant_vendor_id: row.product_variant_vendor_id,
            sku: row.sku,
            vendor_name: row.vendor_name,
            option_title: optTitle,
            option_value: "",
            open_mall_url: row.open_mall_url,
            origin_url: row.origin_url,
            note: row.note,
            crawl_status: "성공",
          });
        }
      }

      successCount++;
    } catch (e) {
      console.log(`  [!] 에러: ${e.message}`);
      results.push({
        product_id: row.product_id,
        product_variant_vendor_id: row.product_variant_vendor_id,
        sku: row.sku,
        vendor_name: row.vendor_name,
        option_title: "",
        option_value: "",
        open_mall_url: row.open_mall_url,
        origin_url: row.origin_url,
        note: row.note,
        crawl_status: `에러: ${e.message}`,
      });
      errorCount++;
    }

    // 요청 간 딜레이
    await delay(1000);
  }

  // 브라우저 종료
  await browser.close();

  // 결과 Excel 저장
  const newWorkbook = XLSX.utils.book_new();
  const newSheet = XLSX.utils.json_to_sheet(results);
  XLSX.utils.book_append_sheet(newWorkbook, newSheet, "옵션크롤링결과");
  XLSX.writeFile(newWorkbook, OUTPUT_FILE);

  console.log(`\n=== 크롤링 완료 ===`);
  console.log(`성공: ${successCount}건`);
  console.log(`에러: ${errorCount}건`);
  console.log(`결과 행 수: ${results.length}건`);
  console.log(`저장: ${OUTPUT_FILE}`);
}

main().catch(console.error);
