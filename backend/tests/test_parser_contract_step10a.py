"""Step 10A — Vehicle Parser Contract tests (offline, deterministic).

These tests lock the contract surface frozen in
`/app/memory/sprint10a_parser_audit.md`. Three layers are covered:

  1. The pure classifier (`classify_completeness`, `classify_failure_mode`)
     — no parser invocation, just input dicts → expected verdict.
  2. The legacy → canonical adapter (`from_legacy`) — every shape that
     today's parsers actually emit must map without raising and produce
     a `ListingParseResult` consistent with the audit.
  3. Existing extractors run against on-disk HTML fixtures with
     `httpx.AsyncClient.get` monkey-patched. **No network access.** The
     test asserts that whatever current behaviour produces, the result
     wrapped in `from_legacy` lands in the right `ok` / completeness /
     failure_mode bucket.

Layer 3 is deliberately defensive — the audit explicitly catalogues that
the current `_parse_generic` fake-succeeds on Cloudflare and expired
pages. The test pins **today's behaviour** and the **canonical re-read**
side-by-side, so that Step 10B's hardening can flip the canonical bucket
without changing the legacy heuristic until consumers are migrated.
"""
from __future__ import annotations

import sys
import asyncio
from pathlib import Path
from typing import Any

import pytest

# Ensure backend package is importable.
sys.path.insert(0, "/app/backend")

from app.parsers import contract as C  # noqa: E402
from app.parsers.mobile_de import parse_html as md_parse_html  # noqa: E402


FIXTURES_DIR = Path(__file__).parent / "fixtures" / "listings"


def _load(name: str) -> str:
    return (FIXTURES_DIR / name).read_text(encoding="utf-8")


# ─────────────────────────────────────────────────────────────────────
# Layer 1 — pure classifier
# ─────────────────────────────────────────────────────────────────────

class TestClassifyCompleteness:
    def test_strong_all_core(self):
        fields = {"title": "BMW", "priceEur": 18900, "mileageKm": 120000, "year": 2018}
        assert C.classify_completeness(fields) == "strong"

    def test_partial_three(self):
        fields = {"title": "BMW", "priceEur": 18900, "mileageKm": 120000}
        assert C.classify_completeness(fields) == "partial"

    def test_partial_two(self):
        fields = {"title": "BMW", "year": 2018}
        assert C.classify_completeness(fields) == "partial"

    def test_weak_one(self):
        fields = {"title": "BMW"}
        assert C.classify_completeness(fields) == "weak"

    def test_weak_zero(self):
        assert C.classify_completeness({}) == "weak"

    def test_zero_is_not_signal(self):
        # priceEur=0 and year=0 must NOT count toward completeness.
        fields = {"title": "BMW", "priceEur": 0, "mileageKm": 0, "year": 0}
        assert C.classify_completeness(fields) == "weak"

    def test_make_and_model_do_not_count(self):
        # Even with title+make+model, missing price/mileage/year is weak.
        fields = {"title": "BMW 320d", "make": "BMW", "model": "320d"}
        assert C.classify_completeness(fields) == "weak"


class TestClassifyFailureMode:
    def test_no_error_returns_none(self):
        assert C.classify_failure_mode(None, source_recognised=True) is None

    def test_hard_unsupported_domain(self):
        assert C.classify_failure_mode("unsupported_domain", source_recognised=False) == "hard"

    def test_hard_bad_url(self):
        assert C.classify_failure_mode("bad_url", source_recognised=False) == "hard"

    def test_hard_url_required(self):
        assert C.classify_failure_mode("url_required", source_recognised=False) == "hard"

    def test_unsupported_source_with_dispatcher_recognition_is_soft(self):
        # Audit D.1 — when the dispatcher recognised the host but
        # mobile_de.parse_url was the entry point, the result is soft.
        assert C.classify_failure_mode("unsupported_source", source_recognised=True) == "soft"

    def test_unsupported_source_without_dispatcher_recognition_is_hard(self):
        assert C.classify_failure_mode("unsupported_source", source_recognised=False) == "hard"

    @pytest.mark.parametrize("code", ["http_403", "http_404", "http_429", "http_503"])
    def test_soft_http_status(self, code):
        assert C.classify_failure_mode(code, source_recognised=True) == "soft"

    @pytest.mark.parametrize("code", [
        "no_html", "timeout", "network", "fetch_failed", "parse_error",
        "parse_exception", "low_extraction_confidence", "antibot",
        "expired_listing",
    ])
    def test_soft_known_codes(self, code):
        assert C.classify_failure_mode(code, source_recognised=True) == "soft"

    def test_soft_fetch_error_prefix(self):
        assert C.classify_failure_mode("fetch_error:ConnectError", source_recognised=True) == "soft"

    def test_unknown_code_defaults_to_soft(self):
        assert C.classify_failure_mode("brand_new_emit_code", source_recognised=True) == "soft"


