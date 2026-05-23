"""Step 10C-B — Kleinanzeigen dedicated extractor.

Coverage:
  1. URL topology classifier (PURE — no I/O).
  2. parse_html against the rich `kleinanzeigen_listing.html` fixture
     covering DOM details list + VB-priced text.
  3. Individual extraction layers in isolation.
  4. Orchestrator: URL-topology short-circuit BEFORE fetch,
     anti-bot / expired short-circuit AFTER fetch.
  5. Dispatcher routing.
  6. Anchor: generic parser no longer sees kleinanzeigen URLs.

All offline. No network. No contract expansion — VB stays implicit in
`priceEur: int | None`.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, "/app/backend")

from app.parsers import kleinanzeigen as K  # noqa: E402
from app.parsers.contract import from_legacy  # noqa: E402


FIXTURES_DIR = Path(__file__).parent / "fixtures" / "listings"


def _load(name: str) -> str:
    return (FIXTURES_DIR / name).read_text(encoding="utf-8")


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ─────────────────────────────────────────────────────────────────────
# 1) URL gate
# ─────────────────────────────────────────────────────────────────────

class TestIsKleinanzeigenUrl:
    @pytest.mark.parametrize("url", [
        "https://www.kleinanzeigen.de/s-anzeige/x/123456789",
        "https://kleinanzeigen.de/s-auto-kaufen-und-verkaufen/k0c216",
        "https://www.ebay-kleinanzeigen.de/s-anzeige/y/987654",
    ])
    def test_accepts(self, url):
        assert K.is_kleinanzeigen_url(url) is True

    @pytest.mark.parametrize("url", [
        "https://www.autoscout24.de/x",
        "https://example.com/",
        "https://kleinanzeigen-fake.io/x",
        "",
    ])
    def test_rejects(self, url):
        assert K.is_kleinanzeigen_url(url) is False


# ─────────────────────────────────────────────────────────────────────
# 2) URL TOPOLOGY classifier — pure, no I/O
# ─────────────────────────────────────────────────────────────────────

class TestClassifyUrlTopology:
    @pytest.mark.parametrize("url", [
        "https://www.kleinanzeigen.de/s-anzeige/opel-astra/2345678901",
        "https://www.kleinanzeigen.de/s-anzeige/vw-golf/123456789-216-1234",
        "https://kleinanzeigen.de/s-anzeige/bmw-x3/9999999999",
    ])
    def test_listing_topology(self, url):
        assert K.classify_url_topology(url) == "listing"

    @pytest.mark.parametrize("url", [
        "https://www.kleinanzeigen.de/s-auto-kaufen-und-verkaufen/k0c216",
        "https://www.kleinanzeigen.de/s-auto-kaufen-und-verkaufen/c216l1234",
        "https://www.kleinanzeigen.de/s-autos/k0",
    ])
    def test_category_topology(self, url):
        assert K.classify_url_topology(url) == "category"

    @pytest.mark.parametrize("url", [
        "https://www.kleinanzeigen.de/s-suchanfrage/audi-a4",
        "https://www.kleinanzeigen.de/s-seite/123/auto",
    ])
    def test_search_topology(self, url):
        assert K.classify_url_topology(url) == "search"

    @pytest.mark.parametrize("url", [
        "https://www.kleinanzeigen.de/pro/sample-dealer",
        "https://www.kleinanzeigen.de/m-12345",
        "https://www.kleinanzeigen.de/s-bestandsliste.html?userId=42",
    ])
    def test_profile_topology(self, url):
        assert K.classify_url_topology(url) == "profile"

    def test_unknown_topology(self):
        # Home page, no recognised path.
        assert K.classify_url_topology(
            "https://www.kleinanzeigen.de/"
        ) == "unknown"

    def test_empty_url(self):
        assert K.classify_url_topology("") == "unknown"


# ─────────────────────────────────────────────────────────────────────
# 3) parse_html — rich fixture (DOM details + VB pricing)
# ─────────────────────────────────────────────────────────────────────

class TestParseHtmlRich:
    URL = "https://www.kleinanzeigen.de/s-anzeige/opel-astra/2345678901"

    def test_full_extraction(self):
        data = K.parse_html(_load("kleinanzeigen_listing.html"), self.URL)
        assert data["source"] == "kleinanzeigen.de"
        assert data["parsed"] is True
        assert data["title"] == "Opel Astra K 1.6 Diesel"
        assert data["price"] == 7890
        assert data["currency"] == "EUR"
        assert data["year"] == 2017       # from "Erstzulassung 06/2017"
        assert data["mileage"] == 165000  # from "Kilometerstand 165.000 km"
        assert data["fuel"] == "diesel"
        assert data["transmission"] == "manual"
        assert data["make"] == "Opel"
        assert data["model"] == "Astra K"
        assert data["location"] == "22765 Hamburg-Altona"
        # JSON-LD seller is "Person" → sellerType="private".
        assert data["sellerType"] == "private"
        # listingId from URL.
        assert data["listingId"] == "2345678901"

    def test_canonical_roundtrip_strong(self):
        data = K.parse_html(_load("kleinanzeigen_listing.html"), self.URL)
        canon = from_legacy(data)
        assert canon.ok is True
        assert canon.parseCompleteness == "strong"
        assert canon.priceEur == 7890
        assert canon.mileageKm == 165000
        assert canon.year == 2017
        assert canon.degradedReason is None


# ─────────────────────────────────────────────────────────────────────
# 4) VB pricing — contract MUST NOT expand
# ─────────────────────────────────────────────────────────────────────

class TestVBPricing:
    """Audit 10C-B emphasis: VB ("Verhandlungsbasis" — negotiable)
    stays a UI concern. The substrate MUST emit `priceEur: int | None`
    and NEVER a `negotiable` boolean. This pins that decision."""

    URL = "https://www.kleinanzeigen.de/s-anzeige/x/123456789"

    def test_vb_price_extracts_number(self):
        html = """<html><body>
