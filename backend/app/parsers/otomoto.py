"""app.parsers.otomoto — dedicated extractor for otomoto.pl.

Step 10C-C. Otomoto is the Polish vehicle marketplace; it's the last
tier-2 extractor we land in this sprint. Properties that make Otomoto
a clean fit:

  - Strong schema.org discipline (Vehicle / Product JSON-LD on detail
    pages).
  - Predictable URL topology — `/osobowe/oferta/{slug}-ID{external-id}.html`
    for vehicle listings; `/osobowe/` listings for cars (vs.
    `/dostawcze/`, `/motocykle/`, etc.).
  - Currency is **PLN, not EUR**. The canonical contract pins EUR
    (`from_legacy` drops `priceEur` when `currency != "EUR"`). We
    preserve `currency="PLN"` on the legacy dict so downstream
    surfaces can decide what to do — they receive `priceEur=None` and
    a typed currency. This is deliberate: surface-level FX conversion
    is *not* substrate work, it is a presentation concern.

The module mirrors willhaben.py / autoscout24.py public surface:
  - `parse_html(html, url)` — pure HTML → legacy dict
  - `parse_url(url)`        — fetch + classify + extract orchestrator
  - `is_otomoto_url(url)`   — exposed host gate
  - `classify_url_topology(url)` — pure URL topology, runs BEFORE fetch

Output shape (consumed by `contract.from_legacy`):
    same legacy-dict keys as autoscout24/kleinanzeigen/willhaben.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Literal, Optional
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup


logger = logging.getLogger("parsers.otomoto")


_HOSTS: tuple[str, ...] = (
    "otomoto.pl",
    "www.otomoto.pl",
    "m.otomoto.pl",
)

_HEADERS: dict[str, str] = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8",
}


def is_otomoto_url(url: str) -> bool:
    """True if URL's host belongs to otomoto.pl."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    if not host:
        return False
    return host == "otomoto.pl" or host.endswith(".otomoto.pl")


# ─────────────────────────────────────────────────────────────────────
# URL TOPOLOGY CLASSIFIER — runs BEFORE fetch
# ─────────────────────────────────────────────────────────────────────

UrlTopology = Literal["listing", "category", "search", "profile", "unknown"]


# Listing detail URLs:
#   /osobowe/oferta/{slug}-ID{external-id}.html
#   /dostawcze/oferta/...      (covered for completeness; we still
#                               treat as listing — the report builder
#                               doesn't care if it's an LCV vs a car)
# external-id is alphanumeric, 6-12 chars after the literal `-ID`.
_RE_LISTING = re.compile(
    r"/(?:osobowe|dostawcze|motocykle|ciezarowe|przyczepy-naczepy|"
    r"autobusy|maszyny-budowlane|maszyny-rolnicze|maszyny-i-przemysl)"
    r"/oferta/[^/?#]+-ID([0-9A-Za-z]{6,12})(?:\.html|/|$|[?#])",
    re.IGNORECASE,
)

# Search results: `/osobowe/uzywane/...` or category browse paths.
_RE_SEARCH = re.compile(
    r"/(?:osobowe|dostawcze|motocykle|ciezarowe)/(?:uzywane|nowe)/",
    re.IGNORECASE,
)

# Profile / dealer pages: `/dealer/{slug}`, `/profil/{slug}`.
_RE_PROFILE = re.compile(
    r"^/(?:dealer|profil|uzytkownik|sprzedawca)/",
    re.IGNORECASE,
)

# Category: top-level `/osobowe/`, `/dostawcze/` (without `oferta/` segment).
_RE_CATEGORY = re.compile(
    r"^/(?:osobowe|dostawcze|motocykle|ciezarowe|przyczepy-naczepy|"
    r"autobusy|maszyny-budowlane|maszyny-rolnicze|maszyny-i-przemysl)"
    r"/?$",
    re.IGNORECASE,
)


