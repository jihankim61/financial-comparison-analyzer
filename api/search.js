const fs = require("fs");
const path = require("path");

let COMPANIES = null;
function loadCompanies() {
  if (COMPANIES) return COMPANIES;
  const p = path.join(__dirname, "..", "data", "listed_companies.json");
  COMPANIES = JSON.parse(fs.readFileSync(p, "utf-8"));
  return COMPANIES;
}

// DART에 등록된 공식 상호가 일반적으로 통용되는 한글 표기와 다른 경우를 위한 별칭.
// 예: 네이버(주)는 DART에 영문 "NAVER"로만 등록되어 있어 "네이버"로 검색하면 원래 결과가 없다.
const COLLOQUIAL_ALIASES = {
  "네이버": "NAVER",
};

module.exports = (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=3600");
  const url = new URL(req.url, "http://x");
  const q = (req.query && req.query.q !== undefined ? req.query.q : url.searchParams.get("q") || "").trim();

  if (!q) {
    res.status(200).json([]);
    return;
  }

  const companies = loadCompanies();
  const qLower = q.toLowerCase();

  // 질의어가 별칭 표기와 일치하면, 실제 DART 등록명 기준으로도 함께 찾는다.
  const aliasTargets = Object.keys(COLLOQUIAL_ALIASES)
    .filter((alias) => alias.toLowerCase().includes(qLower) || qLower.includes(alias.toLowerCase()))
    .map((alias) => COLLOQUIAL_ALIASES[alias].toLowerCase());

  const starts = [];
  const contains = [];
  const seen = new Set();
  for (const c of companies) {
    const nameLower = c.name.toLowerCase();
    const matchesQuery = nameLower.startsWith(qLower) || nameLower.includes(qLower);
    const matchesAlias = aliasTargets.some((target) => nameLower.includes(target));
    if (!matchesQuery && !matchesAlias) continue;
    if (seen.has(c.code)) continue;
    seen.add(c.code);
    if (nameLower.startsWith(qLower)) starts.push(c);
    else contains.push(c);
    if (starts.length >= 15) break;
  }

  const results = starts.concat(contains).slice(0, 15);
  res.status(200).json(results);
};
