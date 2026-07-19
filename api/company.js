const fs = require("fs");
const path = require("path");

const EXACT_ALIASES = {
  revenue: ["매출액", "수익(매출액)", "영업수익"],
  opIncome: ["영업이익", "영업이익(손실)"],
  netIncome: ["당기순이익", "당기순이익(손실)"],
  currAssets: ["유동자산"],
  currLiab: ["유동부채"],
  totalAssets: ["자산총계"],
  totalLiab: ["부채총계"],
  totalEquity: ["자본총계"],
};
const EXCLUDE_SUBSTR = ["지배기업", "비지배", "지배주주", "소유주"];
const VALID_SJ = new Set(["BS", "IS", "CIS"]);

function toNumber(s) {
  if (s === null || s === undefined) return null;
  s = String(s).trim();
  if (!s || s === "-") return null;
  const neg = s.startsWith("(") && s.endsWith(")");
  s = s.replace(/,/g, "").replace(/[()]/g, "");
  const v = parseFloat(s);
  if (Number.isNaN(v)) return null;
  return neg ? -v : v;
}

function pickItem(items, aliases) {
  const pool = items.filter((it) => VALID_SJ.has(it.sj_div));
  for (const alias of aliases) {
    const hit = pool.find((it) => (it.account_nm || "").trim() === alias && !EXCLUDE_SUBSTR.some((x) => (it.account_nm || "").includes(x)));
    if (hit) return hit;
  }
  for (const alias of aliases) {
    const hit = pool.find((it) => (it.account_nm || "").includes(alias) && !EXCLUDE_SUBSTR.some((x) => (it.account_nm || "").includes(x)));
    if (hit) return hit;
  }
  return null;
}

function extractPeriods(items, aliases) {
  const it = pickItem(items, aliases);
  if (!it) return { thstrm: null, frmtrm: null, bfefrmtrm: null, accountNm: null };
  return {
    thstrm: toNumber(it.thstrm_amount),
    frmtrm: toNumber(it.frmtrm_amount),
    bfefrmtrm: toNumber(it.bfefrmtrm_amount),
    accountNm: it.account_nm,
  };
}

