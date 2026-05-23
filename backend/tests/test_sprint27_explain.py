"""Sprint 27 — Explainability backend tests.

Covers:
  - GET /api/provider/performance/explain auth gates (401/403/200)
  - Provider JWT slug resolution from organizations
  - Admin override via ?providerSlug=
  - Tip "money" when boost.multiplier == 1
  - Customer flow regression (/api/health, /api/marketplace/providers, login)
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8001").rstrip("/")
EXPLAIN_URL = f"{BASE_URL}/api/provider/performance/explain"


# ────────────── Fixtures ──────────────
@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def _login(session, email, password):
    r = session.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password}, timeout=15)
    assert r.status_code == 200, f"login failed for {email}: {r.status_code} {r.text}"
    body = r.json()
    token = body.get("accessToken") or body.get("token") or body.get("access_token")
    assert token, f"no token in login response: {body}"
    return token


@pytest.fixture(scope="module")
def admin_token(session):
    return _login(session, "admin@autoservice.com", "Admin123!")


@pytest.fixture(scope="module")
def provider_token(session):
    return _login(session, "provider@test.com", "Provider123!")


@pytest.fixture(scope="module")
def customer_token(session):
    return _login(session, "customer@test.com", "Customer123!")


# ────────────── Auth gates ──────────────
class TestExplainAuth:
    def test_no_auth_returns_401(self, session):
        r = session.get(EXPLAIN_URL, timeout=15)
        assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text}"

    def test_invalid_token_returns_401(self, session):
        r = session.get(EXPLAIN_URL, headers={"Authorization": "Bearer not.a.real.jwt"}, timeout=15)
        assert r.status_code == 401, f"expected 401 for invalid token, got {r.status_code}"

    def test_customer_token_returns_403(self, session, customer_token):
        r = session.get(EXPLAIN_URL, headers={"Authorization": f"Bearer {customer_token}"}, timeout=15)
        assert r.status_code == 403, f"expected 403 for customer, got {r.status_code}: {r.text}"


# ────────────── Provider happy path ──────────────
class TestExplainProvider:
    def test_provider_returns_200_with_full_shape(self, session, provider_token):
        r = session.get(EXPLAIN_URL, headers={"Authorization": f"Bearer {provider_token}"}, timeout=15)
        assert r.status_code == 200, f"provider should get 200, got {r.status_code}: {r.text}"
        data = r.json()

        # Required top-level keys per spec
        for key in ["finalScore", "headline", "subline", "factors", "tips", "boost", "performance"]:
            assert key in data, f"missing key '{key}' in response: keys={list(data.keys())}"

        # Type checks
        assert isinstance(data["finalScore"], (int, float))
        assert isinstance(data["headline"], str) and len(data["headline"]) > 0
        assert isinstance(data["subline"], str)
        assert isinstance(data["factors"], list) and len(data["factors"]) >= 1
        assert isinstance(data["tips"], list) and len(data["tips"]) >= 1
        assert isinstance(data["boost"], dict)
        assert "multiplier" in data["boost"]
        assert isinstance(data["performance"], dict)
        assert "multiplier" in data["performance"]

        # Each factor must have required fields
        for f in data["factors"]:
            assert "key" in f and "label" in f and "impact" in f and "tone" in f
            assert f["tone"] in ("good", "neutral", "bad")

        # Each tip must have type+text
        for t in data["tips"]:
            assert "type" in t and "text" in t
            assert t["type"] in ("money", "critical", "danger", "warning", "good")

    def test_money_tip_present_when_boost_multiplier_is_1(self, session, provider_token):
        """DoD: boost.multiplier == 1 → money tip with ctaRoute=/provider-boost."""
        r = session.get(EXPLAIN_URL, headers={"Authorization": f"Bearer {provider_token}"}, timeout=15)
        assert r.status_code == 200
        data = r.json()
        boost_mult = data["boost"]["multiplier"]
        money_tips = [t for t in data["tips"] if t.get("type") == "money"]

        if boost_mult == 1.0:
            assert len(money_tips) >= 1, "expected at least one money tip when boost.multiplier=1"
            mt = money_tips[0]
            assert mt.get("ctaRoute") == "/provider-boost", f"money tip ctaRoute mismatch: {mt}"
            assert mt.get("cta"), "money tip must have cta label"
        else:
            # If a boost is somehow active in seed data, just log — DoD is conditional on mult=1
            pytest.skip(f"boost multiplier is {boost_mult} (not 1.0) — money tip rule not triggered")


# ────────────── Admin override ──────────────
class TestExplainAdmin:
    def test_admin_with_provider_slug_returns_200(self, session, admin_token):
        r = session.get(
            EXPLAIN_URL,
            params={"providerSlug": "avtomaster-pro"},
            headers={"Authorization": f"Bearer {admin_token}"},
            timeout=15,
        )
        assert r.status_code == 200, f"admin debug should be 200, got {r.status_code}: {r.text}"
        data = r.json()
        assert data.get("providerSlug") == "avtomaster-pro"
        assert "finalScore" in data and "factors" in data and "tips" in data

    def test_admin_without_slug_returns_403(self, session, admin_token):
        """Admin without ?providerSlug= → not a provider role → 403."""
        r = session.get(EXPLAIN_URL, headers={"Authorization": f"Bearer {admin_token}"}, timeout=15)
        # Endpoint requires providerSlug for admin path; without it admin falls through to non-provider branch → 403
        assert r.status_code in (403, 400), f"expected 403/400, got {r.status_code}: {r.text}"


# ────────────── Customer flow regression ──────────────
class TestCustomerFlowRegression:
    def test_health_ok(self, session):
        r = session.get(f"{BASE_URL}/api/health", timeout=10)
        assert r.status_code == 200, f"/api/health failed: {r.status_code}"

    def test_marketplace_providers_ok(self, session):
        r = session.get(f"{BASE_URL}/api/marketplace/providers", timeout=15)
        assert r.status_code == 200, f"/api/marketplace/providers failed: {r.status_code}"
        body = r.json()
        # accept either list or dict-with-providers
        assert isinstance(body, (list, dict)), f"unexpected body type: {type(body)}"

    def test_customer_login_still_works(self, session):
        r = session.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": "customer@test.com", "password": "Customer123!"},
            timeout=15,
        )
        assert r.status_code == 200, f"customer login broken: {r.status_code} {r.text}"
        data = r.json()
        assert data.get("accessToken") or data.get("token") or data.get("access_token")

    def test_admin_login_still_works(self, session):
        r = session.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": "admin@autoservice.com", "password": "Admin123!"},
            timeout=15,
        )
        assert r.status_code == 200
