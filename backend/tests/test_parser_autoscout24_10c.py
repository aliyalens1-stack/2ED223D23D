"""Step 10C-A — AutoScout24 dedicated extractor.

Three layers of coverage:

  1. `parse_html` against fixtures (pure offline).
  2. Each priority layer in isolation (JSON-LD / __NEXT_DATA__ / meta).
  3. Dispatcher integration — `parse_listing` on an autoscout24 URL must
     route through the new extractor and produce a canonical-shaped
     result with the same legacy keys consumers already use.

No retry / proxy / UA-rotation tests — those are explicitly out of scope
for Step 10C-A.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, "/app/backend")

from app.parsers import autoscout24 as A  # noqa: E402
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

class TestIsAutoscoutUrl:
    @pytest.mark.parametrize("url", [
        "https://www.autoscout24.de/angebote/x-12345",
        "https://autoscout24.de/x",
        "https://www.autoscout24.eu/angebote/y-1",
        "https://www.autoscout24.fr/annonces/z-2",
        "https://m.autoscout24.com/listing/3",
    ])
    def test_accepts(self, url):
        assert A.is_autoscout_url(url) is True

    @pytest.mark.parametrize("url", [
        "https://www.mobile.de/x",
        "https://example.com/",
        "https://autoscout24-fake.io/x",
        "https://kleinanzeigen.de/x",
        "",
    ])
    def test_rejects(self, url):
        assert A.is_autoscout_url(url) is False


# ─────────────────────────────────────────────────────────────────────
# 2) parse_html — JSON-LD path
# ─────────────────────────────────────────────────────────────────────

class TestParseHtmlJsonLd:
    """`autoscout24_basic.html` fixture has a full Product JSON-LD block."""

    URL = "https://www.autoscout24.de/angebote/vw-passat-a1b2c3d4e5f6"

    def test_full_field_extraction(self):
        data = A.parse_html(_load("autoscout24_basic.html"), self.URL)
        assert data["source"] == "autoscout24"
        assert data["parsed"] is True
        assert data["title"] == "VW Passat Variant 2.0 TDI DSG"
        assert data["make"] == "Volkswagen"
        assert data["model"] == "Passat Variant"
        assert data["year"] == 2020
        assert data["price"] == 22490
        assert data["currency"] == "EUR"
        assert data["mileage"] == 95000
        assert data["fuel"] == "diesel"
        assert "sample-passat" in data["image"]
        assert data["images"]
        assert data.get("error") is None

    def test_canonical_roundtrip_is_strong(self):
        data = A.parse_html(_load("autoscout24_basic.html"), self.URL)
        canon = from_legacy(data)
        assert canon.ok is True
        assert canon.parseCompleteness == "strong"
        assert canon.priceEur == 22490
        assert canon.mileageKm == 95000
        assert canon.year == 2020
        assert canon.degradedReason is None
        assert canon.source == "autoscout24"

    def test_listing_id_from_url_slug(self):
        # autoscout listing slug ends with a hex id segment.
        url = "https://www.autoscout24.de/angebote/vw-passat-a1b2c3d4e5f6"
        data = A.parse_html(_load("autoscout24_basic.html"), url)
        assert data["listingId"] == "a1b2c3d4e5f6"


# ─────────────────────────────────────────────────────────────────────
# 3) parse_html — __NEXT_DATA__ path
# ─────────────────────────────────────────────────────────────────────

class TestParseHtmlNextData:
    """`autoscout24_nextdata.html` fixture has NO JSON-LD; only the
    Next.js `__NEXT_DATA__` JSON blob and a minimal og:title. The
    extractor must descend into the JSON tree to pull listing data."""

    URL = "https://www.autoscout24.de/angebote/bmw-x3-a1b2c3d4e5f6"

    def test_nextdata_extraction(self):
        data = A.parse_html(_load("autoscout24_nextdata.html"), self.URL)
        assert data["parsed"] is True
        # NEXT_DATA path provides:
        assert data["price"] == 39990
        assert data["mileage"] == 48500
        assert data["year"] == 2021
        assert data["make"] == "BMW"
        assert data["model"] == "X3"
        assert data["fuel"] == "diesel"
        assert data["transmission"] == "automatic"
        assert data["sellerType"] == "dealer"
        assert data["location"] == "München"
        # listingId either from NEXT_DATA or URL slug; both should give
        # the same hex token here.
        assert data["listingId"] == "a1b2c3d4e5f6"
        # Gallery built from `mainImageUrl` entries.
        assert len(data["images"]) >= 1
        assert "sample-x3" in data["image"]

    def test_nextdata_canonical_strong(self):
        data = A.parse_html(_load("autoscout24_nextdata.html"), self.URL)
        canon = from_legacy(data)
        assert canon.parseCompleteness == "strong"
        assert canon.priceEur == 39990
        assert canon.mileageKm == 48500
        assert canon.year == 2021
        assert canon.ok is True


# ─────────────────────────────────────────────────────────────────────
# 4) Individual extraction layers — unit tests
# ─────────────────────────────────────────────────────────────────────

class TestExtractionLayersIsolation:
    def test_jsonld_only(self):
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(_load("autoscout24_basic.html"), "lxml")
        ld = A._from_jsonld(soup)
        assert ld["price"] == 22490
        assert ld["mileage"] == 95000
        assert ld["make"] == "Volkswagen"

    def test_nextdata_only(self):
        nd = A._from_nextdata(_load("autoscout24_nextdata.html"))
        assert nd["price"] == 39990
        assert nd["year"] == 2021
        assert nd["transmission"] == "automatic"

    def test_nextdata_empty_when_no_blob(self):
        nd = A._from_nextdata("<html><body>nothing here</body></html>")
        assert nd == {}

    def test_meta_extraction(self):
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(_load("autoscout24_basic.html"), "lxml")
        m = A._from_meta(soup)
        # og:title present, og:image present
        assert m["title"].startswith("VW Passat")
        assert "sample-passat" in m["image"]

    def test_dom_year_regex(self):
        from bs4 import BeautifulSoup
        html = "<html><body>Production year 2018, 145.000 km, full service.</body></html>"
        soup = BeautifulSoup(html, "lxml")
        d = A._from_dom(soup)
        assert d.get("year") == 2018
        assert d.get("mileage") == 145000

    def test_dom_skips_implausible_year(self):
        from bs4 import BeautifulSoup
        html = "<html><body>Article from 1899, totally fake.</body></html>"
        soup = BeautifulSoup(html, "lxml")
        d = A._from_dom(soup)
        assert d.get("year") is None


# ─────────────────────────────────────────────────────────────────────
# 5) Priority chain — JSON-LD wins over NEXT_DATA which wins over meta
# ─────────────────────────────────────────────────────────────────────

class TestPriorityChain:
    URL = "https://www.autoscout24.de/angebote/x-1"

    def test_jsonld_wins_when_both_present(self):
        """Construct a synthetic page with BOTH JSON-LD (price 100) and
        __NEXT_DATA__ (priceRaw 200). JSON-LD must win per the audit's
        priority chain (1 → 4)."""
        html = """<html><head>
