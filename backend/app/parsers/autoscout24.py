"""app.parsers.autoscout24 — dedicated extractor for autoscout24.de / .eu.

Step 10C-A. The previous code path routed every non-mobile.de URL
through `_parse_generic` — a single regex / OG / JSON-LD bag of
heuristics. That worked for the JSON-LD-rich subset of pages but
left field quality inconsistent across the source's two SSR modes
(server-rendered JSON-LD vs. Next.js `__NEXT_DATA__`).

This module owns autoscout24 HTML → normalized fields. It does NOT:
  - classify failure modes (that's `page_classifier`)
  - decide hard/soft fail (that's `contract.classify_failure_mode`)
  - know about ingest / refresh / consumers

It only does: **HTML → legacy dict shape**. The orchestrator
(`parse_listing` in `universal.py`) wraps this in the canonical
contract via `from_legacy` upstream.

Extraction priority chain (order matters — first match wins per field):
    1. JSON-LD (Vehicle / Product / Offer)
    2. __NEXT_DATA__ (Next.js SSR payload)
    3. meta tags (og:*, twitter:*, product:*)
    4. DOM fallback (regex over visible text)

Output shape (legacy dict, consumed by `contract.from_legacy`):
    {
      "parsed":     bool,
      "source":     "autoscout24",
      "sourceUrl":  str,
      "listingId":  str | None,
      "title":      str | None,
      "make":       str | None,
      "model":      str | None,
      "year":       int | None,
      "price":      int | None,
      "currency":   str,
      "mileage":    int | None,
      "fuel":       str | None,
      "transmission": str | None,
      "image":      str | None,
      "images":     list[str],
      "location":   str | None,
      "sellerType": str | None,
      "error":      None | str,
    }
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Optional
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup


logger = logging.getLogger("parsers.autoscout24")


_HOSTS: tuple[str, ...] = (
    "autoscout24.de", "autoscout24.eu", "autoscout24.com", "autoscout24.at",
    "autoscout24.fr", "autoscout24.it", "autoscout24.es", "autoscout24.nl",
    "autoscout24.be", "autoscout24.pl",
)

_HEADERS: dict[str, str] = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
}


def is_autoscout_url(url: str) -> bool:
    """True if URL's host belongs to an autoscout24 domain. Exposed so
    the dispatcher can short-circuit without re-implementing the check."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    return any(host == h or host.endswith("." + h) for h in _HOSTS)


# ─────────────────────────────────────────────────────────────────────
# 1) JSON-LD extractor
# ─────────────────────────────────────────────────────────────────────

def _from_jsonld(soup: BeautifulSoup) -> dict:
    """Extract canonical fields from any `<script type="application/ld+json">`
    block that looks like a Vehicle / Product / Offer."""
    out: dict[str, Any] = {}
    for tag in soup.find_all("script", {"type": "application/ld+json"}):
        try:
            data = json.loads(tag.string or "{}")
        except Exception:
            continue
        # JSON-LD can be a single object or a list — normalise to list.
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

            md = (node.get("vehicleModelDate") or node.get("modelDate")
                  or node.get("productionDate"))
            if md:
                out.setdefault("year", _coerce_int(md))

            mfo = node.get("mileageFromOdometer")
            if isinstance(mfo, dict):
                out.setdefault("mileage", _coerce_int(mfo.get("value")))
            elif mfo is not None:
                out.setdefault("mileage", _coerce_int(mfo))

            offers = node.get("offers")
            if isinstance(offers, dict):
                out.setdefault("price", _coerce_int(offers.get("price")))
                cur = offers.get("priceCurrency")
                if cur:
                    out.setdefault("currency", str(cur).upper())
                seller = offers.get("seller")
                if isinstance(seller, dict):
                    st = (seller.get("@type") or "").lower()
                    if "dealer" in st:
                        out.setdefault("sellerType", "dealer")
                    elif "person" in st or "individual" in st:
                        out.setdefault("sellerType", "private")

            ft = node.get("fuelType")
            if isinstance(ft, str):
                out.setdefault("fuel", ft.lower())

            trans = node.get("vehicleTransmission")
            if isinstance(trans, str):
                t_lc = trans.lower()
                if "auto" in t_lc:
                    out.setdefault("transmission", "automatic")
                elif "manual" in t_lc or "schalt" in t_lc:
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
# 2) __NEXT_DATA__ extractor
# ─────────────────────────────────────────────────────────────────────

