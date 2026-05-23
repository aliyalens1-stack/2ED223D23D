"""Sprint 1C — Identity Runtime Closure tests.

Scope: POST /api/auth/login, /api/auth/register, GET /api/auth/me,
POST /api/auth/switch-account + smoke endpoints. Bizdomain must not regress.
"""
from __future__ import annotations
import os
import uuid
import jwt as pyjwt
import pytest
import requests


BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ.get("EXPO_BACKEND_URL")
    or "http://localhost:8001"
).rstrip("/")

ADMIN_EMAIL = "admin@autoservice.com"
ADMIN_PASSWORD = "Admin123!"


@pytest.fixture(scope="module")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def _decode_no_verify(token: str) -> dict:
    return pyjwt.decode(token, options={"verify_signature": False})


# ─── Login ────────────────────────────────────────────────────────────────
class TestLogin:
    def test_admin_login_shape_and_jwt_claims(self, api_client):
        r = api_client.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
            timeout=30,
        )
        assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
        body = r.json()
        # response shape
        assert "accessToken" in body
        assert "user" in body
        assert "accounts" in body and isinstance(body["accounts"], list)
        assert "activeAccount" in body and body["activeAccount"]
        user = body["user"]
        active = body["activeAccount"]
        # activeAccount.id must NOT equal user.id (post-migration real account)
        assert active["id"] != user["id"], (
            f"activeAccount.id ({active['id']}) must not equal user.id "
            f"({user['id']}) — indicates legacy-shim fallback, migration not applied."
        )
        assert active.get("isLegacy") is False
        # JWT claims
        claims = _decode_no_verify(body["accessToken"])
        assert "accountId" in claims
        assert "kind" in claims
        assert "caps" in claims and isinstance(claims["caps"], list)
        assert claims["accountId"] == active["id"]

    def test_login_wrong_password(self, api_client):
        r = api_client.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": ADMIN_EMAIL, "password": "WRONGpwd!"},
            timeout=30,
        )
        assert r.status_code == 401


# ─── Register ─────────────────────────────────────────────────────────────
class TestRegister:
    def test_register_provider_owner_creates_inspector_account(self, api_client):
        email = f"TEST_inspector_{uuid.uuid4().hex[:8]}@test.com"
        r = api_client.post(
            f"{BASE_URL}/api/auth/register",
            json={
                "email": email,
                "password": "Passw0rd!",
                "firstName": "Test",
                "lastName": "Inspector",
                "role": "provider_owner",
            },
            timeout=30,
        )
        assert r.status_code in (200, 201), f"{r.status_code} {r.text}"
        body = r.json()
        active = body["activeAccount"]
        assert active["kind"] == "inspector", f"kind={active['kind']}"
        assert active.get("isLegacy") is False, "inspector shouldn't be legacy shim"
        assert "inspect" in active.get("capabilities", []), (
            f"missing 'inspect' cap: {active.get('capabilities')}"
        )
        # activeAccount.id != user.id
        assert active["id"] != body["user"]["id"]

    def test_register_customer_no_capabilities(self, api_client):
        email = f"TEST_customer_{uuid.uuid4().hex[:8]}@test.com"
        r = api_client.post(
            f"{BASE_URL}/api/auth/register",
            json={
                "email": email,
                "password": "Passw0rd!",
                "firstName": "Test",
                "lastName": "Customer",
                "role": "customer",
            },
            timeout=30,
        )
        assert r.status_code in (200, 201), f"{r.status_code} {r.text}"
        active = r.json()["activeAccount"]
        assert active["kind"] == "customer"
        assert active.get("capabilities", []) == [], (
            f"customer should have no caps, got: {active.get('capabilities')}"
        )

    def test_register_duplicate_email_returns_409(self, api_client):
        email = f"TEST_dup_{uuid.uuid4().hex[:8]}@test.com"
        payload = {
            "email": email,
            "password": "Passw0rd!",
            "firstName": "Dup",
            "lastName": "User",
            "role": "customer",
        }
        r1 = api_client.post(f"{BASE_URL}/api/auth/register", json=payload, timeout=30)
        assert r1.status_code in (200, 201)
        r2 = api_client.post(f"{BASE_URL}/api/auth/register", json=payload, timeout=30)
        assert r2.status_code == 409, f"expected 409, got {r2.status_code} {r2.text}"


