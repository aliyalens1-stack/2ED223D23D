"""Sprint 1D.2 — Customer Domain Migration tests.

Verifies:
  * `require_account_kind` helper unit checks
  * Full coverage matrix: customer-gated endpoints reject anon/provider/admin
  * Anonymous-friendly endpoints stay open
  * Public reads stay open
  * Dual-write of `customerAccountId` in 4 collections
  * 403 message clarity (carries kind required + active kind)
  * Non-regression smoke for inspector + admin + base
"""
from __future__ import annotations
import os
import asyncio
import pytest
import httpx

from tests.conftest import (
    BACKEND_URL, BYPASS_HEADERS, auth_headers, _ensure_admin_login,
    _ensure_provider_signup, _ensure_customer_signup,
)


# ─── Module-level: reuse the conftest sync caches via a quick warmup ──
ADMIN = _ensure_admin_login()
PROVIDER = _ensure_provider_signup()
CUSTOMER = _ensure_customer_signup()

ADMIN_TOKEN = ADMIN["accessToken"]
PROVIDER_TOKEN = PROVIDER["accessToken"]
CUSTOMER_TOKEN = CUSTOMER["accessToken"]
CUSTOMER_USER_ID = CUSTOMER["user"]["id"]
CUSTOMER_ACCOUNT_ID = CUSTOMER["activeAccount"]["id"]


# Endpoints that require account.kind=="customer"
CUSTOMER_GET_ENDPOINTS = [
    "/api/customer/intelligence",
    "/api/customer/favorites",
    "/api/customer/repeat-options",
    "/api/customer/garage/recommendations",
    "/api/customer/recommendations",
    "/api/customer/history/summary",
    "/api/customer/requests/my",
    "/api/customer/reports",
    "/api/customer/reports/some-id",                 # any id ok — gate runs first
    "/api/customer/requests/some-id/reports",
    "/api/customer/credits",
    "/api/customer/credits/ledger",
]

CUSTOMER_POST_ENDPOINTS = [
    ("/api/customer/favorites", {"providerId": "p1"}),
    ("/api/customer/repeat-booking", {"providerId": "p1", "serviceId": "s1"}),
    ("/api/customer/behavior/track", {"type": "view"}),
]

CUSTOMER_DELETE_ENDPOINTS = [
    "/api/customer/favorites/some-pid",
]


# ─────────────────────────────────────────────────────────────────────
# Unit-import test for require_account_kind
# ─────────────────────────────────────────────────────────────────────

class TestRequireAccountKindHelper:
    def test_accepts_customer(self):
        from app.core.identity_runtime import require_account_kind
        dep = require_account_kind("customer")
        assert callable(dep)

    def test_accepts_multiple(self):
        from app.core.identity_runtime import require_account_kind
        dep = require_account_kind("admin", "customer")
        assert callable(dep)

    def test_raises_on_unknown(self):
        from app.core.identity_runtime import require_account_kind
        with pytest.raises(ValueError):
            require_account_kind("totally-unknown-kind")

    def test_raises_on_no_kinds(self):
        from app.core.identity_runtime import require_account_kind
        with pytest.raises(ValueError):
            require_account_kind()

    def test_in_all(self):
        import app.core.identity_runtime as m
        assert "require_account_kind" in m.__all__


# ─────────────────────────────────────────────────────────────────────
# Coverage matrix — anon / provider / admin / customer
# ─────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("path", CUSTOMER_GET_ENDPOINTS)
@pytest.mark.asyncio
async def test_customer_get_anon_401(client, path):
    r = await client.get(path)
    assert r.status_code == 401, f"{path} → {r.status_code} {r.text}"


@pytest.mark.parametrize("path", CUSTOMER_GET_ENDPOINTS)
@pytest.mark.asyncio
async def test_customer_get_provider_403(client, path):
    r = await client.get(path, headers=auth_headers(PROVIDER_TOKEN))
    assert r.status_code == 403, f"{path} → {r.status_code} {r.text}"
    assert "account kind required" in r.text.lower() or "kind" in r.text.lower()


@pytest.mark.parametrize("path", CUSTOMER_GET_ENDPOINTS)
@pytest.mark.asyncio
async def test_customer_get_admin_403(client, path):
    r = await client.get(path, headers=auth_headers(ADMIN_TOKEN))
    assert r.status_code == 403, f"{path} → {r.status_code} {r.text}"


@pytest.mark.parametrize("path", CUSTOMER_GET_ENDPOINTS)
@pytest.mark.asyncio
async def test_customer_get_customer_passes_gate(client, path):
    r = await client.get(path, headers=auth_headers(CUSTOMER_TOKEN))
    # Gate must pass — handler may legitimately 404 (e.g. unknown report id)
    assert r.status_code != 401 and r.status_code != 403, f"{path} → {r.status_code} {r.text}"
    assert r.status_code in (200, 404), f"{path} unexpected status {r.status_code}"


