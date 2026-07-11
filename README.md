# financial-comparison-analyzer

금융감독원 전자공시시스템(DART) Open API로 국내 상장기업의 재무제표를 회사명 기준으로 조회하여, 여러 기업을 비교하는 엑셀 리포트와 웹 대시보드를 만드는 도구입니다.

## 구성

```
scripts/   DART API 조회 및 엑셀 생성 스크립트
data/      조회된 원본 재무/배당 데이터 스냅샷 (JSON)
output/    생성된 엑셀 비교분석 리포트
web/       인터랙티브 대시보드 및 제품 요구사항 정의서(PRD)
```

### scripts

각 실행 묶음은 `fetch_dart*.py`(DART에서 데이터 조회) → `build_*.py`(엑셀 생성)의 짝으로 구성됩니다.

| 스크립트 | 대상 기업 | 비고 |
|---|---|---|
| `fetch_dart.py` / `build_dart_excel*.py` | 삼성전자, SK하이닉스, 현대자동차 | |
| `fetch_dart2.py` / `build_v2*.py` | 한국전력, LG에너지솔루션, HD현대 | 배당성향 지표 추가 |
| `fetch_dart3.py` / `build_v3_all.py` | LG유플러스, HD현대, 셀트리온 | |
| `fetch_dart4.py` / `build_v4_all.py` | 한국전력, 삼성전자, SK하이닉스 | 배당소득 분리과세 대상 판정 기능 포함 |

`recalc_excel_com.py`는 Windows에서 Microsoft Excel COM 자동화로 생성된 워크북의 수식을 재계산하고 오류를 검사하는 보조 스크립트입니다.

### output

각 엑셀 파일은 공통적으로 `사용안내 / 원본데이터 / 비교분석 / 대시보드` 시트로 구성되며, 비율은 모두 수식으로 계산되어 원본 수치를 바꾸면 자동 갱신됩니다. `한국전력_삼성전자_SK하이닉스_...` 파일에는 `분리과세판정` 시트가 추가로 포함되어 있습니다.

### web

- `financial_dashboard.html` — 8개 기업 데이터를 담은 인터랙티브 비교 대시보드 (회사 검색/선택, 추이 차트, 비율 비교, 분리과세 배지)
- `financial_analyzer_prd.html` — 이 프로젝트를 웹 서비스로 확장하기 위한 제품 요구사항 정의서(PRD)

## 실행 방법

1. [DART Open API](https://opendart.fss.or.kr)에서 무료 개인 인증키를 발급받습니다.
2. `scripts/` 안에 `.env.example`을 참고해 `.env` 파일을 만들고 발급받은 키를 넣습니다.
3. `pip install requests openpyxl pandas pywin32` (Windows에서 수식 재계산까지 하려면 `pywin32` 필요)
4. `python scripts/fetch_dartN.py` 실행 → 같은 폴더에 `dart_dataN.json` 생성
5. 이어서 해당 `build_*.py` 스크립트를 순서대로 실행하면 `output/`에 엑셀 파일이 생성됩니다.

## 주의사항

- **데이터는 스냅샷입니다.** 각 파일은 스크립트 실행 시점의 DART 최신 공시를 기준으로 하며, 최신 공시가 갱신되면 다시 조회해야 합니다.
- **배당소득 분리과세 판정은 확정 법령이 아닙니다.** 2025년 세제개편안(조세특례제한법 §91의19, 2026.1.1 시행 예정)에 대한 보도자료·법무법인 뉴스레터를 근거로 구성한 추정치이며, 실제 세무 판단 전 국세청·기획재정부 공식 자료 또는 세무전문가 확인이 필요합니다.
- **계정과목 자동 매칭의 한계.** 기업별로 계정과목명이 달라(예: "당기순이익" vs "연결당기순이익") alias 매칭을 사용하며, 매칭 실패 시 값은 `N/A`로 표시됩니다.
- **API 키는 절대 커밋하지 마세요.** `.env`는 `.gitignore`에 포함되어 있습니다.
