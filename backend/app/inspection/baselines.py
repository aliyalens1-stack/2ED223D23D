"""app.inspection.baselines — Berlin Launch B1.1.

Make/Model-aware market baseline lookup.
Input: make (e.g. "Audi"), model (e.g. "A6 2.0 TDI quattro"), year.
Output: (eur_avg, key) or (None, None) if no match.

Used by B1 report scoring to replace the coarse year-only `estimate_market_avg`
with per-model reality. Keeps model-agnostic fallback intact.

Data: hand-curated 2026 German used-car averages (EUR) for the ~15 top-selling
models. Not ML — deterministic table, easy to audit & extend.
"""
from __future__ import annotations
import re
from typing import Optional

CURRENT_YEAR = 2026

# Per-model average EUR for year. Values reflect Feb-2026 DE used-car market
# (rough medians — source: mobile.de / autoscout24 manual sampling).
MARKET_BASELINES: dict[str, dict[int, int]] = {
    # ─── Audi (premium) ───
    "audi_a3": {2024:32000,2023:28000,2022:25000,2021:22000,2020:19000,2019:16000,2018:14000,2017:12000,2016:10500,2015:9000,2014:7500,2013:6500,2012:5500},
    "audi_a4": {2024:42000,2023:36000,2022:31000,2021:27000,2020:23000,2019:20000,2018:17000,2017:14500,2016:12500,2015:10500,2014:8800,2013:7500,2012:6300},
    "audi_a6": {2024:58000,2023:50000,2022:43000,2021:37000,2020:32000,2019:28000,2018:24000,2017:20500,2016:17500,2015:14500,2014:12000,2013:9800,2012:8000},
    "audi_q3": {2024:36000,2023:31000,2022:27000,2021:23500,2020:20500,2019:18000,2018:15500,2017:13500,2016:11500,2015:9800,2014:8300},
    "audi_q5": {2024:52000,2023:45000,2022:39000,2021:34000,2020:29500,2019:25500,2018:22000,2017:19000,2016:16500,2015:14000,2014:11500},
    # ─── BMW (premium) ───
    "bmw_1":   {2024:30000,2023:26000,2022:23000,2021:20000,2020:17500,2019:15000,2018:13000,2017:11000,2016:9500,2015:8000,2014:6800,2013:5800},
    "bmw_3":   {2024:44000,2023:38000,2022:33000,2021:28500,2020:24500,2019:21000,2018:18000,2017:15500,2016:13000,2015:11000,2014:9200,2013:7800,2012:6500,2010:4800},
    "bmw_5":   {2024:58000,2023:50000,2022:43000,2021:37000,2020:32000,2019:27500,2018:23500,2017:20000,2016:17000,2015:14500,2014:12000,2013:10000,2012:8200},
    "bmw_x1":  {2024:38000,2023:33000,2022:28500,2021:24500,2020:21000,2019:18000,2018:15500,2017:13500,2016:11500,2015:9800,2014:8300},
    "bmw_x3":  {2024:52000,2023:45000,2022:39000,2021:34000,2020:29500,2019:25500,2018:22000,2017:19000,2016:16500,2015:14000,2014:11800,2013:9800},
    "bmw_x5":  {2024:75000,2023:65000,2022:56000,2021:49000,2020:42500,2019:37000,2018:32000,2017:27500,2016:24000,2015:20500,2014:17500,2013:14500},
    # ─── Mercedes-Benz (premium) ───
    "mercedes_a":     {2024:36000,2023:31000,2022:27000,2021:23500,2020:20500,2019:18000,2018:15500,2017:13500,2016:11800,2015:10000,2014:8500},
    "mercedes_c":     {2024:48000,2023:42000,2022:36000,2021:31000,2020:27000,2019:23000,2018:19500,2017:16800,2016:14500,2015:12500,2014:10500,2013:8800,2012:7500},
    "mercedes_e":     {2024:62000,2023:54000,2022:46000,2021:40000,2020:34500,2019:29500,2018:25500,2017:22000,2016:18800,2015:16000,2014:13500,2013:11500,2012:9500},
    "mercedes_glc":   {2024:54000,2023:47000,2022:40500,2021:35000,2020:30500,2019:26500,2018:23000,2017:20000,2016:17300},
    # ─── VW (volume) ───
    "vw_polo":    {2024:20500,2023:18000,2022:16000,2021:14000,2020:12500,2019:11000,2018:9500,2017:8300,2016:7200,2015:6300,2014:5500,2013:4800},
    "vw_golf":    {2024:28500,2023:24500,2022:21500,2021:19000,2020:16500,2019:14500,2018:12500,2017:11000,2016:9500,2015:8200,2014:7000,2013:6000,2012:5200,2011:4500,2010:4000},
    "vw_passat":  {2024:35000,2023:30500,2022:26500,2021:23000,2020:19500,2019:17000,2018:14500,2017:12500,2016:10800,2015:9200,2014:7800,2013:6500,2012:5500},
    "vw_tiguan":  {2024:38000,2023:33000,2022:28500,2021:25000,2020:21500,2019:18500,2018:16000,2017:14000,2016:12000,2015:10500,2014:9000,2013:7800},
    # ─── Opel / Ford / Skoda (volume) ───
    "opel_astra":     {2024:22500,2023:19500,2022:17000,2021:15000,2020:13000,2019:11500,2018:10000,2017:8800,2016:7500,2015:6500,2014:5500,2013:4800},
    "opel_corsa":     {2024:18500,2023:16500,2022:14500,2021:12500,2020:11000,2019:9700,2018:8500,2017:7400,2016:6400,2015:5500},
    "ford_focus":     {2024:23500,2023:20500,2022:18000,2021:15800,2020:13800,2019:12000,2018:10500,2017:9200,2016:8000,2015:6800,2014:5800,2013:4800},
    "ford_fiesta":    {2024:18500,2023:16500,2022:14500,2021:12700,2020:11200,2019:9900,2018:8700,2017:7600,2016:6600,2015:5700},
    "skoda_octavia":  {2024:28500,2023:24500,2022:21500,2021:19000,2020:16500,2019:14500,2018:12500,2017:11000,2016:9500,2015:8200,2014:7000,2013:6000},
    "skoda_fabia":    {2024:19500,2023:17500,2022:15500,2021:13700,2020:12100,2019:10700,2018:9400,2017:8200,2016:7100},
    # ─── Alternative brands (volume) ───
    "hyundai_i30":    {2024:24500,2023:21500,2022:19000,2021:16800,2020:14800,2019:13000,2018:11400,2017:10000,2016:8700,2015:7500},
    "toyota_corolla": {2024:27000,2023:23500,2022:20500,2021:18000,2020:15900,2019:14000,2018:12300,2017:10800,2016:9500,2015:8300},
    "kia_ceed":       {2024:24000,2023:21000,2022:18500,2021:16300,2020:14400,2019:12700,2018:11200,2017:9800,2016:8500,2015:7400},
}


