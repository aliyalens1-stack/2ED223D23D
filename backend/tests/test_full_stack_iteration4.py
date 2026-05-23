"""
Iteration 4 Backend Testing: Full-stack composition validation.

Scope (per review_request):
  - FastAPI auth (login/me/register) for admin/customer/provider
  - FastAPI /api/health returning ok + nestjs healthy
  - NestJS via FastAPI proxy: organizations, marketplace, matching, admin automation
  - Phase E/G/H: orchestrator/state, orchestrator/metrics, feedback/dashboard, feedback/strategy
  - Static file delivery: /api/admin-panel/, /api/web-app/
  - Zones: /api/zones (6 Kyiv zones with surge/ratio/status)
"""

import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8001").rstrip("/")

ADMIN = {"email": "admin@autoservice.com", "password": "Admin123!"}
CUSTOMER = {"email": "customer@test.com", "password": "Customer123!"}
PROVIDER = {"email": "provider@test.com", "password": "Provider123!"}


# ---------- Shared fixtures ----------

@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def _login(api, creds):
    r = api.post(f"{BASE_URL}/api/auth/login", json=creds, timeout=30)
    assert r.status_code == 200, f"Login failed for {creds['email']}: {r.status_code} {r.text}"
    data = r.json()
    token = data.get("accessToken") or data.get("token") or data.get("access_token")
    assert token, f"No accessToken in response: {data}"
    return token, data.get("user", {})


@pytest.fixture(scope="module")
def admin_token(api):
    t, _ = _login(api, ADMIN)
    return t


@pytest.fixture(scope="module")
def customer_token(api):
    t, _ = _login(api, CUSTOMER)
    return t


@pytest.fixture(scope="module")
def provider_token(api):
    t, _ = _login(api, PROVIDER)
    return t


# ---------- Health & Auth ----------