def classify_url_topology(url: str) -> UrlTopology:
    """Pure-URL topology classifier. Runs BEFORE fetch.

    Same pattern as kleinanzeigen/willhaben — non-listing URLs
    short-circuit to `not_a_listing` upstream without ever fetching.
    """
    if not url:
        return "unknown"
    try:
        path = (urlparse(url).path or "")
    except Exception:
        return "unknown"

    if _RE_LISTING.search(path):
        return "listing"
    if _RE_PROFILE.search(path):
        return "profile"
    if _RE_CATEGORY.search(path):
        return "category"
    if _RE_SEARCH.search(path):
        return "search"
    return "unknown"


# ─────────────────────────────────────────────────────────────────────
# Extraction layer 1 — JSON-LD (primary on otomoto)
# ─────────────────────────────────────────────────────────────────────

def _from_jsonld(soup: BeautifulSoup) -> dict:
    """Pull Vehicle / Product / Offer JSON-LD. Otomoto's vehicle detail
    pages emit a rich schema.org block — the highest-fidelity layer."""
    out: dict[str, Any] = {}
    for tag in soup.find_all("script", {"type": "application/ld+json"}):
        try:
            data = json.loads(tag.string or "{}")
        except Exception:
            continue
        nodes = data if isinstance(data, list) else [data]
        for node in nodes:
            if not isinstance(node, dict):
                continue
            t = node.get("@type")
            if isinstance(t, list):
                ts = [str(x).lower() for x in t]
            else:
                ts = [str(t or "").lower()]
            if not any(x in ("vehicle", "car", "product") for x in ts):
                continue

            out.setdefault("title", node.get("name"))

            brand = node.get("brand")
            if isinstance(brand, dict):
                out.setdefault("make", brand.get("name"))
            elif isinstance(brand, str):
                out.setdefault("make", brand)

            mdl = node.get("model") or node.get("vehicleModel")
            if isinstance(mdl, dict):
                out.setdefault("model", mdl.get("name"))
            elif isinstance(mdl, str):
                out.setdefault("model", mdl)

            yr = (node.get("vehicleModelDate") or node.get("modelDate")
                  or node.get("productionDate"))
            if yr:
                out.setdefault("year", _coerce_year(yr))

            mfo = node.get("mileageFromOdometer")
            if isinstance(mfo, dict):
                out.setdefault("mileage", _coerce_int(mfo.get("value")))
            elif mfo is not None:
                out.setdefault("mileage", _coerce_int(mfo))

            offers = node.get("offers")
            if isinstance(offers, dict):
                p = _coerce_price(offers.get("price"))
                if p is not None:
                    out.setdefault("price", p)
                cur = offers.get("priceCurrency")
                if cur:
                    out.setdefault("currency", str(cur).upper())
                seller = offers.get("seller")
                if isinstance(seller, dict):
                    st = (seller.get("@type") or "").lower()
                    if "dealer" in st or "organization" in st or "business" in st:
                        out.setdefault("sellerType", "dealer")
                    elif "person" in st or "individual" in st or "private" in st:
                        out.setdefault("sellerType", "private")

            ft = node.get("fuelType")
            if isinstance(ft, str):
                out.setdefault("fuel", ft.lower())

            trans = node.get("vehicleTransmission")
            if isinstance(trans, str):
                t_lc = trans.lower()
                if "auto" in t_lc:
                    out.setdefault("transmission", "automatic")
                elif "manual" in t_lc or "schalt" in t_lc or "manualna" in t_lc:
                    out.setdefault("transmission", "manual")

            img = node.get("image")
            if isinstance(img, str):
                out.setdefault("image", img)
                out.setdefault("images", [img])
            elif isinstance(img, list):
                imgs = [x for x in img if isinstance(x, str)]
                if imgs:
                    out.setdefault("image", imgs[0])
                    out.setdefault("images", imgs)
    return out


# ─────────────────────────────────────────────────────────────────────
# Extraction layer 2 — meta tags
# ─────────────────────────────────────────────────────────────────────

