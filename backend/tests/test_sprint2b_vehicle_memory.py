"""Sprint 2B — Vehicle Memory MVP tests.

Covers all endpoints under /api/customer/vehicles:
  - POST   /api/customer/vehicles
  - GET    /api/customer/vehicles
  - GET    /api/customer/vehicles/{id}
  - PATCH  /api/customer/vehicles/{id}
  - DELETE /api/customer/vehicles/{id}

Verifies:
  - Auth gate (anonymous → 401)
  - Customer-scoped visibility (customer A cannot see/modify B's vehicles)
  - Validation rules (brand/model required, year/mileage/price ranges)
  - No Mongo `_id` leak in responses
  - createdAt/updatedAt behaviour on PATCH
  - Persistence (POST → GET, PATCH → GET, DELETE → 404)
"""
from __future__ import annotations

import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL must be set"


# ───────────────────────── helpers ─────────────────────────

def _register_customer():
    """Register a fresh customer account, return (token, email, user_id)."""
    suffix = uuid.uuid4().hex[:10]
    email = f"TEST_veh_{suffix}@example.com"
    password = "TestPass123!"
    payload = {
        "email": email,
        "password": password,
        "name": f"TEST veh {suffix}",
        "role": "customer",
    }
    r = requests.post(f"{BASE_URL}/api/auth/register", json=payload, timeout=20)
    assert r.status_code in (200, 201), f"register failed: {r.status_code} {r.text}"
    data = r.json()
    token = data.get("accessToken")
    assert token, f"no accessToken in register response: {data}"
    user = data.get("user") or {}
    return token, email, user.get("id")


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _has_no_mongo_id(obj) -> bool:
    """Recursively assert no `_id` key anywhere in the structure."""
    if isinstance(obj, dict):
        if "_id" in obj:
            return False
        return all(_has_no_mongo_id(v) for v in obj.values())
    if isinstance(obj, list):
        return all(_has_no_mongo_id(x) for x in obj)
    return True


# ───────────────────────── fixtures ─────────────────────────

@pytest.fixture(scope="module")
def customer_a():
    token, email, uid = _register_customer()
    return {"token": token, "email": email, "user_id": uid}


@pytest.fixture(scope="module")
def customer_b():
    token, email, uid = _register_customer()
    return {"token": token, "email": email, "user_id": uid}


@pytest.fixture
def sample_vehicle_payload():
    return {
        "brand": "BMW",
        "model": "320d",
        "year": 2018,
        "mileage": 95000,
        "price": 18500.50,
        "currency": "EUR",
        "location": "Berlin",
        "fuel": "diesel",
        "transmission": "automatic",
        "thumbnail": "https://example.com/img.jpg",
        "listing_url": "https://mobile.de/vehicle/123",
        "source": "mobile.de",
        "external_source_id": "mde_123",
        "notes": "TEST_initial note",
    }


# ───────────────────────── auth gate ─────────────────────────

class TestAuthGate:
    """Anonymous requests must be rejected."""

    def test_post_anonymous_401(self, sample_vehicle_payload):
        r = requests.post(
            f"{BASE_URL}/api/customer/vehicles",
            json=sample_vehicle_payload,
            timeout=15,
        )
        assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text}"

    def test_get_list_anonymous_401(self):
        r = requests.get(f"{BASE_URL}/api/customer/vehicles", timeout=15)
        assert r.status_code == 401

    def test_get_one_anonymous_401(self):
        r = requests.get(
            f"{BASE_URL}/api/customer/vehicles/vehicle_anything", timeout=15
        )
        assert r.status_code == 401

    def test_patch_anonymous_401(self):
        r = requests.patch(
            f"{BASE_URL}/api/customer/vehicles/vehicle_anything",
            json={"notes": "x"},
            timeout=15,
        )
        assert r.status_code == 401

    def test_delete_anonymous_401(self):
        r = requests.delete(
            f"{BASE_URL}/api/customer/vehicles/vehicle_anything", timeout=15
        )
        assert r.status_code == 401


# ───────────────────────── CRUD happy path ─────────────────────────

