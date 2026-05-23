"""app.parsers.contract — canonical Listing Parse Result contract (Step 10A).

This module is the single source of truth for the *shape* and the
*hard-fail vs soft-fail semantics* of every parser path in the platform.

Step 10A is intentionally read-only: no consumer is migrated to this
contract yet. Existing parsers (`mobile_de.py`, `universal.py`) keep
returning their legacy dicts. The helpers in this file let tests — and,
in Step 10B, consumers — translate legacy dicts into the canonical
`ListingParseResult` without re-running extraction.

Naming choices (documented in `/app/memory/sprint10a_parser_audit.md`):
  - `parseCompleteness` (not `confidence`) — the original `confidence`
    name collided with the customer-facing "report confidence" surface.
    `parseCompleteness` is unambiguously about extraction quality.
  - `externalId` (not `listingId`) — the pair (source, externalId) is
    the natural foreign key for marketplace listings.
  - `priceEur` / `mileageKm` — units are part of the name so consumers
    can never mis-interpret. We pin EUR because every supported source
    is EU-based; non-EUR results are coerced via `currency` legacy field
    before mapping (see `from_legacy`).

This file MUST NOT import any HTTP client, MongoDB driver, or any other
side-effect-carrying dependency. It is pure substrate.
"""
from __future__ import annotations

from typing import Any, Iterable, List, Literal, Optional, Tuple

from pydantic import BaseModel, Field


# ─────────────────────────────────────────────────────────────────────
# Canonical envelope
# ─────────────────────────────────────────────────────────────────────

ParseCompleteness = Literal["strong", "partial", "weak"]
FailureMode = Literal["hard", "soft"]


# Core fields counted toward `parseCompleteness`. Kept explicit on purpose:
# `make` and `model` are excluded because they are often inferred from
# `title` and would double-count.
CORE_FIELDS: Tuple[str, ...] = ("title", "priceEur", "mileageKm", "year")


# Error codes the platform recognises today. Step 10B will add `antibot`,
# `not_a_listing`, `expired_listing` and remove the now-redundant
# `low_extraction_confidence` (it duplicates `parseCompleteness=weak`).
HARD_FAIL_CODES: frozenset[str] = frozenset({
    "url_required",
    "bad_url",
    "unsupported_source",
    "unsupported_domain",
    # Step 10B reservations (recognised but not yet emitted by parsers):
    "not_a_listing",
})

SOFT_FAIL_CODES: frozenset[str] = frozenset({
    "no_html",
    "timeout",
    "network",
    "fetch_failed",
    "fetch_error",
    "parse_error",
    "parse_exception",
    "low_extraction_confidence",
    # Step 10B reservations:
    "antibot",
    "expired_listing",
})


def _is_http_status_error(code: Optional[str]) -> bool:
    """`http_403`, `http_429`, `http_503`, etc. — always soft-fail."""
    if not isinstance(code, str):
        return False
    return code.startswith("http_4") or code.startswith("http_5")


def _is_fetch_error_prefix(code: Optional[str]) -> bool:
    """`fetch_error:TimeoutError`, `fetch_error:ConnectError`, etc."""
    return isinstance(code, str) and code.startswith("fetch_error")


class ListingParseResult(BaseModel):
    """Canonical parse result shape (frozen at Step 10A).

    Every parser path is expected, by Step 10B, to return data that maps
    cleanly into this model via `from_legacy`. Today the model is used
    only by the audit tests — production traffic still flows through the
    legacy dict shape.
    """

    ok: bool
    source: str
    sourceUrl: str

    externalId: Optional[str] = None
    title: Optional[str] = None
    make: Optional[str] = None
    model: Optional[str] = None
    year: Optional[int] = None
    priceEur: Optional[int] = None
    mileageKm: Optional[int] = None
    location: Optional[str] = None
    vin: Optional[str] = None
    fuel: Optional[str] = None
    transmission: Optional[str] = None
    sellerType: Optional[str] = None
    images: List[str] = Field(default_factory=list)

    parseCompleteness: ParseCompleteness
    degradedReason: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────
