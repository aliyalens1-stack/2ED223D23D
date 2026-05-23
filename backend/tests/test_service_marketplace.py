"""
Service Marketplace v1 — backend regression tests.

Covers:
  - GET  /api/service-requests/categories
  - POST /api/service-requests  (auth optional)
  - GET  /api/service-requests/me
  - GET  /api/service-requests/{id}  (owner vs other viewer projection)
  - GET  /api/provider/service-requests  (filters + provider role gating)
  - POST /api/provider/service-requests/{id}/bids (create + update idempotent)
  - POST /api/service-requests/{id}/accept-bid  (status flips, contacts open)
  - POST /api/service-requests/{id}/cancel
  - GET  /api/admin/service-requests + /stats
  - POST /api/admin/service-requests/{id}/assign
  - Anti-bypass: contactPhone / provider contacts hidden until accept-bid
  - Permissions: customer cannot touch provider endpoints; non-owner cannot
    accept-bid / cancel; guest cannot GET /me
  - Regression: /api/health, /api/auth/login, /api/cities
"""
from __future__ import annotations
import os
import pytest
import requests

BASE_URL = os.environ.get(
    "EXPO_BACKEND_URL",
    "https://999ad826-9a3c-42c1-bd8b-073df8bd305a.preview.emergentagent.com",
).rstrip("/")

ADMIN = {"email": "admin@autoservice.com", "password": "Admin123!"}
CUSTOMER = {"email": "customer@test.com", "password": "Customer123!"}
PROVIDER = {"email": "provider@test.com", "password": "Provider123!"}


# ── Helpers ──────────────────────────────────────────────────────────────
def _login(creds: dict) -> str:
    r = requests.post(f"{BASE_URL}/api/auth/login", json=creds, timeout=30)
    assert r.status_code == 200, f"login failed for {creds['email']}: {r.status_code} {r.text}"
    data = r.json()
    token = data.get("token") or data.get("accessToken") or data.get("access_token")
    assert token, f"no token in login response: {data}"
    return token


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# ── Fixtures (module-scoped tokens) ──────────────────────────────────────
@pytest.fixture(scope="module")
def admin_token():
    return _login(ADMIN)


@pytest.fixture(scope="module")
def customer_token():
    return _login(CUSTOMER)


@pytest.fixture(scope="module")
def provider_token():
    return _login(PROVIDER)


@pytest.fixture(scope="module")
def created_request(customer_token):
    """Create one tow request used across the suite."""
    payload = {
        "category": "tow",
        "description": "TEST_smoke service marketplace tow request",
        "city": "Berlin",
        "urgency": "urgent",
        "budget": {"min": 80, "max": 150, "currency": "EUR"},
        "contactPhone": "+49 30 TESTPHONE",
        "location": {"lat": 52.5200, "lng": 13.4050, "address": "Berlin Mitte"},
    }
    r = requests.post(f"{BASE_URL}/api/service-requests", json=payload,
                      headers=_auth(customer_token), timeout=30)
    assert r.status_code in (200, 201), f"create failed: {r.status_code} {r.text}"
    data = r.json()
    req = data.get("request") or {}
    assert req.get("id"), f"no id in response: {data}"
    assert data.get("status") == "open" or req.get("status") == "open"
    return req


# ── Regression: existing endpoints still work ────────────────────────────
class TestRegression:
    def test_health(self):
        r = requests.get(f"{BASE_URL}/api/health", timeout=15)
        assert r.status_code == 200

    def test_auth_login_admin(self):
        r = requests.post(f"{BASE_URL}/api/auth/login", json=ADMIN, timeout=20)
        assert r.status_code == 200
        body = r.json()
        assert body.get("token") or body.get("accessToken") or body.get("access_token")

    def test_cities(self):
        r = requests.get(f"{BASE_URL}/api/cities", timeout=15)
        assert r.status_code == 200, r.text


