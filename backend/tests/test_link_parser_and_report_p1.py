"""P1.2 + P1.5 — Link parser + Inspection report hero block.

Tests the public endpoints used by the new mobile screen:
- POST /api/parse/car-link        (LinkPreview component)
- POST /api/inspection/report/generate  (Inspection-preview screen)
"""
from __future__ import annotations
import os
import pytest
import requests

BASE_URL = (
    os.environ.get("EXPO_BACKEND_URL")
    or os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or "http://localhost:8001"
).rstrip("/")

MOBILE_DE = "https://suchen.mobile.de/fahrzeuge/details.html?id=387654321"
AUTOSCOUT = "https://www.autoscout24.de/angebote/audi-a4-2-0-tdi-test-test-12345"


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ───────── Health ─────────
def test_health(session):
    r = session.get(f"{BASE_URL}/api/health", timeout=20)
    assert r.status_code == 200, r.text


# ───────── /api/parse/car-link ─────────
class TestParseCarLink:
    def test_mobile_de_returns_structured(self, session):
        r = session.post(f"{BASE_URL}/api/parse/car-link", json={"url": MOBILE_DE}, timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        # Must include identifying fields irrespective of parse success (anti-bot 403 is OK)
        assert d.get("source") == "mobile.de"
        assert d.get("sourceUrl") == MOBILE_DE
        assert "parsed" in d
        assert d.get("listingId") == "387654321"
        # currency default
        assert d.get("currency") in (None, "EUR")

    def test_autoscout_supported(self, session):
        r = session.post(f"{BASE_URL}/api/parse/car-link", json={"url": AUTOSCOUT}, timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("source") in ("autoscout24.de", "autoscout24", "generic")
        assert d.get("sourceUrl", "").startswith("http")

    def test_invalid_url_too_short(self, session):
        r = session.post(f"{BASE_URL}/api/parse/car-link", json={"url": "x"}, timeout=15)
        assert r.status_code in (400, 422)

    def test_supported_sources(self, session):
        r = session.get(f"{BASE_URL}/api/parse/car-link/../parse/supported-sources", timeout=10)
        # Try direct path
        r = session.get(f"{BASE_URL}/api/parse/supported-sources", timeout=10)
        assert r.status_code == 200, r.text
        d = r.json()
        assert isinstance(d.get("sources"), list)
        ids = {s["id"] for s in d["sources"]}
        assert {"mobile.de", "autoscout24.de", "kleinanzeigen.de"}.issubset(ids)


# ───────── /api/inspection/report/generate ─────────
class TestInspectionReport:
    def test_full_response_shape_via_url(self, session):
        r = session.post(
            f"{BASE_URL}/api/inspection/report/generate",
            json={"url": MOBILE_DE},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        d = r.json()
        # Top-level keys
        for k in ("report", "car", "parseMeta", "pricing"):
            assert k in d, f"Missing key: {k}"
        # report shape
        rep = d["report"]
        for k in (
            "score", "risk", "summary", "reasons", "costEstimate",
            "decisionLabel", "confidence", "similarVehiclesCount", "roiHint",
        ):
            assert k in rep, f"report missing: {k}"
        assert isinstance(rep["score"], (int, float))
        assert 0 <= rep["score"] <= 10
        assert rep["risk"] in ("low", "medium", "high")
        assert isinstance(rep["reasons"], list)
        assert isinstance(rep["costEstimate"], list) and len(rep["costEstimate"]) == 2
        # pricing
        pr = d["pricing"]
        assert pr["inspectionFee"] == 149
        assert pr["currency"] == "EUR"
        assert pr["deliveryHours"] == 24
        # parseMeta
        pm = d["parseMeta"]
        assert "parsed" in pm and "source" in pm

    def test_manual_high_risk(self, session):
        # high mileage + low price → should produce medium/high risk path
        payload = {"make": "BMW", "model": "320d", "year": 2010,
                   "mileage": 280000, "price": 3500, "fuel": "diesel"}
        r = session.post(f"{BASE_URL}/api/inspection/report/generate", json=payload, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["report"]["risk"] in ("medium", "high")
        assert d["car"]["make"] == "BMW"
        assert d["car"]["mileage"] == 280000

    def test_manual_low_risk(self, session):
        payload = {"make": "Audi", "model": "A4", "year": 2022,
                   "mileage": 25000, "price": 32000, "fuel": "diesel"}
        r = session.post(f"{BASE_URL}/api/inspection/report/generate", json=payload, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        rep = d["report"]
        assert rep["risk"] in ("low", "medium")
        assert isinstance(rep["score"], (int, float))

    def test_validation_no_inputs(self, session):
        r = session.post(f"{BASE_URL}/api/inspection/report/generate", json={}, timeout=15)
        assert r.status_code == 422

    def test_response_has_no_mongo_id(self, session):
        r = session.post(f"{BASE_URL}/api/inspection/report/generate",
                         json={"url": MOBILE_DE}, timeout=20)
        assert r.status_code == 200
        body = r.text
        assert '"_id"' not in body
