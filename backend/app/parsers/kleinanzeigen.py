"""app.parsers.kleinanzeigen — dedicated extractor for kleinanzeigen.de.

Step 10C-B. Kleinanzeigen is harder than AutoScout for substrate
reasons, not HTML reasons:
  - inconsistent JSON-LD (private-seller listings often miss it)
  - category / search / profile URLs that *look* like listings
  - aggressive anti-bot (Datadome / PerimeterX rather than Cloudflare)
  - listings can be in a "deleted-but-cached" state with stale OG
  - VB ("Verhandlungsbasis" — negotiable price) embedded in price text

The audit's discipline keeps this module narrow:

  1. URL topology is checked **before** any HTML is fetched. Non-listing
     URLs (category / search / profile) short-circuit to a *hard-fail*
     with `error="not_a_listing"`. No HTML touches the wire.
  2. The page classifier (shared) runs on the fetched body before
     extraction — anti-bot / expired pages return a typed soft-fail.
  3. Extraction priority for kleinanzeigen is DIFFERENT from AutoScout:
       embedded JSON blobs  →  meta tags  →  DOM extraction  →  weak
     JSON-LD is folded into "embedded JSON blobs" and is NOT treated as
     a primary source the way it is on AutoScout.
  4. VB pricing collapses to `priceEur: int | None`. No new field.
  5. Same canonical-bound output shape — `ListingParseResult` is NOT
     extended. Anything new (negotiability, freshness, seller trust)
     stays a UI / consumer concern.

Output: legacy dict consumed by `contract.from_legacy`.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Literal, Optional
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup


logger = logging.getLogger("parsers.kleinanzeigen")


_HOSTS: tuple[str, ...] = (
    "kleinanzeigen.de",
    "www.kleinanzeigen.de",
    "ebay-kleinanzeigen.de",
    "www.ebay-kleinanzeigen.de",
)

_HEADERS: dict[str, str] = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
}


def is_kleinanzeigen_url(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    return any(host == h or host.endswith("." + h.removeprefix("www."))
               for h in _HOSTS)


# ─────────────────────────────────────────────────────────────────────
# URL TOPOLOGY CLASSIFIER — runs BEFORE fetch
# ─────────────────────────────────────────────────────────────────────

UrlTopology = Literal["listing", "category", "search", "profile", "unknown"]


# Listing detail URLs: /s-anzeige/{slug}/{id}-{?-?} where id is 7-12 digits.
_RE_LISTING = re.compile(r"/s-anzeige/[^/?#]+/(\d{7,12})(?:[-/?#]|$)", re.IGNORECASE)

# Category (browse) URLs: /s-auto-kaufen-und-verkaufen/{cat}/{cat-id}
_RE_CATEGORY = re.compile(
    r"/s-auto[a-z\-]*/[^/?#]*(?:/[^/?#]*)?/?$",
    re.IGNORECASE,
)

# Search URLs: /s-suchanfrage/... or paths with `keywords=` etc.
_RE_SEARCH = re.compile(r"/s-(?:suchanfrage|seite|kategorie)/", re.IGNORECASE)

# Profile / shop / user pages: /pro/{seller}, /m-{user-id}, /s-bestandsliste, etc.
_RE_PROFILE = re.compile(
    r"^/(?:pro/|m-|s-bestandsliste|s-meinbenutzer|nutzer/|benutzerprofil)",
    re.IGNORECASE,
)


def classify_url_topology(url: str) -> UrlTopology:
    """Decide whether a kleinanzeigen URL is a listing-detail page —
    BEFORE fetching anything. The audit's #1 finding for kleinanzeigen
    was that category/search/profile pages were silently extracting OG
    titles and reaching `parsed=True`. This is the gate that closes
    that defect.

    Pure function — no I/O, no exception path. An unrecognised URL
    shape returns `"unknown"` and falls through to the body classifier
    upstream (which will then emit `unsupported_domain` /
    `not_a_listing` based on HTML markers).
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
    if _RE_SEARCH.search(path):
        return "search"
    # CATEGORY check runs AFTER listing — a `/s-anzeige/` URL would
    # otherwise match the broader `/s-auto*/` pattern.
    if _RE_CATEGORY.search(path):
        return "category"
    return "unknown"