# Classifiers (pure functions — no I/O)
# ─────────────────────────────────────────────────────────────────────

def classify_completeness(fields: dict) -> ParseCompleteness:
    """Return `strong` / `partial` / `weak` from a dict of canonical fields.

    Counts how many of `CORE_FIELDS` carry a truthy value. Tie-breaker
    rules are explicit in the audit doc (C.1) — kept here as code so a
    grep for `parseCompleteness` lands on the rule.
    """
    filled = sum(1 for f in CORE_FIELDS if fields.get(f) not in (None, "", 0))
    # `year=0` is legitimately not a year, treat as missing. `priceEur=0`
    # is "free" — extremely rare in vehicle marketplaces and almost
    # always a parsing artefact — so we treat 0 as missing too.
    if filled >= 4:
        return "strong"
    if filled >= 2:
        return "partial"
    return "weak"


def classify_failure_mode(error_code: Optional[str], *,
                          source_recognised: bool) -> Optional[FailureMode]:
    """Return `'hard'`, `'soft'`, or `None` (no failure).

    A *None* result means the parser completed without a recognised error
    code — the consumer should still inspect `parseCompleteness` to
    decide if the payload is useful enough.

    Hard-fail = the user must change something. Soft-fail = the substrate
    must retry / proxy / accept the link anyway.
    """
    if error_code is None:
        return None

    if error_code in HARD_FAIL_CODES:
        # `unsupported_source` is hard ONLY when the dispatcher also did
        # not recognise the host. mobile_de.parse_url emits this code
        # even when called *directly* on a non-mobile.de URL — in that
        # path (used by /api/inspection/report/generate) the dispatcher
        # may still know what to do, so the router that consumed the
        # error treats it as soft. Step 10B collapses both callers.
        if error_code == "unsupported_source" and source_recognised:
            return "soft"
        return "hard"

    if error_code in SOFT_FAIL_CODES:
        return "soft"

    if _is_http_status_error(error_code) or _is_fetch_error_prefix(error_code):
        return "soft"

    # Unknown error code → default to soft. Surface keeps the link, ops
    # gets a "new error code observed" signal from telemetry.
    return "soft"


# ─────────────────────────────────────────────────────────────────────
# Legacy → canonical adapter
# ─────────────────────────────────────────────────────────────────────

# Synonym list per canonical field. Kept ordered so that the higher-
# fidelity legacy key wins (e.g., JSON-LD `price` from mobile_de.parse_html
# is preferred over OG-only `product:price:amount`).
_LEGACY_KEY_MAP: dict[str, Tuple[str, ...]] = {
    "title":       ("title",),
    "make":        ("make", "brand"),
    "model":       ("model",),
    "year":        ("year", "modelYear"),
    "priceEur":    ("priceEur", "price"),
    "mileageKm":   ("mileageKm", "mileage"),
    "fuel":        ("fuel", "fuelType"),
    "transmission": ("transmission", "gearbox"),
    "sellerType":  ("sellerType", "seller_type", "seller"),
    "location":    ("location", "city"),
    "vin":         ("vin",),
    "externalId":  ("externalId", "listingId"),
}


def _coerce_int(v: Any) -> Optional[int]:
    if v is None:
        return None
    if isinstance(v, bool):
        return None  # don't let `True` become `1`
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v) if v == v and v not in (float("inf"), float("-inf")) else None
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        # Strip thousand separators / currency symbols / 'km' suffix
        keep = []
        for ch in s:
            if ch.isdigit() or ch == "-":
                keep.append(ch)
        digits = "".join(keep)
        if digits in ("", "-"):
            return None
        try:
            return int(digits)
        except ValueError:
            return None
    return None


def _coerce_images(legacy: dict) -> List[str]:
    out: List[str] = []
    img = legacy.get("image")
    if isinstance(img, str) and img:
        out.append(img)
    extra = legacy.get("images")
    if isinstance(extra, list):
        for x in extra:
            if isinstance(x, str) and x and x not in out:
                out.append(x)
    return out


