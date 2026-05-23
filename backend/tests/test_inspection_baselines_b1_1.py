"""Berlin Launch B1.1 — Make/Model-aware market baseline tests.

Covers:
  - baselines.py unit (get_baseline, humanize_model, _normalize_make_model)
  - /api/inspection/report/generate with make/model integration
  - Model-aware reason codes (price_suspicious_low_model, price_below_market)
  - Confidence bump when marketSource=='model'
  - Graceful fallback for unknown brand/model
  - Edge: qualifiers stripped, BMW '320d' normalized, Mercedes-Benz aliases
"""
from __future__ import annotations
import os
import sys
import pytest
import requests

sys.path.insert(0, "/app/backend")
from app.inspection.baselines import (  # noqa: E402
    get_baseline,
    humanize_model,
    _normalize_make_model,
    MARKET_BASELINES,
)
from app.inspection.report import build_report  # noqa: E402

BASE_URL = os.environ.get("EXPO_BACKEND_URL", "http://localhost:8001").rstrip("/")
EP = f"{BASE_URL}/api/inspection/report/generate"


@pytest.fixture(scope="session")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ── Regression smoke ─────────────────────────────────────────────────
class TestRegression:
    def test_health(self, api):
        r = api.get(f"{BASE_URL}/api/health", timeout=10)
        assert r.status_code == 200

    def test_admin_login(self, api):
        r = api.post(f"{BASE_URL}/api/auth/login",
                     json={"email": "admin@autoservice.com", "password": "Admin123!"}, timeout=10)
        assert r.status_code == 200
        d = r.json()
        tok = d.get("accessToken") or d.get("token") or (d.get("data") or {}).get("token")
        assert tok and len(tok) > 20

    def test_parse_car_link(self, api):
        r = api.post(f"{BASE_URL}/api/parse/car-link",
                     json={"url": "https://www.mobile.de/fahrzeuge/details.html?id=1"}, timeout=20)
        assert r.status_code in (200, 422)


# ── Unit: _normalize_make_model edge cases ───────────────────────────
class TestNormalizer:
    def test_audi_with_qualifiers(self):
        assert _normalize_make_model("Audi", "A6 Avant 2.0 TDI quattro") == "audi_a6"
        assert _normalize_make_model("Audi", "A6 2.0 TDI") == "audi_a6"
        assert _normalize_make_model("Audi", "Q5 S-line quattro") == "audi_q5"

    def test_bmw_series_strip_digits(self):
        assert _normalize_make_model("BMW", "320d Touring") == "bmw_3"
        assert _normalize_make_model("BMW", "318i") == "bmw_3"
        assert _normalize_make_model("BMW", "520d xDrive") == "bmw_5"
        assert _normalize_make_model("BMW", "X3 M-sport") == "bmw_x3"
        assert _normalize_make_model("BMW", "X5 xDrive30d") == "bmw_x5"

    def test_mercedes_alias_and_class(self):
        assert _normalize_make_model("Mercedes-Benz", "C220d AMG line") == "mercedes_c"
        assert _normalize_make_model("Mercedes", "E350d") == "mercedes_e"
        assert _normalize_make_model("Mercedes-Benz", "GLC 300 4MATIC") == "mercedes_glc"

    def test_vw(self):
        assert _normalize_make_model("VW", "Golf GTI") == "vw_golf"
        assert _normalize_make_model("VW", "Passat Variant 2.0 TDI") == "vw_passat"

    def test_unknown_returns_none(self):
        assert _normalize_make_model("Tesla", "Model S") is None
        assert _normalize_make_model("Ferrari", "488") is None
        assert _normalize_make_model("Audi", "Unknown9999") is None

    def test_empty_inputs(self):
        assert _normalize_make_model(None, "A6") is None
        assert _normalize_make_model("Audi", None) is None
        assert _normalize_make_model("", "") is None


