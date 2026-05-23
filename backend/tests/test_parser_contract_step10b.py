"""Step 10B Pass 1 — page classifier + /api/parse/car-link canonical migration.

These tests cover the three new substrate primitives added in 10B:

  1. `page_classifier.classify_page` — verdicts on HTML before extraction.
  2. `universal._parse_generic` + `mobile_de.parse_url` — both now route
     through the classifier and stop fake-success cases at the gate.
  3. `POST /api/parse/car-link` — emits the canonical envelope alongside
     legacy keys.

All assertions are offline. The endpoint test uses FastAPI's TestClient
+ monkey-patched httpx so no real network is touched.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Optional

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, "/app/backend")

from app.parsers import contract as C  # noqa: E402
from app.parsers.page_classifier import classify_page, PageVerdict  # noqa: E402


FIXTURES_DIR = Path(__file__).parent / "fixtures" / "listings"


def _load(name: str) -> str:
    return (FIXTURES_DIR / name).read_text(encoding="utf-8")


# ─────────────────────────────────────────────────────────────────────
# Pure classifier tests
# ─────────────────────────────────────────────────────────────────────

class TestClassifyPage:
    def test_valid_mobile_de_listing(self):
        v = classify_page(html=_load("mobile_de_basic.html"),
                          status_code=200, source="mobile.de",
                          url="https://mobile.de/x?id=1")
        assert v.kind == "valid_listing"
        assert v.degradedReason is None

    def test_antibot_with_200(self):
        v = classify_page(html=_load("antibot_page.html"),
                          status_code=200, source="autoscout24",
                          url="https://autoscout24.de/x")
        assert v.kind == "antibot"
        assert v.degradedReason == "antibot"

    def test_antibot_with_403(self):
        """403 + Cloudflare body — classifier prefers `antibot` over
        the generic `http_error` verdict."""
        v = classify_page(html=_load("antibot_page.html"),
                          status_code=403, source="autoscout24",
                          url="https://autoscout24.de/x")
        assert v.kind == "antibot"

    def test_expired_listing(self):
        v = classify_page(html=_load("expired_listing.html"),
                          status_code=200, source="autoscout24",
                          url="https://autoscout24.de/x")
        assert v.kind == "expired_listing"
        assert v.degradedReason == "expired_listing"

    def test_unsupported_domain(self):
        v = classify_page(html=_load("unsupported_domain.html"),
                          status_code=200, source=None,
                          url="https://example.com/x")
        assert v.kind == "unsupported_domain"

    def test_http_error_without_antibot_markers(self):
        v = classify_page(html="<html><body>404 not found</body></html>",
                          status_code=404, source="autoscout24",
                          url="https://autoscout24.de/x")
        assert v.kind == "http_error"
        assert v.degradedReason == "http_404"

    def test_timeout(self):
        v = classify_page(html=None, status_code=None,
                          source="mobile.de",
                          url="https://mobile.de/x")
        assert v.kind == "timeout"

    def test_not_a_listing_search_page(self):
        html = """<html><head><title>Suchergebnisse — mobile.de</title>
        </head><body>Search results</body></html>"""
        v = classify_page(html=html, status_code=200, source="mobile.de",
                          url="https://www.mobile.de/?search=audi")
        assert v.kind == "not_a_listing"

    def test_search_title_with_listing_path_is_still_valid(self):
        """Conservative branch — if URL path looks like a listing detail
        page, we don't flip to `not_a_listing` even when the title has
        a search-results marker (long-tail listings sometimes embed the
        word 'Suchergebnisse' in seller blurbs)."""
        html = """<html><head><title>Audi A4 · Suchergebnisse</title>
        </head><body></body></html>"""
        v = classify_page(html=html, status_code=200, source="mobile.de",
                          url="https://www.mobile.de/fahrzeuge/details.html?id=1")
        assert v.kind == "valid_listing"


# ─────────────────────────────────────────────────────────────────────
# Wiring: _parse_generic now stops at the classifier verdict
# ─────────────────────────────────────────────────────────────────────

def _patch_httpx(monkeypatch, html_body: str, status_code: int = 200):
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


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class TestGenericClassifierWiring:
    def test_antibot_short_circuits_extraction(self, monkeypatch):
        U = _patch_httpx(monkeypatch, _load("antibot_page.html"))
        legacy = _run(U._parse_generic(
            "https://www.autoscout24.de/x", "autoscout24"
        ))
        assert legacy["error"] == "antibot"
        # No fake-success leakage of OG title.
        assert not legacy.get("title")
        assert not legacy.get("price")

    def test_expired_short_circuits_extraction(self, monkeypatch):
        U = _patch_httpx(monkeypatch, _load("expired_listing.html"))
        legacy = _run(U._parse_generic(
            "https://www.autoscout24.de/x", "autoscout24"
        ))
        assert legacy["error"] == "expired_listing"
        assert not legacy.get("price")

    def test_valid_listing_still_extracts_strong(self, monkeypatch):
        U = _patch_httpx(monkeypatch, _load("autoscout24_basic.html"))
        legacy = _run(U._parse_generic(
            "https://www.autoscout24.de/angebote/x", "autoscout24"
        ))
        # Classifier said "valid_listing" → extraction proceeded.
        assert legacy.get("error") in (None, "")
        assert legacy.get("price") == 22490
        assert legacy.get("mileage") == 95000

    def test_unsupported_domain_short_circuit(self, monkeypatch):
        U = _patch_httpx(monkeypatch, _load("unsupported_domain.html"))
        legacy = _run(U._parse_generic(
            "https://example.com/anything", None
        ))
        assert legacy["error"] == "unsupported_domain"


# ─────────────────────────────────────────────────────────────────────
# /api/parse/car-link — canonical envelope migration
# ─────────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def app_client():
    """Boot a FastAPI app that mounts only the parser router. Avoids
    pulling in the whole server.py startup machinery."""
    from fastapi import FastAPI
    from app.parsers.router import router

    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as c:
        yield c


class TestCarLinkCanonicalEnvelope:
    def test_bad_url_emits_canonical(self, app_client):
        # Length ≥8 to pass the Pydantic min_length validator, but no
        # dot in the host → hard-fail at substrate level.
        # Step 11D-γ — legacy top-level mirror removed; only the
        # canonical envelope is published.
        r = app_client.post("/api/parse/car-link", json={"url": "notaurlx"})
        assert r.status_code == 200
        body = r.json()
        # Canonical envelope present, well-formed, and ONLY thing on the wire.
        assert "canonical" in body
        canon = body["canonical"]
        assert canon["ok"] is False
        assert canon["parseCompleteness"] == "weak"
        assert canon["degradedReason"] == "bad_url"
        # Canonical field names are the new ones.
        assert "externalId" in canon
        assert "priceEur" in canon
        assert "mileageKm" in canon
        assert "images" in canon and isinstance(canon["images"], list)
        # γ — legacy top-level mirror MUST NOT leak.
        for legacy in ("recognized", "softFail", "hardFail", "parsed", "error",
                       "source", "sourceUrl", "title", "make", "model",
                       "price", "mileage", "year", "fuel", "image", "currency"):
            assert legacy not in body, f"γ should have removed top-level '{legacy}'"

    def test_antibot_emits_soft_fail_canonical(self, app_client, monkeypatch):
        """Patch httpx so the generic parser sees a Cloudflare body for
        an autoscout24 URL. Step 11D-γ — failure mode now lives ONLY in
        the canonical envelope; surfaces read `canonical.degradedReason`
        via shared classifier `classifyParseFailure()`."""
        import httpx

        antibot_html = _load("antibot_page.html")

        class _Resp:
            status_code = 200
            text = antibot_html

        async def fake_get(self, *a, **kw):
            return _Resp()

        monkeypatch.setattr(httpx.AsyncClient, "get", fake_get, raising=True)

        r = app_client.post("/api/parse/car-link",
                            json={"url": "https://www.autoscout24.de/angebote/x-1"})
        assert r.status_code == 200
        body = r.json()
        canon = body["canonical"]
        assert canon["degradedReason"] == "antibot"
        assert canon["ok"] is False
        assert canon["parseCompleteness"] == "weak"
        # γ — no legacy top-level mirror.
        assert "softFail" not in body
        assert "recognized" not in body

    def test_valid_listing_emits_strong_canonical(self, app_client, monkeypatch):
        """Step 11D-γ — recognized/price/mileage now live exclusively in
        the canonical envelope (priceEur/mileageKm with units in the
        field name)."""
        import httpx

        ok_html = _load("autoscout24_basic.html")

        class _Resp:
            status_code = 200
            text = ok_html

        async def fake_get(self, *a, **kw):
            return _Resp()

        monkeypatch.setattr(httpx.AsyncClient, "get", fake_get, raising=True)

        r = app_client.post("/api/parse/car-link",
                            json={"url": "https://www.autoscout24.de/angebote/x-1"})
        assert r.status_code == 200
        body = r.json()
        canon = body["canonical"]
        assert canon["ok"] is True
        assert canon["parseCompleteness"] == "strong"
        assert canon["priceEur"] == 22490
        assert canon["mileageKm"] == 95000
        assert canon["year"] == 2020
        assert canon["degradedReason"] is None
        # γ — no legacy mirror leak.
        for legacy in ("price", "mileage", "recognized", "softFail", "parsed", "error"):
            assert legacy not in body

    def test_supported_sources_still_works(self, app_client):
        """Regression — Step 10A endpoint must still serve catalogue."""
        r = app_client.get("/api/parse/supported-sources")
        assert r.status_code == 200
        ids = {s["id"] for s in r.json()["sources"]}
        assert {"mobile.de", "autoscout24", "kleinanzeigen.de"}.issubset(ids)


# ─────────────────────────────────────────────────────────────────────
# Regression — Step 10A contract tests imported here for visibility.
# (They live in test_parser_contract_step10a.py; this section just
# pins the count so a future delete is loud.)
# ─────────────────────────────────────────────────────────────────────

class TestContractTestCountAnchor:
    def test_step10a_file_still_present(self):
        f = Path(__file__).parent / "test_parser_contract_step10a.py"
        assert f.exists(), "Step 10A contract tests must not be deleted"
