"""Universal car listing parser — multi-source preview for /api/parse/car-link.

Supports:
  • mobile.de       → delegates to existing mobile_de.parse_url (full extraction)
  • autoscout24.de  → JSON-LD `Vehicle`/`Product` + OG fallback
  • kleinanzeigen.de / ebay-kleinanzeigen.de → OG + price regex fallback
  • generic dealer site → OG meta + JSON-LD fallback (best-effort)

Returns same shape across all sources:
{
  parsed: bool,
  source: str | None,
  sourceUrl: str,
  title, make, model, year, price, currency, mileage, fuel, city, image
}

If `parsed=false`, the frontend should switch to manual entry — UX must
NEVER block the user when parsing fails.
"""
from __future__ import annotations
import json
import logging
import re
from typing import Optional, Tuple
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

from app.parsers.mobile_de import parse_url as parse_mobile_de, fetch_html

logger = logging.getLogger("parsers.universal")

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Accept-Language": "de,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
}


def _detect_source(url: str) -> Optional[str]:
    # Step 10C-C: `lstrip("www.")` is a real bug — it strips a *character
    # set* (`{w, .}`), not the prefix string. `www.willhaben.at` becomes
    # `illhaben.at`, `www.wuw.de` becomes `uw.de`. Replace with a literal
    # prefix check. Substring matches below tolerate the bug today, but
    # the next contributor adding an exact-host comparison would silently
    # lose traffic.
    host = (urlparse(url).hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    # Phase C.1 — Link Intelligence Core: 9-marketplace domain map.
    # We add EU coverage but keep extraction stable. Anti-bot 4xx/5xx → soft-fail at the API layer.
    if "mobile.de" in host:
        return "mobile.de"
    if "autoscout24" in host:
        # autoscout24.de | .ch | .it | .fr | .nl | .at — keep the same extractor (same HTML)
        return "autoscout24"
    if "kleinanzeigen" in host or "ebay-kleinanzeigen" in host:
        return "kleinanzeigen.de"
    if "heycar" in host:
        return "heycar"
    if "pkw.de" in host:
        return "pkw.de"
    if "otomoto" in host:
        return "otomoto.pl"
    if "leboncoin" in host:
        return "leboncoin.fr"
    if "willhaben" in host:
        return "willhaben.at"
    if "marktplaats" in host:
        return "marktplaats.nl"
    if "lacentrale" in host:
        return "lacentrale.fr"
    if "subito" in host:
        return "subito.it"
    return None


# ── Shared extraction helpers ─────────────────────────────────────────
_PRICE_RE = re.compile(r"(\d{1,3}(?:[.\s]\d{3})+|\d{4,6})\s*€?\s*(?:EUR)?", re.IGNORECASE)
_MILEAGE_RE = re.compile(r"(\d{1,3}(?:[.\s,]\d{3})+|\d{3,7})\s*km", re.IGNORECASE)
_YEAR_RE = re.compile(r"\b(19[89]\d|20[0-2]\d)\b")


def _to_int(s) -> Optional[int]:
    # Step 10B: coerce non-string inputs (audit defect E.4).
    # Real-world JSON-LD sometimes emits numeric `value` / `price`.
    # Before this fix `re.sub` crashed with TypeError and the whole
    # `_parse_generic` call short-circuited to `fetch_failed`.
    if s is None:
        return None
    if isinstance(s, bool):
        return None
    if isinstance(s, int):
        return s
    if isinstance(s, float):
        try:
            return int(s)
        except (OverflowError, ValueError):
            return None
    s = str(s)
    if not s:
        return None
    digits = re.sub(r"[^\d]", "", s)
    return int(digits) if digits else None


def _from_jsonld(soup: BeautifulSoup) -> dict:
    """Extract a Product/Vehicle JSON-LD blob if present."""
    out: dict = {}
    for tag in soup.find_all("script", attrs={"type": "application/ld+json"}):
        try:
            raw = tag.string or tag.get_text() or ""
            data = json.loads(raw)
        except Exception:
            continue
        nodes = data if isinstance(data, list) else [data]
        for node in nodes:
            if not isinstance(node, dict):
                continue
            t = node.get("@type")
            if isinstance(t, list):
                t_str = " ".join(t).lower()
            else:
                t_str = str(t or "").lower()
            if not any(k in t_str for k in ("vehicle", "car", "product", "offer")):
                continue
            if "name" in node and not out.get("title"):
                out["title"] = str(node["name"])[:200]
            if "brand" in node and not out.get("make"):
                b = node["brand"]
                out["make"] = b.get("name") if isinstance(b, dict) else str(b)
            if "model" in node and not out.get("model"):
                out["model"] = str(node["model"])[:80]
            if "vehicleModelDate" in node and not out.get("year"):
                out["year"] = _to_int(str(node["vehicleModelDate"]))
            if "productionDate" in node and not out.get("year"):
                out["year"] = _to_int(str(node["productionDate"]))
            if "mileageFromOdometer" in node and not out.get("mileage"):
                m = node["mileageFromOdometer"]
                out["mileage"] = _to_int(m.get("value") if isinstance(m, dict) else str(m))
            if "fuelType" in node and not out.get("fuel"):
                out["fuel"] = str(node["fuelType"]).lower()[:32]
            if "image" in node and not out.get("image"):
                img = node["image"]
                if isinstance(img, list) and img:
                    img = img[0]
                if isinstance(img, dict):
                    img = img.get("url")
                if isinstance(img, str):
                    out["image"] = img
            offers = node.get("offers")
            if offers and not out.get("price"):
                if isinstance(offers, list) and offers:
                    offers = offers[0]
                if isinstance(offers, dict):
                    out["price"] = _to_int(str(offers.get("price", "")))
                    if "priceCurrency" in offers:
                        out["currency"] = str(offers["priceCurrency"])[:6]
    return out


def _from_og(soup: BeautifulSoup) -> dict:
    out: dict = {}
    for prop, key in [
        ("og:title", "title"), ("twitter:title", "title"),
        ("og:image", "image"), ("twitter:image", "image"),
        ("og:description", "description"),
        ("product:price:amount", "price"),
        ("product:price:currency", "currency"),
        ("og:url", "canonical"),
    ]:
        if out.get(key):
            continue
        tag = soup.find("meta", attrs={"property": prop}) or soup.find("meta", attrs={"name": prop})
        if tag and tag.get("content"):
            v = tag["content"].strip()
            if key == "price":
                out["price"] = _to_int(v)
            else:
                out[key] = v[:300]
    return out


def _heuristic_year_mileage(soup: BeautifulSoup, og: dict) -> dict:
    """Last-resort regex over title + description + visible text."""
    out: dict = {}
    text_parts = [og.get("title", ""), og.get("description", "")]
    h1 = soup.find("h1")
    if h1:
        text_parts.append(h1.get_text(" ", strip=True))
    text = " ".join(text_parts)[:2000]
    if not out.get("year"):
        ym = _YEAR_RE.search(text)
        if ym:
            out["year"] = int(ym.group(1))
    if not out.get("mileage"):
        mm = _MILEAGE_RE.search(text)
        if mm:
            out["mileage"] = _to_int(mm.group(1))
    return out


def _split_make_model(title: str) -> Tuple[Optional[str], Optional[str]]:
    """Best-effort split: 'BMW 320d Touring' → ('BMW', '320d Touring')."""
    if not title:
        return None, None
    parts = title.strip().split(maxsplit=1)
    if len(parts) >= 2:
        return parts[0], parts[1].split("·")[0].split("•")[0].strip()[:80]
    if parts:
        return parts[0], None
    return None, None


# ── Generic parser: works for autoscout/kleinanzeigen/dealer ─────────
async def _parse_generic(url: str, source: Optional[str]) -> dict:
    base = {"parsed": False, "sourceUrl": url, "source": source}
    try:
        async with httpx.AsyncClient(headers=_HEADERS, follow_redirects=True, timeout=10.0) as cli:
            resp = await cli.get(url)
        status_code = resp.status_code
        body = resp.text or ""
    except httpx.TimeoutException:
        logger.warning(f"generic parser timeout {url}")
        base["error"] = "timeout"
        return base
    except Exception as exc:
        logger.warning(f"generic parser fetch failed {url}: {exc}")
        base["error"] = "fetch_failed"
        return base

    # Step 10B: page-level classifier runs BEFORE field extraction.
    # Anti-bot interstitials, expired listings, and not-a-listing pages
    # short-circuit to a typed soft-fail. This is the single fix for
    # audit defects E.1 (anti-bot fake-success) and E.2 (expired-listing
    # fake-success).
    from app.parsers.page_classifier import classify_page
    verdict = classify_page(html=body, status_code=status_code, source=source, url=url)
    if verdict.kind != "valid_listing":
        base["error"] = verdict.degradedReason
        return base

    try:
        soup = BeautifulSoup(body, "lxml")
    except Exception as exc:
        logger.warning(f"generic parser soup failed {url}: {exc}")
        base["error"] = "parse_error"
        return base

    ld = _from_jsonld(soup)
    og = _from_og(soup)
    heur = _heuristic_year_mileage(soup, og)

    title = ld.get("title") or og.get("title")
    make = ld.get("make")
    model = ld.get("model")
    if not make and title:
        make, m2 = _split_make_model(title)
        if not model:
            model = m2

    out = {
        **base,
        "parsed": bool(title or ld.get("price") or og.get("price")),
        "source": source or "generic",
        "title": (title or "")[:200] or None,
        "make": make,
        "model": model,
        "year": ld.get("year") or heur.get("year"),
        "price": ld.get("price") or og.get("price"),
        "currency": ld.get("currency") or og.get("currency") or "EUR",
        "mileage": ld.get("mileage") or heur.get("mileage"),
        "fuel": ld.get("fuel"),
        "image": ld.get("image") or og.get("image"),
    }
    return out


# ── Public entry point ───────────────────────────────────────────────
async def parse_listing(url: str) -> dict:
    """Auto-detect source and return preview data. Never raises — always
    returns a dict; on failure returns {parsed: false, error, sourceUrl}."""
    if not url:
        return {"parsed": False, "error": "url_required", "source": None, "sourceUrl": ""}

    source = _detect_source(url)

    # mobile.de — delegate to dedicated parser (best fidelity)
    if source == "mobile.de":
        try:
            data = await parse_mobile_de(url)
            data.setdefault("sourceUrl", url)
            data.setdefault("source", "mobile.de")
            return data
        except Exception as exc:
            logger.warning(f"mobile.de parser failed, falling back to generic: {exc}")

    # Step 10C-A — autoscout24 has its own per-source extractor.
    # The dispatcher is the only place that knows which extractor to
    # call; everything downstream consumes the same legacy dict shape.
    if source == "autoscout24":
        try:
            from app.parsers.autoscout24 import parse_url as parse_autoscout
            data = await parse_autoscout(url)
            data.setdefault("sourceUrl", url)
            data.setdefault("source", "autoscout24")
            return data
        except Exception as exc:
            logger.warning(f"autoscout24 parser failed, falling back to generic: {exc}")

    # Step 10C-B — kleinanzeigen.de owns its own extractor too. The
    # module's URL-topology classifier short-circuits category/search/
    # profile URLs to `not_a_listing` before any network call.
    if source == "kleinanzeigen.de":
        try:
            from app.parsers.kleinanzeigen import parse_url as parse_kleinanz
            data = await parse_kleinanz(url)
            data.setdefault("sourceUrl", url)
            data.setdefault("source", "kleinanzeigen.de")
            return data
        except Exception as exc:
            logger.warning(f"kleinanzeigen parser failed, falling back to generic: {exc}")

    # Step 10C-C — willhaben (AT). Schema.org-rich; topology gate runs
    # before fetch (search / profile / category URLs short-circuit).
    if source == "willhaben.at":
        try:
            from app.parsers.willhaben import parse_url as parse_willhaben
            data = await parse_willhaben(url)
            data.setdefault("sourceUrl", url)
            data.setdefault("source", "willhaben.at")
            return data
        except Exception as exc:
            logger.warning(f"willhaben parser failed, falling back to generic: {exc}")

    # Step 10C-C — otomoto (PL). Schema-driven. PLN currency is dropped
    # at the canonical layer (contract pins EUR); priceEur is None for
    # otomoto until the consumer surface adds explicit FX support.
    if source == "otomoto.pl":
        try:
            from app.parsers.otomoto import parse_url as parse_otomoto
            data = await parse_otomoto(url)
            data.setdefault("sourceUrl", url)
            data.setdefault("source", "otomoto.pl")
            return data
        except Exception as exc:
            logger.warning(f"otomoto parser failed, falling back to generic: {exc}")

    # All others — generic OG/JSON-LD path (kept as fallback substrate
    # only; per Sprint 10C-C, extractor proliferation STOPS here).
    return await _parse_generic(url, source)


__all__ = ["parse_listing"]