# ── Unit: get_baseline ───────────────────────────────────────────────
class TestGetBaseline:
    def test_exact_year_hit(self):
        eur, key = get_baseline("Audi", "A6 2.0 TDI", 2018)
        assert eur == 24000
        assert key == "audi_a6"

    def test_bmw_normalization_and_key(self):
        eur, key = get_baseline("BMW", "320d Touring", 2015)
        assert key == "bmw_3"
        assert eur == 11000  # from table

    def test_nearest_year_fallback(self):
        # audi_a6 table has no 2011 — should fall back to 2012 (within ±3)
        eur, key = get_baseline("Audi", "A6", 2011)
        assert key == "audi_a6"
        assert eur == 8000  # 2012 value

    def test_year_out_of_range_returns_none(self):
        # audi_a6 has no 2005 or nearby — oldest is 2012
        eur, key = get_baseline("Audi", "A6", 2005)
        assert (eur, key) == (None, None)

    def test_unknown_model_returns_none(self):
        assert get_baseline("Tesla", "Model S", 2020) == (None, None)

    def test_no_year_returns_none(self):
        assert get_baseline("Audi", "A6", None) == (None, None)


# ── Unit: humanize_model ─────────────────────────────────────────────
class TestHumanize:
    def test_audi(self):
        assert humanize_model("audi_a6") == "Audi A6"
        assert humanize_model("audi_q5") == "Audi Q5"

    def test_bmw_series(self):
        assert humanize_model("bmw_3") == "BMW 3er"
        assert humanize_model("bmw_5") == "BMW 5er"
        assert humanize_model("bmw_x3") == "BMW X3"

    def test_vw(self):
        assert humanize_model("vw_golf") == "VW Golf"
        assert humanize_model("vw_polo") == "VW Polo"

    def test_mercedes(self):
        assert humanize_model("mercedes_c") == "Mercedes-Benz C"
        assert humanize_model("mercedes_glc") == "Mercedes-Benz GLC"

    def test_empty(self):
        assert humanize_model(None) == ""
        assert humanize_model("") == ""


# ── build_report integration with model baseline ─────────────────────
class TestBuildReportModelAware:
    def test_audi_a6_2018_below_market(self):
        rep = build_report({
            "make": "Audi", "model": "A6 2.0 TDI", "year": 2018,
            "mileage": 120000, "price": 18900, "fuel": "diesel",
        })
        assert rep["marketSource"] == "model"
        assert rep["matchedModel"] == "Audi A6"
        assert rep["inputs"]["marketAvg"] == 24000
        codes = {r["code"] for r in rep["reasons"]}
        assert "price_below_market" in codes
        below_reason = next(r for r in rep["reasons"] if r["code"] == "price_below_market")
        assert "Audi A6" in below_reason["detail"]
        assert "€24.000" in below_reason["detail"]

    def test_audi_a6_2018_suspicious_low(self):
        rep = build_report({
            "make": "Audi", "model": "A6", "year": 2018,
            "mileage": 120000, "price": 10000, "fuel": "diesel",
        })
        codes = {r["code"] for r in rep["reasons"]}
        assert "price_suspicious_low_model" in codes
        sus = next(r for r in rep["reasons"] if r["code"] == "price_suspicious_low_model")
        assert sus["severity"] == "high"
        assert "%" in sus["detail"]
        assert "Unfallhistorie" in sus["detail"]

    def test_bmw_320d_touring_matches_3er(self):
        rep = build_report({
            "make": "BMW", "model": "320d Touring", "year": 2015,
            "mileage": 95000, "price": 12500,
        })
        assert rep["marketSource"] == "model"
        assert rep["matchedModel"] == "BMW 3er"

    def test_vw_golf_high_confidence(self):
        rep = build_report({
            "make": "VW", "model": "Golf", "year": 2023,
            "mileage": 40000, "price": 25000, "fuel": "petrol",
        })
        assert rep["marketSource"] == "model"
        assert rep["matchedModel"] == "VW Golf"
        assert rep["confidence"] == "high"

    def test_mercedes_c220d(self):
        rep = build_report({
            "make": "Mercedes-Benz", "model": "C220d", "year": 2019,
            "mileage": 80000, "price": 23000,
        })
        assert rep["marketSource"] == "model"
        assert "Mercedes-Benz" in rep["matchedModel"]
        assert "C" in rep["matchedModel"]

    def test_unknown_brand_tesla_fallback(self):
        # No model baseline for Tesla — marketAvg=None unless year-only estimate is supplied
        rep = build_report({
            "make": "Tesla", "model": "Model S", "year": 2020,
            "mileage": 60000, "price": 45000, "marketAvg": 38000,
        })
        assert rep["marketSource"] == "year"
        assert rep["matchedModel"] is None
        # Still returns valid report
        assert 2.0 <= rep["score"] <= 10.0

    def test_confidence_fallback_medium(self):
        # All fields filled but no model baseline hit → confidence='medium'
        rep = build_report({
            "make": "Tesla", "model": "Model S", "year": 2020,
            "mileage": 60000, "price": 45000, "marketAvg": 38000,
        })
        assert rep["confidence"] == "medium"

    def test_missing_model_year_only_confidence(self):
        # No make/model → year-only → confidence='medium' with 3 filled
        rep = build_report({
            "year": 2020, "mileage": 60000, "price": 15000, "marketAvg": 18000,
        })
        assert rep["marketSource"] == "year"
        assert rep["confidence"] == "medium"