class TestVehicleCRUD:
    """Core CRUD lifecycle for customer A."""

    def test_create_vehicle_returns_201_with_required_fields(
        self, customer_a, sample_vehicle_payload
    ):
        r = requests.post(
            f"{BASE_URL}/api/customer/vehicles",
            json=sample_vehicle_payload,
            headers=_headers(customer_a["token"]),
            timeout=20,
        )
        assert r.status_code == 201, f"{r.status_code} {r.text}"
        data = r.json()
        # Identity + ownership + timestamps
        assert isinstance(data.get("id"), str) and data["id"].startswith("vehicle_")
        assert data.get("customerId") == customer_a["user_id"]
        assert data.get("createdAt")
        assert data.get("updatedAt")
        # All input fields echoed
        for k, v in sample_vehicle_payload.items():
            assert data.get(k) == v, f"field {k} mismatch: {data.get(k)} != {v}"
        # No Mongo _id leak
        assert _has_no_mongo_id(data), f"Mongo _id leak: {data}"
        # Stash for later tests
        TestVehicleCRUD.created_id = data["id"]
        TestVehicleCRUD.created_createdAt = data["createdAt"]
        TestVehicleCRUD.created_updatedAt = data["updatedAt"]

    def test_create_persists_and_get_returns_same(self, customer_a):
        vid = TestVehicleCRUD.created_id
        r = requests.get(
            f"{BASE_URL}/api/customer/vehicles/{vid}",
            headers=_headers(customer_a["token"]),
            timeout=15,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["id"] == vid
        assert body["customerId"] == customer_a["user_id"]
        assert _has_no_mongo_id(body)

    def test_list_returns_only_own_vehicles_sorted_desc(
        self, customer_a, sample_vehicle_payload
    ):
        # Create a second vehicle so we can verify sort order
        time.sleep(1.05)  # ensure createdAt differs by >=1s
        p2 = dict(sample_vehicle_payload, brand="Audi", model="A4", notes="TEST_second")
        r2 = requests.post(
            f"{BASE_URL}/api/customer/vehicles",
            json=p2,
            headers=_headers(customer_a["token"]),
            timeout=20,
        )
        assert r2.status_code == 201
        second_id = r2.json()["id"]

        r = requests.get(
            f"{BASE_URL}/api/customer/vehicles",
            headers=_headers(customer_a["token"]),
            timeout=15,
        )
        assert r.status_code == 200
        items = r.json()
        assert isinstance(items, list)
        ids = [it["id"] for it in items]
        assert second_id in ids and TestVehicleCRUD.created_id in ids
        # All belong to current customer
        assert all(it["customerId"] == customer_a["user_id"] for it in items)
        # No _id leaks
        assert _has_no_mongo_id(items)
        # Newest first
        idx_first = ids.index(second_id)
        idx_second = ids.index(TestVehicleCRUD.created_id)
        assert idx_first < idx_second, f"expected newer first, got order {ids}"

    def test_patch_partial_update_advances_updatedAt(self, customer_a):
        vid = TestVehicleCRUD.created_id
        time.sleep(1.05)  # ensure updatedAt advances by >=1s
        patch = {"notes": "TEST_updated_note", "mileage": 100000}
        r = requests.patch(
            f"{BASE_URL}/api/customer/vehicles/{vid}",
            json=patch,
            headers=_headers(customer_a["token"]),
            timeout=15,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["notes"] == "TEST_updated_note"
        assert body["mileage"] == 100000
        # Untouched fields preserved
        assert body["brand"] == "BMW"
        assert body["model"] == "320d"
        assert body["year"] == 2018
        # createdAt is preserved (compare just the seconds prefix; Mongo
        # round-trips datetimes at ms precision and drops the trailing 'Z',
        # while the original POST response was ISO-formatted in-process).
        assert body["createdAt"][:19] == TestVehicleCRUD.created_createdAt[:19]
        # updatedAt advanced (later than original)
        assert body["updatedAt"][:19] > TestVehicleCRUD.created_updatedAt[:19]
        assert _has_no_mongo_id(body)

    def test_delete_returns_204_then_get_404(self, customer_a):
        vid = TestVehicleCRUD.created_id
        r = requests.delete(
            f"{BASE_URL}/api/customer/vehicles/{vid}",
            headers=_headers(customer_a["token"]),
            timeout=15,
        )
        assert r.status_code == 204, f"{r.status_code} {r.text}"
        # Subsequent GET → 404
        r2 = requests.get(
            f"{BASE_URL}/api/customer/vehicles/{vid}",
            headers=_headers(customer_a["token"]),
            timeout=15,
        )
        assert r2.status_code == 404

    def test_delete_nonexistent_returns_404(self, customer_a):
        r = requests.delete(
            f"{BASE_URL}/api/customer/vehicles/vehicle_does_not_exist_xyz",
            headers=_headers(customer_a["token"]),
            timeout=15,
        )
        assert r.status_code == 404


# ───────────────────────── cross-customer isolation ─────────────────────────

class TestCrossCustomerIsolation:
    """Customer A must NOT see/modify/delete customer B's vehicles."""

    def test_isolation_full_matrix(self, customer_a, customer_b, sample_vehicle_payload):
        # B creates a vehicle
        payload_b = dict(sample_vehicle_payload, brand="VW", model="Golf", notes="TEST_b")
        r = requests.post(
            f"{BASE_URL}/api/customer/vehicles",
            json=payload_b,
            headers=_headers(customer_b["token"]),
            timeout=20,
        )
        assert r.status_code == 201
        b_vehicle = r.json()
        b_id = b_vehicle["id"]
        assert b_vehicle["customerId"] == customer_b["user_id"]

        # A's list does NOT contain B's vehicle
        r_list = requests.get(
            f"{BASE_URL}/api/customer/vehicles",
            headers=_headers(customer_a["token"]),
            timeout=15,
        )
        assert r_list.status_code == 200
        a_ids = [v["id"] for v in r_list.json()]
        assert b_id not in a_ids
        # And no foreign customerIds in A's list
        for v in r_list.json():
            assert v["customerId"] == customer_a["user_id"]

        # A GET on B's id → 404
        r_get = requests.get(
            f"{BASE_URL}/api/customer/vehicles/{b_id}",
            headers=_headers(customer_a["token"]),
            timeout=15,
        )
        assert r_get.status_code == 404

        # A PATCH on B's id → 404 (no info leak)
        r_patch = requests.patch(
            f"{BASE_URL}/api/customer/vehicles/{b_id}",
            json={"notes": "hacked"},
            headers=_headers(customer_a["token"]),
            timeout=15,
        )
        assert r_patch.status_code == 404

        # A DELETE on B's id → 404
        r_del = requests.delete(
            f"{BASE_URL}/api/customer/vehicles/{b_id}",
            headers=_headers(customer_a["token"]),
            timeout=15,
        )
        assert r_del.status_code == 404

        # B can still see their own vehicle (not damaged)
        r_b = requests.get(
            f"{BASE_URL}/api/customer/vehicles/{b_id}",
            headers=_headers(customer_b["token"]),
            timeout=15,
        )
        assert r_b.status_code == 200
        assert r_b.json()["notes"] == "TEST_b"

        # cleanup
        requests.delete(
            f"{BASE_URL}/api/customer/vehicles/{b_id}",
            headers=_headers(customer_b["token"]),
            timeout=15,
        )


# ───────────────────────── validation ─────────────────────────

class TestValidation:
    """Field validation rules from the schema."""

    @pytest.mark.parametrize(
        "bad_payload, reason",
        [
            ({"model": "X"}, "missing brand"),
            ({"brand": "BMW"}, "missing model"),
            ({"brand": "", "model": "X"}, "empty brand"),
            ({"brand": "BMW", "model": ""}, "empty model"),
            ({"brand": "BMW", "model": "X", "year": 1899}, "year < 1900"),
            ({"brand": "BMW", "model": "X", "year": 2100}, "year > 2099"),
            ({"brand": "BMW", "model": "X", "mileage": -1}, "mileage < 0"),
            ({"brand": "BMW", "model": "X", "mileage": 2_000_001}, "mileage > 2_000_000"),
            ({"brand": "BMW", "model": "X", "price": -0.01}, "price < 0"),
            ({"brand": "BMW", "model": "X", "price": 100_000_001}, "price > 100_000_000"),
        ],
    )
    def test_create_validation_rejected(self, customer_a, bad_payload, reason):
        r = requests.post(
            f"{BASE_URL}/api/customer/vehicles",
            json=bad_payload,
            headers=_headers(customer_a["token"]),
            timeout=15,
        )
        assert r.status_code == 422, f"{reason}: expected 422, got {r.status_code} {r.text}"

    def test_create_minimum_valid_payload(self, customer_a):
        r = requests.post(
            f"{BASE_URL}/api/customer/vehicles",
            json={"brand": "Tesla", "model": "Model 3"},
            headers=_headers(customer_a["token"]),
            timeout=15,
        )
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["brand"] == "Tesla"
        assert body["model"] == "Model 3"
        # Optional fields default sensibly
        assert body.get("year") is None
        assert body.get("mileage") is None
        assert body.get("price") is None
        assert body.get("currency") == "EUR"  # schema default
        assert body.get("source") == "manual"  # schema default
        assert _has_no_mongo_id(body)
        # cleanup
        requests.delete(
            f"{BASE_URL}/api/customer/vehicles/{body['id']}",
            headers=_headers(customer_a["token"]),
            timeout=15,
        )

    def test_create_boundary_values_accepted(self, customer_a):
        payload = {
            "brand": "X",
            "model": "Y",
            "year": 1900,
            "mileage": 0,
            "price": 0,
        }
        r = requests.post(
            f"{BASE_URL}/api/customer/vehicles",
            json=payload,
            headers=_headers(customer_a["token"]),
            timeout=15,
        )
        assert r.status_code == 201, r.text
        vid = r.json()["id"]
        requests.delete(
            f"{BASE_URL}/api/customer/vehicles/{vid}",
            headers=_headers(customer_a["token"]),
            timeout=15,
        )

        payload2 = {
            "brand": "X",
            "model": "Y",
            "year": 2099,
            "mileage": 2_000_000,
            "price": 100_000_000,
        }
        r2 = requests.post(
            f"{BASE_URL}/api/customer/vehicles",
            json=payload2,
            headers=_headers(customer_a["token"]),
            timeout=15,
        )
        assert r2.status_code == 201, r2.text
        vid2 = r2.json()["id"]
        requests.delete(
            f"{BASE_URL}/api/customer/vehicles/{vid2}",
            headers=_headers(customer_a["token"]),
            timeout=15,
        )


# ───────────────────────── _id leak audit ─────────────────────────

class TestNoMongoIdLeak:
    """Final audit: _id must NEVER appear in any response."""

    def test_no_id_leak_in_list_or_create(self, customer_a):
        # Create one
        r = requests.post(
            f"{BASE_URL}/api/customer/vehicles",
            json={"brand": "Audit", "model": "Leak", "notes": "TEST_audit"},
            headers=_headers(customer_a["token"]),
            timeout=15,
        )
        assert r.status_code == 201
        # Use structural check (raw substring would false-match `external_source_id`)
        assert _has_no_mongo_id(r.json()), f"Mongo _id leak in create: {r.json()}"
        vid = r.json()["id"]

        # List
        r_list = requests.get(
            f"{BASE_URL}/api/customer/vehicles",
            headers=_headers(customer_a["token"]),
            timeout=15,
        )
        assert _has_no_mongo_id(r_list.json()), "Mongo _id leak in list"

        # Get one
        r_get = requests.get(
            f"{BASE_URL}/api/customer/vehicles/{vid}",
            headers=_headers(customer_a["token"]),
            timeout=15,
        )
        assert _has_no_mongo_id(r_get.json())

        # Patch
        r_patch = requests.patch(
            f"{BASE_URL}/api/customer/vehicles/{vid}",
            json={"notes": "TEST_audit2"},
            headers=_headers(customer_a["token"]),
            timeout=15,
        )
        assert _has_no_mongo_id(r_patch.json())

        # cleanup
        requests.delete(
            f"{BASE_URL}/api/customer/vehicles/{vid}",
            headers=_headers(customer_a["token"]),
            timeout=15,
        )
