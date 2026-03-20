/**
 * 다음 주소 검색 iframe 공통 모듈
 * - OOPIF(Out-of-Process iframe) CDP 방식으로 Daum 주소 검색 iframe 찾기
 * - CDP 세션을 puppeteer Frame/Element처럼 사용할 수 있는 프록시 객체 생성
 * - baemin, adpia 등 다음 주소 검색 사용하는 벤더에서 공통 사용
 */

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * OOPIF CDP 방식으로 Daum 주소 검색 iframe 찾기
 * @param {Object} page - Puppeteer page 객체
 * @param {string} inputSelector - iframe 내 주소 input 셀렉터 (기본: #region_name)
 * @param {string} logPrefix - 로그 prefix (기본: [daum-address])
 * @returns {Object|null} frame 프록시 객체 또는 null
 */
async function findDaumFrameViaCDP(page, inputSelector = "#region_name", logPrefix = "[daum-address]") {
  const browser = page.browser();
  const targets = browser.targets();

  console.log(`${logPrefix} OOPIF CDP: 전체 타겟 ${targets.length}개 탐색`);

  // Daum postcode iframe 타겟 찾기
  for (const target of targets) {
    const targetUrl = target.url();
    if (
      targetUrl.includes("postcode") ||
      targetUrl.includes("daum.net/search")
    ) {
      console.log(
        `${logPrefix} OOPIF CDP: Daum 타겟 발견 - ${targetUrl.substring(0, 100)}`,
      );

      try {
        const cdpClient = await target.createCDPSession();
        await cdpClient.send("Runtime.enable");

        // input 존재 확인
        const checkResult = await cdpClient.send("Runtime.evaluate", {
          expression: `!!document.querySelector('${inputSelector}')`,
          returnByValue: true,
        });

        if (checkResult.result?.value) {
          console.log(
            `${logPrefix} OOPIF CDP: ${inputSelector} 발견! CDP 프록시 프레임 반환`,
          );
          return createCDPFrameProxy(cdpClient);
        } else {
          console.log(`${logPrefix} OOPIF CDP: Daum 타겟에 ${inputSelector} 없음`);
          await cdpClient.detach();
        }
      } catch (e) {
        console.log(`${logPrefix} OOPIF CDP: 타겟 접근 실패 - ${e.message}`);
      }
    }
  }

  // page.frames()에서 URL로 찾은 뒤 CDP 세션 시도
  const allFrames = page.frames();
  for (const f of allFrames) {
    const url = f.url();
    if (url.includes("postcode") || url.includes("daum")) {
      console.log(
        `${logPrefix} OOPIF CDP: page.frames() Daum 프레임 발견 - ${url.substring(0, 100)}`,
      );
      try {
        const cdpClient = await page.target().createCDPSession();
        await cdpClient.send("Runtime.enable");

        const { result: contexts } = await cdpClient.send("Runtime.evaluate", {
          expression: "true",
          returnByValue: true,
        });

        // 프레임에 직접 접근 시도
        const hasInput = await f.$(inputSelector);
        if (hasInput) {
          console.log(`${logPrefix} OOPIF CDP: f.$() 재시도 성공!`);
          await cdpClient.detach();
          return f;
        }
        await cdpClient.detach();
      } catch (e) {
        console.log(`${logPrefix} OOPIF CDP: 프레임 재시도 실패 - ${e.message}`);
      }
    }
  }

  console.log(`${logPrefix} OOPIF CDP: Daum 프레임 찾기 실패`);
  return null;
}

/**
 * CDP 세션을 puppeteer Frame처럼 사용할 수 있는 프록시 객체 생성
 */
function createCDPFrameProxy(cdpClient) {
  return {
    async $(selector) {
      const result = await cdpClient.send("Runtime.evaluate", {
        expression: `document.querySelector('${selector.replace(/'/g, "\\'")}')`,
        returnByValue: false,
      });
      if (
        !result.result ||
        result.result.type === "undefined" ||
        result.result.subtype === "null"
      ) {
        return null;
      }
      const objectId = result.result.objectId;
      return createCDPElementProxy(cdpClient, objectId, selector);
    },

    async evaluate(fn, ...args) {
      const fnStr = fn.toString();
      const argsStr = args.map((a) => JSON.stringify(a)).join(", ");
      const expression = `(${fnStr})(${argsStr})`;
      const result = await cdpClient.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || "evaluate failed");
      }
      return result.result?.value;
    },

    async waitForSelector(selector, options = {}) {
      const timeout = options.timeout || 5000;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const el = await this.$(selector);
        if (el) return el;
        await delay(300);
      }
      throw new Error(`waitForSelector timeout: ${selector}`);
    },

    keyboard: {
      async press(key) {
        const keyMap = { Enter: 13, Tab: 9, Escape: 27 };
        const keyCode = keyMap[key] || 0;
        await cdpClient.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key,
          code: `Key${key}`,
          windowsVirtualKeyCode: keyCode,
          nativeVirtualKeyCode: keyCode,
        });
        await delay(50);
        await cdpClient.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key,
          code: `Key${key}`,
          windowsVirtualKeyCode: keyCode,
          nativeVirtualKeyCode: keyCode,
        });
      },
    },

    _cdpClient: cdpClient,
    _isCDPProxy: true,
  };
}

/**
 * CDP 엘리먼트 프록시 - puppeteer ElementHandle처럼 사용
 */
