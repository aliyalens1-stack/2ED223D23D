"""Berlin Launch B2 — mobile.de parser tests.

Tests both unit-level parse_html() with mock HTML and HTTP-level
endpoint POST /api/parse/car-link. Also verifies supported-sources
and regression of existing endpoints (health, auth/login, zones,
marketplace providers).
"""
from __future__ import annotations
import os
import sys
import pytest
import requests

# Ensure backend package is importable for unit-level tests
sys.path.insert(0, "/app/backend")

from app.parsers.mobile_de import parse_html, estimate_market_avg  # noqa: E402

BASE_URL = os.environ.get("EXPO_BACKEND_URL", "http://localhost:8001").rstrip("/")


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def admin_token(api):
    r = api.post(f"{BASE_URL}/api/auth/login",
                 json={"email": "admin@autoservice.com", "password": "Admin123!"})
    if r.status_code != 200:
        pytest.skip(f"admin login failed: {r.status_code} {r.text[:200]}")
    data = r.json()
    tok = data.get("accessToken") or data.get("access_token") or data.get("token")
    if not tok:
        pytest.skip(f"no token in login response: {data}")
    return tok


# ── Unit tests: parse_html() with mock HTML ────────────────────────────
class TestParseHTMLJsonLD:
    """parse_html extracts from JSON-LD Vehicle block (most reliable path)."""

    MOCK_JSONLD = """
    <html><head>
      <meta property="og:title" content="Audi A6 2.0 TDI · 2018 · 120.000 km">
      <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Vehicle",
        "name": "Audi A6 2.0 TDI Avant",
        "brand": {"@type": "Brand", "name": "Audi"},
        "model": "A6",
        "modelDate": "2018",
        "fuelType": "Diesel",
        "mileageFromOdometer": {"@type": "QuantitativeValue", "value": 120000, "unitCode": "KMT"},
        "image": "https://img.mobile.de/abc.jpg",
        "offers": {"@type": "Offer", "price": 18900, "priceCurrency": "EUR"}
      }
      </script>
    </head><body></body></html>
    """

    def test_jsonld_extracts_all_fields(self):
        out = parse_html(self.MOCK_JSONLD, "https://www.mobile.de/fahrzeuge/details.html?id=429123")
        assert out["title"] == "Audi A6 2.0 TDI Avant"
        assert out["make"] == "Audi"
        assert out["model"] == "A6"
        assert out["year"] == 2018
        assert out["price"] == 18900
        assert out["currency"] == "EUR"
        assert out["mileage"] == 120000
        assert out["fuel"] == "diesel"
        assert out["image"] == "https://img.mobile.de/abc.jpg"
        assert out["source"] == "mobile.de"
        assert out["listingId"] == "429123"
        assert out["marketAvg"] is not None


class TestParseHTMLOGFallback:
    """No JSON-LD: parse_html falls back to OG meta + regex extraction."""

    MOCK_OG_ONLY = """
    <html><head>
      <meta property="og:title" content="BMW 320d Touring 2016 - 150.000 km">
      <meta property="og:description" content="EZ 05/2016, 150.000 km, Diesel, 12.500 €. Top Zustand.">
      <meta property="og:image" content="https://img.mobile.de/bmw.jpg">
    </head><body></body></html>
    """

    def test_og_regex_fallback(self):
        out = parse_html(self.MOCK_OG_ONLY, "https://www.mobile.de/fahrzeuge/details.html?id=555")
        assert out["title"].startswith("BMW 320d Touring")
        assert out["make"] == "BMW"
        assert out["model"] and "320d" in out["model"]
        assert out["year"] == 2016
        assert out["price"] == 12500
        assert out["mileage"] == 150000
        assert out["fuel"] == "diesel"
        assert out["image"] == "https://img.mobile.de/bmw.jpg"
        assert out["listingId"] == "555"