# ─────────────────────────────────────────────────────────────────────
# Layer 2 — legacy → canonical adapter
# ─────────────────────────────────────────────────────────────────────

class TestFromLegacyShapes:
    def test_full_mobile_de_success(self):
        legacy = {
            "parsed": True, "source": "mobile.de", "sourceUrl": "https://mobile.de/x?id=1",
            "title": "BMW 320d Touring", "make": "BMW", "model": "320d Touring",
            "year": 2019, "price": 18900, "currency": "EUR", "mileage": 128000,
            "fuel": "diesel", "image": "https://img/a.jpg", "listingId": "1",
            "error": None,
        }
        out = C.from_legacy(legacy)
        assert out.ok is True
        assert out.source == "mobile.de"
        assert out.externalId == "1"
        assert out.priceEur == 18900
        assert out.mileageKm == 128000
        assert out.year == 2019
        assert out.fuel == "diesel"
        assert out.images == ["https://img/a.jpg"]
        assert out.parseCompleteness == "strong"
        assert out.degradedReason is None

    def test_anti_bot_soft_fail_weak(self):
        legacy = {
            "parsed": False, "source": "mobile.de", "sourceUrl": "https://mobile.de/x",
            "error": "http_403", "title": None, "currency": "EUR",
        }
        out = C.from_legacy(legacy)
        assert out.ok is False
        assert out.parseCompleteness == "weak"
        assert out.degradedReason == "http_403"

    def test_hard_fail_unsupported_domain(self):
        legacy = {
            "parsed": False, "source": None, "sourceUrl": "https://example.com/foo",
            "error": "unsupported_domain", "currency": "EUR",
        }
        out = C.from_legacy(legacy)
        assert out.ok is False
        assert out.degradedReason == "unsupported_domain"
        assert out.parseCompleteness == "weak"

    def test_non_eur_currency_drops_price(self):
        legacy = {
            "parsed": True, "source": "autoscout24", "sourceUrl": "x",
            "title": "Car", "price": 22000, "currency": "PLN",
            "mileage": 50000, "year": 2020, "error": None,
        }
        out = C.from_legacy(legacy)
        # Price dropped because currency != EUR; mileage+year still in
        # → 2 core fields (title, mileage, year? title+mileage+year=3) → partial
        assert out.priceEur is None
        assert out.mileageKm == 50000
        assert out.year == 2020
        # title + mileageKm + year = 3 filled core fields
        assert out.parseCompleteness == "partial"

    def test_string_numeric_coercion(self):
        legacy = {
            "parsed": True, "source": "autoscout24", "sourceUrl": "x",
            "title": "X", "price": "22.490", "mileage": "95.000 km", "year": "2020",
            "currency": "EUR", "error": None,
        }
        out = C.from_legacy(legacy)
        assert out.priceEur == 22490
        assert out.mileageKm == 95000
        assert out.year == 2020

    def test_legacy_listingId_renamed_to_externalId(self):
        legacy = {"parsed": False, "source": "mobile.de", "sourceUrl": "x",
                  "listingId": "429123", "error": "http_403", "currency": "EUR"}
        out = C.from_legacy(legacy)
        assert out.externalId == "429123"

    def test_implausible_year_is_dropped(self):
        legacy = {"parsed": True, "source": "mobile.de", "sourceUrl": "x",
                  "title": "X", "year": 1899, "currency": "EUR", "error": None}
        out = C.from_legacy(legacy)
        assert out.year is None

    def test_image_singleton_promotes_to_list(self):
        legacy = {"parsed": False, "source": "mobile.de", "sourceUrl": "x",
                  "image": "https://img/single.jpg", "error": "http_403",
                  "currency": "EUR"}
        out = C.from_legacy(legacy)
        assert out.images == ["https://img/single.jpg"]

    def test_ok_requires_partial_or_better(self):
        # No error code, but only title was extracted — weak → ok=False.
        legacy = {"parsed": True, "source": "kleinanzeigen.de", "sourceUrl": "x",
                  "title": "Some Car", "currency": "EUR", "error": None}
        out = C.from_legacy(legacy)
        assert out.parseCompleteness == "weak"
        assert out.ok is False