def _normalize_make_model(make: Optional[str], model: Optional[str]) -> Optional[str]:
    """Map (make, model) → baseline key. Handles BMW '320d' → '3', 'X3' → 'x3', etc."""
    if not make:
        return None
    m = make.strip().lower()
    md_raw = (model or "").strip().lower()
    if not md_raw:
        return None

    # Drop common qualifiers so "A6 Avant 2.0 TDI quattro" → "a6"
    md_raw = re.sub(
        r"\b(avant|touring|variant|kombi|limousine|sportback|allroad|quattro|xdrive|"
        r"awd|tdi|tfsi|tsi|tdci|hybrid|plug\-?in|diesel|benzin|automatik|dsg|manuell|"
        r"line|edition|sport|advance|elegance|premium|business|executive|luxury|amg|"
        r"s\-?line|m\-?sport|se|cdi|bluetec|efficient|econetic)\b",
        " ", md_raw,
    )
    md_raw = re.sub(r"\s+", " ", md_raw).strip()
    md_token = md_raw.split()[0] if md_raw else ""
    if not md_token:
        return None

    # BMW series: "320d", "318i", "520" → "3", "5"
    if m == "bmw":
        num = re.match(r"^(\d)\d+", md_token)
        if num:
            md_token = num.group(1)
        # X-series / i-series stay as-is (x1, x3, x5, i3, i4)
        elif re.match(r"^[xi]\d$", md_token):
            pass

    # Mercedes: "c200", "e220d", "glc300" → "c", "e", "glc"
    if m == "mercedes" or m == "mercedes-benz":
        m = "mercedes"
        mm = re.match(r"^(glc|gla|gle|gls|c|e|a|b|s|g|cls)\s*\d*", md_token)
        if mm:
            md_token = mm.group(1)

    # Audi: "a6", "q5" — already correct. Strip trailing digits only if not class letter+digit.
    # (a6 must stay a6; 2.0 was stripped above.)
    key = f"{m}_{md_token}"
    return key if key in MARKET_BASELINES else None


def get_baseline(make: Optional[str], model: Optional[str], year: Optional[int]) -> tuple[Optional[int], Optional[str]]:
    """Return (eur_avg, matched_key) or (None, None) if not found."""
    if not year:
        return (None, None)
    key = _normalize_make_model(make, model)
    if not key:
        return (None, None)
    table = MARKET_BASELINES.get(key) or {}
    if year in table:
        return (table[year], key)
    # Linear nearest-year fallback within ±3 years
    for offset in (1, 2, 3):
        if (year - offset) in table:
            return (table[year - offset], key)
        if (year + offset) in table:
            return (table[year + offset], key)
    return (None, None)


_BRAND_DISPLAY = {
    "bmw": "BMW", "vw": "VW", "audi": "Audi", "mercedes": "Mercedes-Benz",
    "opel": "Opel", "ford": "Ford", "skoda": "Škoda",
    "hyundai": "Hyundai", "toyota": "Toyota", "kia": "Kia",
}


def humanize_model(key: Optional[str]) -> str:
    """Baseline key → human label for UI ('audi_a6' → 'Audi A6', 'bmw_3' → 'BMW 3er')."""
    if not key:
        return ""
    parts = key.split("_", 1)
    if len(parts) != 2:
        return key
    brand = _BRAND_DISPLAY.get(parts[0], parts[0].capitalize())
    m = parts[1]
    # BMW numeric series → '3er'/'5er'; X/i series stay upper
    if parts[0] == "bmw" and m.isdigit():
        model = f"{m}er"
    elif len(m) <= 3:
        model = m.upper()
    else:
        model = m.capitalize()
    return f"{brand} {model}"
