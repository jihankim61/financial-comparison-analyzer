# -*- coding: utf-8 -*-
"""Fetch financials + dividend + separate-taxation eligibility fields from DART Open API.
Fixes a bug from the prior scripts: alotMatter's third period field is "lwfr" (전전기),
NOT "bfefrmtrm" (that name only exists in fnlttSinglAcntAll). Using the wrong key silently
returned None for the oldest dividend year in every previous run.
"""
import io, json, os, zipfile, requests
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))

def load_api_key():
    with open(os.path.join(HERE, ".env"), encoding="utf-8") as f:
        for line in f:
            if line.startswith("DART_API_KEY="):
                return line.strip().split("=", 1)[1]
    raise RuntimeError("DART_API_KEY not found in .env")

API_KEY = load_api_key()
CORPCODE_CACHE = os.path.join(HERE, "corpCode.xml")

COMPANIES = {
    "한국전력": "한국전력공사",
    "삼성전자": "삼성전자",
    "SK하이닉스": "SK하이닉스",
}

def find_corp_code(dart_name):
    tree = ET.parse(CORPCODE_CACHE)
    root = tree.getroot()
    candidates = []
    for item in root.findall("list"):
        corp_name = item.findtext("corp_name", "").strip()
        stock_code = item.findtext("stock_code", "").strip()
        corp_code = item.findtext("corp_code", "").strip()
        if corp_name == dart_name:
            candidates.append((corp_code, corp_name, stock_code))
    listed = [c for c in candidates if c[2]]
    if listed:
        return listed[0]
    if candidates:
        return candidates[0]
    return None

def fetch_financials(corp_code, bsns_year, reprt_code="11011", fs_div="CFS"):
    url = "https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json"
    params = {"crtfc_key": API_KEY, "corp_code": corp_code, "bsns_year": str(bsns_year),
               "reprt_code": reprt_code, "fs_div": fs_div}
    r = requests.get(url, params=params, timeout=30)
    r.raise_for_status()
    return r.json()

def fetch_dividend(corp_code, bsns_year, reprt_code="11011"):
    url = "https://opendart.fss.or.kr/api/alotMatter.json"
    params = {"crtfc_key": API_KEY, "corp_code": corp_code, "bsns_year": str(bsns_year), "reprt_code": reprt_code}
    r = requests.get(url, params=params, timeout=30)
    r.raise_for_status()
    return r.json()

def try_fetch_best(corp_code):
    for year in (2025, 2024, 2023):
        for fs_div in ("CFS", "OFS"):
            data = fetch_financials(corp_code, year, fs_div=fs_div)
            if data.get("status") == "000" and data.get("list"):
                return year, fs_div, data["list"]
    return None, None, []

EXACT_ALIASES = {
    "revenue": ["매출액", "수익(매출액)", "영업수익"],
    "cogs": ["매출원가"],
    "op_income": ["영업이익", "영업이익(손실)"],
    "net_income": ["당기순이익", "당기순이익(손실)"],
    "curr_assets": ["유동자산"],
    "inventory": ["재고자산"],
    "total_assets": ["자산총계"],
    "curr_liab": ["유동부채"],
    "total_liab": ["부채총계"],
    "total_equity": ["자본총계"],
}
EXCLUDE_SUBSTR = ["지배기업", "비지배", "지배주주", "소유주"]

def pick_item(items, key):
    aliases = EXACT_ALIASES[key]
    valid_sj = ("BS", "IS", "CIS")
    pool = [it for it in items if it.get("sj_div") in valid_sj]
    for alias in aliases:
        for it in pool:
            nm = it.get("account_nm", "").strip()
            if nm == alias and not any(x in nm for x in EXCLUDE_SUBSTR):
                return it
    for alias in aliases:
        for it in pool:
            nm = it.get("account_nm", "").strip()
            if alias in nm and not any(x in nm for x in EXCLUDE_SUBSTR):
                return it
    return None

def to_number(s):
    if s is None:
        return None
    s = str(s).strip()
    if not s or s == "-":
        return None
    neg = s.startswith("(") and s.endswith(")")
    s = s.replace(",", "").replace("(", "").replace(")", "")
    try:
        v = float(s)
        return -v if neg else v
    except ValueError:
        return None

