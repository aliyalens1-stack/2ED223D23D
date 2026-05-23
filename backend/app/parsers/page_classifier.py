"""app.parsers.page_classifier — page-level verdict BEFORE field extraction.

Step 10B Pass 1.

The audit (sprint10a_parser_audit.md §E) catalogued three fake-success
defects. All three share the same root cause: the parser starts pulling
fields *before* it asks "is this even a listing page?". Cloudflare
interstitials, expired-listing notices, and search-results pages all
expose JSON-LD / OpenGraph fragments and therefore sneak past
`parsed = bool(title or price)`.

This module is the gate. Every fetched HTML body passes through
`classify_page(...)` and only `valid_listing` proceeds to extraction.
Everything else short-circuits to a typed soft-fail with a
`degradedReason` the canonical adapter understands.

Design rules:
  - Pure substrate. No HTTP, no DB, no logging side-effects.
  - Conservative: when in doubt, return `valid_listing`. False negatives
    erase legitimate traffic; false positives surface as
    `parseCompleteness=weak` downstream and are harmless.
  - All markers are explicit literals. Regex used only to anchor
    boundaries — no opaque pattern soup.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, Optional
from urllib.parse import urlparse


PageKind = Literal[
    "valid_listing",
    "antibot",
    "expired_listing",
    "not_a_listing",
    "unsupported_domain",
    "http_error",
    "timeout",
]


@dataclass(frozen=True)
class PageVerdict:
    """Result of page-level classification.

    `kind` is the typed verdict consumed by `_parse_generic` and
    `parse_url` (mobile.de). `degradedReason` is the canonical-contract
    code that maps 1:1 to `ListingParseResult.degradedReason` for the
    non-valid kinds.
    """
    kind: PageKind
    degradedReason: Optional[str] = None  # `None` only when kind == "valid_listing"


# ─────────────────────────────────────────────────────────────────────
# Marker tables (explicit strings only — no opaque heuristics)
# ─────────────────────────────────────────────────────────────────────

# Anti-bot signatures. Lowercased substring match against title + first
# ~4 KB of body. The list is intentionally short — only signatures we've
# personally observed on the supported sources or that are universal
# across CDNs.
_ANTIBOT_TITLE_MARKERS: tuple[str, ...] = (
    "just a moment",
    "attention required",
    "access denied",
    "you have been blocked",
    "please verify you are a human",
    "checking your browser",
    "one more step",
    "ddos protection",
)

_ANTIBOT_BODY_MARKERS: tuple[str, ...] = (
    "checking your browser before accessing",
    "ddos protection by cloudflare",
    "cf-browser-verification",
    "cf-challenge",
    "challenge-platform",
    "datadome",
    "px-captcha",
    "perimeterx",
    "_incapsula_resource",
    "this process is automatic",  # CF "Just a moment" body
)

# Expired-listing signatures. Multi-language because the supported
# marketplaces span DE / FR / IT / PL / AT / NL.
_EXPIRED_TITLE_MARKERS: tuple[str, ...] = (
    "ist nicht mehr verfügbar",
    "no longer available",
    "n'est plus disponible",
    "non è più disponibile",
    "nie jest już dostępne",
    "nie jest juz dostepne",
    "anzeige nicht gefunden",
    "anzeige wurde gelöscht",
    "listing not found",
    "this item has been sold",
    "verkauft",
)

_EXPIRED_BODY_MARKERS: tuple[str, ...] = (
    "wurde verkauft oder vom inserenten entfernt",
    "the listing is no longer available",
    "it has been sold or removed",
    "diese anzeige ist nicht mehr aktiv",
    "diese anzeige wurde",  # "...gelöscht" / "...entfernt" variants
)

# "Not a listing" signatures — pages from a known marketplace host but
# that are clearly search results, homepage, login walls, etc.
_NOT_A_LISTING_TITLE_MARKERS: tuple[str, ...] = (
    "suchergebnisse",
    "search results",
    "résultats de recherche",
    "anmelden",
    "log in",
    "sign in",
    "homepage",
)

# A *known* marketplace path that looks like a listing detail page —
# heuristic complement to the negative markers above. Conservative on
# purpose; failing this only flips the verdict to `not_a_listing` when
# the title also matches a negative marker.
_LISTING_PATH_HINTS: tuple[str, ...] = (
    "/fahrzeuge/",
    "/angebote/",
    "/details",
    "/inserate",
    "/anzeige/",
    "/cars/",
    "/used/",
    "/auto/",
    "/listing/",
)


# ─────────────────────────────────────────────────────────────────────
# Cheap HTML peek helpers — no BeautifulSoup, classifier is hot path
# ─────────────────────────────────────────────────────────────────────

_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_OG_TITLE_RE = re.compile(
    r'<meta[^>]*\bproperty=["\']og:title["\'][^>]*\bcontent=["\']([^"\']+)["\']',
    re.IGNORECASE,
)


def _extract_title(html: str) -> str:
    """Best-effort title — `<title>` first, then `og:title`."""
    m = _TITLE_RE.search(html)
    if m:
        return _strip(m.group(1))
    m = _OG_TITLE_RE.search(html)
    if m:
        return _strip(m.group(1))
    return ""


def _strip(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def _body_snippet(html: str, *, max_chars: int = 4096) -> str:
    """Lowercased prefix of the body for marker scanning. Cheap."""
    return (html or "")[:max_chars].lower()


def _matches_any(haystack: str, markers: tuple[str, ...]) -> bool:
    if not haystack:
        return False
    return any(m in haystack for m in markers)


# ─────────────────────────────────────────────────────────────────────
# Public classifier
# ─────────────────────────────────────────────────────────────────────

def classify_page(*, html: Optional[str],
                  status_code: Optional[int],
                  source: Optional[str],
                  url: str) -> PageVerdict:
    """Classify a fetched page BEFORE field extraction.

    Args:
        html:        response body (str) or None when fetch failed.
        status_code: HTTP status from upstream; None when we never
                     reached the upstream (e.g., timeout, DNS).
        source:      source id from `_detect_source` — or None for
                     unrecognised hosts.
        url:         the request URL (used for `not_a_listing` path
                     heuristics only).

    Returns:
        `PageVerdict` with `kind` and `degradedReason`. The mapping to
        the canonical contract is:
            antibot          → degradedReason="antibot"        soft-fail
            expired_listing  → "expired_listing"               soft-fail
            not_a_listing    → "not_a_listing"                 hard-fail
            unsupported_domain → "unsupported_domain"          hard-fail
            http_error       → "http_4xx" / "http_5xx"         soft-fail
            timeout          → "timeout"                       soft-fail
            valid_listing    → None
    """
    # 1) Network-layer failures — caller never got a body.
    if status_code is None and not html:
        return PageVerdict("timeout", "timeout")

    if isinstance(status_code, int) and status_code >= 400:
        # Anti-bot CDNs (Cloudflare/Datadome) often signal block via
        # 403/503 with a recognisable body. Prefer the more specific
        # `antibot` verdict when markers match.
        body = _body_snippet(html or "")
        title = _extract_title(html or "").lower()
        if _matches_any(title, _ANTIBOT_TITLE_MARKERS) or _matches_any(body, _ANTIBOT_BODY_MARKERS):
            return PageVerdict("antibot", "antibot")
        return PageVerdict("http_error", f"http_{status_code}")

    # 2) Body-driven classification — we have HTML to inspect.
    body = _body_snippet(html or "")
    title = _extract_title(html or "").lower()

    # 2a) Anti-bot interstitials returned with HTTP 200 (the audit E.1
    # case). Title or body match is enough.
    if _matches_any(title, _ANTIBOT_TITLE_MARKERS) or _matches_any(body, _ANTIBOT_BODY_MARKERS):
        return PageVerdict("antibot", "antibot")

    # 2b) Expired-listing markers (audit E.2).
    if _matches_any(title, _EXPIRED_TITLE_MARKERS) or _matches_any(body, _EXPIRED_BODY_MARKERS):
        return PageVerdict("expired_listing", "expired_listing")

    # 2c) Unsupported domain — we never even recognised the host.
    if source is None:
        return PageVerdict("unsupported_domain", "unsupported_domain")

    # 2d) Known marketplace, but URL/title look like a non-detail page.
    if _looks_like_non_listing(url=url, title=title):
        return PageVerdict("not_a_listing", "not_a_listing")

    # 3) Everything else — proceed with extraction.
    return PageVerdict("valid_listing", None)


def _looks_like_non_listing(*, url: str, title: str) -> bool:
    """Conservative heuristic: title says "search results / login" AND
    URL path lacks any listing-detail hint. Either condition alone is
    NOT enough — we don't want to misclassify a legitimate listing
    whose seller put `Anmelden` somewhere in the title."""
    if not _matches_any(title, _NOT_A_LISTING_TITLE_MARKERS):
        return False
    try:
        path = (urlparse(url).path or "").lower()
    except Exception:
        path = ""
    has_listing_hint = any(h in path for h in _LISTING_PATH_HINTS)
    return not has_listing_hint


__all__ = ["classify_page", "PageVerdict", "PageKind"]