<script type="application/ld+json">{"@type":"Vehicle","name":"X","offers":{"@type":"Offer","price":"100","priceCurrency":"EUR"}}</script>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"listingDetails":{"prices":{"public":{"priceRaw":200,"currency":"EUR"}},"vehicle":{"modelYear":2020,"rawMileageInKm":50000}}}}}</script>
</head><body></body></html>"""
        data = A.parse_html(html, self.URL)
        # JSON-LD price (100) wins because it's layer 1.
        assert data["price"] == 100
        # NEXT_DATA fills the rest (mileage, year) because JSON-LD didn't.
        assert data["mileage"] == 50000
        assert data["year"] == 2020

    def test_meta_only_partial(self):
        """A page with neither JSON-LD nor __NEXT_DATA__ — only OG tags.
        Result should still parse what's available."""
        html = """<html><head>
<title>Audi A4 — 16.490 € · AutoScout24</title>
<meta property="og:title" content="Audi A4 — 16.490 €">
<meta property="og:image" content="https://prod.pictures.autoscout24.net/x.jpg">
<meta property="product:price:amount" content="16490">
<meta property="product:price:currency" content="EUR">
</head><body>Bj 2018, 120.000 km</body></html>"""
        data = A.parse_html(html, self.URL)
        assert data["price"] == 16490
        # DOM fallback fills year + mileage from visible text.
        assert data["year"] == 2018
        assert data["mileage"] == 120000


# ─────────────────────────────────────────────────────────────────────
# 6) parse_url orchestrator — fetch + classify + extract
# ─────────────────────────────────────────────────────────────────────

def _patch_fetch(monkeypatch, html: str | None, err: str | None = None):
    async def fake_fetch(url):
        return (html, err)
    monkeypatch.setattr(A, "fetch_html", fake_fetch, raising=True)