# ─────────────────────────────────────────────────────────────────────
# Layer 3 — fixture-driven, fully offline
# ─────────────────────────────────────────────────────────────────────

class TestMobileDeFixtures:
    """The dedicated mobile.de extractor runs on disk HTML — no network."""

    def test_mobile_de_jsonld_path_is_strong(self):
        html = _load("mobile_de_basic.html")
        legacy = md_parse_html(html, "https://www.mobile.de/fahrzeuge/details.html?id=429123")
        # Legacy `parse_html` doesn't set `parsed`; emulate the
        # `parse_url` wrapper rule: ≥2 of title/price/mileage/year.
        legacy["parsed"] = sum(1 for k in ("title", "price", "mileage", "year")
                               if legacy.get(k)) >= 2

        out = C.from_legacy(legacy)
        assert out.source == "mobile.de"
        assert out.title and "BMW" in out.title
        assert out.priceEur == 18900
        assert out.mileageKm == 128000
        assert out.year == 2019
        assert out.fuel == "diesel"
        assert out.externalId == "429123"
        assert out.parseCompleteness == "strong"
        assert out.ok is True

    def test_mobile_de_og_fallback_is_strong(self):
        html = _load("mobile_de_og_only.html")
        legacy = md_parse_html(html, "https://www.mobile.de/fahrzeuge/details.html?id=555")
        legacy["parsed"] = sum(1 for k in ("title", "price", "mileage", "year")
                               if legacy.get(k)) >= 2

        out = C.from_legacy(legacy)
        assert out.source == "mobile.de"
        assert out.priceEur == 16490
        assert out.mileageKm == 145000
        assert out.year == 2018
        assert out.externalId == "555"
        assert out.parseCompleteness == "strong"