def from_legacy(legacy: dict) -> ListingParseResult:
    """Map a legacy parser dict (from `parse_listing` / `parse_url` /
    `_parse_generic`) to the canonical `ListingParseResult`.

    Behaviour is intentionally lenient — every legacy dict shape we
    encounter today is accepted. Unknown legacy keys are ignored.
    Currency other than EUR is **dropped** rather than converted; the
    audit explicitly pins EUR as the only supported currency at the
    contract layer (every supported source is EU-based). Non-EUR price
    legacy values fall through to `priceEur=None`.
    """
    if not isinstance(legacy, dict):
        raise TypeError("legacy must be a dict")

    source = legacy.get("source") or "unknown"
    source_url = legacy.get("sourceUrl") or legacy.get("url") or ""
    error_code = legacy.get("error")

    # Source recognition: parser produced a non-null source AND it's not
    # the "generic" bucket.
    source_recognised = bool(legacy.get("source")) and legacy.get("source") != "generic"
    failure = classify_failure_mode(error_code, source_recognised=source_recognised)

    # Extract canonical fields.
    pulled: dict = {}
    for canonical, synonyms in _LEGACY_KEY_MAP.items():
        for s in synonyms:
            if s in legacy and legacy[s] not in (None, ""):
                pulled[canonical] = legacy[s]
                break

    # Currency guard — drop priceEur if currency is set and is not EUR.
    currency = legacy.get("currency")
    if isinstance(currency, str) and currency.strip().upper() not in ("", "EUR"):
        pulled.pop("priceEur", None)

    # Type coercion for numerics.
    if "year" in pulled:
        y = _coerce_int(pulled["year"])
        pulled["year"] = y if (y is not None and 1950 <= y <= 2035) else None
    if "priceEur" in pulled:
        pulled["priceEur"] = _coerce_int(pulled["priceEur"])
    if "mileageKm" in pulled:
        pulled["mileageKm"] = _coerce_int(pulled["mileageKm"])

    # String coercion for textual fields — strip and trim absurd lengths.
    for f in ("title", "make", "model", "fuel", "transmission", "sellerType",
              "location", "vin", "externalId"):
        v = pulled.get(f)
        if isinstance(v, str):
            pulled[f] = v.strip()[:200] or None
        elif v is not None:
            pulled[f] = str(v)[:200] or None

    images = _coerce_images(legacy)

    # Compute parseCompleteness from canonical fields.
    completeness = classify_completeness(pulled)

    # `ok` = no hard-fail AND at least partial signal.
    # A soft-fail with weak completeness is still NOT ok — but we keep
    # `source`/`sourceUrl` so consumers can render the "✓ Link accepted"
    # state. Hard-fail is never ok.
    if failure == "hard":
        ok = False
    elif failure == "soft":
        ok = completeness != "weak"
    else:
        ok = completeness in ("strong", "partial")

    return ListingParseResult(
        ok=ok,
        source=source,
        sourceUrl=source_url,
        externalId=pulled.get("externalId"),
        title=pulled.get("title"),
        make=pulled.get("make"),
        model=pulled.get("model"),
        year=pulled.get("year"),
        priceEur=pulled.get("priceEur"),
        mileageKm=pulled.get("mileageKm"),
        location=pulled.get("location"),
        vin=pulled.get("vin"),
        fuel=pulled.get("fuel"),
        transmission=pulled.get("transmission"),
        sellerType=pulled.get("sellerType"),
        images=images,
        parseCompleteness=completeness,
        degradedReason=error_code if failure is not None else None,
    )


__all__ = [
    "ListingParseResult",
    "ParseCompleteness",
    "FailureMode",
    "CORE_FIELDS",
    "HARD_FAIL_CODES",
    "SOFT_FAIL_CODES",
    "classify_completeness",
    "classify_failure_mode",
    "from_legacy",
]