async function dartGet(url, params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${url}?${qs}`);
  if (!r.ok) throw new Error(`DART HTTP ${r.status}`);
  return r.json();
}

async function fetchFinancials(apiKey, corpCode, bsnsYear, fsDiv) {
  return dartGet("https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json", {
    crtfc_key: apiKey,
    corp_code: corpCode,
    bsns_year: String(bsnsYear),
    reprt_code: "11011",
    fs_div: fsDiv,
  });
}

async function fetchDividend(apiKey, corpCode, bsnsYear) {
  return dartGet("https://opendart.fss.or.kr/api/alotMatter.json", {
    crtfc_key: apiKey,
    corp_code: corpCode,
    bsns_year: String(bsnsYear),
    reprt_code: "11011",
  });
}

async function tryFetchBest(apiKey, corpCode) {
  const now = new Date();
  const guess = now.getUTCFullYear() - 1; // most recent annual report is usually filed by ~March of guess+1
  const candidateYears = [guess, guess - 1, guess - 2];
  for (const year of candidateYears) {
    for (const fsDiv of ["CFS", "OFS"]) {
      const data = await fetchFinancials(apiKey, corpCode, year, fsDiv);
      if (data.status === "000" && Array.isArray(data.list) && data.list.length) {
        return { year, fsDiv, items: data.list };
      }
    }
  }
  return { year: null, fsDiv: null, items: [] };
}

function findAlotItem(items, seCandidates) {
  for (const se of seCandidates) {
    const hit = items.find((it) => (it.se || "").trim() === se);
    if (hit) return hit;
  }
  return null;
}

let STOCK_BY_CORP_CODE = null;
function stockCodeFor(corpCode) {
  if (!STOCK_BY_CORP_CODE) {
    const p = path.join(__dirname, "..", "data", "listed_companies.json");
    const list = JSON.parse(fs.readFileSync(p, "utf-8"));
    STOCK_BY_CORP_CODE = {};
    for (const c of list) STOCK_BY_CORP_CODE[c.code] = c.stock;
  }
  return STOCK_BY_CORP_CODE[corpCode] || null;
}

// KRX KIND 기업밸류업 "고배당기업 현황" 자율공시 조회 (조세특례제한법 제104조의27④의
// 기업 자체 요건 공시와는 별개 창구이지만, 같은 배당성향/증가율 수치를 기업이 직접 공시함 — 교차검증용).
// 핵심: 쿼리스트링(?method=...)이 붙은 URL로 POST하면 풀페이지가 반환되고, 붙이지 않아야
// AJAX 조각(HTML fragment)이 반환된다 — 실제 페이지의 jQuery ajaxSubmit 호출을 그대로 재현.
async function checkKrxDisclosure(stockCode) {
  if (!stockCode) return { checked: false, found: false, reason: "종목코드 없음" };
  const isurCd = stockCode.slice(0, 5);
  const body = new URLSearchParams({
    method: "valueupHighDividendSub",
    currentPageSize: "15",
    pageIndex: "1",
    orderMode: "0",
    orderStat: "D",
    repIsuSrtCd: stockCode,
    isurCd,
    forward: "valueupHighDividend_sub",
    searchCorpName: "",
    allRepIsuSrtCd: "",
    marketType: "",
    selYear: "",
    acntclsMm: "",
  });
  try {
    const r = await fetch("https://kind.krx.co.kr/valueup/dividend.do", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!r.ok) return { checked: false, found: false, error: `KRX HTTP ${r.status}` };
    const text = await r.text();
    if (text.includes("조회된 결과값이 없습니다")) {
      return { checked: true, found: false };
    }
    const rowRe = /<td class="first txc">(\d{4})<\/td>\s*<td class="first txc">(\d{2})<\/td>\s*<td class="first txc">([\d.]+)<\/td>\s*<td class="first txc">(-?[\d.]+)<\/td>/;
    const m = text.match(rowRe);
    if (!m) return { checked: true, found: false, note: "응답 형식 해석 실패" };
    const rceptMatch = text.match(/openDisclsViewer\('(\d+)'/);
    return {
      checked: true,
      found: true,
      bsnsYear: parseInt(m[1], 10),
      settleMonth: m[2],
      payoutPct: parseFloat(m[3]),
      growthPct: parseFloat(m[4]),
      rceptNo: rceptMatch ? rceptMatch[1] : null,
    };
  } catch (err) {
    return { checked: false, found: false, error: err.message };
  }
}

async function getDividendData(apiKey, corpCode, year) {
  const [dataA, dataB] = await Promise.all([
    fetchDividend(apiKey, corpCode, year),
    fetchDividend(apiKey, corpCode, year - 1),
  ]);
  const itemsA = dataA.status === "000" ? dataA.list || [] : [];
  const itemsB = dataB.status === "000" ? dataB.list || [] : [];

  const cashA = findAlotItem(itemsA, ["현금배당금총액(백만원)"]);
  const payA = findAlotItem(itemsA, ["(연결)현금배당성향(%)", "현금배당성향(%)"]);
  const cashB = findAlotItem(itemsB, ["현금배당금총액(백만원)"]);
  const payB = findAlotItem(itemsB, ["(연결)현금배당성향(%)", "현금배당성향(%)"]);

  const toWon = (v) => (v === null ? null : v * 1_000_000);

  const dividendByYear = {
    [year]: toWon(cashA ? toNumber(cashA.thstrm) : null),
    [year - 1]: toWon(cashA ? toNumber(cashA.frmtrm) : null),
    [year - 2]: toWon(cashA ? toNumber(cashA.lwfr) : null),
    [year - 3]: toWon(cashB ? toNumber(cashB.lwfr) : null),
  };
  const payoutPctByYear = {
    [year]: payA ? toNumber(payA.thstrm) : null,
    [year - 1]: payA ? toNumber(payA.frmtrm) : null,
    [year - 2]: payA ? toNumber(payA.lwfr) : null,
    [year - 3]: payB ? toNumber(payB.lwfr) : null,
  };
  return { dividendByYear, payoutPctByYear };
}

// 조세특례제한법 제104조의27(고배당기업 주식 배당소득에 대한 과세특례), [본조신설 2025.12.23.]
// 요건(모두 충족해야 "고배당기업"):
//   ① 사업연도 종료일 현재 코스피·코스닥 상장법인일 것 (코넥스·투자회사 등 제외 - 이 도구는 미확인, 검색 대상이
//      DART 상장기업 목록이므로 코넥스가 섞여 있을 수 있음)
//   ② 직전 사업연도 배당소득이 2024년 12월 31일이 속하는 사업연도보다 감소하지 않았을 것
//   ③ 가) 직전 사업연도 배당성향 40% 이상, 또는
//      나) 직전 사업연도 배당성향 25% 이상 AND 이익배당금액이 전전 사업연도 대비 10% 이상 증가
function computeTaxEligibility(year, dividendByYear, payoutPctByYear) {
  const divThis = dividendByYear[year];           // 직전 사업연도 배당금 (예: 2025)
  const divBaseline2024 = dividendByYear[2024];    // 법조문상 고정 기준연도(2024년) 배당금
  const divOneYearAgo = dividendByYear[year - 1];  // 전전 사업연도 배당금 (예: 2024)
  const payoutThis = payoutPctByYear[year];        // 직전 사업연도 배당성향(%)

  const haveNonDecreaseData = divThis !== null && divThis !== undefined && divBaseline2024 !== null && divBaseline2024 !== undefined;
  const nonDecreasePass = haveNonDecreaseData ? divThis >= divBaseline2024 : null;

  const havePayout = payoutThis !== null && payoutThis !== undefined;
  const payoutFrac = havePayout ? payoutThis / 100 : null;

  const growth = (divOneYearAgo !== null && divOneYearAgo !== undefined && divOneYearAgo !== 0 && divThis !== null && divThis !== undefined)
    ? divThis / divOneYearAgo - 1
    : null;

  const pass40 = havePayout ? payoutFrac >= 0.4 : null;
  const pass25Growth10 = (havePayout && growth !== null) ? (payoutFrac >= 0.25 && growth >= 0.10) : null;
  const condB = (pass40 === true || pass25Growth10 === true) ? true : (havePayout ? false : null);

  const conditions = [
    {
      key: "listed",
      label: "① 코스피·코스닥 상장법인 (코넥스·투자회사 제외)",
      pass: null,
      detail: "이 도구는 상장 여부만 확인하며 코넥스·투자회사 해당 여부는 확인하지 않음",
    },
    {
      key: "nonDecrease",
      label: `② 직전사업연도(${year}) 배당액, 2024사업연도 대비 비감소`,
      pass: nonDecreasePass,
      detail: haveNonDecreaseData
        ? `${year}년 ${Math.round(divThis).toLocaleString("ko-KR")}원 vs 2024년 ${Math.round(divBaseline2024).toLocaleString("ko-KR")}원`
        : "배당 데이터 부족",
    },
    {
      key: "payout40",
      label: "③-가 배당성향 40% 이상",
      pass: pass40,
      detail: havePayout ? `배당성향 ${payoutThis.toFixed(1)}%` : "배당성향 공시 없음",
    },
    {
      key: "payout25Growth10",
      label: "③-나 배당성향 25% 이상 AND 전전사업연도 대비 10% 이상 증가",
      pass: pass25Growth10,
      detail: (havePayout && growth !== null)
        ? `배당성향 ${payoutThis.toFixed(1)}%, 증가율 ${(growth * 100).toFixed(1)}%`
        : "배당성향 또는 전전사업연도 배당 데이터 부족",
    },
  ];

  const growthTxt = growth !== null ? `${(growth * 100).toFixed(1)}%` : "N/A(자료부족)";
  const payoutTxt = havePayout ? `${payoutThis.toFixed(1)}%` : "N/A";
  const detail = `배당성향 ${payoutTxt} · 전전사업연도 대비 ${growthTxt}`;

  let status;
  if (!haveNonDecreaseData || !havePayout) {
    status = "unknown";
  } else if (nonDecreasePass && condB) {
    status = "yes";
  } else {
    status = "no";
  }

  const condBWhy = pass40 ? "배당성향 40%+" : pass25Growth10 ? "배당성향 25%+ 및 전전사업연도 대비 10%+ 증가" : null;

  return {
    status,
    detail: status === "yes" ? `${detail} (${condBWhy})` : detail,
    basis: {
      bsnsYear: year,
      payoutPct: payoutThis,
      growthPct: growth !== null ? growth * 100 : null,
      dividendThis: divThis,
      dividendBaseline2024: divBaseline2024,
      dividendOneYearAgo: divOneYearAgo,
    },
    conditions,
  };
}

module.exports = async (req, res) => {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "서버에 DART_API_KEY 환경변수가 설정되어 있지 않습니다." });
    return;
  }

  const url = new URL(req.url, "http://x");
  const corpCode = (req.query && req.query.code) || url.searchParams.get("code");
  const name = (req.query && req.query.name) || url.searchParams.get("name") || "";

  if (!corpCode) {
    res.status(400).json({ error: "code 파라미터(corp_code)가 필요합니다." });
    return;
  }

  try {
    const { year, fsDiv, items } = await tryFetchBest(apiKey, corpCode);
    if (!year) {
      res.status(404).json({ error: `${name || corpCode}: 최근 3개년 사업보고서 재무데이터를 찾을 수 없습니다.` });
      return;
    }

    const periods = {};
    for (const key of Object.keys(EXACT_ALIASES)) {
      periods[key] = extractPeriods(items, EXACT_ALIASES[key]);
    }

    const years = [year - 2, year - 1, year];
    const toSeries = (key) => [periods[key].bfefrmtrm, periods[key].frmtrm, periods[key].thstrm];

    const stockCode = stockCodeFor(corpCode);
    const [{ dividendByYear, payoutPctByYear }, krx] = await Promise.all([
      getDividendData(apiKey, corpCode, year),
      checkKrxDisclosure(stockCode),
    ]);
    const tax = computeTaxEligibility(year, dividendByYear, payoutPctByYear);

    if (krx.found) {
      const ourPayout = tax.basis.payoutPct;
      const ourGrowth = tax.basis.growthPct;
      const closeEnough = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(a - b) < 1.0;
      krx.matchesOurCalc = closeEnough(ourPayout, krx.payoutPct) && closeEnough(ourGrowth, krx.growthPct);
    }
    tax.krx = krx;

    res.status(200).json({
      name,
      corpCode,
      bsnsYear: year,
      fsDiv,
      years,
      revenue: toSeries("revenue"),
      opIncome: toSeries("opIncome"),
      netIncome: toSeries("netIncome"),
      totalAssets: toSeries("totalAssets"),
      totalLiab: toSeries("totalLiab"),
      totalEquity: toSeries("totalEquity"),
      currAssets: toSeries("currAssets"),
      currLiab: toSeries("currLiab"),
      tax,
    });
  } catch (err) {
    res.status(502).json({ error: `DART 조회 중 오류: ${err.message}` });
  }
};
