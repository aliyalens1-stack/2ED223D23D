"""Berlin Launch B1 — tests for POST /api/inspection/report/generate + build_report unit checks."""
from __future__ import annotations
import os
import sys
import pytest
import requests

# Allow importing build_report directly for unit tests
sys.path.insert(0, "/app/backend")
from app.inspection.report import build_report  # noqa: E402

BASE_URL = os.environ.get("EXPO_BACKEND_URL", "http://localhost:8001").rstrip("/")
EP = f"{BASE_URL}/api/inspection/report/generate"

ADMIN_EMAIL = "admin@autoservice.com"
ADMIN_PASSWORD = "Admin123!"


# ── Fixtures ─────────────────────────────────────────────────────────
@pytest.fixture(scope="session")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ── Regression: core endpoints still work ────────────────────────────
class TestRegression:
    def test_health_200(self, api):
        r = api.get(f"{BASE_URL}/api/health", timeout=10)
        assert r.status_code == 200

    def test_admin_login_jwt(self, api):
        r = api.post(f"{BASE_URL}/api/auth/login",
                     json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=10)
        assert r.status_code == 200, r.text
        data = r.json()
        token = (data.get("token") or data.get("access_token") or data.get("accessToken")
                 or (data.get("data") or {}).get("token"))
        assert token and isinstance(token, str) and len(token) > 20

    def test_parse_car_link_endpoint_exists(self, api):
        # smoke: endpoint should accept {url} and not 404/500
        r = api.post(f"{BASE_URL}/api/parse/car-link",
                     json={"url": "https://www.mobile.de/fahrzeuge/details.html?id=123"}, timeout=20)
        assert r.status_code in (200, 422)


