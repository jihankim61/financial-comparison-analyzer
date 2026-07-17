const fs = require("fs");
const path = require("path");

let COMPANIES = null;
function loadCompanies() {
  if (COMPANIES) return COMPANIES;
  const p = path.join(__dirname, "..", "data", "listed_companies.json");
  COMPANIES = JSON.parse(fs.readFileSync(p, "utf-8"));
  return COMPANIES;
}

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

  const starts = [];
  const contains = [];
  for (const c of companies) {
    const nameLower = c.name.toLowerCase();
    if (nameLower.startsWith(qLower)) {
      starts.push(c);
    } else if (nameLower.includes(qLower)) {
      contains.push(c);
    }
    if (starts.length >= 15) break;
  }

  const results = starts.concat(contains).slice(0, 15);
  res.status(200).json(results);
};