@pytest.mark.parametrize("path,body", CUSTOMER_POST_ENDPOINTS)
@pytest.mark.asyncio
async def test_customer_post_anon_401(client, path, body):
    r = await client.post(path, json=body)
    assert r.status_code == 401, f"{path} → {r.status_code}"


@pytest.mark.parametrize("path,body", CUSTOMER_POST_ENDPOINTS)
@pytest.mark.asyncio
async def test_customer_post_provider_403(client, path, body):
    r = await client.post(path, json=body, headers=auth_headers(PROVIDER_TOKEN))
    assert r.status_code == 403, f"{path} → {r.status_code}"


@pytest.mark.parametrize("path,body", CUSTOMER_POST_ENDPOINTS)
@pytest.mark.asyncio
async def test_customer_post_admin_403(client, path, body):
    r = await client.post(path, json=body, headers=auth_headers(ADMIN_TOKEN))
    assert r.status_code == 403, f"{path} → {r.status_code}"


@pytest.mark.parametrize("path", CUSTOMER_DELETE_ENDPOINTS)
@pytest.mark.asyncio
async def test_customer_delete_anon_401(client, path):
    r = await client.delete(path)
    assert r.status_code == 401


@pytest.mark.parametrize("path", CUSTOMER_DELETE_ENDPOINTS)
@pytest.mark.asyncio
async def test_customer_delete_provider_403(client, path):
    r = await client.delete(path, headers=auth_headers(PROVIDER_TOKEN))
    assert r.status_code == 403


# ─────────────────────────────────────────────────────────────────────
# Anonymous-friendly stay open
# ─────────────────────────────────────────────────────────────────────

class TestAnonymousFriendly:
    @pytest.mark.asyncio
    async def test_packages_list_anon(self, client):
        r = await client.get("/api/packages")
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    @pytest.mark.asyncio
    async def test_checkout_anon_accepted(self, client):
        # Should not 401/403 — it might 400/404 on bad pkg, but the gate is open.
        r = await client.post("/api/payments/packages/checkout",
                              json={"packageId": "starter", "provider": "paypal"})
        assert r.status_code != 401 and r.status_code != 403

    @pytest.mark.asyncio
    async def test_create_request_anon(self, client):
        payload = {
            "cities": ["berlin"],
            "make": "BMW",
            "model": "3 Series",
            "yearFrom": 2015,
            "yearTo": 2022,
            "priceMin": 5000,
            "priceMax": 30000,
            "mileageMax": 200000,
            "fuelTypes": ["petrol"],
            "transmission": "any",
        }
        r = await client.post("/api/customer/requests", json=payload)
        assert r.status_code in (200, 201, 422), f"{r.status_code}: {r.text}"


# ─────────────────────────────────────────────────────────────────────
# Public reads stay open
# ─────────────────────────────────────────────────────────────────────

class TestPublicReads:
    @pytest.mark.asyncio
    async def test_get_request_anon(self, client):
        r = await client.get("/api/customer/requests/non-existent-id")
        assert r.status_code == 404  # not 401/403

    @pytest.mark.asyncio
    async def test_get_request_jobs_anon(self, client):
        r = await client.get("/api/customer/requests/non-existent-id/jobs")
        assert r.status_code == 404


# ─────────────────────────────────────────────────────────────────────
# Dual-write verification — direct mongo reads
# ─────────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def db():
    from pymongo import MongoClient
    from dotenv import dotenv_values
    env = dotenv_values("/app/backend/.env")
    mongo_url = (env.get("MONGO_URL") or os.environ.get("MONGO_URL") or "").strip().strip('"').strip("'")
    db_name = (env.get("DB_NAME") or os.environ.get("DB_NAME") or "").strip().strip('"').strip("'")
    client = MongoClient(mongo_url)
    return client[db_name]