def _from_meta(soup: BeautifulSoup) -> dict:
    out: dict[str, Any] = {}

    def meta(prop_name: str) -> Optional[str]:
        tag = (soup.find("meta", property=prop_name)
               or soup.find("meta", attrs={"name": prop_name}))
        if tag and tag.get("content"):
            return tag["content"].strip()
        return None

    title = meta("og:title") or meta("twitter:title")
    if title:
        out["title"] = title

    img = meta("og:image") or meta("twitter:image")
    if img:
        out["image"] = img
        out["images"] = [img]

    for k in ("product:price:amount", "og:price:amount"):
        v = meta(k)
        if v:
            p = _coerce_price(v)
            if p is not None:
                out["price"] = p
                break

    for k in ("product:price:currency", "og:price:currency"):
        v = meta(k)
        if v:
            out["currency"] = v.upper()
            break

    return out


# ─────────────────────────────────────────────────────────────────────
# Extraction layer 3 — DOM fallback
# ─────────────────────────────────────────────────────────────────────

_YEAR_TEXT_RE = re.compile(r"\b(19\d{2}|20[0-3]\d)\b")
_MILEAGE_TEXT_RE = re.compile(
    r"(\d{1,3}(?:[.\s]\d{3})+|\d{4,6})\s*km",
    re.IGNORECASE,
)


def _from_dom(soup: BeautifulSoup) -> dict:
    """Last-resort regex over visible text."""
    out: dict[str, Any] = {}
    if soup is None:
        return out
    text = soup.get_text(" ", strip=True)[:4000]
    if not text:
        return out

    my = _YEAR_TEXT_RE.search(text)
    if my:
        try:
            y = int(my.group(1))
            if 1950 <= y <= 2035:
                out["year"] = y
        except ValueError:
            pass

    mm = _MILEAGE_TEXT_RE.search(text)
    if mm:
        out["mileage"] = _coerce_int(mm.group(1))

    return out


# ─────────────────────────────────────────────────────────────────────
# URL slug → external id
# ─────────────────────────────────────────────────────────────────────

def _external_id_from_url(url: str) -> Optional[str]:
    """Otomoto listing ids are the alphanumeric segment after `-ID` in
    `/{vertical}/oferta/{slug}-ID{external-id}.html`."""
    if not url:
        return None
    m = _RE_LISTING.search(urlparse(url).path or "")
    return m.group(1) if m else None


# ─────────────────────────────────────────────────────────────────────
# Coercion helpers (copied — per architecture.md §F.6: copy, don't abstract)
# ─────────────────────────────────────────────────────────────────────

def _coerce_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        try:
            return int(value)
        except (OverflowError, ValueError):
            return None
    if isinstance(value, str):
        s = re.sub(r"[^\d-]", "", value)
        if s in ("", "-"):
            return None
        try:
            return int(s)
        except ValueError:
            return None
    return None


def _coerce_price(value: Any) -> Optional[int]:
    n = _coerce_int(value)
    if n is None:
        return None
    if n <= 0 or n > 10_000_000:
        return None
    return n


def _coerce_year(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, int) and 1950 <= value <= 2035:
        return value
    if isinstance(value, str):
        m = re.search(r"\b(19\d{2}|20[0-3]\d)\b", value)
        if m:
            return int(m.group(1))
    return None


# ─────────────────────────────────────────────────────────────────────
# Public: parse_html (pure HTML → legacy dict)
# ─────────────────────────────────────────────────────────────────────