function createCDPElementProxy(cdpClient, objectId, selector) {
  return {
    async click() {
      const boxResult = await cdpClient.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function() {
          const rect = this.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }`,
        returnByValue: true,
      });
      const { x, y } = boxResult.result.value;
      await cdpClient.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await delay(50);
      await cdpClient.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
    },

    async type(text, options = {}) {
      await cdpClient.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function() { this.focus(); }",
      });
      await delay(100);

      const charDelay = options.delay || 0;
      for (const char of text) {
        await cdpClient.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          text: char,
          unmodifiedText: char,
          key: char,
        });
        await cdpClient.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: char,
        });
        if (charDelay > 0) await delay(charDelay);
      }
    },

    _objectId: objectId,
    _selector: selector,
  };
}

/**
 * CDP 프록시 프레임 사용 후 세션 정리
 */
async function cleanupCDPFrame(frame, logPrefix = "[daum-address]") {
  if (frame?._isCDPProxy && frame._cdpClient) {
    try {
      await frame._cdpClient.detach();
      console.log(`${logPrefix} CDP 세션 정리 완료`);
    } catch (e) {
      console.log(`${logPrefix} CDP 세션 정리 실패 (이미 닫힘?): ${e.message}`);
    }
    frame._cdpClient = null;
  }
}

/**
 * iframe 내에서 주소 검색어 입력 + 검색 실행
 * @param {Object} frame - Daum 주소 iframe (또는 CDP 프록시)
 * @param {string} searchAddress - 검색할 주소
 * @param {string} inputSelector - 주소 input 셀렉터 (기본: #region_name)
 * @param {string} searchBtnSelector - 검색 버튼 셀렉터 (기본: .btn_search)
 * @param {string} logPrefix - 로그 prefix
 */
async function searchAddressInFrame(frame, searchAddress, inputSelector = "#region_name", searchBtnSelector = ".btn_search", logPrefix = "[daum-address]") {
  if (!searchAddress) {
    console.log(`${logPrefix} ❌ 검색할 주소가 비어있음`);
    return { success: false, error: "검색할 주소가 비어있음" };
  }

  // iframe 내 input 로딩 대기 (최대 10초)
  let addressInput = null;
  for (let i = 0; i < 20; i++) {
    addressInput = await frame.$(inputSelector);
    if (addressInput) break;
    await delay(500);
  }
  if (!addressInput) {
    console.log(`${logPrefix} ❌ 주소 검색 input 못찾음 (10초 대기 후)`);
    return { success: false, error: "주소 검색 input 못찾음" };
  }

  await addressInput.click();
  await addressInput.type(searchAddress, { delay: 50 });
  console.log(`${logPrefix} 주소 검색어: ${searchAddress}`);
  await delay(300);

  const searchBtn = await frame.$(searchBtnSelector);
  if (searchBtn) {
    await searchBtn.click();
    console.log(`${logPrefix} 검색 버튼 클릭`);
  } else {
    await frame.keyboard.press("Enter");
    console.log(`${logPrefix} Enter 키로 검색`);
  }
  await delay(1500);

  return { success: true };
}

/**
 * 주소 검색 결과 첫 번째 항목 클릭 (도로명 > 지번 순)
 * @param {Object} frame - Daum 주소 iframe (또는 CDP 프록시)
 * @param {string} itemSelector - 결과 항목 셀렉터 (기본: li.list_post_item)
 * @param {string} logPrefix - 로그 prefix
 */
async function selectAddressResult(frame, itemSelector = "li.list_post_item", logPrefix = "[daum-address]") {
  try {
    await frame.waitForSelector(itemSelector, { timeout: 5000 });
    await delay(500);

    const addressClicked = await frame.evaluate((selector) => {
      const firstItem = document.querySelector(selector);
      if (!firstItem) return { clicked: false };

      // 1순위: 도로명 주소 링크
      const roadAddrBtn =
        firstItem.querySelector(".main_road .link_post") ||
        firstItem.querySelector(".rel_road .link_post");
      if (roadAddrBtn) {
        roadAddrBtn.click();
        return {
          clicked: true,
          type: "road_button",
          text: roadAddrBtn.textContent?.trim().substring(0, 50),
        };
      }

      // 2순위: 지번 주소 링크
      const jibunAddrBtn =
        firstItem.querySelector(".main_jibun .link_post") ||
        firstItem.querySelector(".main_address .link_post");
      if (jibunAddrBtn) {
        jibunAddrBtn.click();
        return {
          clicked: true,
          type: "jibun_button",
          text: jibunAddrBtn.textContent?.trim().substring(0, 50),
        };
      }

      return { clicked: false };
    }, itemSelector);

    if (addressClicked.clicked) {
      console.log(`${logPrefix} 주소 선택 완료 (${addressClicked.type}): ${addressClicked.text}`);
      await delay(1500);
      return { success: true, ...addressClicked };
    } else {
      console.log(`${logPrefix} ❌ 주소 검색 결과에서 클릭 가능한 버튼 없음`);
      return { success: false, error: "주소 검색 결과에서 클릭 가능한 버튼 없음" };
    }
  } catch (e) {
    console.log(`${logPrefix} ❌ 주소 선택 에러: ${e.message}`);
    return { success: false, error: `주소 선택 에러: ${e.message}` };
  }
}

module.exports = {
  findDaumFrameViaCDP,
  createCDPFrameProxy,
  createCDPElementProxy,
  cleanupCDPFrame,
  searchAddressInFrame,
  selectAddressResult,
};