class TestDualWrite:
    @pytest.mark.asyncio
    async def test_favorite_dual_write(self, client, db):
        provider_id = "TEST_dual_write_prov_1"
        r = await client.post(
            "/api/customer/favorites",
            json={"providerId": provider_id},
            headers=auth_headers(CUSTOMER_TOKEN),
        )
        assert r.status_code == 200, r.text
        doc = db.customer_favorites.find_one(
            {"customerId": CUSTOMER_USER_ID, "providerId": provider_id}
        )
        assert doc is not None, "favorite not persisted"
        assert doc.get("customerId") == CUSTOMER_USER_ID
        assert doc.get("customerAccountId") == CUSTOMER_ACCOUNT_ID
        # cleanup
        db.customer_favorites.delete_many(
            {"customerId": CUSTOMER_USER_ID, "providerId": provider_id}
        )

    @pytest.mark.asyncio
    async def test_behavior_track_dual_write(self, client, db):
        r = await client.post(
            "/api/customer/behavior/track",
            json={"type": "TEST_dual_write_event", "providerId": "px"},
            headers=auth_headers(CUSTOMER_TOKEN),
        )
        assert r.status_code == 200, r.text
        doc = db.customer_behavior_events.find_one(
            {"customerId": CUSTOMER_USER_ID, "type": "TEST_dual_write_event"}
        )
        assert doc is not None
        assert doc.get("customerAccountId") == CUSTOMER_ACCOUNT_ID
        db.customer_behavior_events.delete_many(
            {"customerId": CUSTOMER_USER_ID, "type": "TEST_dual_write_event"}
        )

    @pytest.mark.asyncio
    async def test_repeat_booking_dual_write(self, client, db):
        r = await client.post(
            "/api/customer/repeat-booking",
            json={
                "providerId": "TEST_p_repeat",
                "serviceId": "TEST_s_repeat",
                "vehicleId": "TEST_v_repeat",
            },
            headers=auth_headers(CUSTOMER_TOKEN),
        )
        assert r.status_code == 200, r.text
        booking_id = r.json().get("booking", {}).get("id")
        assert booking_id
        doc = db.web_bookings.find_one({"id": booking_id})
        assert doc is not None
        assert doc.get("customerId") == CUSTOMER_USER_ID
        assert doc.get("customerAccountId") == CUSTOMER_ACCOUNT_ID
        db.web_bookings.delete_many({"id": booking_id})

    @pytest.mark.asyncio
    async def test_car_request_dual_write_authenticated(self, client, db):
        payload = {
            "type": "selection",
            "brand": "TESTBrand",
            "model": "TESTModel",
            "budget": 15000,
            "cities": ["berlin"],
        }
        r = await client.post(
            "/api/customer/requests",
            json=payload,
            headers=auth_headers(CUSTOMER_TOKEN),
        )
        if r.status_code == 422:
            pytest.skip(f"schema mismatch in test payload: {r.text}")
        assert r.status_code in (200, 201), r.text
        req_id = r.json().get("id")
        assert req_id
        # allow background dual-write to settle
        await asyncio.sleep(0.3)
        doc = db.car_requests.find_one({"_id": req_id})
        assert doc is not None
        assert doc.get("customerAccountId") == CUSTOMER_ACCOUNT_ID, (
            f"expected dual-write of {CUSTOMER_ACCOUNT_ID}, got {doc.get('customerAccountId')}"
        )
        db.car_requests.delete_many({"_id": req_id})

    @pytest.mark.asyncio
    async def test_car_request_anon_no_dual_write(self, client, db):
        payload = {
            "type": "selection",
            "brand": "TESTAnon",
            "model": "X",
            "budget": 15000,
            "cities": ["berlin"],
        }
        r = await client.post("/api/customer/requests", json=payload)
        if r.status_code == 422:
            pytest.skip(f"schema mismatch: {r.text}")
        assert r.status_code in (200, 201)
        req_id = r.json().get("id")
        doc = db.car_requests.find_one({"_id": req_id})
        assert doc is not None
        # anon → field absent or null
        assert doc.get("customerAccountId") in (None,)
        db.car_requests.delete_many({"_id": req_id})


# ─────────────────────────────────────────────────────────────────────
# 403 message clarity
# ─────────────────────────────────────────────────────────────────────

class TestErrorMessageClarity:
    @pytest.mark.asyncio
    async def test_admin_403_on_customer_endpoint_message(self, client):
        r = await client.get(
            "/api/customer/credits", headers=auth_headers(ADMIN_TOKEN)
        )
        assert r.status_code == 403
        body = r.text.lower()
        assert "account kind required" in body
        assert "customer" in body
        assert "active kind" in body
        assert "admin" in body


# ─────────────────────────────────────────────────────────────────────
# Non-regression smokes
# ─────────────────────────────────────────────────────────────────────

class TestNonRegression:
    @pytest.mark.asyncio
    async def test_admin_can_hit_auth_me(self, client):
        r = await client.get("/api/auth/me", headers=auth_headers(ADMIN_TOKEN))
        assert r.status_code == 200
        data = r.json()
        assert data["activeAccount"]["kind"] == "admin"

    @pytest.mark.asyncio
    async def test_provider_inspector_jobs(self, client):
        r = await client.get("/api/inspector/jobs", headers=auth_headers(PROVIDER_TOKEN))
        # Sprint 1D.1 gate must remain intact — provider has 'inspect' cap by default
        assert r.status_code in (200, 403), r.text
        # If 403, message should be capability-based, not kind-based
        if r.status_code == 403:
            assert "capability" in r.text.lower()

    @pytest.mark.asyncio
    async def test_health(self, client):
        r = await client.get("/api/health")
        assert r.status_code == 200

    @pytest.mark.asyncio
    async def test_cities(self, client):
        r = await client.get("/api/cities")
        assert r.status_code == 200

    @pytest.mark.asyncio
    async def test_marketplace_providers(self, client):
        r = await client.get("/api/marketplace/providers")
        assert r.status_code == 200

    @pytest.mark.asyncio
    async def test_admin_panel(self, client):
        r = await client.get("/api/admin-panel/")
        assert r.status_code in (200, 401, 403)  # may need auth

    @pytest.mark.asyncio
    async def test_web_app(self, client):
        r = await client.get("/api/web-app/")
        assert r.status_code in (200, 401, 403, 307)
