"""
Partner registration + admin verification flow tests.
Covers:
- POST /api/marketplace/partner/register (validation, success, duplicate)
- GET /api/admin/partner-verifications/ (status filters, auth)
- GET /api/admin/partner-verifications/{id}
- POST /api/admin/partner-verifications/{id}/approve
- POST /api/admin/partner-verifications/{id}/reject
- repeat decision -> 400
- GET /api/marketplace/partner/me/status
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL") or os.environ.get("EXPO_BACKEND_URL")
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL missing"
BASE_URL = BASE_URL.rstrip("/")

ADMIN_EMAIL = "admin@autoservice.com"
ADMIN_PASSWORD = "Admin123!"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                      timeout=20)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text[:300]}"
    data = r.json()
    token = data.get("token") or data.get("access_token") or data.get("accessToken")
    assert token, f"no token in response: {data}"
    return token


@pytest.fixture
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


def _mk_partner(kind="workshop", lat=52.52, lng=13.41, city="berlin"):
    suffix = uuid.uuid4().hex[:10]
    return {
        "name": f"TEST_Partner_{suffix}",
        "email": f"test_partner_{suffix}@example.com",
        "password": "PartnerPass123!",
        "phone": "+491234567890",
        "kind": kind,
        "city": city,
        "address": "Teststrasse 1",
        "lat": lat,
        "lng": lng,
    }


# --- Registration ---------------------------------------------------------

class TestPartnerRegister:

    def test_register_workshop_success(self):
        payload = _mk_partner("workshop")
        r = requests.post(f"{BASE_URL}/api/marketplace/partner/register", json=payload, timeout=20)
        assert r.status_code == 200, f"{r.status_code} {r.text[:400]}"
        d = r.json()
        assert d.get("ok") is True
        assert d.get("organizationId")
        assert d.get("queueId")
        assert d.get("status") == "pending_verification"

    def test_register_all_kinds(self):
        for k in ("inspector", "dealer", "carwash"):
            p = _mk_partner(k)
            r = requests.post(f"{BASE_URL}/api/marketplace/partner/register", json=p, timeout=20)
            assert r.status_code == 200, f"kind {k} failed: {r.status_code} {r.text[:300]}"
            assert r.json().get("organizationId")

    def test_register_invalid_kind(self):
        p = _mk_partner("invalid_kind_xxx")
        r = requests.post(f"{BASE_URL}/api/marketplace/partner/register", json=p, timeout=20)
        # Either 400 (custom) or 422 (pydantic)
        assert r.status_code in (400, 422), f"got {r.status_code} {r.text[:300]}"

    def test_register_invalid_coords(self):
        p = _mk_partner(lat=200.0, lng=13.4)
        r = requests.post(f"{BASE_URL}/api/marketplace/partner/register", json=p, timeout=20)
        assert r.status_code in (400, 422)

    def test_register_duplicate_email_409(self):
        p = _mk_partner("workshop")
        r1 = requests.post(f"{BASE_URL}/api/marketplace/partner/register", json=p, timeout=20)
        assert r1.status_code == 200
        r2 = requests.post(f"{BASE_URL}/api/marketplace/partner/register", json=p, timeout=20)
        assert r2.status_code == 409, f"expected 409 got {r2.status_code} {r2.text[:300]}"

    def test_me_status_after_register(self):
        p = _mk_partner("workshop")
        r = requests.post(f"{BASE_URL}/api/marketplace/partner/register", json=p, timeout=20)
        assert r.status_code == 200
        org_id = r.json()["organizationId"]
        s = requests.get(f"{BASE_URL}/api/marketplace/partner/me/status",
                         params={"organizationId": org_id}, timeout=20)
        assert s.status_code == 200, f"{s.status_code} {s.text[:300]}"
        d = s.json()
        assert d.get("status") == "pending_verification"
        assert d.get("organizationId") == org_id


# --- Admin list/single ----------------------------------------------------

class TestAdminList:

    def test_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/admin/partner-verifications/", timeout=20)
        assert r.status_code in (401, 403), f"expected 401/403 got {r.status_code}"

    def test_list_pending(self, admin_headers):
        # Ensure at least one pending entry
        p = _mk_partner("workshop")
        rr = requests.post(f"{BASE_URL}/api/marketplace/partner/register", json=p, timeout=20)
        assert rr.status_code == 200
        org_id = rr.json()["organizationId"]

        r = requests.get(f"{BASE_URL}/api/admin/partner-verifications/",
                         params={"status": "pending", "limit": 100},
                         headers=admin_headers, timeout=20)
        assert r.status_code == 200, f"{r.status_code} {r.text[:400]}"
        d = r.json()
        for key in ("applications", "total", "limit", "skip"):
            assert key in d, f"missing {key}"
        apps = d["applications"]
        # Our org should be present
        match = [a for a in apps if a.get("organizationId") == org_id]
        assert match, "newly created application not in pending list"
        a = match[0]
        assert a.get("organization") is not None, "hydrated organization missing"
        assert a["organization"].get("name", "").startswith("TEST_Partner_")

    def test_list_all(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/admin/partner-verifications/",
                         params={"status": "all", "limit": 5},
                         headers=admin_headers, timeout=20)
        assert r.status_code == 200
        assert "applications" in r.json()

    def test_get_single(self, admin_headers):
        p = _mk_partner("dealer")
        rr = requests.post(f"{BASE_URL}/api/marketplace/partner/register", json=p, timeout=20).json()
        queue_id = rr["queueId"]
        r = requests.get(f"{BASE_URL}/api/admin/partner-verifications/{queue_id}",
                         headers=admin_headers, timeout=20)
        assert r.status_code == 200, f"{r.status_code} {r.text[:300]}"
        d = r.json()
        assert d.get("application", {}).get("id") == queue_id
        assert d.get("organization") is not None
        assert d.get("user") is not None
        assert "passwordHash" not in (d["user"] or {})


# --- Approve / Reject -----------------------------------------------------

class TestAdminDecisions:

    def test_approve_flow(self, admin_headers):
        p = _mk_partner("carwash")
        rr = requests.post(f"{BASE_URL}/api/marketplace/partner/register", json=p, timeout=20).json()
        queue_id = rr["queueId"]
        org_id = rr["organizationId"]

        r = requests.post(f"{BASE_URL}/api/admin/partner-verifications/{queue_id}/approve",
                          json={}, headers=admin_headers, timeout=20)
        assert r.status_code == 200, f"{r.status_code} {r.text[:300]}"
        assert r.json().get("status") == "approved"

        # verify org status flipped
        s = requests.get(f"{BASE_URL}/api/marketplace/partner/me/status",
                         params={"organizationId": org_id}, timeout=20).json()
        assert s.get("status") == "active", f"org status not active: {s}"

        # repeat decision should fail
        r2 = requests.post(f"{BASE_URL}/api/admin/partner-verifications/{queue_id}/approve",
                           json={}, headers=admin_headers, timeout=20)
        assert r2.status_code == 400, f"expected 400 got {r2.status_code}"

    def test_reject_flow(self, admin_headers):
        p = _mk_partner("inspector")
        rr = requests.post(f"{BASE_URL}/api/marketplace/partner/register", json=p, timeout=20).json()
        queue_id = rr["queueId"]
        org_id = rr["organizationId"]

        # reject without note -> 400
        r0 = requests.post(f"{BASE_URL}/api/admin/partner-verifications/{queue_id}/reject",
                           json={}, headers=admin_headers, timeout=20)
        assert r0.status_code in (400, 422), f"expected 400/422 got {r0.status_code}"

        r = requests.post(f"{BASE_URL}/api/admin/partner-verifications/{queue_id}/reject",
                          json={"note": "TEST rejection - docs missing"},
                          headers=admin_headers, timeout=20)
        assert r.status_code == 200, f"{r.status_code} {r.text[:300]}"
        assert r.json().get("status") == "rejected"

        # org should remain pending_verification
        s = requests.get(f"{BASE_URL}/api/marketplace/partner/me/status",
                         params={"organizationId": org_id}, timeout=20).json()
        assert s.get("status") == "pending_verification", f"org status: {s}"

        # repeat reject -> 400
        r2 = requests.post(f"{BASE_URL}/api/admin/partner-verifications/{queue_id}/reject",
                           json={"note": "again"},
                           headers=admin_headers, timeout=20)
        assert r2.status_code == 400


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v", "--tb=short"]))