# ── End-to-end: POST /api/inspection/report/generate ─────────────────
class TestEndpointIntegration:
    def test_audi_a6_e2e(self, api):
        r = api.post(EP, json={
            "make": "Audi", "model": "A6 2.0 TDI", "year": 2018,
            "mileage": 120000, "price": 18900, "fuel": "diesel",
        }, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        rep = body["report"]
        assert rep["marketSource"] == "model"
        assert rep["matchedModel"] == "Audi A6"
        assert body["car"]["marketAvg"] == 24000
        # price_below_market expected (18900/24000 ≈ 0.7875 → below_market range)
        codes = {r2["code"] for r2 in rep["reasons"]}
        assert "price_below_market" in codes
        reason = next(r2 for r2 in rep["reasons"] if r2["code"] == "price_below_market")
        assert "Audi A6" in reason["detail"]
        assert "€24.000" in reason["detail"]

    def test_bmw_320d_e2e(self, api):
        r = api.post(EP, json={
            "make": "BMW", "model": "320d Touring", "year": 2015,
            "mileage": 95000, "price": 12500,
        }, timeout=15)
        assert r.status_code == 200
        rep = r.json()["report"]
        assert rep["matchedModel"] == "BMW 3er"
        assert rep["marketSource"] == "model"

    def test_vw_golf_e2e_high_confidence(self, api):
        r = api.post(EP, json={
            "make": "VW", "model": "Golf", "year": 2023,
            "mileage": 40000, "price": 25000, "fuel": "petrol",
        }, timeout=15)
        assert r.status_code == 200
        rep = r.json()["report"]
        assert rep["marketSource"] == "model"
        assert rep["matchedModel"] == "VW Golf"
        assert rep["confidence"] == "high"

    def test_mercedes_c_e2e(self, api):
        r = api.post(EP, json={
            "make": "Mercedes-Benz", "model": "C220d", "year": 2019,
            "mileage": 80000, "price": 23000, "fuel": "diesel",
        }, timeout=15)
        assert r.status_code == 200
        rep = r.json()["report"]
        assert rep["marketSource"] == "model"
        assert "Mercedes-Benz" in rep["matchedModel"]
        assert "C" in rep["matchedModel"]

    def test_unknown_brand_still_200(self, api):
        r = api.post(EP, json={
            "make": "Tesla", "model": "Model S", "year": 2020,
            "mileage": 60000, "price": 45000,
        }, timeout=15)
        assert r.status_code == 200
        rep = r.json()["report"]
        assert rep["matchedModel"] is None
        assert rep["marketSource"] in ("year", None)

    def test_audi_a6_suspicious_low_e2e(self, api):
        r = api.post(EP, json={
            "make": "Audi", "model": "A6", "year": 2018,
            "mileage": 120000, "price": 10000, "fuel": "diesel",
        }, timeout=15)
        assert r.status_code == 200
        rep = r.json()["report"]
        codes = {r2["code"] for r2 in rep["reasons"]}
        assert "price_suspicious_low_model" in codes
        sus = next(r2 for r2 in rep["reasons"] if r2["code"] == "price_suspicious_low_model")
        assert sus["severity"] == "high"
        assert "%" in sus["detail"]
        assert "Unfallhistorie" in sus["detail"]
