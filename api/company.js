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

function computeTaxEligibility(year, dividendByYear, payoutPctByYear) {
  const divThis = dividendByYear[year];
  const divPrev = dividendByYear[year - 1];
  const payoutThis = payoutPctByYear[year];

  if (divThis === null || divThis === undefined || divPrev === null || divPrev === undefined) {
    return { status: "unknown", detail: "배당 데이터 부족 (공시 확인 필요)" };
  }
  const condAOk = divThis >= divPrev;

  if (payoutThis === null || payoutThis === undefined) {
    return { status: "unknown", detail: "배당성향 공시 없음" };
  }

  const y3 = [year - 3, year - 2, year - 1].map((y) => dividendByYear[y]);
  const haveAvg3 = y3.every((v) => v !== null && v !== undefined);
  const avg3 = haveAvg3 ? (y3[0] + y3[1] + y3[2]) / 3 : null;
  const growth = avg3 ? divThis / avg3 - 1 : null;

  const payoutFrac = payoutThis / 100;
  let condB = false;
  let condBWhy = "";
  if (payoutFrac >= 0.4) {
    condB = true;
    condBWhy = "배당성향 40%+";
  } else if (payoutFrac >= 0.25 && growth !== null && growth >= 0.05) {
    condB = true;
    condBWhy = "배당성향 25%+ 및 3년평균 대비 5%+ 증가";
  }

  const growthTxt = growth !== null ? `${(growth * 100).toFixed(1)}%` : "N/A(자료부족)";
  const detail = `배당성향 ${payoutThis.toFixed(1)}% · 3년평균 대비 ${growthTxt}`;

  if (condAOk && condB) {
    return { status: "yes", detail: `${detail} (${condBWhy})` };
  }
  return { status: "no", detail };
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

    const { dividendByYear, payoutPctByYear } = await getDividendData(apiKey, corpCode, year);
    const tax = computeTaxEligibility(year, dividendByYear, payoutPctByYear);

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