class TestGenericFixturesOffline:
    """`_parse_generic` triggers a network call; we monkey-patch
    `httpx.AsyncClient.get` so it returns a canned HTML body."""

    def _patch_httpx(self, monkeypatch, html_body: str, status_code: int = 200):
        import httpx
        from app.parsers import universal as U

        class _StubResp:
            def __init__(self):
                self.status_code = status_code
                self.text = html_body

        async def fake_get(self, *args, **kwargs):
            return _StubResp()

        monkeypatch.setattr(httpx.AsyncClient, "get", fake_get, raising=True)
        return U

    def _run(self, coro):
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()

    def test_autoscout24_jsonld(self, monkeypatch):
        U = self._patch_httpx(monkeypatch, _load("autoscout24_basic.html"))
        legacy = self._run(U._parse_generic(
            "https://www.autoscout24.de/angebote/vw-passat-x-12345", "autoscout24"
        ))
        out = C.from_legacy(legacy)
        assert out.source == "autoscout24"
        assert out.title and "Passat" in out.title
        assert out.priceEur == 22490
        assert out.mileageKm == 95000
        assert out.year == 2020
        assert out.parseCompleteness == "strong"
        assert out.ok is True

    def test_kleinanzeigen_og_partial(self, monkeypatch):
        U = self._patch_httpx(monkeypatch, _load("kleinanzeigen_basic.html"))
        legacy = self._run(U._parse_generic(
            "https://www.kleinanzeigen.de/s-auto-kaufen-und-verkaufen/opel/k0c216",
            "kleinanzeigen.de",
        ))
        out = C.from_legacy(legacy)
        assert out.source == "kleinanzeigen.de"
        # We have OG title + product price meta → at least partial.
        assert out.priceEur == 7890
        assert out.parseCompleteness in ("partial", "strong")
        assert out.ok is True

    def test_antibot_page_canonical_view_is_weak(self, monkeypatch):
        """Audit E.1 — Step 10B closed this defect via page_classifier.
        `_parse_generic` now emits `error="antibot"` BEFORE field
        extraction; the canonical adapter maps that to a soft-fail with
        `degradedReason="antibot"` and `parseCompleteness=weak`."""
        U = self._patch_httpx(monkeypatch, _load("antibot_page.html"))
        legacy = self._run(U._parse_generic(
            "https://www.autoscout24.de/angebote/anything-12345", "autoscout24"
        ))
        out = C.from_legacy(legacy)
        # Step 10B contract: typed degraded reason, no fake-success.
        assert out.degradedReason == "antibot"
        assert out.parseCompleteness == "weak"
        assert out.ok is False
        assert out.title is None

    def test_expired_listing_canonical_view_is_weak(self, monkeypatch):
        """Audit E.2 — same closure path as anti-bot. Multi-language
        markers in page_classifier flip the verdict to
        `degradedReason="expired_listing"`."""
        U = self._patch_httpx(monkeypatch, _load("expired_listing.html"))
        legacy = self._run(U._parse_generic(
            "https://www.autoscout24.de/angebote/expired-99999", "autoscout24"
        ))
        out = C.from_legacy(legacy)
        assert out.degradedReason == "expired_listing"
        assert out.parseCompleteness == "weak"
        assert out.ok is False

    def test_unsupported_domain_no_signal(self, monkeypatch):
        """Generic HTML with no automotive content. Step 10B classifier
        flags `source=None` as `unsupported_domain` (hard-fail). The
        canonical adapter maps the hard-fail to `ok=False` with the
        typed `degradedReason`."""
        U = self._patch_httpx(monkeypatch, _load("unsupported_domain.html"))
        legacy = self._run(U._parse_generic(
            "https://example.com/some-page", None  # source=None → unsupported
        ))
        out = C.from_legacy(legacy)
        assert out.degradedReason == "unsupported_domain"
        assert out.parseCompleteness == "weak"
        assert out.ok is False

    def test_jsonld_numeric_mileage_value_coerces(self, monkeypatch):
        """Step 10B closure of audit defect E.4. `_to_int` now coerces
        non-string inputs to `str`, so numeric JSON-LD `value` fields
        flow through without raising TypeError."""
        html_int_mileage = """<!DOCTYPE html><html><head>
<title>X</title>
<script type="application/ld+json">
{"@type": "Vehicle", "name": "Some car X",
 "mileageFromOdometer": {"@type": "QuantitativeValue", "value": 95000},
 "offers": {"@type": "Offer", "price": 22490, "priceCurrency": "EUR"}}
</script></head><body></body></html>"""
        U = self._patch_httpx(monkeypatch, html_int_mileage)
        legacy = self._run(U._parse_generic(
            "https://www.autoscout24.de/x", "autoscout24"
        ))
        # No crash, both numeric fields extracted.
        assert legacy.get("error") in (None, "")
        assert legacy.get("mileage") == 95000
        assert legacy.get("price") == 22490


# ─────────────────────────────────────────────────────────────────────
# Negative tests — fixtures must exist on disk so we never silently
# regress to a "no test corpus" state.
# ─────────────────────────────────────────────────────────────────────

class TestFixtureCorpusPresence:
    REQUIRED = (
        "mobile_de_basic.html",
        "mobile_de_og_only.html",
        "autoscout24_basic.html",
        "kleinanzeigen_basic.html",
        "antibot_page.html",
        "expired_listing.html",
        "unsupported_domain.html",
    )

    @pytest.mark.parametrize("name", REQUIRED)
    def test_fixture_exists_and_non_empty(self, name):
        p = FIXTURES_DIR / name
        assert p.exists(), f"Missing fixture: {name}"
        assert p.stat().st_size > 100, f"Suspiciously small fixture: {name}"
