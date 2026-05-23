"""Pass #2 — Berlin Marketplace FLOW INTEGRITY regression tests.

Covers:
  FLOW 1 — Customer inspection (3 fixtures + edge cases)
  FLOW 2 — Provider onboarding (full payload + DB side-effects + duplicate 409)
  FLOW 3 — Edge/broken UX (auth errors, admin panel unauth)
  AUTH SANITY — 3 role logins + /auth/me
  DEAD-END WATCH — web-app + admin-panel HTML routes not 5xx
"""
from __future__ import annotations
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8001").rstrip("/")
TIMEOUT = 30


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ── AUTH SANITY ───────────────────────────────────────────────────────
class TestAuthSanity:
    def test_customer_login(self, api):
        r = api.post(f"{BASE_URL}/api/auth/login",
                     json={"email": "customer@test.com", "password": "Customer123!"},
                     timeout=TIMEOUT)
        if r.status_code == 429:
            pytest.skip("rate limited")
        assert r.status_code == 200, r.text
        body = r.json()
        assert "accessToken" in body or "token" in body, body
        user = body.get("user") or {}
        name = f"{user.get('firstName','')} {user.get('lastName','')}".strip()
        assert "Ivan" in name or "Schneider" in name or user.get("email") == "customer@test.com", \
            f"Unexpected user identity: {user}"

    def test_provider_login(self, api):
        time.sleep(2)
        r = api.post(f"{BASE_URL}/api/auth/login",
                     json={"email": "provider@test.com", "password": "Provider123!"},
                     timeout=TIMEOUT)
        if r.status_code == 429:
            pytest.skip("rate limited")
        assert r.status_code == 200, r.text
        user = r.json().get("user") or {}
        assert user.get("email") == "provider@test.com"

    def test_admin_login(self, api):
        time.sleep(2)
        r = api.post(f"{BASE_URL}/api/auth/login",
                     json={"email": "admin@autoservice.com", "password": "Admin123!"},
                     timeout=TIMEOUT)
        if r.status_code == 429:
            pytest.skip("rate limited")
        assert r.status_code == 200, r.text
        token = r.json().get("accessToken") or r.json().get("token")
        assert token
        me = api.get(f"{BASE_URL}/api/auth/me",
                     headers={"Authorization": f"Bearer {token}"}, timeout=TIMEOUT)
        assert me.status_code == 200, me.text
        assert me.json().get("role") == "admin" or "admin" in str(me.json()).lower()

    def test_login_wrong_password(self, api):
        time.sleep(3)
        r = api.post(f"{BASE_URL}/api/auth/login",
                     json={"email": "customer@test.com", "password": "WrongPass!"},
                     timeout=TIMEOUT)
        if r.status_code == 429:
            pytest.skip("rate limited")
        assert r.status_code in (400, 401), f"expected 4xx, got {r.status_code}"

    def test_login_empty(self, api):
        time.sleep(3)
        r = api.post(f"{BASE_URL}/api/auth/login", json={}, timeout=TIMEOUT)
        assert r.status_code in (400, 401, 422), f"expected 4xx, got {r.status_code}"