def _walk_nextdata(payload: Any, sink: dict) -> None:
    """Recursively descend into a Next.js JSON tree and collect any
    listing-shaped field we find. Defensive — autoscout24's payload
    shape drifts slightly across regions and releases, so we look for
    well-known *leaf* keys instead of locking to a single path.
    """
    if isinstance(payload, dict):
        # Common leaf shapes:
        if "rawMileageInKm" in payload and "mileage" not in sink:
            sink["mileage"] = _coerce_int(payload["rawMileageInKm"])
        if "mileage" in payload and isinstance(payload["mileage"], (int, str)) and "mileage" not in sink:
            sink["mileage"] = _coerce_int(payload["mileage"])
        if "powerInKw" in payload and "powerKw" not in sink:
            sink["powerKw"] = _coerce_int(payload["powerInKw"])
        if "firstRegistrationDate" in payload and "year" not in sink:
            sink["year"] = _coerce_year(payload["firstRegistrationDate"])
        if "modelYear" in payload and "year" not in sink:
            sink["year"] = _coerce_int(payload["modelYear"])
        if "transmissionType" in payload and "transmission" not in sink:
            v = str(payload["transmissionType"] or "").lower()
            if "auto" in v:
                sink["transmission"] = "automatic"
            elif "manual" in v:
                sink["transmission"] = "manual"
        if "fuelCategory" in payload and isinstance(payload["fuelCategory"], dict):
            f = payload["fuelCategory"].get("formatted") or payload["fuelCategory"].get("name")
            if f and "fuel" not in sink:
                sink["fuel"] = str(f).lower()
        if "priceRaw" in payload and "price" not in sink:
            sink["price"] = _coerce_int(payload["priceRaw"])
        if "amount" in payload and "currency" in payload and "price" not in sink:
            sink["price"] = _coerce_int(payload["amount"])
            sink["currency"] = str(payload["currency"]).upper()
        # Image gallery
        if "mainImageUrl" in payload and isinstance(payload["mainImageUrl"], str):
            sink.setdefault("images", [])
            if payload["mainImageUrl"] not in sink["images"]:
                sink["images"].append(payload["mainImageUrl"])
        # Make / model — autoscout often nests as {make: {formatted: "BMW"}}
        for k in ("make", "model"):
            v = payload.get(k)
            if isinstance(v, dict):
                fmt = v.get("formatted") or v.get("name")
                if fmt and k not in sink:
                    sink[k] = str(fmt)
            elif isinstance(v, str) and k not in sink:
                # but only at "vehicle" / "listing" level — heuristic guard
                if any(parent in payload for parent in
                       ("modelYear", "fuelCategory", "transmissionType",
                        "rawMileageInKm", "powerInKw")):
                    sink[k] = v
        # Location
        if "city" in payload and isinstance(payload["city"], str) and "location" not in sink:
            sink["location"] = payload["city"]
        # Listing id at the root of listingDetails
        if "id" in payload and isinstance(payload["id"], (str, int)):
            # only accept when sibling looks listing-shaped
            if any(p in payload for p in ("vehicle", "prices", "media", "seller")):
                sink.setdefault("listingId", str(payload["id"]))
        # Seller type
        if "seller" in payload and isinstance(payload["seller"], dict):
            st = (payload["seller"].get("type") or "").lower()
            if "dealer" in st and "sellerType" not in sink:
                sink["sellerType"] = "dealer"
            elif "private" in st and "sellerType" not in sink:
                sink["sellerType"] = "private"

        for v in payload.values():
            _walk_nextdata(v, sink)
    elif isinstance(payload, list):
        for item in payload:
            _walk_nextdata(item, sink)


_NEXT_DATA_RE = re.compile(
    r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>',
    re.DOTALL | re.IGNORECASE,
)


def _from_nextdata(html: str) -> dict:
    """Parse `<script id="__NEXT_DATA__">...</script>` JSON payload."""
    m = _NEXT_DATA_RE.search(html or "")
    if not m:
        return {}
    try:
        payload = json.loads(m.group(1))
    except Exception:
        return {}
    sink: dict = {}
    _walk_nextdata(payload, sink)
    # Build derived fields.
    if sink.get("make") and sink.get("model") and "title" not in sink:
        year_str = f" {sink['year']}" if sink.get("year") else ""
        sink["title"] = f"{sink['make']} {sink['model']}{year_str}".strip()
    return sink


# ─────────────────────────────────────────────────────────────────────
# 3) Meta tags extractor
# ─────────────────────────────────────────────────────────────────────

_OG_PROPS = ("og:title", "og:image", "og:description")
_PRICE_META = ("product:price:amount", "og:price:amount")
_CURRENCY_META = ("product:price:currency", "og:price:currency")


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

    for k in _PRICE_META:
        v = meta(k)
        if v:
            p = _coerce_int(v)
            if p:
                out["price"] = p
                break

    for k in _CURRENCY_META:
        v = meta(k)
        if v:
            out["currency"] = v.upper()
            break

    return out


# ─────────────────────────────────────────────────────────────────────
# 4) DOM fallback (visible text heuristics)
# ─────────────────────────────────────────────────────────────────────

_YEAR_TEXT_RE = re.compile(r"\b(19\d{2}|20[0-3]\d)\b")
_MILEAGE_TEXT_RE = re.compile(r"(\d{1,3}(?:[.\s]\d{3})+|\d{4,6})\s*(?:km|тыс\s*км)", re.IGNORECASE)


def _from_dom(soup: BeautifulSoup) -> dict:
    """Last-resort regex over body text. Conservative — only fills what
    higher-priority extractors didn't already provide."""
    text = soup.get_text(" ", strip=True)[:4000] if soup else ""
    out: dict[str, Any] = {}
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
# URL-level extraction (last fallback)
# ─────────────────────────────────────────────────────────────────────