# ── Manual payload scoring ───────────────────────────────────────────
class TestManualPayload:
    def test_low_risk_recent_car(self, api):
        payload = {"year": 2023, "mileage": 40000, "price": 25000, "fuel": "petrol"}
        r = api.post(EP, json=payload, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        rep = body["report"]
        assert rep["score"] >= 9, f"expected >=9, got {rep['score']}"
        assert rep["risk"] == "low"
        # Berlin Launch B1 — decision is ALWAYS action-oriented; never "buy"/"avoid"
        assert rep["decision"] == "inspect"
        assert rep["decisionLabel"] == "Vor dem Kauf prüfen lassen"
        # only low-severity reasons allowed (e.g. mileage_moderate absent here)
        for reason in rep["reasons"]:
            assert reason["severity"] in ("low", "medium"), reason

    def test_high_risk_old_diesel(self, api):
        payload = {"year": 2010, "mileage": 230000, "price": 3500, "fuel": "diesel"}
        r = api.post(EP, json=payload, timeout=15)
        assert r.status_code == 200, r.text
        rep = r.json()["report"]
        assert rep["score"] <= 6, rep["score"]
        assert rep["risk"] == "high"
        # Berlin Launch B1 — high-risk no longer says "avoid"; converts via urgent inspection
        assert rep["decision"] == "inspect"
        assert "prüf" in rep["decisionLabel"].lower()
        codes = {reason["code"] for reason in rep["reasons"]}
        assert "mileage_very_high" in codes
        assert "age_very_old" in codes
        assert "diesel_age" in codes
        assert rep["costEstimate"][1] > 2000, rep["costEstimate"]

    def test_minimal_data_only_year(self, api):
        r = api.post(EP, json={"year": 2020}, timeout=15)
        assert r.status_code == 200, r.text
        rep = r.json()["report"]
        assert 2.0 <= rep["score"] <= 10.0
        assert rep["confidence"] in ("low", "medium")

    def test_empty_body_422(self, api):
        r = api.post(EP, json={}, timeout=15)
        assert r.status_code == 422, r.text
        body = r.json()
        # unified error envelope: {error, code, message, details}
        text = (body.get("message") or "") + " " + str(body.get("details") or "")
        assert ("url" in text.lower()) or ("price" in text.lower()) or ("VALIDATION" in (body.get("code") or ""))


# ── URL-only path ────────────────────────────────────────────────────
class TestUrlPath:
    def test_url_only_does_not_500(self, api):
        r = api.post(EP, json={"url": "https://www.mobile.de/fahrzeuge/details.html?id=999999"}, timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "report" in body and "car" in body and "parseMeta" in body
        pm = body["parseMeta"]
        assert pm.get("parsed") in (True, False, None)  # graceful either way
        # bounded score
        assert 2.0 <= body["report"]["score"] <= 10.0

    def test_manual_price_overrides_parsed(self, api):
        r = api.post(EP, json={
            "url": "https://www.mobile.de/fahrzeuge/details.html?id=111",
            "price": 99999, "mileage": 50000, "year": 2022, "fuel": "petrol",
        }, timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["car"]["price"] == 99999
        assert body["car"]["mileage"] == 50000
        assert body["car"]["year"] == 2022


# ── Contract: German labels + pricing ────────────────────────────────
class TestContract:
    def test_pricing_fields(self, api):
        r = api.post(EP, json={"year": 2022, "mileage": 60000, "price": 18000}, timeout=15)
        assert r.status_code == 200
        p = r.json()["pricing"]
        assert p["inspectionFee"] == 149
        assert p["currency"] == "EUR"
        assert p["deliveryHours"] == 24

    def test_reasons_and_summary_in_german(self, api):
        r = api.post(EP, json={"year": 2010, "mileage": 230000, "price": 3500, "fuel": "diesel"}, timeout=15)
        assert r.status_code == 200
        rep = r.json()["report"]
        # Check German umlauts / words present (case-insensitive)
        german_markers = ("ä", "ö", "ü", "ß", "fahrzeug", "kilometer", "baujahr", "markt",
                          "preis", "prüf", "durchschnitt", "überraschung", "risiko",
                          "inspektion", "empfehl", "verhandl")
        summary_l = rep["summary"].lower()
        summary_ok = any(m in summary_l for m in german_markers)
        assert summary_ok, rep["summary"]
        for reason in rep["reasons"]:
            blob = (reason["label"] + " " + reason["detail"]).lower()
            hit = any(m in blob for m in german_markers)
            assert hit, reason
        # Ensure decision label is DE
        assert any(m in rep["decisionLabel"] for m in german_markers) or \
               rep["decisionLabel"] in ("Kaufen mit ruhigem Gewissen",
                                         "Wir empfehlen Verhandlung",
                                         "Vorsicht — eventuell Finger weg")


# ── Unit tests on build_report() for edge cases ──────────────────────
class TestBuildReportUnit:
    def test_empty_dict_bounded(self):
        rep = build_report({})
        assert 2.0 <= rep["score"] <= 10.0
        assert rep["confidence"] == "low"

    def test_score_floor_wild_inputs(self):
        rep = build_report({"price": 1, "mileage": 999999, "year": 1990, "fuel": "diesel", "marketAvg": 20000})
        assert rep["score"] >= 2.0
        assert rep["score"] <= 10.0
        assert rep["risk"] == "high"

    def test_score_ceiling_perfect_car(self):
        rep = build_report({"price": 25000, "mileage": 10000, "year": 2024, "fuel": "petrol", "marketAvg": 25000})
        assert rep["score"] <= 10.0
        assert rep["score"] >= 9.0
        # Berlin Launch B1 — action-oriented decision, even for low-risk
        assert rep["decision"] == "inspect"
        assert rep["decisionLabel"] == "Vor dem Kauf prüfen lassen"

    def test_ev_battery_age_reason(self):
        rep = build_report({"year": 2015, "mileage": 80000, "price": 12000, "fuel": "electric", "marketAvg": 14000})
        codes = {r["code"] for r in rep["reasons"]}
        assert "ev_battery_age" in codes

    def test_cost_estimate_monotonic(self):
        rep = build_report({"year": 2010, "mileage": 230000, "price": 3000, "fuel": "diesel", "marketAvg": 6000})
        lo, hi = rep["costEstimate"]
        assert isinstance(lo, int) and isinstance(hi, int)
        assert hi > lo
        assert lo >= 0

    def test_confidence_levels(self):
        # Berlin B1.3: 'high' only when marketSource=='model' AND filled>=3
        assert build_report({
            "make": "Audi", "model": "A6", "price": 20000, "mileage": 90000, "year": 2018,
        })["confidence"] == "high"
        # Without model-aware baseline (year-only or None), 3 filled fields → 'medium'
        assert build_report({"price": 1, "mileage": 1, "year": 2020})["confidence"] == "medium"
        # 2 filled fields without model baseline → 'low'
        assert build_report({"price": 1, "mileage": 1})["confidence"] == "low"
        assert build_report({"year": 2020})["confidence"] == "low"

    def test_price_overpriced_soft_flag(self):
        rep = build_report({"price": 30000, "mileage": 50000, "year": 2022, "fuel": "petrol", "marketAvg": 20000})
        codes = {r["code"] for r in rep["reasons"]}
        assert "price_overpriced" in codes

    def test_price_suspicious_low(self):
        rep = build_report({"price": 5000, "mileage": 50000, "year": 2022, "fuel": "petrol", "marketAvg": 20000})
        codes = {r["code"] for r in rep["reasons"]}
        assert "price_suspicious_low" in codes