def extract_periods(items, key):
    it = pick_item(items, key)
    if not it:
        return {"thstrm": None, "frmtrm": None, "bfefrmtrm": None, "account_nm": None}
    return {
        "thstrm": to_number(it.get("thstrm_amount")),
        "frmtrm": to_number(it.get("frmtrm_amount")),
        "bfefrmtrm": to_number(it.get("bfefrmtrm_amount")),
        "account_nm": it.get("account_nm"),
    }

def find_alot_item(items, se_candidates):
    for se in se_candidates:
        for it in items:
            if (it.get("se") or "").strip() == se:
                return it
    return None

def main():
    result = {"companies": {}}
    for display_name, dart_name in COMPANIES.items():
        found = find_corp_code(dart_name)
        if not found:
            result["companies"][display_name] = {"error": "corp_code not found"}
            print(f"[WARN] {display_name}: corp_code not found")
            continue
        corp_code, corp_name, stock_code = found
        year, fs_div, items = try_fetch_best(corp_code)
        if not items:
            result["companies"][display_name] = {"error": "financial data not found", "corp_code": corp_code}
            print(f"[WARN] {display_name}: financial data not found")
            continue
        data = {"corp_code": corp_code, "dart_corp_name": corp_name, "stock_code": stock_code,
                "bsns_year": year, "fs_div": fs_div, "reprt_code": "11011"}
        for key in EXACT_ALIASES:
            data[key] = extract_periods(items, key)

        # --- dividend: two alotMatter calls to backfill 4 years (year, year-1, year-2, year-3) ---
        div_report_a = fetch_dividend(corp_code, year)          # thstrm=year, frmtrm=year-1, lwfr=year-2
        div_report_b = fetch_dividend(corp_code, year - 1)      # thstrm=year-1, frmtrm=year-2, lwfr=year-3
        items_a = div_report_a.get("list", []) if div_report_a.get("status") == "000" else []
        items_b = div_report_b.get("list", []) if div_report_b.get("status") == "000" else []

        cash_div_item_a = find_alot_item(items_a, ["현금배당금총액(백만원)"])
        payout_item_a = find_alot_item(items_a, ["(연결)현금배당성향(%)", "현금배당성향(%)"])
        cash_div_item_b = find_alot_item(items_b, ["현금배당금총액(백만원)"])
        payout_item_b = find_alot_item(items_b, ["(연결)현금배당성향(%)", "현금배당성향(%)"])

        def million_to_won(v):
            return v * 1_000_000 if v is not None else None

        dividend_by_year = {
            str(year):     million_to_won(to_number(cash_div_item_a.get("thstrm"))) if cash_div_item_a else None,
            str(year - 1): million_to_won(to_number(cash_div_item_a.get("frmtrm"))) if cash_div_item_a else None,
            str(year - 2): million_to_won(to_number(cash_div_item_a.get("lwfr"))) if cash_div_item_a else None,
            str(year - 3): million_to_won(to_number(cash_div_item_b.get("lwfr"))) if cash_div_item_b else None,
        }
        payout_pct_by_year = {
            str(year):     to_number(payout_item_a.get("thstrm")) if payout_item_a else None,
            str(year - 1): to_number(payout_item_a.get("frmtrm")) if payout_item_a else None,
            str(year - 2): to_number(payout_item_a.get("lwfr")) if payout_item_a else None,
            str(year - 3): to_number(payout_item_b.get("lwfr")) if payout_item_b else None,
        }

        data["dividend_krw_by_year"] = dividend_by_year
        data["dart_reported_payout_pct_by_year"] = payout_pct_by_year
        data["dividend_source_rcept_no"] = {
            "report_a (year, year-1, year-2)": div_report_a.get("list", [{}])[0].get("rcept_no") if items_a else None,
            "report_b (year-1, year-2, year-3)": div_report_b.get("list", [{}])[0].get("rcept_no") if items_b else None,
        }

        result["companies"][display_name] = data
        print(f"[OK] {display_name} ({corp_name}) year={year} fs_div={fs_div} dividend_by_year={dividend_by_year}")

    with open(os.path.join(HERE, "dart_data4.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print("saved dart_data4.json")

if __name__ == "__main__":
    main()