# autoscout24 listing URLs look like /angebote/{slug}-{id}
_ID_FROM_URL_RE = re.compile(r"/angebote/[^/?#]*-([0-9a-f]{8,32})", re.IGNORECASE)


def _external_id_from_url(url: str) -> Optional[str]:
    m = _ID_FROM_URL_RE.search(url or "")
    return m.group(1) if m else None


# ─────────────────────────────────────────────────────────────────────
# Coercion helpers
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


def _coerce_year(value: Any) -> Optional[int]:
    """Accepts ISO date strings (`2020-06-01`) or bare years."""
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
# Public: pure HTML → legacy dict
# ─────────────────────────────────────────────────────────────────────

def parse_html(html: str, url: str) -> dict:
    """Pure extractor — runs the four-layer priority chain.

    Does NOT classify failures. Caller is expected to have already
    invoked `page_classifier.classify_page(...)` and only delegate
    here when the verdict is `valid_listing`.
    """
    base: dict[str, Any] = {
        "parsed": False,
        "source": "autoscout24",
        "sourceUrl": url,
        "currency": "EUR",
    }
    if not html:
        return base

    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception:
        return base

    # Priority chain. Each layer ONLY fills fields the previous didn't.
    layers = [
        _from_jsonld(soup),
        _from_nextdata(html),
        _from_meta(soup),
        _from_dom(soup),
    ]

    merged: dict[str, Any] = {}
    for layer in layers:
        for k, v in (layer or {}).items():
            if v in (None, "", []):
                continue
            merged.setdefault(k, v)

    # Derive title if extractors only gave us make+model.
    if not merged.get("title") and merged.get("make") and merged.get("model"):
        ystr = f" {merged['year']}" if merged.get("year") else ""
        merged["title"] = f"{merged['make']} {merged['model']}{ystr}".strip()

    # External id from URL slug as last fallback.
    if not merged.get("listingId"):
        slug_id = _external_id_from_url(url)
        if slug_id:
            merged["listingId"] = slug_id

    # Build final legacy dict.
    title = merged.get("title")
    base.update({
        "title":        (title[:200] if isinstance(title, str) else None),
        "make":         merged.get("make"),
        "model":        merged.get("model"),
        "year":         merged.get("year"),
        "price":        merged.get("price"),
        "currency":     (merged.get("currency") or "EUR").upper(),
        "mileage":      merged.get("mileage"),
        "fuel":         merged.get("fuel"),
        "transmission": merged.get("transmission"),
        "sellerType":   merged.get("sellerType"),
        "image":        merged.get("image"),
        "images":       merged.get("images") or [],
        "location":     merged.get("location"),
        "listingId":    merged.get("listingId"),
    })

    # `parsed` mirrors the legacy convention: ≥2 of title/price/mileage/year.
    core_filled = sum(1 for k in ("title", "price", "mileage", "year")
                      if base.get(k))
    base["parsed"] = core_filled >= 2
    if core_filled < 2:
        base["error"] = "low_extraction_confidence"
    return base


# ─────────────────────────────────────────────────────────────────────
# Public: orchestrator (fetch + classify + parse)
# ─────────────────────────────────────────────────────────────────────

async def fetch_html(url: str) -> tuple[Optional[str], Optional[str]]:
    """Fetch HTML for an autoscout24 URL. Returns (html, error_code).

    No proxy / retry — Step 10C-A is extractor-only. If the upstream
    blocks, `classify_page` upstream will mark it `antibot` /
    `http_error` and the consumer renders the typed reason.
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
        logger.warning(f"autoscout24 fetch failed {url}: {exc}")
        return None, "fetch_failed"


async def parse_url(url: str) -> dict:
    """Orchestrator: fetch → classify → extract.

    Returns a legacy dict shape (consumed by `contract.from_legacy`).
    Failure modes mirror those documented in the audit:
      - timeout / fetch_failed / http_4xx / http_5xx — soft
      - antibot / expired_listing / not_a_listing — page_classifier
      - low_extraction_confidence — soft (downstream `parseCompleteness=weak`)
    """
    base = {
        "parsed": False,
        "source": "autoscout24",
        "sourceUrl": url,
        "currency": "EUR",
    }
    if not url:
        base["error"] = "url_required"
        return base
    if not is_autoscout_url(url):
        base["error"] = "unsupported_source"
        return base

    html, err = await fetch_html(url)
    if err or not html:
        slug_id = _external_id_from_url(url)
        base["error"] = err or "no_html"
        if slug_id:
            base["listingId"] = slug_id
        return base

    # Page classifier defends against fake-success (audit E.1/E.2).
    from app.parsers.page_classifier import classify_page
    verdict = classify_page(html=html, status_code=200,
                            source="autoscout24", url=url)
    if verdict.kind != "valid_listing":
        slug_id = _external_id_from_url(url)
        base["error"] = verdict.degradedReason
        if slug_id:
            base["listingId"] = slug_id
        return base

    return parse_html(html, url)


__all__ = ["parse_url", "parse_html", "fetch_html", "is_autoscout_url"]