# ── Categories (public) ──────────────────────────────────────────────────
class TestCategories:
    def test_categories_public_no_auth(self):
        r = requests.get(f"{BASE_URL}/api/service-requests/categories", timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["total"] == 9
        keys = {c["key"] for c in data["categories"]}
        assert keys == {
            "repair", "tow", "wash", "detailing", "battery",
            "parts", "delivery", "inspection", "car_selection",
        }
        # Each entry has required UI fields
        for c in data["categories"]:
            assert {"key", "titleRu", "titleEn", "emoji", "minBudget", "currency"} <= set(c.keys())


# ── Customer create/list/get ─────────────────────────────────────────────
class TestCustomerCreate:
    def test_create_request_returns_open(self, created_request):
        assert created_request["status"] == "open"
        assert created_request["category"] == "tow"
        assert created_request["city"] == "berlin"  # normalised to lowercase
        # Owner-view: contactPhone должно быть видно владельцу
        assert created_request.get("contactPhone") == "+49 30 TESTPHONE"

    def test_me_lists_my_requests(self, customer_token, created_request):
        r = requests.get(f"{BASE_URL}/api/service-requests/me",
                         headers=_auth(customer_token), timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        assert any(req["id"] == created_request["id"] for req in data["requests"])

    def test_me_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/service-requests/me", timeout=15)
        assert r.status_code in (401, 403), f"guest should not list /me, got {r.status_code}"


# ── Anti-bypass: non-owner cannot see contactPhone ───────────────────────
class TestAntiBypass:
    def test_other_user_cannot_see_contact_phone(self, created_request, provider_token):
        r = requests.get(
            f"{BASE_URL}/api/service-requests/{created_request['id']}",
            headers=_auth(provider_token), timeout=15,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        req = body["request"]
        assert "contactPhone" not in req, "contactPhone должно быть скрыто от провайдера"
        assert "customerId" not in req
        assert "customerName" not in req
        assert body["isOwner"] is False

    def test_owner_sees_contact_phone(self, created_request, customer_token):
        r = requests.get(
            f"{BASE_URL}/api/service-requests/{created_request['id']}",
            headers=_auth(customer_token), timeout=15,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["isOwner"] is True
        assert body["request"].get("contactPhone") == "+49 30 TESTPHONE"


# ── Provider browse ──────────────────────────────────────────────────────
class TestProviderBrowse:
    def test_provider_can_list_open_requests(self, provider_token, created_request):
        r = requests.get(
            f"{BASE_URL}/api/provider/service-requests",
            params={"city": "berlin", "category": "tow"},
            headers=_auth(provider_token), timeout=15,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        ids = [req["id"] for req in data["requests"]]
        assert created_request["id"] in ids
        for req in data["requests"]:
            assert "customerId" not in req
            assert req["status"] in ("open", "bidding")

    def test_provider_geo_filter(self, provider_token, created_request):
        # Берлинская точка — заявка должна попасть в радиус
        r = requests.get(
            f"{BASE_URL}/api/provider/service-requests",
            params={"lat": 52.52, "lng": 13.40, "radius_km": 25},
            headers=_auth(provider_token), timeout=15,
        )
        assert r.status_code == 200
        ids = [x["id"] for x in r.json()["requests"]]
        assert created_request["id"] in ids

    def test_customer_cannot_use_provider_endpoint(self, customer_token):
        r = requests.get(
            f"{BASE_URL}/api/provider/service-requests",
            headers=_auth(customer_token), timeout=15,
        )
        assert r.status_code == 403, f"customer должен получать 403, got {r.status_code} {r.text}"


# ── Bids ─────────────────────────────────────────────────────────────────
class TestBids:
    def test_provider_below_min_budget_rejected(self, provider_token, created_request):
        # tow min = €60
        r = requests.post(
            f"{BASE_URL}/api/provider/service-requests/{created_request['id']}/bids",
            json={"price": 10, "currency": "EUR", "message": "TEST_too cheap"},
            headers=_auth(provider_token), timeout=15,
        )
        assert r.status_code == 400, r.text

    def test_provider_creates_bid(self, provider_token, created_request):
        r = requests.post(
            f"{BASE_URL}/api/provider/service-requests/{created_request['id']}/bids",
            json={"price": 95, "currency": "EUR", "message": "TEST_bid v1", "etaMinutes": 30},
            headers=_auth(provider_token), timeout=15,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("created") is True
        assert body["requestStatus"] == "bidding"
        bid = body["bid"]
        # public-projection: контакты провайдера НЕ возвращаются
        assert "providerPhone" not in bid
        assert "providerEmail" not in bid
        pytest.bid_id = bid["id"]  # type: ignore[attr-defined]

    def test_repeat_bid_updates_not_duplicates(self, provider_token, created_request):
        r = requests.post(
            f"{BASE_URL}/api/provider/service-requests/{created_request['id']}/bids",
            json={"price": 99, "currency": "EUR", "message": "TEST_bid v2"},
            headers=_auth(provider_token), timeout=15,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("updated") is True

        # bidsCount должен остаться == 1
        det = requests.get(
            f"{BASE_URL}/api/service-requests/{created_request['id']}",
            headers=_auth(provider_token), timeout=15,
        ).json()
        assert det["request"]["bidsCount"] == 1
        assert len(det["bids"]) == 1
        # Bid в публичной проекции не должен содержать провайдер-контакты
        b0 = det["bids"][0]
        assert "providerPhone" not in b0
        assert "providerEmail" not in b0

    def test_customer_cannot_bid(self, customer_token, created_request):
        r = requests.post(
            f"{BASE_URL}/api/provider/service-requests/{created_request['id']}/bids",
            json={"price": 99, "currency": "EUR", "message": "TEST_no"},
            headers=_auth(customer_token), timeout=15,
        )
        assert r.status_code == 403, r.text


# ── Accept-bid flow ──────────────────────────────────────────────────────
class TestAcceptBid:
    def test_non_owner_cannot_accept(self, provider_token, created_request):
        bid_id = getattr(pytest, "bid_id", None)
        if not bid_id:
            pytest.skip("no bid_id from previous test")
        r = requests.post(
            f"{BASE_URL}/api/service-requests/{created_request['id']}/accept-bid",
            json={"bidId": bid_id},
            headers=_auth(provider_token), timeout=15,
        )
        assert r.status_code == 403, r.text

    def test_owner_accepts_and_status_becomes_assigned(self, customer_token, created_request):
        bid_id = getattr(pytest, "bid_id", None)
        assert bid_id, "previous bid creation test must have run"
        r = requests.post(
            f"{BASE_URL}/api/service-requests/{created_request['id']}/accept-bid",
            json={"bidId": bid_id},
            headers=_auth(customer_token), timeout=15,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["request"]["status"] == "assigned"
        assert body["request"]["acceptedBidId"] == bid_id
        # После accept провайдер-контакты должны быть в payload
        bid = body["bid"]
        assert bid["status"] == "accepted"
        assert "providerEmail" in bid  # contacts opened

    def test_get_after_accept_persists_state(self, customer_token, created_request):
        r = requests.get(
            f"{BASE_URL}/api/service-requests/{created_request['id']}",
            headers=_auth(customer_token), timeout=15,
        )
        assert r.status_code == 200
        body = r.json()
        assert body["request"]["status"] == "assigned"
        assert body["request"]["acceptedBidId"]
        assert body["request"]["assignedProviderId"]


# ── Cancel flow (use a NEW request to keep state isolated) ───────────────
class TestCancel:
    @pytest.fixture(scope="class")
    def cancel_request(self, customer_token):
        payload = {
            "category": "wash",
            "description": "TEST_cancel flow request",
            "city": "Munich",
        }
        r = requests.post(f"{BASE_URL}/api/service-requests", json=payload,
                          headers=_auth(customer_token), timeout=15)
        assert r.status_code in (200, 201), r.text
        return r.json()["request"]

    def test_non_owner_cannot_cancel(self, cancel_request, provider_token):
        r = requests.post(
            f"{BASE_URL}/api/service-requests/{cancel_request['id']}/cancel",
            headers=_auth(provider_token), timeout=15,
        )
        assert r.status_code == 403, r.text

    def test_owner_cancels(self, cancel_request, customer_token):
        r = requests.post(
            f"{BASE_URL}/api/service-requests/{cancel_request['id']}/cancel",
            headers=_auth(customer_token), timeout=15,
        )
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "cancelled"

        # GET to verify persistence
        det = requests.get(
            f"{BASE_URL}/api/service-requests/{cancel_request['id']}",
            headers=_auth(customer_token), timeout=15,
        ).json()
        assert det["request"]["status"] == "cancelled"


# ── Admin endpoints ──────────────────────────────────────────────────────
class TestAdmin:
    def test_admin_list_all(self, admin_token, created_request):
        r = requests.get(
            f"{BASE_URL}/api/admin/service-requests",
            params={"category": "tow"},
            headers=_auth(admin_token), timeout=15,
        )
        assert r.status_code == 200, r.text
        ids = [req["id"] for req in r.json()["requests"]]
        assert created_request["id"] in ids

    def test_admin_filter_has_bids(self, admin_token, created_request):
        r = requests.get(
            f"{BASE_URL}/api/admin/service-requests",
            params={"has_bids": "true"},
            headers=_auth(admin_token), timeout=15,
        )
        assert r.status_code == 200
        for req in r.json()["requests"]:
            assert req["bidsCount"] >= 1

    def test_admin_stats(self, admin_token):
        r = requests.get(f"{BASE_URL}/api/admin/service-requests/stats",
                         headers=_auth(admin_token), timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        for key in ("byStatus", "byCategory", "gmv", "avgCommissionPct",
                    "categories", "platformRevenue"):
            assert key in data, f"missing {key}: {list(data.keys())}"
        assert isinstance(data["byStatus"], dict)
        assert isinstance(data["byCategory"], dict)

    def test_admin_non_admin_blocked(self, customer_token):
        r = requests.get(f"{BASE_URL}/api/admin/service-requests",
                         headers=_auth(customer_token), timeout=15)
        assert r.status_code in (401, 403), r.text

    def test_admin_manual_assign(self, admin_token, customer_token):
        # Create fresh request
        r = requests.post(
            f"{BASE_URL}/api/service-requests",
            json={"category": "battery", "description": "TEST_manual assign", "city": "Hamburg"},
            headers=_auth(customer_token), timeout=15,
        )
        assert r.status_code in (200, 201), r.text
        req_id = r.json()["request"]["id"]

        r2 = requests.post(
            f"{BASE_URL}/api/admin/service-requests/{req_id}/assign",
            json={"providerId": "manual-provider-001", "note": "TEST_manual"},
            headers=_auth(admin_token), timeout=15,
        )
        assert r2.status_code == 200, r2.text
        body = r2.json()
        assert body["status"] == "assigned"
        assert body["bid"]["providerId"] == "manual-provider-001"

        # Verify persisted via admin GET
        det = requests.get(
            f"{BASE_URL}/api/admin/service-requests/{req_id}",
            headers=_auth(admin_token), timeout=15,
        ).json()
        assert det["request"]["status"] == "assigned"
        assert det["request"]["assignedProviderId"] == "manual-provider-001"