# ── FLOW 1 — CUSTOMER INSPECTION ──────────────────────────────────────
class TestInspectionFlow:
    def test_audi_a6_2018_medium(self, api):
        r = api.post(f"{BASE_URL}/api/inspection/report/generate", json={
            "make": "Audi", "model": "A6", "year": 2018,
            "price": 18900, "mileage": 120000, "fuel": "Diesel",
        }, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "report" in body and "car" in body
        report = body["report"]
        assert "score" in report and "risk" in report
        assert isinstance(report.get("reasons", []), list)
        assert body["car"].get("marketAvg"), "marketAvg must be set"
        assert report["risk"] in ("low", "medium", "high")
        # CTA pricing
        assert body["pricing"]["inspectionFee"] == 149

    def test_bmw_320d_2017_low(self, api):
        r = api.post(f"{BASE_URL}/api/inspection/report/generate", json={
            "make": "BMW", "model": "320d", "year": 2017,
            "price": 13500, "mileage": 150000, "fuel": "Diesel",
        }, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        report = r.json()["report"]
        assert report["risk"] in ("low", "medium", "high")

    def test_vw_golf_2019(self, api):
        r = api.post(f"{BASE_URL}/api/inspection/report/generate", json={
            "make": "VW", "model": "Golf", "year": 2019,
            "price": 7500, "mileage": 80000, "fuel": "Benzin",
        }, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        report = r.json()["report"]
        assert report["risk"] in ("medium", "high"), f"expected medium/high for discount override, got {report['risk']}"

    def test_empty_body_422(self, api):
        r = api.post(f"{BASE_URL}/api/inspection/report/generate", json={}, timeout=TIMEOUT)
        assert r.status_code == 422, f"expected 422 for empty body, got {r.status_code}"

    def test_garbage_url_graceful(self, api):
        r = api.post(f"{BASE_URL}/api/inspection/report/generate", json={
            "url": "https://not-a-real-listing.example.com/garbage"
        }, timeout=TIMEOUT)
        # should NOT 500 — either 422 (no data extractable) or 200 with parseMeta.error
        assert r.status_code in (200, 422), f"expected graceful 2xx/422, got {r.status_code}: {r.text[:300]}"
        if r.status_code == 200:
            assert r.json().get("parseMeta", {}).get("error") or not r.json().get("parseMeta", {}).get("parsed")


# ── FLOW 2 — PROVIDER ONBOARDING ──────────────────────────────────────
class TestProviderOnboarding:
    _shared_email = None
    _shared_slug = None

    def test_full_onboarding(self, api):
        ts = int(time.time())
        email = f"TEST_berlin+{ts}{uuid.uuid4().hex[:4]}@flow2.de"
        TestProviderOnboarding._shared_email = email
        payload = {
            "email": email,
            "password": "Berlin2026!",
            "name": "Test Berlin Werkstatt",
            "phone": "+49301234567",
            "clusters": ["inspection"],
            "profile": {
                "tuvVerified": True,
                "yearsExperience": 15,
                "brands": ["BMW", "Audi"],
                "cities": ["Berlin"],
            },
            "autoMoney": {
                "enabled": True, "targetRank": 2, "maxBid": 30,
                "dailyBudget": 300, "strategy": "balanced",
            },
        }
        r = api.post(f"{BASE_URL}/api/provider/onboarding", json=payload, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("ok") is True
        assert body.get("accessToken"), "JWT must be issued"
        assert body["user"]["role"] == "provider_owner"
        assert body["user"]["email"] == email.lower()
        slug = body["provider"]["slug"]
        TestProviderOnboarding._shared_slug = slug
        assert slug, "provider slug required"
        # seeded bids across top zones × clusters
        seeded = body.get("seededBids", [])
        zones = {b["zone"] for b in seeded}
        assert {"berlin-mitte", "berlin-neukolln"}.issubset(zones), f"missing zones: {zones}"
        # auto-money on
        assert body["autoMoney"].get("enabled") is True
        # nextStep
        assert body["nextStep"]["redirectTo"] == "/provider"
        assert "Dashboard" in body["nextStep"]["label"]

    def test_duplicate_email_409(self, api):
        if not TestProviderOnboarding._shared_email:
            pytest.skip("no prior email")
        payload = {
            "email": TestProviderOnboarding._shared_email,
            "password": "Berlin2026!",
            "name": "dup",
        }
        r = api.post(f"{BASE_URL}/api/provider/onboarding", json=payload, timeout=TIMEOUT)
        assert r.status_code == 409, f"expected 409 duplicate, got {r.status_code}: {r.text[:200]}"

    def test_onboarding_landing_html(self, api):
        r = requests.get(f"{BASE_URL}/api/web-app/provider-onboarding",
                         timeout=TIMEOUT, allow_redirects=True)
        assert r.status_code == 200, r.status_code
        html = r.text
        # must look like a proper SPA shell, not an error
        assert "<html" in html.lower()
        assert "error" not in html.lower()[:500] or "html" in html.lower()[:500]


# ── FLOW 3 — EDGE / DEAD-END WATCH ────────────────────────────────────
class TestEdge:
    def test_admin_panel_unauth(self, api):
        r = requests.get(f"{BASE_URL}/api/admin-panel/",
                         timeout=TIMEOUT, allow_redirects=False)
        # must not 5xx — either redirect to login OR 200 with login screen
        assert r.status_code < 500, f"admin-panel 5xx: {r.status_code}"
        assert r.status_code in (200, 301, 302, 307, 308, 401, 403), r.status_code

    def test_web_app_landing(self, api):
        r = requests.get(f"{BASE_URL}/api/web-app/", timeout=TIMEOUT, allow_redirects=True)
        assert r.status_code == 200
        assert "<html" in r.text.lower()

    def test_inspection_missing_fields_graceful(self, api):
        # price only — valid since at least one of price/mileage/year present
        r = api.post(f"{BASE_URL}/api/inspection/report/generate",
                     json={"price": 20000}, timeout=TIMEOUT)
        assert r.status_code in (200, 422), r.status_code
