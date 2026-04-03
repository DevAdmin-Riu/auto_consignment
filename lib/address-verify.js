/**
 * 배송지 검증 공통 모듈
 * - 카카오 주소 API로 도로명/지번 검색
 * - 화면에 표시된 배송지와 비교 검증
 */

const KAKAO_REST_API_KEY = "79dc6806a9d2eb8f19a6be309205f3c5";
const KAKAO_ADDRESS_API_URL = "https://dapi.kakao.com/v2/local/search/address.json";

/**
 * 카카오 주소 API로 주소 검색 (도로명/지번 둘 다 반환)
 */
async function searchAddressWithKakao(query) {
  const url = `${KAKAO_ADDRESS_API_URL}?query=${encodeURIComponent(query)}`;

  try {
    const response = await fetch(url, {
      headers: { Authorization: `KakaoAK ${KAKAO_REST_API_KEY}` },
    });
    const data = await response.json();

    if (!data.documents || data.documents.length === 0) {
      console.log(`[주소검증] 카카오 주소 검색 결과 없음: ${query}`);
      return null;
    }

    const doc = data.documents[0];
    const result = {
      roadAddress: doc.road_address
        ? doc.road_address.address_name
        : doc.address_name,
      jibunAddress: doc.address ? doc.address.address_name : null,
      roadAddressShort: doc.road_address
        ? `${doc.road_address.region_2depth_name} ${doc.road_address.road_name} ${doc.road_address.main_building_no}${doc.road_address.sub_building_no ? "-" + doc.road_address.sub_building_no : ""}`
        : null,
      jibunAddressShort: doc.address
        ? `${doc.address.region_2depth_name} ${doc.address.region_3depth_name} ${doc.address.main_address_no}${doc.address.sub_address_no ? "-" + doc.address.sub_address_no : ""}`
        : null,
    };

    console.log(`[주소검증] 카카오 결과 - 도로명: ${result.roadAddress}, 지번: ${result.jibunAddress}`);
    return result;
  } catch (e) {
    console.error(`[주소검증] 카카오 주소 API 에러: ${e.message}`);
    return null;
  }
}

/**
 * 주소 문자열 정규화 (비교용)
 */
function normalizeAddress(addr) {
  if (!addr) return "";
  return addr
    .replace(/\s+/g, " ")
    .replace(/특별시|광역시|특별자치시|특별자치도/g, "")
    .trim();
}

/**
 * 주소 핵심 부분 비교 (구/군 + 도로명/동 + 번지)
 */
function compareAddressCore(addr1, addr2) {
  // 숫자 패턴 추출 (번지/건물번호)
  const nums1 = addr1.match(/\d+(-\d+)?/g) || [];
  const nums2 = addr2.match(/\d+(-\d+)?/g) || [];

  if (nums1.length === 0 || nums2.length === 0) return false;
  const mainNum1 = nums1[nums1.length - 1];
  const mainNum2 = nums2[nums2.length - 1];
  if (mainNum1 !== mainNum2) return false;

  // 구/군 이름 비교
  const gu1 = addr1.match(/([가-힣]+[구군])/);
  const gu2 = addr2.match(/([가-힣]+[구군])/);
  if (gu1 && gu2 && gu1[1] !== gu2[1]) return false;

  // 도로명 or 동 이름 비교
  const road1 = addr1.match(/([가-힣]+[로길동리])\s/);
  const road2 = addr2.match(/([가-힣]+[로길동리])\s/);
  if (road1 && road2 && road1[1] === road2[1]) return true;

  return false;
}

/**
 * 화면에서 주소 텍스트 추출
 */
async function extractAddressFromPage(page) {
  return await page.evaluate(() => {
    const allText = document.body.innerText || "";
    const addressElements = [];

    const allEls = document.querySelectorAll("span, p, div, li");
    for (const el of allEls) {
      const text = (el.innerText || el.textContent || "").trim();
      if (
        text.length > 5 &&
        text.length < 100 &&
        (text.match(/[가-힣]+시\s/) || text.match(/[가-힣]+도\s/) || text.match(/[가-힣]+구\s/)) &&
        (text.includes("로 ") || text.includes("길 ") || text.includes("동 "))
      ) {
        addressElements.push(text);
      }
    }

    return {
      addressTexts: addressElements,
      fullText: allText.substring(0, 3000),
    };
  });
}

/**
 * 배송지 검증 - 화면에 표시된 주소를 카카오 API 결과와 비교
 * @param {Object} page - Puppeteer page
 * @param {Object} shippingAddress - 배송지 정보 (streetAddress1, streetAddress2 등)
 * @param {string} vendor - 벤더명 (로그용)
 * @returns {{ success: boolean, message: string }}
 */