# ─────────────────────────────────────────────────────────────────────
# Extraction layer 1 — embedded JSON blobs (multiple shapes)
# ─────────────────────────────────────────────────────────────────────

def _from_embedded_json(html: str, soup: BeautifulSoup) -> dict:
    """Kleinanzeigen embeds listing state in several JSON blobs:
      - JSON-LD `<script type="application/ld+json">` Product / Offer
      - `window.__INITIAL_STATE__ = {...};` inline script
      - `<script type="application/json" data-component="...">{...}</script>`

    All three are folded into one extraction step because kleinanzeigen
    moves between them between releases. We pull whatever the page
    exposes today.
    """
    out: dict[str, Any] = {}

    # 1a. JSON-LD
    for tag in soup.find_all("script", {"type": "application/ld+json"}):
        try:
            data = json.loads(tag.string or "{}")
        except Exception:
            continue
        nodes = data if isinstance(data, list) else [data]
        for node in nodes:
            if not isinstance(node, dict):
                continue
            t = str(node.get("@type", "")).lower()
            if t not in ("product", "vehicle", "offer", "individualproduct"):
                continue
            out.setdefault("title", node.get("name"))
            offers = node.get("offers")
            if isinstance(offers, dict):
                p = _coerce_price(offers.get("price"))
                if p is not None:
                    out.setdefault("price", p)
                if offers.get("priceCurrency"):
                    out.setdefault("currency", str(offers["priceCurrency"]).upper())
                seller = offers.get("seller")
                if isinstance(seller, dict):
                    st = (seller.get("@type") or "").lower()
                    if "person" in st or "private" in st:
                        out.setdefault("sellerType", "private")
                    elif "dealer" in st or "organization" in st or "business" in st:
                        out.setdefault("sellerType", "dealer")
            img = node.get("image")
            if isinstance(img, str):
                out.setdefault("image", img)
                out.setdefault("images", [img])
            elif isinstance(img, list):
                imgs = [x for x in img if isinstance(x, str)]
                if imgs:
                    out.setdefault("image", imgs[0])
                    out.setdefault("images", imgs)

    # 1b. window.__INITIAL_STATE__ inline blob
    m = re.search(
        r"window\.__INITIAL_STATE__\s*=\s*(\{.*?\})\s*;\s*</script>",
        html or "",
        re.DOTALL,
    )
    if m:
        try:
            payload = json.loads(m.group(1))
            _walk_initial_state(payload, out)
        except Exception:
            pass

    return out


def _walk_initial_state(payload: Any, sink: dict) -> None:
    """Defensive walk through the inline state blob. We accept whatever
    leaf keys we recognise — schema drift on kleinanzeigen is a known
    failure mode (audit).
    """
    if isinstance(payload, dict):
        if isinstance(payload.get("price"), dict):
            amount = payload["price"].get("amount") or payload["price"].get("value")
            p = _coerce_price(amount)
            if p is not None:
                sink.setdefault("price", p)
        if "title" in payload and isinstance(payload["title"], str):
            sink.setdefault("title", payload["title"])
        if "locationName" in payload and isinstance(payload["locationName"], str):
            sink.setdefault("location", payload["locationName"])
        for v in payload.values():
            _walk_initial_state(v, sink)
    elif isinstance(payload, list):
        for item in payload:
            _walk_initial_state(item, sink)


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

    # `product:price:amount` is the canonical meta hint kleinanzeigen
    # uses for the price on listing pages. It is also where the VB
    # signal disappears — VB doesn't ship in meta, only in DOM text.
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
# Extraction layer 3 — DOM extraction
#
# Kleinanzeigen renders listing details as a key-value list:
#   <ul id="viewad-details-list">
#     <li><span>Erstzulassung</span><span>06/2017</span></li>
#     <li><span>Kilometerstand</span><span>165.000 km</span></li>
#     <li><span>Kraftstoffart</span><span>Diesel</span></li>
#     <li><span>Getriebe</span><span>Schaltgetriebe</span></li>
#   </ul>
# ─────────────────────────────────────────────────────────────────────