class TestHealth:
    def test_health_ok_and_nestjs(self, api):
        r = api.get(f"{BASE_URL}/api/health", timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        # FastAPI should report ok and ideally include nestjs status
        status = data.get("status") or data.get("state")
        assert status in ("ok", "healthy"), f"status={status}, body={data}"
        # Best-effort nestjs healthy check
        nest = data.get("nestjs") or data.get("services", {}).get("nestjs") or {}
        if isinstance(nest, dict) and nest:
            nest_status = nest.get("status") or nest.get("state")
            assert nest_status in ("healthy", "ok", "up", True), f"nestjs status={nest_status}, data={data}"
        print(f"[health] {data}")


class TestAuth:
    def test_admin_login(self, api):
        token, user = _login(api, ADMIN)
        assert user.get("role") == "admin", f"user={user}"

    def test_customer_login(self, api):
        token, user = _login(api, CUSTOMER)
        assert user.get("role") in ("customer", "user"), f"user={user}"

    def test_provider_login(self, api):
        token, user = _login(api, PROVIDER)
        assert user.get("role") in ("provider_owner", "provider", "owner"), f"user={user}"

    def test_auth_me_admin(self, api, admin_token):
        r = api.get(f"{BASE_URL}/api/auth/me", headers={"Authorization": f"Bearer {admin_token}"}, timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("role") == "admin"
        assert data.get("email") == ADMIN["email"]

    def test_auth_me_customer(self, api, customer_token):
        r = api.get(f"{BASE_URL}/api/auth/me", headers={"Authorization": f"Bearer {customer_token}"}, timeout=30)
        assert r.status_code == 200, r.text

    def test_auth_me_provider(self, api, provider_token):
        r = api.get(f"{BASE_URL}/api/auth/me", headers={"Authorization": f"Bearer {provider_token}"}, timeout=30)
        assert r.status_code == 200, r.text

    def test_register_new_user(self, api):
        unique = f"TEST_{uuid.uuid4().hex[:10]}@example.com"
        payload = {
            "email": unique,
            "password": "TestPass123!",
            "name": "TEST User",
            "firstName": "TEST",
            "lastName": "User",
            "role": "customer",
        }
        r = api.post(f"{BASE_URL}/api/auth/register", json=payload, timeout=30)
        assert r.status_code in (200, 201), f"register failed: {r.status_code} {r.text}"
        data = r.json()
        token = data.get("accessToken") or data.get("token")
        assert token, f"No token in register response: {data}"
        # verify JWT works
        me = api.get(f"{BASE_URL}/api/auth/me", headers={"Authorization": f"Bearer {token}"}, timeout=30)
        assert me.status_code == 200, me.text
        # Backend normalizes email to lowercase - accept case-insensitive match
        assert (me.json().get("email") or "").lower() == unique.lower()


# ---------- NestJS via FastAPI proxy ----------

class TestNestJsProxy:
    def test_organizations_list(self, api):
        r = api.get(f"{BASE_URL}/api/organizations", timeout=30)
        assert r.status_code == 200, f"{r.status_code} {r.text[:500]}"
        data = r.json()
        # Accept either list or dict with items/data
        items = data if isinstance(data, list) else (data.get("items") or data.get("data") or data.get("organizations") or [])
        assert isinstance(items, list), f"Unexpected shape: {type(data)} -> {str(data)[:300]}"
        assert len(items) >= 6, f"Expected >= 6 organizations, got {len(items)}"
        print(f"[organizations] count={len(items)} sample={items[0] if items else None}")

    def test_matching_nearby(self, api):
        r = api.get(f"{BASE_URL}/api/matching/nearby?lat=50.4501&lng=30.5234", timeout=30)
        assert r.status_code == 200, f"{r.status_code} {r.text[:500]}"
        data = r.json()
        # Flexible: list or dict with matches/providers
        if isinstance(data, dict):
            any_list = (data.get("matches") or data.get("providers") or data.get("items") or data.get("data"))
            assert any_list is not None, f"No list in body: {str(data)[:300]}"
        print(f"[matching/nearby] ok -> {str(data)[:200]}")

    def test_admin_automation_dashboard(self, api, admin_token):
        r = api.get(
            f"{BASE_URL}/api/admin/automation/dashboard",
            headers={"Authorization": f"Bearer {admin_token}"},
            timeout=30,
        )
        # NestJS may respond 200 or 401 if guard differs - capture either case
        assert r.status_code == 200, f"{r.status_code} {r.text[:500]}"
        data = r.json()
        assert isinstance(data, dict) and len(data) > 0


# ---------- Marketplace & Zones ----------

class TestMarketplaceAndZones:
    def test_marketplace_providers(self, api):
        r = api.get(f"{BASE_URL}/api/marketplace/providers?lat=50.4501&lng=30.5234&limit=5", timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        providers = data.get("providers") or data.get("items") or []
        assert len(providers) > 0, f"No providers returned: {data}"

    def test_marketplace_stats(self, api):
        r = api.get(f"{BASE_URL}/api/marketplace/stats", timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "totalProviders" in data or "providers" in data or "stats" in data

    def test_marketplace_services(self, api):
        r = api.get(f"{BASE_URL}/api/marketplace/services", timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        cats = data.get("categories") or data.get("items") or []
        assert len(cats) > 0, f"No service categories: {data}"

    def test_zones_list_six_kyiv(self, api):
        r = api.get(f"{BASE_URL}/api/zones", timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        zones = data.get("zones") or data if isinstance(data, list) else data.get("zones")
        assert isinstance(zones, list) and len(zones) == 6, f"Expected 6 zones, got {len(zones) if zones else 'none'}"
        z = zones[0]
        for key in ("surgeMultiplier", "ratio", "status"):
            assert key in z, f"Zone missing {key}: {z}"


# ---------- Orchestrator (Phase E) ----------

class TestOrchestrator:
    def test_state_cycle_zones_actions(self, api):
        r = api.get(f"{BASE_URL}/api/orchestrator/state", timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("cycleCount", 0) > 0, f"cycleCount not > 0: {data.get('cycleCount')}"
        assert isinstance(data.get("zones"), list) and len(data["zones"]) == 6
        # actions key flexibility
        # Orchestrator state returns lastActionsCount (not an "actions" array)
        assert any(k in data for k in ("actions", "activeActions", "lastActions", "lastActionsCount")), f"No actions key in state: {list(data.keys())}"

    def test_metrics_timeline(self, api):
        r = api.get(f"{BASE_URL}/api/orchestrator/metrics", timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "timeline" in data
        assert isinstance(data["timeline"], list)


# ---------- Feedback (Phase G) & Strategy (Phase H) ----------

class TestFeedbackAndStrategy:
    def test_feedback_dashboard(self, api):
        r = api.get(f"{BASE_URL}/api/feedback/dashboard", timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "stats" in data
        assert "actionBreakdown" in data

    def test_feedback_strategy_weights(self, api):
        r = api.get(f"{BASE_URL}/api/feedback/strategy", timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "global" in data and "zones" in data
        weights = data["global"].get("weights") or data["global"]
        assert isinstance(weights, dict) and len(weights) > 0, f"No global weights: {data['global']}"


# ---------- Static files (Admin panel & Web app) ----------

class TestStaticBundles:
    def test_admin_panel_html(self, api):
        r = api.get(f"{BASE_URL}/api/admin-panel/", timeout=30)
        assert r.status_code == 200, f"{r.status_code} {r.text[:300]}"
        ctype = r.headers.get("content-type", "")
        assert "html" in ctype.lower(), f"Expected HTML, got content-type={ctype}"
        assert "<html" in r.text.lower() or "<!doctype html" in r.text.lower(), r.text[:300]

    def test_web_app_html(self, api):
        r = api.get(f"{BASE_URL}/api/web-app/", timeout=30)
        assert r.status_code == 200, f"{r.status_code} {r.text[:300]}"
        ctype = r.headers.get("content-type", "")
        assert "html" in ctype.lower(), f"Expected HTML, got content-type={ctype}"
        assert "<html" in r.text.lower() or "<!doctype html" in r.text.lower(), r.text[:300]


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short", "--junitxml=/app/test_reports/pytest/pytest_iteration4.xml"])