def parse_html(html: str, url: str) -> dict:
    """Pure extractor — runs the three-layer chain in priority order.

    Currency note: otomoto emits `PLN` in JSON-LD. We preserve it on
    the legacy dict; `contract.from_legacy` will drop `priceEur`
    accordingly (canonical contract pins EUR).
    """
    base: dict[str, Any] = {
        "parsed": False,
        "source": "otomoto.pl",
        "sourceUrl": url,
        "currency": "PLN",  # Otomoto default; JSON-LD may override.
    }
    if not html:
        return base

    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception:
        return base

    layers = [
        _from_jsonld(soup),
        _from_meta(soup),
        _from_dom(soup),
    ]
    merged: dict[str, Any] = {}
    for layer in layers:
        for k, v in (layer or {}).items():
            if v in (None, "", []):
                continue
            merged.setdefault(k, v)

    if not merged.get("title") and merged.get("make") and merged.get("model"):
        ystr = f" {merged['year']}" if merged.get("year") else ""
        merged["title"] = f"{merged['make']} {merged['model']}{ystr}".strip()

    slug_id = _external_id_from_url(url)
    if slug_id:
        merged.setdefault("listingId", slug_id)

    title = merged.get("title")
    base.update({
        "title":        (title[:200] if isinstance(title, str) else None),
        "make":         merged.get("make"),
        "model":        merged.get("model"),
        "year":         merged.get("year"),
        "price":        merged.get("price"),
        "currency":     (merged.get("currency") or "PLN").upper(),
        "mileage":      merged.get("mileage"),
        "fuel":         merged.get("fuel"),
        "transmission": merged.get("transmission"),
        "sellerType":   merged.get("sellerType"),
        "image":        merged.get("image"),
        "images":       merged.get("images") or [],
        "location":     merged.get("location"),
        "listingId":    merged.get("listingId"),
    })

    core_filled = sum(1 for k in ("title", "price", "mileage", "year")
                      if base.get(k))
    base["parsed"] = core_filled >= 2
    if core_filled < 2:
        base["error"] = "low_extraction_confidence"
    return base


# ─────────────────────────────────────────────────────────────────────
# Public: orchestrator (URL topology → fetch → classify → extract)
# ─────────────────────────────────────────────────────────────────────

async def fetch_html(url: str) -> tuple[Optional[str], Optional[str]]:
    """Fetch HTML for an otomoto URL. Returns (html, error_code).

    No retry / proxy / UA rotation — Sprint 10C-C scope discipline.
    """
    try:
        async with httpx.AsyncClient(
            headers=_HEADERS, follow_redirects=True, timeout=10.0,
        ) as cli:
            resp = await cli.get(url)
        if resp.status_code >= 400:
            return None, f"http_{resp.status_code}"
        return (resp.text or ""), None
    except httpx.TimeoutException:
        return None, "timeout"
    except Exception as exc:
        logger.warning(f"otomoto fetch failed {url}: {exc}")
        return None, "fetch_failed"


async def parse_url(url: str) -> dict:
    """Orchestrator pipeline:

      1. URL gate (must be otomoto host)
      2. URL TOPOLOGY classifier — category/search/profile short-circuit
         BEFORE the network is touched.
      3. fetch
      4. page_classifier (anti-bot / expired)
      5. parse_html
    """
    base: dict[str, Any] = {
        "parsed": False,
        "source": "otomoto.pl",
        "sourceUrl": url,
        "currency": "PLN",
    }
    if not url:
        base["error"] = "url_required"
        return base
    if not is_otomoto_url(url):
        base["error"] = "unsupported_source"
        return base

    # 2) URL topology gate.
    topology = classify_url_topology(url)
    if topology in ("category", "search", "profile"):
        base["error"] = "not_a_listing"
        return base

    # 3) Fetch.
    html, err = await fetch_html(url)
    if err or not html:
        slug_id = _external_id_from_url(url)
        base["error"] = err or "no_html"
        if slug_id:
            base["listingId"] = slug_id
        return base

    # 4) Shared page classifier.
    from app.parsers.page_classifier import classify_page
    verdict = classify_page(html=html, status_code=200,
                            source="otomoto.pl", url=url)
    if verdict.kind != "valid_listing":
        slug_id = _external_id_from_url(url)
        base["error"] = verdict.degradedReason
        if slug_id:
            base["listingId"] = slug_id
        return base

    return parse_html(html, url)


__all__ = [
    "parse_url", "parse_html", "fetch_html",
    "is_otomoto_url", "classify_url_topology",
]