class TestEstimateMarketAvg:
    def test_recent_year(self):
        assert estimate_market_avg(2024, current_year=2026) == 26000  # delta=2

    def test_older_year(self):
        assert estimate_market_avg(2010, current_year=2026) == 3000  # delta>13

    def test_none(self):
        assert estimate_market_avg(None) is None

    def test_current_year(self):
        assert estimate_market_avg(2026, current_year=2026) == 35000  # delta=0


# ── HTTP endpoint tests ────────────────────────────────────────────────
class TestParseCarLinkEndpoint:
    """POST /api/parse/car-link integration tests."""

    def test_valid_mobile_de_url_returns_structured_response(self, api):
        r = api.post(f"{BASE_URL}/api/parse/car-link",
                     json={"url": "https://www.mobile.de/fahrzeuge/details.html?id=429123456"})
        assert r.status_code == 200, r.text
        data = r.json()
        # Either parsed=True (real HTML extracted) or parsed=False with graceful fallback
        assert "parsed" in data
        assert data.get("source") == "mobile.de" or data.get("sourceUrl")
        # listingId must be extracted from URL slug even on 403
        assert data.get("listingId") == "429123456"
        assert data.get("currency") == "EUR"

    def test_non_mobile_de_url_unsupported_source(self, api):
        r = api.post(f"{BASE_URL}/api/parse/car-link",
                     json={"url": "https://example.com/some-car"})
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["parsed"] is False
        assert data["error"] == "unsupported_source"
        assert "mobile.de" in data.get("supportedSources", [])

    def test_empty_url_returns_422(self, api):
        r = api.post(f"{BASE_URL}/api/parse/car-link", json={"url": ""})
        assert r.status_code == 422

    def test_missing_url_returns_422(self, api):
        r = api.post(f"{BASE_URL}/api/parse/car-link", json={})
        assert r.status_code == 422

    def test_invalid_url_format_graceful(self, api):
        # "not a url" — no scheme, router prepends https:// so hostname=="not" → unsupported_source
        r = api.post(f"{BASE_URL}/api/parse/car-link", json={"url": "notaurlhere"})
        assert r.status_code == 200
        data = r.json()
        assert data["parsed"] is False
        # either unsupported_source or fetch_error — both are graceful
        assert "error" in data

    def test_mobile_de_subdomain_accepted(self, api):
        r = api.post(f"{BASE_URL}/api/parse/car-link",
                     json={"url": "https://suchen.mobile.de/fahrzeuge/auto/audi/a6"})
        assert r.status_code == 200
        data = r.json()
        # Should NOT be unsupported_source — subdomain is accepted
        assert data.get("error") != "unsupported_source"


class TestSupportedSources:
    def test_supported_sources_list(self, api):
        r = api.get(f"{BASE_URL}/api/parse/supported-sources")
        assert r.status_code == 200, r.text
        data = r.json()
        assert "sources" in data
        mobile_de = next((s for s in data["sources"] if s["id"] == "mobile.de"), None)
        assert mobile_de is not None
        assert mobile_de["active"] is True
        assert mobile_de["country"] == "DE"


# ── Regression: existing endpoints still work ──────────────────────────
class TestRegressionExistingEndpoints:
    def test_health(self, api):
        r = api.get(f"{BASE_URL}/api/health")
        assert r.status_code == 200

    def test_admin_login(self, api):
        r = api.post(f"{BASE_URL}/api/auth/login",
                     json={"email": "admin@autoservice.com", "password": "Admin123!"})
        assert r.status_code == 200
        data = r.json()
        assert data.get("accessToken") or data.get("access_token") or data.get("token")

    def test_admin_zones_heatmap(self, api, admin_token):
        r = api.get(f"{BASE_URL}/api/admin/zones/heatmap",
                    headers={"Authorization": f"Bearer {admin_token}"})
        assert r.status_code == 200
        data = r.json()
        assert "heatmap" in data
        assert isinstance(data["heatmap"], list)

    def test_marketplace_providers(self, api):
        r = api.get(f"{BASE_URL}/api/marketplace/providers")
        assert r.status_code == 200
        # response is list or {providers:[...]}
        data = r.json()
        assert isinstance(data, (list, dict))