class TestParseUrlOrchestrator:
    URL = "https://www.autoscout24.de/angebote/vw-passat-a1b2c3d4e5f6"

    def test_url_required(self):
        data = _run(A.parse_url(""))
        assert data["error"] == "url_required"

    def test_unsupported_source(self):
        data = _run(A.parse_url("https://www.example.com/x"))
        assert data["error"] == "unsupported_source"

    def test_fetch_error_short_circuits(self, monkeypatch):
        _patch_fetch(monkeypatch, None, "http_403")
        data = _run(A.parse_url(self.URL))
        assert data["error"] == "http_403"
        # Even on fetch error, slug-id fallback fills listingId.
        assert data.get("listingId")

    def test_antibot_short_circuits(self, monkeypatch):
        _patch_fetch(monkeypatch, _load("antibot_page.html"))
        data = _run(A.parse_url(self.URL))
        assert data["error"] == "antibot"
        # No fake field leakage.
        assert data.get("price") is None
        assert data.get("title") is None

    def test_expired_short_circuits(self, monkeypatch):
        _patch_fetch(monkeypatch, _load("expired_listing.html"))
        data = _run(A.parse_url(self.URL))
        assert data["error"] == "expired_listing"

    def test_happy_path(self, monkeypatch):
        _patch_fetch(monkeypatch, _load("autoscout24_basic.html"))
        data = _run(A.parse_url(self.URL))
        assert data.get("error") is None
        assert data["price"] == 22490
        assert data["mileage"] == 95000
        canon = from_legacy(data)
        assert canon.parseCompleteness == "strong"


# ─────────────────────────────────────────────────────────────────────
# 7) Dispatcher integration — `parse_listing` routes to the new module
# ─────────────────────────────────────────────────────────────────────

class TestDispatcherRouting:
    URL = "https://www.autoscout24.de/angebote/vw-passat-x-12345"

    def test_dispatcher_calls_autoscout_extractor(self, monkeypatch):
        """Patch the autoscout24 module's `parse_url` so we can verify
        the dispatcher actually delegates here instead of falling
        through to `_parse_generic`."""
        called = {"hit": False, "url": None}

        async def stub(url):
            called["hit"] = True
            called["url"] = url
            return {"parsed": True, "source": "autoscout24",
                    "sourceUrl": url, "title": "stub", "currency": "EUR"}

        from app.parsers import autoscout24 as ASmod
        monkeypatch.setattr(ASmod, "parse_url", stub, raising=True)

        from app.parsers.universal import parse_listing
        out = _run(parse_listing(self.URL))
        assert called["hit"] is True
        assert called["url"] == self.URL
        assert out["source"] == "autoscout24"
        assert out["title"] == "stub"

    def test_dispatcher_does_not_route_mobile_de_to_autoscout(self, monkeypatch):
        called = {"hit": False}

        async def stub(url):
            called["hit"] = True
            return {}

        from app.parsers import autoscout24 as ASmod
        monkeypatch.setattr(ASmod, "parse_url", stub, raising=True)

        # mobile.de URL must NOT touch autoscout extractor.
        from app.parsers.universal import parse_listing
        async def fake_mobile_de(url):
            return {"parsed": True, "source": "mobile.de", "sourceUrl": url,
                    "title": "BMW", "currency": "EUR"}
        from app.parsers import universal as U
        monkeypatch.setattr(U, "parse_mobile_de", fake_mobile_de, raising=True)

        _run(parse_listing("https://www.mobile.de/fahrzeuge/details.html?id=1"))
        assert called["hit"] is False


# ─────────────────────────────────────────────────────────────────────
# 8) Anchor — generic parser must keep working as fallback
# ─────────────────────────────────────────────────────────────────────

class TestGenericFallbackStillOperational:
    """Step 10C-A acceptance — universal `_parse_generic` MUST keep
    serving willhaben / otomoto / unknown-source URLs. The new
    autoscout extractor isolated its own behavior, not replaced the
    generic path.

    Note: as of Step 10C-B, kleinanzeigen has ALSO been removed from
    the generic path. This anchor now uses an unknown-source URL to
    exercise the surviving generic codepath."""

    def test_unknown_source_still_uses_generic(self, monkeypatch):
        """Step 10C-B removed kleinanzeigen from the generic path.
        We exercise the surviving generic codepath with a willhaben URL
        (not yet ported to a dedicated extractor)."""
        import httpx
        from app.parsers import universal as U

        class _R:
            status_code = 200
            text = """<html><head>
<title>BMW X3 — willhaben.at</title>
<meta property="og:title" content="BMW X3 2.0d · 18.500 €">
<meta property="product:price:amount" content="18500">
<script type="application/ld+json">
{"@type":"Vehicle","name":"BMW X3",
 "offers":{"@type":"Offer","price":"18500","priceCurrency":"EUR"}}
</script>
</head><body><p>2018 · 120.000 km</p></body></html>"""

        async def fake_get(self, *a, **kw):
            return _R()

        monkeypatch.setattr(httpx.AsyncClient, "get", fake_get, raising=True)

        out = _run(U.parse_listing(
            "https://heycar.de/auto/bmw-x3-12345"
        ))
        # Generic path still operational for non-dedicated sources.
        assert out["source"] == "heycar"
        assert out["price"] == 18500