_LABEL_RE = re.compile(r"\s+")


def _norm_label(s: str) -> str:
    return _LABEL_RE.sub(" ", (s or "")).strip().lower()


# German labels that map to canonical fields.
_DOM_LABEL_MAP: dict[str, str] = {
    "erstzulassung": "year",
    "kilometerstand": "mileage",
    "kraftstoffart": "fuel",
    "kraftstoff": "fuel",
    "getriebe": "transmission",
    "marke": "make",
    "modell": "model",
}


def _from_dom(soup: BeautifulSoup) -> dict:
    out: dict[str, Any] = {}
    if soup is None:
        return out

    # 3a. Detail key-value pairs.
    container = (soup.find(id="viewad-details-list")
                 or soup.find("ul", class_=re.compile("details", re.IGNORECASE)))
    if container is not None:
        for li in container.find_all("li"):
            spans = li.find_all(["span", "li"])
            if len(spans) < 2:
                continue
            label = _norm_label(spans[0].get_text())
            value = (spans[1].get_text() or "").strip()
            target = _DOM_LABEL_MAP.get(label)
            if not target or not value:
                continue
            if target == "year":
                y = _coerce_year(value)
                if y is not None:
                    out["year"] = y
            elif target == "mileage":
                m = _coerce_int(value)
                if m is not None:
                    out["mileage"] = m
            elif target == "fuel":
                out["fuel"] = value.lower()
            elif target == "transmission":
                v = value.lower()
                if "auto" in v:
                    out["transmission"] = "automatic"
                elif "schalt" in v or "manual" in v:
                    out["transmission"] = "manual"
            elif target in ("make", "model"):
                out[target] = value[:80]

    # 3b. Price text (with VB stripping).
    price_text = ""
    price_node = (soup.find(id="viewad-price")
                  or soup.find("h2", attrs={"itemprop": "price"})
                  or soup.find(class_=re.compile("price", re.IGNORECASE)))
    if price_node is not None:
        price_text = price_node.get_text(strip=True)
    if price_text:
        # VB / Verhandlungsbasis is a NEGOTIABLE signal we deliberately
        # drop at the substrate layer (audit decision: contract not
        # extended). UI may re-derive it from price-text formatting.
        cleaned = re.sub(r"\b(vb|verhandlungsbasis|zu verschenken)\b",
                         "", price_text, flags=re.IGNORECASE)
        # "Zu verschenken" listings carry no numeric price — emit None.
        if "verschenken" in price_text.lower():
            out.setdefault("price", None)
        else:
            p = _coerce_price(cleaned)
            if p is not None:
                out.setdefault("price", p)

    # 3c. Location (city + postcode).
    loc_node = soup.find(id="viewad-locality")
    if loc_node is not None:
        loc = re.sub(r"\s+", " ", loc_node.get_text(strip=True))
        if loc:
            out.setdefault("location", loc)

    return out


# ─────────────────────────────────────────────────────────────────────
# Extraction layer 4 — weak fallback (last resort, body text)
# ─────────────────────────────────────────────────────────────────────

_YEAR_TEXT_RE = re.compile(r"\b(19\d{2}|20[0-3]\d)\b")
_MILEAGE_TEXT_RE = re.compile(
    r"(\d{1,3}(?:[.\s]\d{3})+|\d{4,6})\s*km",
    re.IGNORECASE,
)