<h2 id="viewad-price" itemprop="price">1.500 € VB</h2>
<title>X</title>
</body></html>"""
        data = K.parse_html(html, self.URL)
        assert data["price"] == 1500
        # No new `negotiable` field — contract not expanded.
        assert "negotiable" not in data

    def test_verhandlungsbasis_long_form(self):
        html = """<html><body>
<h2 id="viewad-price" itemprop="price">2.300 € Verhandlungsbasis</h2>
<title>X</title>
</body></html>"""
        data = K.parse_html(html, self.URL)
        assert data["price"] == 2300

    def test_zu_verschenken_listing(self):
        """`Zu verschenken` (free / giveaway) — substrate emits price=None
        rather than 0. Audit 10A: `priceEur=0` is treated as missing."""
        html = """<html><body>
<h2 id="viewad-price" itemprop="price">Zu verschenken</h2>
<title>X</title>
</body></html>"""
        data = K.parse_html(html, self.URL)
        assert data["price"] is None
        canon = from_legacy(data)
        assert canon.priceEur is None


# ─────────────────────────────────────────────────────────────────────
# 5) Isolated layers — each extractor stands alone
# ─────────────────────────────────────────────────────────────────────

class TestIsolatedLayers:
    def test_embedded_json_only(self):
        from bs4 import BeautifulSoup
        html = _load("kleinanzeigen_listing.html")
        soup = BeautifulSoup(html, "lxml")
        out = K._from_embedded_json(html, soup)
        assert out["price"] == 7890
        assert out["title"] == "Opel Astra K 1.6 Diesel"
        assert out["sellerType"] == "private"

    def test_meta_only(self):
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(_load("kleinanzeigen_listing.html"), "lxml")
        out = K._from_meta(soup)
        assert out["title"] == "Opel Astra K 1.6 Diesel"
        assert out["price"] == 7890

    def test_dom_only(self):
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(_load("kleinanzeigen_listing.html"), "lxml")
        out = K._from_dom(soup)
        # Year normalised from "06/2017".
        assert out["year"] == 2017
        # Mileage from "165.000 km".
        assert out["mileage"] == 165000
        # VB stripping happens here.
        assert out["price"] == 7890
        assert out["transmission"] == "manual"

    def test_price_clamping(self):
        """Sanity range — meta accidents (`amount=999999999`) are
        clamped to None, not bled into the result."""
        from bs4 import BeautifulSoup
        html = """<html><head>