async function verifyShippingAddressOnPage(page, shippingAddress, vendor = "") {
  const prefix = vendor ? `[${vendor}]` : "[주소검증]";

  try {
    const ourAddress = shippingAddress.streetAddress1 || shippingAddress.address || shippingAddress.streetAddress || "";
    const ourDetail = (shippingAddress.streetAddress2 || "").trim() || shippingAddress.firstName || "";

    if (!ourAddress) {
      return { success: false, message: "검증할 주소 없음" };
    }

    // 1. 카카오 API로 우리 주소 검색
    const kakaoResult = await searchAddressWithKakao(ourAddress);
    if (!kakaoResult) {
      console.log(`${prefix} 카카오 API 결과 없음 - 검증 스킵 (통과 처리)`);
      return { success: true, message: "카카오 API 결과 없음, 스킵" };
    }

    // 2. 화면에 표시된 배송지 텍스트 읽기
    const { delay } = require("./browser");
    await delay(1000);
    const displayedAddress = await extractAddressFromPage(page);

    console.log(`${prefix} 화면 주소 후보: ${JSON.stringify(displayedAddress.addressTexts)}`);

    // 3. 비교: 카카오 결과(도로명/지번) vs 화면 표시 주소
    const kakaoAddresses = [
      normalizeAddress(kakaoResult.roadAddress),
      normalizeAddress(kakaoResult.jibunAddress),
      normalizeAddress(kakaoResult.roadAddressShort),
      normalizeAddress(kakaoResult.jibunAddressShort),
    ].filter(Boolean);

    let addressMatched = false;
    let matchedDisplayed = "";
    let matchedKakao = "";

    for (const displayed of displayedAddress.addressTexts) {
      const normalizedDisplayed = normalizeAddress(displayed);
      for (const kakaoAddr of kakaoAddresses) {
        if (
          normalizedDisplayed.includes(kakaoAddr) ||
          kakaoAddr.includes(normalizedDisplayed) ||
          compareAddressCore(normalizedDisplayed, kakaoAddr)
        ) {
          addressMatched = true;
          matchedDisplayed = displayed;
          matchedKakao = kakaoAddr;
          break;
        }
      }
      if (addressMatched) break;
    }

    // 풀텍스트에서도 확인
    if (!addressMatched) {
      const normalizedFull = normalizeAddress(displayedAddress.fullText);
      for (const kakaoAddr of kakaoAddresses) {
        if (normalizedFull.includes(kakaoAddr)) {
          addressMatched = true;
          matchedKakao = kakaoAddr;
          matchedDisplayed = "(풀텍스트 매칭)";
          break;
        }
      }
    }

    if (!addressMatched) {
      console.error(`${prefix} 주소 불일치!`);
      console.error(`${prefix}   우리 주소: ${ourAddress}`);
      console.error(`${prefix}   카카오 도로명: ${kakaoResult.roadAddress}`);
      console.error(`${prefix}   카카오 지번: ${kakaoResult.jibunAddress}`);
      console.error(`${prefix}   화면 주소들: ${JSON.stringify(displayedAddress.addressTexts)}`);
      return { success: false, message: `주소 불일치 - 우리: ${ourAddress}, 화면: ${displayedAddress.addressTexts.join(" / ")}` };
    }

    console.log(`${prefix} 주소 매칭 성공: "${matchedDisplayed}" ↔ "${matchedKakao}"`);

    // 4. 상세주소 검증 (20자 기준 — 배민 등 글자수 제한으로 잘리는 경우 대응)
    if (ourDetail) {
      const normalizedFull = normalizeAddress(displayedAddress.fullText);
      const normalizedDetail = normalizeAddress(ourDetail).substring(0, 20);
      if (normalizedFull.includes(normalizedDetail)) {
        console.log(`${prefix} 상세주소 매칭 성공: "${ourDetail}"`);
      } else {
        console.error(`${prefix} 상세주소 불일치! 우리: "${ourDetail}" (비교기준: "${normalizedDetail}")`);
        return { success: false, message: `상세주소 불일치 - 우리: ${ourDetail}` };
      }
    }

    return { success: true, message: "주소 검증 통과" };
  } catch (e) {
    console.error(`${prefix} 배송지 검증 에러: ${e.message}`);
    return { success: false, message: `검증 에러: ${e.message}` };
  }
}

module.exports = {
  searchAddressWithKakao,
  normalizeAddress,
  compareAddressCore,
  extractAddressFromPage,
  verifyShippingAddressOnPage,
};