def _from_weak_fallback(soup: BeautifulSoup) -> dict:
    out: dict[str, Any] = {}
    if soup is None:
        return out
    text = soup.get_text(" ", strip=True)[:5000]
    my = _YEAR_TEXT_RE.search(text)
    if my:
        y = int(my.group(1))
        if 1950 <= y <= 2035:
            out["year"] = y
    mm = _MILEAGE_TEXT_RE.search(text)
    if mm:
        out["mileage"] = _coerce_int(mm.group(1))
    return out


# ─────────────────────────────────────────────────────────────────────
# URL slug → external id
# ─────────────────────────────────────────────────────────────────────

def _external_id_from_url(url: str) -> Optional[str]:
    """Listing ids are the trailing numeric segment in `/s-anzeige/...`."""
    if not url:
        return None
    m = _RE_LISTING.search(urlparse(url).path or "")
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


def _coerce_price(value: Any) -> Optional[int]:
    """Same as `_coerce_int` plus a sanity range so OG product:price
    accidents don't bleed (`product:price:amount=999999999` from a
    misconfigured listing → clamped to None)."""
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
    """Pure extractor — runs the four-layer chain in priority order.

    Does NOT classify failure modes. Caller must have already verified
    `classify_url_topology(url) == "listing"` and that
    `page_classifier.classify_page(...)` returned `valid_listing`.
    """
    base: dict[str, Any] = {
        "parsed": False,
        "source": "kleinanzeigen.de",
        "sourceUrl": url,
        "currency": "EUR",
    }
    if not html:
        return base

    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception:
        return base

    layers = [
        _from_embedded_json(html, soup),
        _from_meta(soup),
        _from_dom(soup),
        _from_weak_fallback(soup),
    ]
    merged: dict[str, Any] = {}
    for layer in layers:
        for k, v in (layer or {}).items():
            if v in (None, "", []):
                continue
            merged.setdefault(k, v)

    # External id from URL slug fallback.
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
        logger.warning(f"kleinanzeigen fetch failed {url}: {exc}")
        return None, "fetch_failed"


async def parse_url(url: str) -> dict:
    """Orchestrator pipeline:

      1. URL gate (must be kleinanzeigen host)
      2. URL TOPOLOGY classifier — category/search/profile short-circuit
         BEFORE the network is touched.
      3. fetch
      4. page_classifier (anti-bot / expired)
      5. parse_html
    """
    base: dict[str, Any] = {
        "parsed": False,
        "source": "kleinanzeigen.de",
        "sourceUrl": url,
        "currency": "EUR",
    }
    if not url:
        base["error"] = "url_required"
        return base
    if not is_kleinanzeigen_url(url):
        base["error"] = "unsupported_source"
        return base

    # 2) URL topology gate — runs BEFORE fetch (audit emphasis 10C-B).
    topology = classify_url_topology(url)
    if topology in ("category", "search", "profile"):
        base["error"] = "not_a_listing"
        # No fetch attempted — `degradedReason="not_a_listing"` is a
        # hard-fail and consumers will surface that to the user.
        return base
    # `unknown` topology is permissive — we still attempt extraction.
    # The body-level page_classifier will catch anti-bot / expired.

    # 3) Fetch.
    html, err = await fetch_html(url)
    if err or not html:
        slug_id = _external_id_from_url(url)
        base["error"] = err or "no_html"
        if slug_id:
            base["listingId"] = slug_id
        return base

    # 4) Page classifier — anti-bot / expired short-circuit.
    from app.parsers.page_classifier import classify_page
    verdict = classify_page(html=html, status_code=200,
                            source="kleinanzeigen.de", url=url)
    if verdict.kind != "valid_listing":
        slug_id = _external_id_from_url(url)
        base["error"] = verdict.degradedReason
        if slug_id:
            base["listingId"] = slug_id
        return base

    return parse_html(html, url)


__all__ = [
    "parse_url", "parse_html", "fetch_html",
    "is_kleinanzeigen_url", "classify_url_topology",
]