<meta property="product:price:amount" content="9999999999">
<meta property="product:price:currency" content="EUR">
</head></html>"""
        soup = BeautifulSoup(html, "lxml")
        out = K._from_meta(soup)
        assert "price" not in out


# ─────────────────────────────────────────────────────────────────────
# 6) parse_url orchestrator
# ─────────────────────────────────────────────────────────────────────

def _patch_fetch(monkeypatch, html: str | None, err: str | None = None):
    async def fake_fetch(url):
        return (html, err)
    monkeypatch.setattr(K, "fetch_html", fake_fetch, raising=True)


class TestParseUrlOrchestrator:
    LISTING_URL = "https://www.kleinanzeigen.de/s-anzeige/opel-astra/2345678901"
    CATEGORY_URL = "https://www.kleinanzeigen.de/s-auto-kaufen-und-verkaufen/k0c216"
    SEARCH_URL = "https://www.kleinanzeigen.de/s-suchanfrage/audi-a4"
    PROFILE_URL = "https://www.kleinanzeigen.de/pro/dealer-x"

    def test_url_required(self):
        data = _run(K.parse_url(""))
        assert data["error"] == "url_required"

    def test_unsupported_source(self):
        data = _run(K.parse_url("https://example.com/x"))
        assert data["error"] == "unsupported_source"

    # ---- URL topology gate (NO network call) -------------------------

    def test_category_url_short_circuits_no_fetch(self, monkeypatch):
        """Audit 10C-B: category/search/profile URLs MUST hard-fail
        BEFORE any HTTP request. We patch fetch_html to a sentinel that
        fails the test if called."""
        called = {"hit": False}

        async def boom(url):
            called["hit"] = True
            return ("<html/>", None)

        monkeypatch.setattr(K, "fetch_html", boom, raising=True)
        data = _run(K.parse_url(self.CATEGORY_URL))
        assert data["error"] == "not_a_listing"
        assert called["hit"] is False
        # Canonical view: hard-fail.
        canon = from_legacy(data)
        assert canon.degradedReason == "not_a_listing"
        assert canon.ok is False

    def test_search_url_short_circuits_no_fetch(self, monkeypatch):
        called = {"hit": False}

        async def boom(url):
            called["hit"] = True
            return ("<html/>", None)

        monkeypatch.setattr(K, "fetch_html", boom, raising=True)
        data = _run(K.parse_url(self.SEARCH_URL))
        assert data["error"] == "not_a_listing"
        assert called["hit"] is False

    def test_profile_url_short_circuits_no_fetch(self, monkeypatch):
        called = {"hit": False}

        async def boom(url):
            called["hit"] = True
            return ("<html/>", None)

        monkeypatch.setattr(K, "fetch_html", boom, raising=True)
        data = _run(K.parse_url(self.PROFILE_URL))
        assert data["error"] == "not_a_listing"
        assert called["hit"] is False

    # ---- listing URLs reach extraction -------------------------------

    def test_listing_happy_path(self, monkeypatch):
        _patch_fetch(monkeypatch, _load("kleinanzeigen_listing.html"))
        data = _run(K.parse_url(self.LISTING_URL))
        assert data.get("error") is None
        assert data["price"] == 7890
        assert data["mileage"] == 165000
        canon = from_legacy(data)
        assert canon.parseCompleteness == "strong"

    def test_fetch_error_carries_listing_id(self, monkeypatch):
        _patch_fetch(monkeypatch, None, "http_403")
        data = _run(K.parse_url(self.LISTING_URL))
        assert data["error"] == "http_403"
        # Slug fallback fills listingId even on soft-fail.
        assert data["listingId"] == "2345678901"

    def test_antibot_short_circuits(self, monkeypatch):
        _patch_fetch(monkeypatch, _load("antibot_page.html"))
        data = _run(K.parse_url(self.LISTING_URL))
        assert data["error"] == "antibot"
        # No fake field leakage from anti-bot page.
        assert data.get("price") is None
        assert data.get("title") is None

    def test_expired_short_circuits(self, monkeypatch):
        _patch_fetch(monkeypatch, _load("expired_listing.html"))
        data = _run(K.parse_url(self.LISTING_URL))
        assert data["error"] == "expired_listing"


# ─────────────────────────────────────────────────────────────────────
# 7) Dispatcher integration — universal.parse_listing routes here
# ─────────────────────────────────────────────────────────────────────

class TestDispatcherRouting:
    URL = "https://www.kleinanzeigen.de/s-anzeige/opel-astra/2345678901"

    def test_dispatcher_calls_kleinanzeigen_extractor(self, monkeypatch):
        called = {"hit": False, "url": None}

        async def stub(url):
            called["hit"] = True
            called["url"] = url
            return {"parsed": True, "source": "kleinanzeigen.de",
                    "sourceUrl": url, "title": "stub", "currency": "EUR"}

        from app.parsers import kleinanzeigen as Kmod
        monkeypatch.setattr(Kmod, "parse_url", stub, raising=True)

        from app.parsers.universal import parse_listing
        out = _run(parse_listing(self.URL))
        assert called["hit"] is True
        assert called["url"] == self.URL
        assert out["source"] == "kleinanzeigen.de"
        assert out["title"] == "stub"

    def test_category_url_routed_to_kleinanzeigen_module(self, monkeypatch):
        """Even non-listing URLs on kleinanzeigen.de must hit the
        module (so the topology classifier runs). The generic parser
        MUST NOT be reached for any kleinanzeigen URL."""
        called = {"kleinanz": False, "generic": False}

        async def stub_kleinanz(url):
            called["kleinanz"] = True
            return {"error": "not_a_listing", "source": "kleinanzeigen.de",
                    "sourceUrl": url, "parsed": False, "currency": "EUR"}

        async def boom_generic(url, source):
            called["generic"] = True
            return {"parsed": False, "source": source, "sourceUrl": url}

        from app.parsers import kleinanzeigen as Kmod
        from app.parsers import universal as U
        monkeypatch.setattr(Kmod, "parse_url", stub_kleinanz, raising=True)
        monkeypatch.setattr(U, "_parse_generic", boom_generic, raising=True)

        _run(U.parse_listing(
            "https://www.kleinanzeigen.de/s-auto-kaufen-und-verkaufen/k0c216"
        ))
        assert called["kleinanz"] is True
        assert called["generic"] is False


# ─────────────────────────────────────────────────────────────────────
# 8) Anchor — kleinanzeigen URLs never reach _parse_generic anymore
# ─────────────────────────────────────────────────────────────────────

class TestKleinanzeigenRemovedFromGenericPath:
    """Audit 10C-B emphasis: generic parser must NOT contain
    Kleinanzeigen heuristics. We assert this by routing a kleinanzeigen
    URL and verifying _parse_generic is never invoked."""

    def test_kleinanzeigen_listing_bypasses_generic(self, monkeypatch):
        called = {"generic": False}

        async def boom_generic(url, source):
            called["generic"] = True
            return {"parsed": False, "source": source, "sourceUrl": url}

        from app.parsers import universal as U
        from app.parsers import kleinanzeigen as Kmod

        # Patch kleinanzeigen.parse_url with the real implementation
        # via a stub that mirrors a successful parse (no need for HTTP).
        async def stub_kleinanz(url):
            return {"parsed": True, "source": "kleinanzeigen.de",
                    "sourceUrl": url, "title": "Opel Astra",
                    "price": 7890, "currency": "EUR"}

        monkeypatch.setattr(Kmod, "parse_url", stub_kleinanz, raising=True)
        monkeypatch.setattr(U, "_parse_generic", boom_generic, raising=True)

        out = _run(U.parse_listing(
            "https://www.kleinanzeigen.de/s-anzeige/opel/2345678901"
        ))
        assert called["generic"] is False
        assert out["source"] == "kleinanzeigen.de"


# ─────────────────────────────────────────────────────────────────────
# 9) Contract invariance — no new fields added
# ─────────────────────────────────────────────────────────────────────

class TestContractNotExpanded:
    URL = "https://www.kleinanzeigen.de/s-anzeige/x/123456789"

    def test_canonical_keys_unchanged(self):
        data = K.parse_html(_load("kleinanzeigen_listing.html"), self.URL)
        canon = from_legacy(data)
        # Inspect the model's fields — must match Step 10A frozen list.
        canonical_keys = set(canon.model_dump().keys())
        expected = {
            "ok", "source", "sourceUrl",
            "externalId", "title", "make", "model", "year",
            "priceEur", "mileageKm", "location", "vin",
            "fuel", "transmission", "sellerType", "images",
            "parseCompleteness", "degradedReason",
        }
        assert canonical_keys == expected
