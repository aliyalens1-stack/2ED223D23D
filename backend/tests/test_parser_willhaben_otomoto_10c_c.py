"""Step 10C-C — Willhaben + Otomoto dedicated extractors.

Sprint 10C-C is the **final** extractor proliferation pass per the
audit doctrine. After this commit, tier topology is frozen:

    tier 1: mobile.de · autoscout24 · kleinanzeigen
    tier 2: willhaben · otomoto
    fallback: generic

Coverage in this test module:
  1. `_detect_source` bug fix — `lstrip("www.")` regression test.
  2. Willhaben: URL gate, URL topology, parse_html (JSON-LD path),
     priority chain, orchestrator failure modes, dispatcher routing.
  3. Otomoto: same coverage, plus PLN→canonical currency guard
     (canonical contract drops `priceEur` for non-EUR sources).
  4. Substrate invariants — `ListingParseResult` is NOT extended.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, "/app/backend")

from app.parsers import otomoto as O  # noqa: E402
from app.parsers import willhaben as W  # noqa: E402
from app.parsers.contract import ListingParseResult, from_legacy  # noqa: E402


FIXTURES_DIR = Path(__file__).parent / "fixtures" / "listings"


def _load(name: str) -> str:
    return (FIXTURES_DIR / name).read_text(encoding="utf-8")


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ═════════════════════════════════════════════════════════════════════
# 1) _detect_source bug fix — Sprint 10C-C item #3
# ═════════════════════════════════════════════════════════════════════

class TestDetectSourceBugFix:
    """`host.lstrip("www.")` strips a character set, not a prefix.

    Before 10C-C: `"www.willhaben.at".lstrip("www.")` → `"illhaben.at"`.
    Today the substring matches below tolerate the bug because
    `"willhaben"` is still in `"illhaben.at"` (no — actually it ISN'T).
    Confirm the fix routes the host correctly post-patch.
    """

    @pytest.mark.parametrize("url,expected", [
        ("https://www.willhaben.at/iad/gebrauchtwagen/d/auto/foo-1234567/", "willhaben.at"),
        ("https://willhaben.at/iad/gebrauchtwagen/d/auto/foo-1234567/", "willhaben.at"),
        ("https://www.otomoto.pl/osobowe/oferta/foo-ID6abc12.html", "otomoto.pl"),
        ("https://otomoto.pl/osobowe/oferta/foo-ID6abc12.html", "otomoto.pl"),
        ("https://www.mobile.de/fahrzeuge/details.html?id=123", "mobile.de"),
        ("https://www.autoscout24.de/angebote/x-1", "autoscout24"),
        ("https://www.kleinanzeigen.de/s-anzeige/foo/1234567890", "kleinanzeigen.de"),
    ])
    def test_known_hosts_route_correctly(self, url, expected):
        from app.parsers.universal import _detect_source
        assert _detect_source(url) == expected

    def test_lstrip_bug_regression(self):
        """If the fix regressed back to `lstrip("www.")`, this would
        return `None` for willhaben (because `"illhaben.at"` doesn't
        contain `"willhaben"`). Locks the prefix-strip semantics."""
        from app.parsers.universal import _detect_source
        # Even bare host (no www.) must still resolve.
        assert _detect_source("https://willhaben.at/x") == "willhaben.at"
        # `wuw.de` would become `uw.de` under the buggy lstrip — assert
        # the new code preserves the full host so the substring match
        # against unrelated marketplaces is intact.
        # No marketplace is matched here, so result is None — but the
        # important assertion is no AttributeError / wrong-host match.
        result = _detect_source("https://wuw.de/something")
        assert result is None

    def test_subdomains_handled(self):
        """`m.willhaben.at` is the willhaben mobile subdomain."""
        from app.parsers.universal import _detect_source
        assert _detect_source("https://m.willhaben.at/iad/gebrauchtwagen/d/auto/foo-99999999/") == "willhaben.at"


# ═════════════════════════════════════════════════════════════════════
# 2) WILLHABEN — URL gate + topology
# ═════════════════════════════════════════════════════════════════════

class TestWillhabenUrlGate:
    @pytest.mark.parametrize("url", [
        "https://www.willhaben.at/iad/gebrauchtwagen/d/auto/foo-1234567/",
        "https://willhaben.at/iad/gebrauchtwagen/d/auto/foo-1234567/",
        "https://m.willhaben.at/iad/x",
    ])
    def test_accepts(self, url):
        assert W.is_willhaben_url(url) is True

    @pytest.mark.parametrize("url", [
        "https://www.mobile.de/x",
        "https://willhaben-fake.io/x",
        "https://example.com/",
        "",
    ])
    def test_rejects(self, url):
        assert W.is_willhaben_url(url) is False


class TestWillhabenUrlTopology:
    @pytest.mark.parametrize("url,expected", [
        ("https://www.willhaben.at/iad/gebrauchtwagen/d/auto/bmw-320d-touring-1234567890/", "listing"),
        ("https://www.willhaben.at/iad/gebrauchtwagen/d/auto/audi-a4-987654321/", "listing"),
        ("https://www.willhaben.at/iad/kaufen-und-verkaufen/verkaeuferprofil/abc", "profile"),
        ("https://www.willhaben.at/iad/gebrauchtwagen/auto/gebrauchtwagenboerse?make=BMW", "search"),
        ("https://www.willhaben.at/iad/gebrauchtwagen/auto", "category"),
        ("https://www.willhaben.at/", "unknown"),
    ])
    def test_topology_classification(self, url, expected):
        assert W.classify_url_topology(url) == expected


# ═════════════════════════════════════════════════════════════════════
# 3) WILLHABEN — parse_html (JSON-LD primary path)
# ═════════════════════════════════════════════════════════════════════

class TestWillhabenParseHtml:
    URL = "https://www.willhaben.at/iad/gebrauchtwagen/d/auto/bmw-320d-touring-1234567890/"

    def test_full_field_extraction(self):
        data = W.parse_html(_load("willhaben_listing.html"), self.URL)
        assert data["source"] == "willhaben.at"
        assert data["parsed"] is True
        assert data["title"] == "BMW 320d Touring xDrive Steptronic"
        assert data["make"] == "BMW"
        assert data["model"] == "320d Touring"
        assert data["year"] == 2019
        assert data["price"] == 18900
        assert data["currency"] == "EUR"
        assert data["mileage"] == 110000
        assert data["fuel"] == "diesel"
        assert data["transmission"] == "automatic"
        assert data["sellerType"] == "dealer"
        assert data["location"] == "Wien"
        assert "sample-bmw-320d" in data["image"]
        assert data.get("error") is None

    def test_canonical_strong(self):
        data = W.parse_html(_load("willhaben_listing.html"), self.URL)
        canon = from_legacy(data)
        assert canon.ok is True
        assert canon.parseCompleteness == "strong"
        assert canon.priceEur == 18900
        assert canon.mileageKm == 110000
        assert canon.year == 2019
        assert canon.source == "willhaben.at"
        assert canon.degradedReason is None

    def test_listing_id_from_url_slug(self):
        data = W.parse_html(_load("willhaben_listing.html"), self.URL)
        assert data["listingId"] == "1234567890"


# ═════════════════════════════════════════════════════════════════════
# 4) WILLHABEN — orchestrator failure modes
# ═════════════════════════════════════════════════════════════════════

def _patch_w_fetch(monkeypatch, html, err=None):
    async def fake_fetch(url):
        return (html, err)
    monkeypatch.setattr(W, "fetch_html", fake_fetch, raising=True)


class TestWillhabenOrchestrator:
    LISTING_URL = "https://www.willhaben.at/iad/gebrauchtwagen/d/auto/bmw-320d-touring-1234567890/"
    SEARCH_URL = "https://www.willhaben.at/iad/gebrauchtwagen/auto/gebrauchtwagenboerse"
    PROFILE_URL = "https://www.willhaben.at/iad/kaufen-und-verkaufen/verkaeuferprofil/abc"

    def test_url_required(self):
        data = _run(W.parse_url(""))
        assert data["error"] == "url_required"

    def test_unsupported_source(self):
        data = _run(W.parse_url("https://www.example.com/x"))
        assert data["error"] == "unsupported_source"

    def test_search_url_short_circuits_before_fetch(self, monkeypatch):
        """The URL topology gate runs BEFORE fetch — patch fetch_html
        with a sentinel that would explode if called."""
        async def must_not_be_called(url):
            raise AssertionError("fetch_html should not be called for search URL")
        monkeypatch.setattr(W, "fetch_html", must_not_be_called, raising=True)
        data = _run(W.parse_url(self.SEARCH_URL))
        assert data["error"] == "not_a_listing"

    def test_profile_url_short_circuits_before_fetch(self, monkeypatch):
        async def must_not_be_called(url):
            raise AssertionError("fetch_html should not be called for profile URL")
        monkeypatch.setattr(W, "fetch_html", must_not_be_called, raising=True)
        data = _run(W.parse_url(self.PROFILE_URL))
        assert data["error"] == "not_a_listing"

    def test_fetch_error_short_circuits(self, monkeypatch):
        _patch_w_fetch(monkeypatch, None, "http_403")
        data = _run(W.parse_url(self.LISTING_URL))
        assert data["error"] == "http_403"
        assert data.get("listingId") == "1234567890"

    def test_antibot_short_circuits(self, monkeypatch):
        _patch_w_fetch(monkeypatch, _load("antibot_page.html"))
        data = _run(W.parse_url(self.LISTING_URL))
        assert data["error"] == "antibot"
        assert data.get("price") is None

    def test_expired_short_circuits(self, monkeypatch):
        _patch_w_fetch(monkeypatch, _load("expired_listing.html"))
        data = _run(W.parse_url(self.LISTING_URL))
        assert data["error"] == "expired_listing"

    def test_happy_path(self, monkeypatch):
        _patch_w_fetch(monkeypatch, _load("willhaben_listing.html"))
        data = _run(W.parse_url(self.LISTING_URL))
        assert data.get("error") is None
        assert data["price"] == 18900
        assert data["mileage"] == 110000
        canon = from_legacy(data)
        assert canon.parseCompleteness == "strong"


# ═════════════════════════════════════════════════════════════════════
# 5) OTOMOTO — URL gate + topology
# ═════════════════════════════════════════════════════════════════════

class TestOtomotoUrlGate:
    @pytest.mark.parametrize("url", [
        "https://www.otomoto.pl/osobowe/oferta/audi-a4-2-0-tdi-ID6abc12.html",
        "https://otomoto.pl/osobowe/oferta/foo-ID6abc12.html",
        "https://m.otomoto.pl/osobowe/oferta/foo-ID6abc12.html",
    ])
    def test_accepts(self, url):
        assert O.is_otomoto_url(url) is True

    @pytest.mark.parametrize("url", [
        "https://www.willhaben.at/x",
        "https://otomoto-fake.io/x",
        "https://example.com/",
        "",
    ])
    def test_rejects(self, url):
        assert O.is_otomoto_url(url) is False


class TestOtomotoUrlTopology:
    @pytest.mark.parametrize("url,expected", [
        ("https://www.otomoto.pl/osobowe/oferta/audi-a4-2-0-tdi-ID6abc12.html", "listing"),
        ("https://www.otomoto.pl/dostawcze/oferta/fiat-ducato-ID7def34.html", "listing"),
        ("https://www.otomoto.pl/dealer/auto-warszawa", "profile"),
        ("https://www.otomoto.pl/osobowe/uzywane/audi/a4", "search"),
        ("https://www.otomoto.pl/osobowe", "category"),
        ("https://www.otomoto.pl/osobowe/", "category"),
        ("https://www.otomoto.pl/", "unknown"),
    ])
    def test_topology_classification(self, url, expected):
        assert O.classify_url_topology(url) == expected


# ═════════════════════════════════════════════════════════════════════
# 6) OTOMOTO — parse_html (JSON-LD primary)
# ═════════════════════════════════════════════════════════════════════

class TestOtomotoParseHtml:
    URL = "https://www.otomoto.pl/osobowe/oferta/audi-a4-2-0-tdi-ID6abc12.html"

    def test_full_field_extraction(self):
        data = O.parse_html(_load("otomoto_listing.html"), self.URL)
        assert data["source"] == "otomoto.pl"
        assert data["parsed"] is True
        assert data["title"] == "Audi A4 Avant 2.0 TDI quattro S-tronic"
        assert data["make"] == "Audi"
        assert data["model"] == "A4 Avant"
        assert data["year"] == 2020
        assert data["price"] == 89900
        # JSON-LD priceCurrency is PLN — we preserve currency on the
        # legacy dict; canonical contract handles the EUR pin.
        assert data["currency"] == "PLN"
        assert data["mileage"] == 85000
        assert data["fuel"] == "diesel"
        assert data["transmission"] == "automatic"
        assert data["sellerType"] == "dealer"
        assert "sample-audi-a4" in data["image"]

    def test_listing_id_from_url_slug(self):
        data = O.parse_html(_load("otomoto_listing.html"), self.URL)
        assert data["listingId"] == "6abc12"


# ═════════════════════════════════════════════════════════════════════
# 7) OTOMOTO — currency invariant (PLN drops priceEur in canonical)
# ═════════════════════════════════════════════════════════════════════

class TestOtomotoCurrencyInvariant:
    """The canonical contract pins EUR; non-EUR currency → priceEur is
    dropped. This is an intentional substrate decision — FX conversion
    is a presentation/consumer concern, not a parser concern. Test
    locks the semantics so a future contributor doesn't quietly add a
    `pricePln` field to the contract."""

    URL = "https://www.otomoto.pl/osobowe/oferta/audi-a4-ID6abc12.html"

    def test_pln_currency_drops_priceEur_at_canonical(self):
        data = O.parse_html(_load("otomoto_listing.html"), self.URL)
        assert data["currency"] == "PLN"
        canon = from_legacy(data)
        # Currency guard in contract: priceEur set to None.
        assert canon.priceEur is None
        # Other fields preserved → still at least partial.
        assert canon.parseCompleteness in ("partial", "strong")
        # Mileage/year present so completeness is at least partial.
        assert canon.mileageKm == 85000
        assert canon.year == 2020
        # Source preserved.
        assert canon.source == "otomoto.pl"

    def test_eur_offer_keeps_priceEur(self):
        """If a future Otomoto listing emits priceCurrency=EUR (rare
        but possible for cross-border listings), priceEur survives."""
        html = """<html><head>
<script type="application/ld+json">
{"@type":"Vehicle","name":"Cross-border","brand":{"name":"BMW"},"model":"X1",
"vehicleModelDate":"2019","mileageFromOdometer":{"value":50000},
"offers":{"@type":"Offer","price":"15000","priceCurrency":"EUR"}}
</script>
</head><body></body></html>"""
        data = O.parse_html(html, self.URL)
        assert data["currency"] == "EUR"
        canon = from_legacy(data)
        assert canon.priceEur == 15000


# ═════════════════════════════════════════════════════════════════════
# 8) OTOMOTO — orchestrator failure modes
# ═════════════════════════════════════════════════════════════════════

def _patch_o_fetch(monkeypatch, html, err=None):
    async def fake_fetch(url):
        return (html, err)
    monkeypatch.setattr(O, "fetch_html", fake_fetch, raising=True)


class TestOtomotoOrchestrator:
    LISTING_URL = "https://www.otomoto.pl/osobowe/oferta/audi-a4-ID6abc12.html"
    SEARCH_URL = "https://www.otomoto.pl/osobowe/uzywane/audi/a4"
    PROFILE_URL = "https://www.otomoto.pl/dealer/auto-warszawa"

    def test_url_required(self):
        data = _run(O.parse_url(""))
        assert data["error"] == "url_required"

    def test_unsupported_source(self):
        data = _run(O.parse_url("https://www.example.com/x"))
        assert data["error"] == "unsupported_source"

    def test_search_url_short_circuits_before_fetch(self, monkeypatch):
        async def must_not_be_called(url):
            raise AssertionError("fetch_html should not be called for search URL")
        monkeypatch.setattr(O, "fetch_html", must_not_be_called, raising=True)
        data = _run(O.parse_url(self.SEARCH_URL))
        assert data["error"] == "not_a_listing"

    def test_profile_url_short_circuits_before_fetch(self, monkeypatch):
        async def must_not_be_called(url):
            raise AssertionError("fetch_html should not be called for profile URL")
        monkeypatch.setattr(O, "fetch_html", must_not_be_called, raising=True)
        data = _run(O.parse_url(self.PROFILE_URL))
        assert data["error"] == "not_a_listing"

    def test_fetch_error_short_circuits(self, monkeypatch):
        _patch_o_fetch(monkeypatch, None, "http_403")
        data = _run(O.parse_url(self.LISTING_URL))
        assert data["error"] == "http_403"
        assert data.get("listingId") == "6abc12"

    def test_antibot_short_circuits(self, monkeypatch):
        _patch_o_fetch(monkeypatch, _load("antibot_page.html"))
        data = _run(O.parse_url(self.LISTING_URL))
        assert data["error"] == "antibot"

    def test_happy_path(self, monkeypatch):
        _patch_o_fetch(monkeypatch, _load("otomoto_listing.html"))
        data = _run(O.parse_url(self.LISTING_URL))
        assert data.get("error") is None
        assert data["price"] == 89900
        assert data["mileage"] == 85000


# ═════════════════════════════════════════════════════════════════════
# 9) Dispatcher routing — universal.parse_listing delegates correctly
# ═════════════════════════════════════════════════════════════════════

class TestDispatcherRouting:
    def test_willhaben_url_routes_to_willhaben_extractor(self, monkeypatch):
        called = {"hit": False, "url": None}

        async def stub(url):
            called["hit"] = True
            called["url"] = url
            return {"parsed": True, "source": "willhaben.at",
                    "sourceUrl": url, "title": "stub", "currency": "EUR"}

        from app.parsers import willhaben as Wmod
        monkeypatch.setattr(Wmod, "parse_url", stub, raising=True)

        from app.parsers.universal import parse_listing
        url = "https://www.willhaben.at/iad/gebrauchtwagen/d/auto/foo-1234567890/"
        out = _run(parse_listing(url))
        assert called["hit"] is True
        assert called["url"] == url
        assert out["source"] == "willhaben.at"

    def test_otomoto_url_routes_to_otomoto_extractor(self, monkeypatch):
        called = {"hit": False, "url": None}

        async def stub(url):
            called["hit"] = True
            called["url"] = url
            return {"parsed": True, "source": "otomoto.pl",
                    "sourceUrl": url, "title": "stub", "currency": "PLN"}

        from app.parsers import otomoto as Omod
        monkeypatch.setattr(Omod, "parse_url", stub, raising=True)

        from app.parsers.universal import parse_listing
        url = "https://www.otomoto.pl/osobowe/oferta/foo-ID6abc12.html"
        out = _run(parse_listing(url))
        assert called["hit"] is True
        assert called["url"] == url
        assert out["source"] == "otomoto.pl"

    def test_dispatcher_does_not_cross_route(self, monkeypatch):
        """willhaben URL must NOT touch otomoto extractor and vice versa."""
        otomoto_called = {"hit": False}
        willhaben_called = {"hit": False}

        async def o_stub(url):
            otomoto_called["hit"] = True
            return {}

        async def w_stub(url):
            willhaben_called["hit"] = True
            return {}

        from app.parsers import otomoto as Omod
        from app.parsers import willhaben as Wmod
        monkeypatch.setattr(Omod, "parse_url", o_stub, raising=True)
        monkeypatch.setattr(Wmod, "parse_url", w_stub, raising=True)

        from app.parsers.universal import parse_listing
        _run(parse_listing("https://www.willhaben.at/iad/gebrauchtwagen/d/auto/foo-1234567890/"))
        assert otomoto_called["hit"] is False
        assert willhaben_called["hit"] is True


# ═════════════════════════════════════════════════════════════════════
# 10) Contract invariance — substrate is NOT extended in 10C-C
# ═════════════════════════════════════════════════════════════════════

class TestContractNotExpanded:
    """Sprint 10C-C explicitly bans contract expansion. The canonical
    model must expose exactly the fields frozen in Step 10A. No
    `currency`, no `negotiable`, no `freshness`, no `sourceCountry`.
    """

    def test_fields_frozen(self):
        fields = set(ListingParseResult.model_fields.keys())
        expected = {
            "ok", "source", "sourceUrl",
            "externalId", "title", "make", "model", "year",
            "priceEur", "mileageKm", "location", "vin",
            "fuel", "transmission", "sellerType", "images",
            "parseCompleteness", "degradedReason",
        }
        assert fields == expected, f"Contract drift: {fields ^ expected}"

    def test_no_pricePln_field(self):
        """Locks the substrate decision: PLN→priceEur=None is correct,
        adding `pricePln` would have been the wrong path."""
        assert "pricePln" not in ListingParseResult.model_fields
        assert "currency" not in ListingParseResult.model_fields
