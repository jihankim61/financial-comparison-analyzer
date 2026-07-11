# -*- coding: utf-8 -*-
"""Fetch corp codes, 3-year financial statements, and dividend payout data from DART Open API."""
import io
import json
import os
import zipfile
import requests
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

# display_name -> exact DART corp_name
COMPANIES = {
    "한국전력": "한국전력공사",
    "LG에너지솔루션": "LG에너지솔루션",
    "HD현대": "HD현대",
}


def ensure_corp_code_xml():
    if os.path.exists(CORPCODE_CACHE):
        return
    url = "https://opendart.fss.or.kr/api/corpCode.xml"
    r = requests.get(url, params={"crtfc_key": API_KEY}, timeout=30)
    r.raise_for_status()
    z = zipfile.ZipFile(io.BytesIO(r.content))
    name = z.namelist()[0]
    with z.open(name) as f, open(CORPCODE_CACHE, "wb") as out:
        out.write(f.read())


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
    params = {
        "crtfc_key": API_KEY,
        "corp_code": corp_code,
        "bsns_year": str(bsns_year),
        "reprt_code": reprt_code,
        "fs_div": fs_div,
    }
    r = requests.get(url, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def fetch_dividend(corp_code, bsns_year, reprt_code="11011"):
    url = "https://opendart.fss.or.kr/api/alotMatter.json"
    params = {
        "crtfc_key": API_KEY,
        "corp_code": corp_code,
        "bsns_year": str(bsns_year),
        "reprt_code": reprt_code,
    }
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
    if not s:
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


DIVIDEND_ALIASES = {
    "cash_dividend_total": ["현금배당금총액"],
}


def extract_dividend(div_items):
    """alotMatter returns se/thstrm/frmtrm/bfefrmtrm as plain strings, unit 백만원 for amounts."""
    result = {"cash_dividend_total": {"thstrm": None, "frmtrm": None, "bfefrmtrm": None, "se": None}}
    if not div_items:
        return result
    for it in div_items:
        se = (it.get("se") or "").strip()
        for key, aliases in DIVIDEND_ALIASES.items():
            if any(a in se for a in aliases):
                result[key] = {
                    "thstrm": to_number(it.get("thstrm")),
                    "frmtrm": to_number(it.get("frmtrm")),
                    "bfefrmtrm": to_number(it.get("bfefrmtrm")),
                    "se": se,
                }
    return result


def main():
    ensure_corp_code_xml()
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
        data = {
            "corp_code": corp_code,
            "dart_corp_name": corp_name,
            "stock_code": stock_code,
            "bsns_year": year,
            "fs_div": fs_div,
            "reprt_code": "11011",
        }
        for key in EXACT_ALIASES:
            data[key] = extract_periods(items, key)

        div_data = fetch_dividend(corp_code, year)
        div_items = div_data.get("list") if div_data.get("status") == "000" else []
        data["dividend"] = extract_dividend(div_items)
        # dividend amounts from alotMatter are reported in 백만원 -> convert to 원 for consistency
        for period in ("thstrm", "frmtrm", "bfefrmtrm"):
            v = data["dividend"]["cash_dividend_total"][period]
            if v is not None:
                data["dividend"]["cash_dividend_total"][period] = v * 1_000_000

        result["companies"][display_name] = data
        print(f"[OK] {display_name} ({corp_name}) corp_code={corp_code} year={year} fs_div={fs_div} "
              f"div_status={div_data.get('status')}")

    with open(os.path.join(HERE, "dart_data2.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print("saved dart_data2.json")


if __name__ == "__main__":
    main()
