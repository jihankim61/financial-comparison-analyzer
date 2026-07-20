const fs = require("fs");
const path = require("path");

const EXACT_ALIASES = {
  revenue: ["매출액", "수익(매출액)", "영업수익"],
  opIncome: ["영업이익", "영업이익(손실)", "영업손실"],
  // 회사마다 손익 부호에 따라 계정명을 다르게 씀: "당기순이익", "당기순이익(손실)"(흑자/적자 겸용),
  // "당기순손실"(적자 전용, 예: SK이노베이션), "당기순손익"(흑자/적자 중립 표기, 예: 카카오페이) 등.
  netIncome: ["당기순이익", "당기순이익(손실)", "당기순손실", "당기순손익"],
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

// 시행령 제104조의24④1호: 연결재무제표 작성법인은 배당성향 산정 시 "지배회사 소유주지분
// 당기순이익"을 분모로 써야 한다 (총 당기순이익이 아님).
//
// 문제는 이 계정의 실제 표기가 회사마다 제각각이라는 것 — 삼성전자는 "지배기업 소유주지분"
// (공백 있음, "당기순이익" 접미사 없음), 카카오페이는 "지배기업소유주지분"(공백 없음) 처럼
// 그 자체로는 "당기순이익"이라는 단어를 포함하지 않는 경우가 많다. 대신 이 항목은 항상
// "당기순이익/당기순손실/당기순손익" 합계 행 바로 다음 줄(ord 순서상 인접)에 "비지배지분"과
// 나란히 나오는 손익 분해 항목이므로, 합계 행의 ord 값에 가장 가까운 후보를 고른다.
// 그래도 못 찾으면 "총당기순이익 - 비지배지분"으로 역산하고, 비지배지분 행 자체가 없으면
// (자회사가 없거나 완전자회사만 있는 경우) 총당기순이익 = 지배주주지분으로 본다.
function isControllingLabel(nm) {
  return nm.includes("지배") && !nm.includes("비지배") && (nm.includes("소유주") || nm.includes("지분"));
}
function isNonControllingLabel(nm) {
  return nm.includes("비지배");
}
function closestByOrd(candidates, baseOrd) {
  const withDelta = candidates.map((it) => ({ it, delta: Number(it.ord) - baseOrd }));
  withDelta.sort((a, b) => {
    const aFwd = a.delta >= 0, bFwd = b.delta >= 0;
    if (aFwd !== bFwd) return aFwd ? -1 : 1; // 합계 행보다 뒤에 나오는(ord가 큰) 항목을 우선
    return Math.abs(a.delta) - Math.abs(b.delta);
  });
  return withDelta[0].it;
}
function pickControllingNetIncome(items, totalNetIncomeItem) {
  if (!totalNetIncomeItem) return null;
  const pool = items.filter((it) => it.sj_div === totalNetIncomeItem.sj_div);
  const baseOrd = Number(totalNetIncomeItem.ord);

  const controllingCandidates = pool.filter((it) => isControllingLabel(it.account_nm || ""));
  if (controllingCandidates.length) {
    const best = closestByOrd(controllingCandidates, baseOrd);
    const v = toNumber(best.thstrm_amount);
    if (v !== null) return { amount: v, method: `직접 매칭(${best.account_nm})` };
  }

  const ncCandidates = pool.filter((it) => isNonControllingLabel(it.account_nm || ""));
  if (ncCandidates.length) {
    const nc = toNumber(closestByOrd(ncCandidates, baseOrd).thstrm_amount);
    const total = toNumber(totalNetIncomeItem.thstrm_amount);
    if (nc !== null && total !== null) return { amount: total - nc, method: "역산(총당기순이익 - 비지배지분)" };
  }

  const total = toNumber(totalNetIncomeItem.thstrm_amount);
  if (total !== null) return { amount: total, method: "비지배지분 없음(총당기순이익 = 지배주주지분으로 간주)" };
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

// KRX KIND 기업밸류업 "고배당기업 현황" 공시 조회.
// 조세특례제한법 시행령(2026.2.24. 국무회의 의결)에 따라, 고배당기업은 정기주주총회 이익배당
// 결의 다음 날까지 한국거래소 상장공시제출시스템을 통해 "기업가치 제고계획" 공시로 요건 충족
// 실적(배당성향, 전전사업연도 대비 배당 증가율 등)을 제출해야 한다. 공시명에는 "(자율공시)"라고
// 표시되지만 고배당기업에게는 법정 의무 제출이다 — 이 함수는 그 공시를 조회해 본 계산과 대조한다.
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

// 시행령 제104조의24⑤: 배당성향 산정연도(직전사업연도)의 당기순이익(연결법인은 지배주주지분
// 기준)이 0원 이하이면 배당성향을 100분의 25로 간주한다. 다만 부채총액이 자본총액의 2배를
// 초과하는(자본잠식 포함) 고레버리지 법인은 배당성향을 0으로 간주한다.
function applyNetLossOverride(reportedPayoutPct, netIncomeForCheck, totalEquityThis, totalLiabThis) {
  if (netIncomeForCheck === null || netIncomeForCheck === undefined) {
    return { payoutPct: reportedPayoutPct, overridden: false, reason: null, dataMissing: true };
  }
  if (netIncomeForCheck > 0) {
    return { payoutPct: reportedPayoutPct, overridden: false, reason: null, dataMissing: false };
  }
  const haveLeverage = totalEquityThis !== null && totalEquityThis !== undefined && totalLiabThis !== null && totalLiabThis !== undefined;
  const highLeverage = haveLeverage ? (totalEquityThis <= 0 || totalLiabThis > totalEquityThis * 2) : null;

  if (highLeverage === true) {
    return { payoutPct: 0, overridden: true, reason: "당기순손실 + 부채 자본 2배 초과(또는 자본잠식) → 배당성향 0%로 간주 (시행령 제104조의24⑤)", dataMissing: false };
  }
  if (highLeverage === false) {
    return { payoutPct: 25, overridden: true, reason: "당기순손실 → 배당성향 25%로 간주 (시행령 제104조의24⑤)", dataMissing: false };
  }
  return { payoutPct: 25, overridden: true, reason: "당기순손실 → 배당성향 25%로 간주 (부채·자본 데이터 부족으로 고레버리지 예외는 미반영)", dataMissing: true };
}

// 조세특례제한법 제104조의27(고배당기업 주식 배당소득에 대한 과세특례), [본조신설 2025.12.23.]
// + 시행령 제104조의24(2026.2.27. 본조신설)
// 요건(모두 충족해야 "고배당기업"):
//   ① 사업연도 종료일 현재 코스피·코스닥 상장법인일 것 (코넥스·투자회사 등 제외 - 이 도구는 미확인, 검색 대상이
//      DART 상장기업 목록이므로 코넥스가 섞여 있을 수 있음)
//   ② 직전 사업연도 배당소득이 2024년 12월 31일이 속하는 사업연도보다 감소하지 않았을 것
//   ③ 가) 직전 사업연도 배당성향 40% 이상, 또는
//      나) 직전 사업연도 배당성향 25% 이상 AND 이익배당금액이 전전 사업연도 대비 10% 이상 증가
//   ※ 배당성향은 연결법인의 경우 지배주주지분 당기순이익 기준(시행령④), 당기순이익 0원 이하 시
//      25%(고레버리지는 0%)로 간주(시행령⑤)
function computeTaxEligibility(year, dividendByYear, payoutPctByYear, netIncomeForCheck, totalEquityThis, totalLiabThis) {
  const divThis = dividendByYear[year];           // 직전 사업연도 배당금 (예: 2025)
  const divBaseline2024 = dividendByYear[2024];    // 법조문상 고정 기준연도(2024년) 배당금
  const divOneYearAgo = dividendByYear[year - 1];  // 전전 사업연도 배당금 (예: 2024)
  const reportedPayout = payoutPctByYear[year];    // DART 공시 배당성향(%) — 시행령⑤ 반영 전 원본값

  const haveNonDecreaseData = divThis !== null && divThis !== undefined && divBaseline2024 !== null && divBaseline2024 !== undefined;
  const nonDecreasePass = haveNonDecreaseData ? divThis >= divBaseline2024 : null;

  const override = applyNetLossOverride(reportedPayout, netIncomeForCheck, totalEquityThis, totalLiabThis);
  const payoutThis = override.overridden ? override.payoutPct : reportedPayout;
  const havePayout = payoutThis !== null && payoutThis !== undefined;
  const payoutFrac = havePayout ? payoutThis / 100 : null;

  const growth = (divOneYearAgo !== null && divOneYearAgo !== undefined && divOneYearAgo !== 0 && divThis !== null && divThis !== undefined)
    ? divThis / divOneYearAgo - 1
    : null;

  const pass40 = havePayout ? payoutFrac >= 0.4 : null;
  const pass25Growth10 = (havePayout && growth !== null) ? (payoutFrac >= 0.25 && growth >= 0.10) : null;
  const condB = (pass40 === true || pass25Growth10 === true) ? true : (havePayout ? false : null);

  const payoutDetailTxt = havePayout
    ? (override.overridden ? `배당성향 ${payoutThis.toFixed(1)}% (시행령⑤ 간주, 원 공시값 ${reportedPayout === null || reportedPayout === undefined ? "N/A" : reportedPayout.toFixed(1) + "%"})` : `배당성향 ${payoutThis.toFixed(1)}%`)
    : "배당성향 공시 없음";

  const fmtWon = (n) => (n === null || n === undefined) ? "N/A" : `${Math.round(n).toLocaleString("ko-KR")}원`;
  const fmtPct = (n) => (n === null || n === undefined) ? "N/A" : `${n.toFixed(1)}%`;

  // metrics: 조건마다 "실제값 vs 기준값"을 그대로 숫자로 노출 — 텍스트 설명 없이도 판정 근거를 바로 확인 가능
  const conditions = [
    {
      key: "listed",
      label: "① 코스피·코스닥 상장법인 (코넥스·투자회사 제외)",
      pass: null,
      detail: "이 도구는 상장 여부만 확인하며 코넥스·투자회사 해당 여부는 확인하지 않음",
      metrics: [],
    },
    {
      key: "nonDecrease",
      label: `② 직전사업연도(${year}) 배당액, 2024사업연도 대비 비감소`,
      pass: nonDecreasePass,
      detail: haveNonDecreaseData ? null : "배당 데이터 부족",
      metrics: haveNonDecreaseData ? [{
        label: `${year}년 배당금 vs 2024년 배당금`,
        actual: divThis, actualFmt: fmtWon(divThis),
        threshold: divBaseline2024, thresholdFmt: fmtWon(divBaseline2024),
        comparator: ">=", pass: nonDecreasePass,
      }] : [],
    },
    {
      key: "payout40",
      label: "③-가 배당성향 40% 이상",
      pass: pass40,
      detail: override.overridden ? `시행령⑤ 간주 적용 (원 공시값 ${fmtPct(reportedPayout)})` : null,
      metrics: havePayout ? [{
        label: "배당성향",
        actual: payoutThis, actualFmt: fmtPct(payoutThis),
        threshold: 40, thresholdFmt: "40.0%",
        comparator: ">=", pass: pass40,
      }] : [],
    },
    {
      key: "payout25Growth10",
      label: "③-나 배당성향 25% 이상 AND 전전사업연도 대비 10% 이상 증가",
      pass: pass25Growth10,
      detail: (havePayout && growth !== null) ? (override.overridden ? `시행령⑤ 간주 적용 (원 공시값 ${fmtPct(reportedPayout)})` : null) : "배당성향 또는 전전사업연도 배당 데이터 부족",
      metrics: (havePayout && growth !== null) ? [
        {
          label: "배당성향",
          actual: payoutThis, actualFmt: fmtPct(payoutThis),
          threshold: 25, thresholdFmt: "25.0%",
          comparator: ">=", pass: payoutFrac >= 0.25,
        },
        {
          label: "전전사업연도 대비 증가율",
          actual: growth * 100, actualFmt: fmtPct(growth * 100),
          threshold: 10, thresholdFmt: "10.0%",
          comparator: ">=", pass: growth >= 0.10,
        },
      ] : [],
    },
  ];
  if (override.overridden) {
    conditions.push({
      key: "netLossOverride",
      label: "※ 시행령 제104조의24⑤ 당기순손실 간주규정 적용",
      pass: null,
      detail: override.reason,
      metrics: [{
        label: "직전사업연도 당기순이익(지배주주지분 기준)",
        actual: netIncomeForCheck, actualFmt: fmtWon(netIncomeForCheck),
        threshold: 0, thresholdFmt: "0원",
        comparator: ">", pass: netIncomeForCheck !== null && netIncomeForCheck !== undefined ? netIncomeForCheck > 0 : null,
      }],
    });
  }

  const growthTxt = growth !== null ? `${(growth * 100).toFixed(1)}%` : "N/A(자료부족)";
  const payoutTxt = havePayout ? `${payoutThis.toFixed(1)}%${override.overridden ? "(간주)" : ""}` : "N/A";
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
      reportedPayoutPct: reportedPayout,
      payoutOverridden: override.overridden,
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

    // 시행령 제104조의24④1호: 연결재무제표는 지배주주지분 당기순이익을 배당성향 분모로 써야 함.
    // 못 찾으면 총 당기순이익으로 대체(근사치)하고 그 사실을 표시한다.
    let netIncomeForCheck = periods.netIncome.thstrm;
    let netIncomeBasisNote = fsDiv === "OFS" ? "별도재무제표 당기순이익" : "연결 총당기순이익(지배주주지분 항목 미확인, 근사치)";
    if (fsDiv === "CFS") {
      const totalNetIncomeItem = pickItem(items, EXACT_ALIASES.netIncome);
      const controllingNI = pickControllingNetIncome(items, totalNetIncomeItem);
      if (controllingNI && controllingNI.amount !== null) {
        netIncomeForCheck = controllingNI.amount;
        netIncomeBasisNote = `연결 지배주주지분 당기순이익 (${controllingNI.method})`;
      }
    }

    const stockCode = stockCodeFor(corpCode);
    const [{ dividendByYear, payoutPctByYear }, krx] = await Promise.all([
      getDividendData(apiKey, corpCode, year),
      checkKrxDisclosure(stockCode),
    ]);
    const tax = computeTaxEligibility(
      year,
      dividendByYear,
      payoutPctByYear,
      netIncomeForCheck,
      periods.totalEquity.thstrm,
      periods.totalLiab.thstrm
    );
    tax.basis.netIncomeBasis = netIncomeBasisNote;

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