# ─── /me ──────────────────────────────────────────────────────────────────
class TestMe:
    @pytest.fixture(scope="class")
    def admin_token(self, api_client):
        r = api_client.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
            timeout=30,
        )
        assert r.status_code == 200
        return r.json()["accessToken"]

    def test_me_with_valid_token(self, api_client, admin_token):
        r = api_client.get(
            f"{BASE_URL}/api/auth/me",
            headers={"Authorization": f"Bearer {admin_token}"},
            timeout=30,
        )
        assert r.status_code == 200, f"{r.status_code} {r.text}"
        body = r.json()
        assert "user" in body and "accounts" in body and "activeAccount" in body
        assert isinstance(body["accounts"], list)
        assert body["user"].get("role") is not None  # legacy compat
        assert body["activeAccount"] is not None

    def test_me_without_token_401(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/auth/me", timeout=30)
        assert r.status_code == 401

    def test_me_invalid_token_401(self, api_client):
        r = api_client.get(
            f"{BASE_URL}/api/auth/me",
            headers={"Authorization": "Bearer not.a.jwt"},
            timeout=30,
        )
        assert r.status_code == 401

    def test_me_expired_token_401(self, api_client):
        # craft an expired token (sig won't verify but endpoint rejects as invalid/expired)
        import datetime as dt
        payload = {
            "sub": "x",
            "email": "x@y.z",
            "exp": int((dt.datetime.utcnow() - dt.timedelta(hours=1)).timestamp()),
            "iat": int((dt.datetime.utcnow() - dt.timedelta(hours=2)).timestamp()),
        }
        tok = pyjwt.encode(payload, "wrong-secret", algorithm="HS256")
        r = api_client.get(
            f"{BASE_URL}/api/auth/me",
            headers={"Authorization": f"Bearer {tok}"},
            timeout=30,
        )
        assert r.status_code == 401


# ─── switch-account ───────────────────────────────────────────────────────
class TestSwitchAccount:
    @pytest.fixture(scope="class")
    def admin_bundle(self, api_client):
        r = api_client.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
            timeout=30,
        )
        assert r.status_code == 200
        return r.json()

    def test_switch_without_token_401(self, api_client):
        r = api_client.post(
            f"{BASE_URL}/api/auth/switch-account",
            json={"accountId": "anything"},
            timeout=30,
        )
        assert r.status_code == 401

    def test_switch_foreign_account_403(self, api_client, admin_bundle):
        # Create a fresh user, grab their activeAccount.id, then try to switch
        # to it using the admin token.
        email = f"TEST_foreign_{uuid.uuid4().hex[:8]}@test.com"
        reg = api_client.post(
            f"{BASE_URL}/api/auth/register",
            json={
                "email": email,
                "password": "Passw0rd!",
                "firstName": "F",
                "lastName": "O",
                "role": "customer",
            },
            timeout=30,
        )
        assert reg.status_code in (200, 201)
        foreign_acc_id = reg.json()["activeAccount"]["id"]

        r = api_client.post(
            f"{BASE_URL}/api/auth/switch-account",
            headers={"Authorization": f"Bearer {admin_bundle['accessToken']}"},
            json={"accountId": foreign_acc_id},
            timeout=30,
        )
        assert r.status_code == 403
        # same message for non-existent
        r2 = api_client.post(
            f"{BASE_URL}/api/auth/switch-account",
            headers={"Authorization": f"Bearer {admin_bundle['accessToken']}"},
            json={"accountId": "000000000000000000000000"},
            timeout=30,
        )
        assert r2.status_code == 403
        # No info leak → identical body
        assert r.json() == r2.json(), (
            f"info leak: foreign={r.json()} non_existent={r2.json()}"
        )

    def test_switch_own_account_success(self, api_client, admin_bundle):
        own_id = admin_bundle["activeAccount"]["id"]
        r = api_client.post(
            f"{BASE_URL}/api/auth/switch-account",
            headers={"Authorization": f"Bearer {admin_bundle['accessToken']}"},
            json={"accountId": own_id},
            timeout=30,
        )
        assert r.status_code == 200, f"{r.status_code} {r.text}"
        body = r.json()
        assert "accessToken" in body
        claims = _decode_no_verify(body["accessToken"])
        assert claims.get("accountId") == own_id


# ─── Smoke / non-regression ───────────────────────────────────────────────
class TestSmoke:
    def test_health(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/health", timeout=30)
        assert r.status_code == 200

    def test_admin_panel_static(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/admin-panel/", timeout=30)
        assert r.status_code == 200

    def test_web_app_static(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/web-app/", timeout=30)
        assert r.status_code == 200

    def test_cities(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/cities", timeout=30)
        assert r.status_code == 200

    def test_marketplace_providers(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/marketplace/providers", timeout=30)
        assert r.status_code == 200


# ─── Single-source capability resolver ───────────────────────────────────
class TestSingleCapabilityResolver:
    def test_v1_delegates_to_v2(self):
        import sys
        sys.path.insert(0, "/app/backend")
        from app.core.capability import require_capability
        from app.core.identity_runtime import require_capability_v2
        dep1 = require_capability("inspect")
        dep2 = require_capability_v2("inspect")
        # Both should be async callables with same arity
        import inspect as ipt
        assert ipt.iscoroutinefunction(dep1)
        assert ipt.iscoroutinefunction(dep2)
        sig1 = ipt.signature(dep1)
        sig2 = ipt.signature(dep2)
        assert list(sig1.parameters) == list(sig2.parameters)
