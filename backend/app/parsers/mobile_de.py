"""app.parsers.mobile_de — mobile.de listing parser.

B2 (Berlin Launch Packaging): принимает URL объявления с mobile.de,
скачивает HTML, вытаскивает базовые поля (title/price/mileage/year/fuel/make/model)
из meta tags + structured data + текстовых паттернов.

Никакого JS-rendering — только статический HTML парсинг (regex + meta).
Достаточно для большинства листингов на mobile.de (они отдают base SSR HTML
с наполненными OpenGraph + JSON-LD).

Если URL не mobile.de или парсинг провалился — возвращаем `parsed=False`
с тем, что удалось извлечь (или fallback из URL slug).
"""
from __future__ import annotations
import re
import json
import logging
from typing import Any, Optional
from urllib.parse import urlparse

import httpx

logger = logging.getLogger("parsers.mobile_de")

# headers, чтобы не получить 403 от mobile.de
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
}

_MOBILE_DE_HOSTS = ("mobile.de", "www.mobile.de", "m.mobile.de", "suchen.mobile.de", "home.mobile.de")


def _is_mobile_de(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
        return host in _MOBILE_DE_HOSTS or host.endswith(".mobile.de")
    except Exception:
        return False


def _extract_meta(html: str, prop: str) -> Optional[str]:
    """Достать <meta property|name="prop" content="..."> в любом порядке атрибутов."""
    patterns = [
        rf'<meta[^>]*\bproperty=["\']{re.escape(prop)}["\'][^>]*\bcontent=["\']([^"\']+)["\']',
        rf'<meta[^>]*\bcontent=["\']([^"\']+)["\'][^>]*\bproperty=["\']{re.escape(prop)}["\']',
        rf'<meta[^>]*\bname=["\']{re.escape(prop)}["\'][^>]*\bcontent=["\']([^"\']+)["\']',
        rf'<meta[^>]*\bcontent=["\']([^"\']+)["\'][^>]*\bname=["\']{re.escape(prop)}["\']',
    ]
    for p in patterns:
        m = re.search(p, html, re.IGNORECASE | re.DOTALL)
        if m:
            return _decode_html_entities(m.group(1).strip())
    return None


def _decode_html_entities(s: str) -> str:
    return (
        s.replace("&amp;", "&")
         .replace("&lt;", "<")
         .replace("&gt;", ">")
         .replace("&quot;", '"')
         .replace("&#39;", "'")
         .replace("&euro;", "€")
         .replace("&#8364;", "€")
    )


def _extract_jsonld(html: str) -> list[dict]:
    """Все блоки <script type=application/ld+json> → list of parsed JSON objects."""
    out: list[dict] = []
    for m in re.finditer(
        r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html, re.IGNORECASE | re.DOTALL
    ):
        raw = m.group(1).strip()
        try:
            data = json.loads(raw)
            if isinstance(data, list):
                out.extend([d for d in data if isinstance(d, dict)])
            elif isinstance(data, dict):
                out.append(data)
        except Exception:
            continue
    return out


def _find_in_jsonld(blocks: list[dict], target_types: tuple[str, ...]) -> Optional[dict]:
    """Найти первый блок где @type ∈ target_types (рекурсивно по @graph)."""
    for b in blocks:
        t = b.get("@type")
        if isinstance(t, str) and t in target_types:
            return b
        if isinstance(t, list) and any(x in target_types for x in t):
            return b
        graph = b.get("@graph")
        if isinstance(graph, list):
            r = _find_in_jsonld(graph, target_types)
            if r:
                return r
    return None


def _to_int(v: Any) -> Optional[int]:
    if v is None:
        return None
    try:
        if isinstance(v, (int, float)):
            return int(v)
        s = re.sub(r"[^\d]", "", str(v))
        return int(s) if s else None
    except Exception:
        return None


def _parse_price(text: str) -> Optional[int]:
    """'18.900 €', 'EUR 18900', '€18900' → 18900."""
    if not text:
        return None
    m = re.search(r"(\d[\d\s\.\,]{2,})\s*(?:€|EUR|euro)", text, re.IGNORECASE)
    if not m:
        m = re.search(r"(?:€|EUR|euro)\s*(\d[\d\s\.\,]{2,})", text, re.IGNORECASE)
    if m:
        return _to_int(m.group(1).replace(".", "").replace(" ", "").replace(",", ""))
    return None


def _parse_mileage(text: str) -> Optional[int]:
    """'120.000 km', '120000 km', 'Kilometerstand: 95.000' → int."""
    if not text:
        return None
    m = re.search(r"(\d[\d\s\.\,]{2,})\s*(?:km|tkm|Kilometer|miles)", text, re.IGNORECASE)
    if m:
        return _to_int(m.group(1).replace(".", "").replace(" ", "").replace(",", ""))
    m = re.search(r"(?:Kilometerstand|Mileage|Laufleistung)[:\s]*(\d[\d\s\.\,]+)", text, re.IGNORECASE)
    if m:
        return _to_int(m.group(1).replace(".", "").replace(" ", "").replace(",", ""))
    return None


def _parse_year(text: str) -> Optional[int]:
    """'EZ 03/2018', 'Erstzulassung 2018', '2018' → 2018."""
    if not text:
        return None
    m = re.search(r"(?:EZ|Erstzulassung|Year|Baujahr)[\s:]*(?:\d{1,2}[/.])?(\d{4})", text, re.IGNORECASE)
    if m:
        y = int(m.group(1))
        if 1950 <= y <= 2030:
            return y
    m = re.search(r"\b(20[0-2]\d|19[89]\d)\b", text)
    if m:
        y = int(m.group(1))
        if 1950 <= y <= 2030:
            return y
    return None


def _parse_fuel(text: str) -> Optional[str]:
    if not text:
        return None
    t = text.lower()
    if any(k in t for k in ("diesel",)):
        return "diesel"
    if any(k in t for k in ("benzin", "petrol", "gasoline", "super", "otto")):
        return "petrol"
    if "hybrid" in t:
        return "hybrid"
    if any(k in t for k in ("elektro", "electric", "ev", "bev")):
        return "electric"
    if any(k in t for k in ("lpg", "autogas")):
        return "lpg"
    if "cng" in t or "erdgas" in t:
        return "cng"
    return None


def _split_make_model(title: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """'Audi A6 2.0 TDI · 2018 · 120.000 km' → ('Audi', 'A6 2.0 TDI')."""
    if not title:
        return (None, None)
    # отрезать всё после первого '·' / '|' / ' - ' / '(' (часто там цена/год)
    cleaned = re.split(r"[·|()]| - ", title, maxsplit=1)[0].strip()
    parts = cleaned.split(" ", 1)
    if len(parts) == 1:
        return (parts[0], None)
    return (parts[0], parts[1])


def _parse_from_slug(url: str) -> dict:
    """Fallback: попытаться вытащить make/model/id из URL slug."""
    out: dict = {}
    try:
        path = urlparse(url).path
        # пример: /fahrzeuge/details.html?id=429... ИЛИ /audi/a6/...
        m = re.search(r"/([a-zA-Z]+)/([a-zA-Z0-9\-]+)/", path)
        if m:
            out["make"] = m.group(1).capitalize()
            out["model"] = m.group(2).replace("-", " ").upper()
        m = re.search(r"\bid[=/](\d+)", url)
        if m:
            out["listingId"] = m.group(1)
    except Exception:
        pass
    return out


# ── простая market price baseline (для inspection report v1 в B1) ──
# Очень грубая модель: средняя цена used car в Германии по году.
# Используется только как референс для risk calculation, не для оценки.
_MARKET_AVG_BY_YEAR_DELTA = {
    # delta_years (current_year - car_year) → typical EUR
    0: 35000, 1: 30000, 2: 26000, 3: 22000, 4: 18000,
    5: 15000, 6: 12500, 7: 10000, 8: 8500,
    9: 7000, 10: 6000, 11: 5000, 12: 4000, 13: 3500,
}


def estimate_market_avg(year: Optional[int], current_year: int = 2026) -> Optional[int]:
    """Грубый market-baseline по году. Используется в B1 для risk scoring."""
    if not year:
        return None
    delta = max(0, current_year - year)
    if delta in _MARKET_AVG_BY_YEAR_DELTA:
        return _MARKET_AVG_BY_YEAR_DELTA[delta]
    if delta > 13:
        return 3000
    return None


# ════════════════════════════════════════════════════════════════
# PUBLIC API
# ════════════════════════════════════════════════════════════════

async def fetch_html(url: str, timeout: float = 8.0) -> tuple[Optional[str], Optional[str]]:
    """Скачать HTML страницу. Возвращает (html, error).

    Proxy support (для обхода 403 от mobile.de):
      - SCRAPERAPI_KEY — ScraperAPI (render=false, country=de). Активируется если задан ключ.
      - PROXY_URL — прямой HTTP(S) proxy (например, BrightData). Формат: http://user:pass@host:port.
    Fallback цепочка: direct → scraperapi (если есть ключ) → proxy (если задан URL).
    """
    import os
    scraperapi_key = os.getenv("SCRAPERAPI_KEY", "").strip()
    proxy_url = os.getenv("PROXY_URL", "").strip()

    # 1) Direct fetch
    try:
        async with httpx.AsyncClient(headers=_HEADERS, follow_redirects=True, timeout=timeout) as cli:
            r = await cli.get(url)
            if r.status_code == 200 and r.text:
                return r.text, None
            direct_err = f"http_{r.status_code}"
    except httpx.TimeoutException:
        direct_err = "timeout"
    except Exception as e:
        direct_err = f"fetch_error: {type(e).__name__}"

    # 2) ScraperAPI fallback
    if scraperapi_key:
        try:
            sa_url = "http://api.scraperapi.com"
            params = {"api_key": scraperapi_key, "url": url, "country_code": "de"}
            async with httpx.AsyncClient(headers=_HEADERS, follow_redirects=True, timeout=max(timeout, 30.0)) as cli:
                r = await cli.get(sa_url, params=params)
                if r.status_code == 200 and r.text:
                    logger.info(f"mobile.de parsed via ScraperAPI (direct={direct_err})")
                    return r.text, None
                logger.warning(f"ScraperAPI failed: http_{r.status_code}")
        except Exception as e:
            logger.warning(f"ScraperAPI error: {type(e).__name__}: {e}")

    # 3) HTTP proxy fallback
    if proxy_url:
        try:
            async with httpx.AsyncClient(
                headers=_HEADERS, follow_redirects=True, timeout=max(timeout, 20.0),
                proxy=proxy_url,
            ) as cli:
                r = await cli.get(url)
                if r.status_code == 200 and r.text:
                    logger.info(f"mobile.de parsed via proxy (direct={direct_err})")
                    return r.text, None
                logger.warning(f"Proxy fetch failed: http_{r.status_code}")
        except Exception as e:
            logger.warning(f"Proxy error: {type(e).__name__}: {e}")

    return None, direct_err


def parse_html(html: str, url: str) -> dict:
    """Чистый парсер: вход — HTML + url, выход — структурированные поля.

    Возвращает dict с полями (любое из них может быть None):
      title, price, mileage, year, fuel, make, model, currency, image, listingId,
      sourceUrl, source, raw_text_excerpt
    """
    out: dict[str, Any] = {
        "source": "mobile.de",
        "sourceUrl": url,
        "title": None, "price": None, "currency": "EUR",
        "mileage": None, "year": None, "fuel": None,
        "make": None, "model": None,
        "image": None, "listingId": None,
    }

    # 1. JSON-LD (если есть Vehicle/Car/Product/Offer — самое надёжное)
    blocks = _extract_jsonld(html)
    veh = _find_in_jsonld(blocks, ("Vehicle", "Car", "Product", "Offer", "MotorVehicle"))
    if veh:
        out["title"] = out["title"] or veh.get("name") or veh.get("description")
        out["make"] = out["make"] or (veh.get("brand", {}) if isinstance(veh.get("brand"), dict) else {}).get("name") or (veh.get("brand") if isinstance(veh.get("brand"), str) else None) or veh.get("manufacturer")
        out["model"] = out["model"] or veh.get("model")
        out["year"] = out["year"] or _to_int(veh.get("modelDate") or veh.get("vehicleModelDate") or veh.get("productionDate"))
        out["mileage"] = out["mileage"] or _to_int((veh.get("mileageFromOdometer", {}) if isinstance(veh.get("mileageFromOdometer"), dict) else {}).get("value") or veh.get("mileageFromOdometer"))
        offers = veh.get("offers")
        if isinstance(offers, dict):
            out["price"] = out["price"] or _to_int(offers.get("price"))
            cur = offers.get("priceCurrency")
            if isinstance(cur, str) and cur:
                out["currency"] = cur.upper()
        elif isinstance(offers, list) and offers:
            of0 = offers[0] if isinstance(offers[0], dict) else {}
            out["price"] = out["price"] or _to_int(of0.get("price"))
        out["image"] = out["image"] or (veh.get("image")[0] if isinstance(veh.get("image"), list) and veh.get("image") else (veh.get("image") if isinstance(veh.get("image"), str) else None))
        ft = veh.get("fuelType")
        if isinstance(ft, str):
            out["fuel"] = out["fuel"] or _parse_fuel(ft)

    # 2. OpenGraph
    out["title"] = out["title"] or _extract_meta(html, "og:title") or _extract_meta(html, "twitter:title")
    out["image"] = out["image"] or _extract_meta(html, "og:image") or _extract_meta(html, "twitter:image")
    og_desc = _extract_meta(html, "og:description") or _extract_meta(html, "description") or ""

    # 3. Из title + description достаём недостающее regex'ами
    pool = " ".join([out["title"] or "", og_desc])
    out["price"] = out["price"] or _parse_price(pool)
    out["mileage"] = out["mileage"] or _parse_mileage(pool)
    out["year"] = out["year"] or _parse_year(pool)
    out["fuel"] = out["fuel"] or _parse_fuel(pool)
    if not out["make"] or not out["model"]:
        mk, mdl = _split_make_model(out["title"])
        out["make"] = out["make"] or mk
        out["model"] = out["model"] or mdl

    # 4. URL fallback (id, иногда make/model)
    slug = _parse_from_slug(url)
    out["listingId"] = out["listingId"] or slug.get("listingId")
    out["make"] = out["make"] or slug.get("make")
    out["model"] = out["model"] or slug.get("model")

    out["raw_text_excerpt"] = (og_desc or "")[:280]

    # market avg для UI (B1 будет использовать это же)
    out["marketAvg"] = estimate_market_avg(out["year"])

    return out


async def parse_url(url: str) -> dict:
    """High-level: validate URL → fetch → parse. Возвращает dict с `parsed` flag."""
    if not url or not isinstance(url, str):
        return {"parsed": False, "error": "url_required"}
    if not _is_mobile_de(url):
        return {
            "parsed": False,
            "error": "unsupported_source",
            "supportedSources": ["mobile.de"],
            "sourceUrl": url,
        }

    html, err = await fetch_html(url)
    if err or not html:
        # graceful fallback: возвращаем что смогли из URL
        slug = _parse_from_slug(url)
        return {
            "parsed": False,
            "error": err or "no_html",
            "source": "mobile.de",
            "sourceUrl": url,
            "title": (f"{slug.get('make', '')} {slug.get('model', '')}".strip() or None),
            "make": slug.get("make"), "model": slug.get("model"),
            "listingId": slug.get("listingId"),
            "currency": "EUR",
        }

    # Step 10B: page-level classifier guards against fake-success
    # (audit defects E.1 anti-bot, E.2 expired listing). The mobile.de
    # path is protected even though its fetch_html already proxies
    # through ScraperAPI — the proxy may return the anti-bot page itself.
    from app.parsers.page_classifier import classify_page
    verdict = classify_page(html=html, status_code=200, source="mobile.de", url=url)
    if verdict.kind != "valid_listing":
        slug = _parse_from_slug(url)
        return {
            "parsed": False,
            "error": verdict.degradedReason,
            "source": "mobile.de",
            "sourceUrl": url,
            "title": (f"{slug.get('make', '')} {slug.get('model', '')}".strip() or None),
            "make": slug.get("make"), "model": slug.get("model"),
            "listingId": slug.get("listingId"),
            "currency": "EUR",
        }

    data = parse_html(html, url)
    # parsed=True если получили хотя бы 2 ключевых поля
    keys_filled = sum(1 for k in ("title", "price", "mileage", "year") if data.get(k))
    data["parsed"] = keys_filled >= 2
    if not data["parsed"]:
        data["error"] = "low_extraction_confidence"
    return data
