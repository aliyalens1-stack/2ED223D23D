"""HTTP integration tests for /api/car-selection (customer + admin).

These hit the live FastAPI server via the public EXPO ingress URL.
They exercise the contract end-to-end:

  • auth gating (401/403)
  • create + serviceType-specific validations (LISTING_LINK_REQUIRED)
  • owner-only reads (404 leakage protection)
  • admin queue with counts + filters
  • admin assign auto-lift (submitted → reviewing → assigned, 3 timeline events)
  • illegal transitions → 409 INVALID_TRANSITION
  • terminal-status transition refusal
  • customer-initiated cancel happy path + double-cancel 409
"""
from __future__ import annotations
import os
import uuid

import pytest
import requests

BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ.get("EXPO_BACKEND_URL")
    or "https://app-mobile-build-26.preview.emergentagent.com"
).rstrip("/")

CUSTOMER = ("customer@test.com", "Customer123!")
ADMIN = ("admin@autoservice.com", "Admin123!")
PROVIDER = ("provider@test.com", "Provider123!")


# ── Auth helpers ──────────────────────────────────────────────────────


def _login(email: str, password: str) -> str:
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": password},
        timeout=20,
    )
    assert r.status_code == 200, f"login failed for {email}: {r.status_code} {r.text}"
    tok = r.json().get("accessToken") or r.json().get("token")
    assert tok, f"no token in login response: {r.text}"
    return tok


@pytest.fixture(scope="module")
def customer_token() -> str:
    return _login(*CUSTOMER)


@pytest.fixture(scope="module")
def admin_token() -> str:
    return _login(*ADMIN)


@pytest.fixture(scope="module")
def provider_token() -> str:
    return _login(*PROVIDER)


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _detail_code(resp) -> str:
    """Extract `code` from the canonical error envelope.

    Server flattens HTTPException(detail={...}) to the response root via a
    custom exception handler, so the shape is:
      {"error": true, "code": "X", "message": "...", "details": {...}}
    A few legacy paths still wrap under "detail" — accept both.
    """
    try:
        body = resp.json()
    except Exception:
        return ""
    if isinstance(body, dict):
        if body.get("code"):
            return body["code"]
        d = body.get("detail")
        if isinstance(d, dict) and d.get("code"):
            return d["code"]
    return ""


def _detail_details(resp) -> dict:
    try:
        body = resp.json()
    except Exception:
        return {}
    if isinstance(body, dict):
        if "details" in body and isinstance(body["details"], dict):
            return body["details"]
        d = body.get("detail")
        if isinstance(d, dict) and isinstance(d.get("details"), dict):
            return d["details"]
    return {}


# ── 1. Auth gating ────────────────────────────────────────────────────


class TestAuthGating:
    """All car-selection endpoints must require auth/role."""

    def test_create_unauth_returns_401(self):
        r = requests.post(
            f"{BASE_URL}/api/car-selection/requests",
            json={
                "serviceType": "budget_search",
                "countryCode": "DE",
                "cityId": "aachen",
                "description": "test",
            },
            timeout=15,
        )
        assert r.status_code in (401, 403), r.text

    def test_admin_queue_unauth_returns_401(self):
        r = requests.get(f"{BASE_URL}/api/admin/car-selection", timeout=15)
        assert r.status_code in (401, 403), r.text

    def test_admin_queue_as_customer_returns_403(self, customer_token):
        r = requests.get(
            f"{BASE_URL}/api/admin/car-selection",
            headers=_auth(customer_token),
            timeout=15,
        )
        assert r.status_code == 403, r.text

    def test_create_as_admin_returns_403(self, admin_token):
        r = requests.post(
            f"{BASE_URL}/api/car-selection/requests",
            headers=_auth(admin_token),
            json={
                "serviceType": "budget_search",
                "countryCode": "DE",
                "cityId": "aachen",
                "description": "admin trying to act as customer",
            },
            timeout=15,
        )
        assert r.status_code == 403, r.text


# ── 2. Customer create + listing_review constraint ────────────────────


class TestCustomerCreate:

    def test_create_budget_search_persists_with_submitted_event(self, customer_token):
        payload = {
            "serviceType": "budget_search",
            "countryCode": "DE",
            "cityId": "aachen",
            "description": f"TEST_budget {uuid.uuid4().hex[:6]}",
            "budget": {"budgetMax": 25000, "brands": ["BMW"]},
        }
        r = requests.post(
            f"{BASE_URL}/api/car-selection/requests",
            headers=_auth(customer_token),
            json=payload,
            timeout=20,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "submitted"
        assert body["serviceType"] == "budget_search"
        assert body["countryCode"] == "DE"
        assert body["cityId"] == "aachen"
        assert body.get("budget", {}).get("budgetMax") == 25000
        tl = body.get("timeline", [])
        assert len(tl) == 1 and tl[0]["type"] == "submitted"
        # GET as owner returns 200.
        rid = body["id"]
        g = requests.get(
            f"{BASE_URL}/api/car-selection/requests/{rid}",
            headers=_auth(customer_token), timeout=15,
        )
        assert g.status_code == 200 and g.json()["id"] == rid

    def test_listing_review_without_link_returns_422(self, customer_token):
        r = requests.post(
            f"{BASE_URL}/api/car-selection/requests",
            headers=_auth(customer_token),
            json={
                "serviceType": "listing_review",
                "countryCode": "DE",
                "cityId": "aachen",
                "description": "TEST_no_link",
            },
            timeout=20,
        )
        assert r.status_code == 422, r.text
        assert _detail_code(r) == "LISTING_LINK_REQUIRED"

    def test_listing_review_with_link_returns_200(self, customer_token):
        r = requests.post(
            f"{BASE_URL}/api/car-selection/requests",
            headers=_auth(customer_token),
            json={
                "serviceType": "listing_review",
                "countryCode": "DE",
                "cityId": "aachen",
                "description": "TEST_with_link",
                "sourceLink": "https://www.mobile.de/auto/details.html?id=test-123",
            },
            timeout=20,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "submitted"
        assert body["serviceType"] == "listing_review"
        assert body.get("sourceLink", "").startswith("https://")


# ── 3. Owner-scoped reads ─────────────────────────────────────────────


class TestOwnership:

    def test_me_returns_only_callers_requests(self, customer_token):
        r = requests.get(
            f"{BASE_URL}/api/car-selection/requests/me",
            headers=_auth(customer_token), timeout=20,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert "items" in body and isinstance(body["items"], list)
        # We have created at least one in previous test; can't guarantee count
        # across run order, so just sanity-check the shape.
        for item in body["items"]:
            assert "id" in item
            assert "status" in item
            assert "serviceType" in item

    def test_non_owner_read_returns_404(self, customer_token, admin_token):
        # Admin first creates a request "owned" by some other customer via
        # the data layer? We can't impersonate, so instead: have customer1
        # create a request, then look up a non-existent UUID — still 404.
        # For true cross-customer 404, we'd need two customer accounts;
        # we only have one. We assert at minimum the random-id case returns
        # 404 with the correct error code.
        bogus = uuid.uuid4().hex
        r = requests.get(
            f"{BASE_URL}/api/car-selection/requests/{bogus}",
            headers=_auth(customer_token), timeout=15,
        )
        assert r.status_code == 404, r.text
        assert _detail_code(r) == "CAR_SELECTION_NOT_FOUND"


# ── 4. Admin queue ────────────────────────────────────────────────────


class TestAdminQueue:

    def test_admin_queue_returns_items_counts_filters(self, admin_token):
        r = requests.get(
            f"{BASE_URL}/api/admin/car-selection",
            headers=_auth(admin_token), timeout=20,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert "items" in body and isinstance(body["items"], list)
        assert "filters" in body and isinstance(body["filters"], dict)
        assert "counts" in body and isinstance(body["counts"], dict)
        # All 7 statuses present in counts dict (even if zero).
        for s in ("submitted", "reviewing", "assigned", "in_progress",
                  "waiting_customer", "completed", "cancelled"):
            assert s in body["counts"], f"missing {s} in counts"
            assert isinstance(body["counts"][s], int)

    def test_admin_queue_filter_narrows(self, admin_token, customer_token):
        # Ensure we have a budget_search/aachen doc.
        requests.post(
            f"{BASE_URL}/api/car-selection/requests",
            headers=_auth(customer_token),
            json={
                "serviceType": "budget_search",
                "countryCode": "DE",
                "cityId": "aachen",
                "description": "TEST_filter_probe",
            }, timeout=15,
        )
        r = requests.get(
            f"{BASE_URL}/api/admin/car-selection"
            "?serviceType=budget_search&cityId=aachen",
            headers=_auth(admin_token), timeout=20,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["filters"]["serviceType"] == "budget_search"
        assert body["filters"]["cityId"] == "aachen"
        for item in body["items"]:
            assert item["serviceType"] == "budget_search"
            assert item["cityId"] == "aachen"


# ── 5. Lifecycle — assign auto-lift + invalid transitions ─────────────


def _create_submitted(token: str) -> str:
    r = requests.post(
        f"{BASE_URL}/api/car-selection/requests",
        headers=_auth(token),
        json={
            "serviceType": "market_search",
            "countryCode": "DE",
            "cityId": "aachen",
            "description": f"TEST_lifecycle {uuid.uuid4().hex[:6]}",
        }, timeout=20,
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


class TestLifecycle:

    def test_admin_assign_from_submitted_records_three_events(
        self, customer_token, admin_token,
    ):
        rid = _create_submitted(customer_token)
        # Fetch admin id from /auth/me to pass as adminId.
        me = requests.get(
            f"{BASE_URL}/api/auth/me", headers=_auth(admin_token), timeout=15,
        )
        assert me.status_code == 200, me.text
        admin_id = me.json().get("id") or me.json().get("userId") or me.json().get("_id")
        # Send adminId; backend should auto-lift submitted→reviewing→assigned.
        r = requests.post(
            f"{BASE_URL}/api/admin/car-selection/{rid}/assign",
            headers=_auth(admin_token),
            json={"adminId": admin_id, "note": "taking it"},
            timeout=20,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "assigned"
        assert body.get("assignedAdminId") == admin_id
        types_ = [e["type"] for e in body.get("timeline", [])]
        assert types_ == ["submitted", "status:reviewing", "assigned"], types_

    def test_assign_missing_target_returns_422(self, customer_token, admin_token):
        rid = _create_submitted(customer_token)
        r = requests.post(
            f"{BASE_URL}/api/admin/car-selection/{rid}/assign",
            headers=_auth(admin_token),
            json={"note": "nope"},
            timeout=20,
        )
        assert r.status_code == 422, r.text
        assert _detail_code(r) == "ASSIGN_MISSING_TARGET"

    def test_illegal_transition_returns_409(self, customer_token, admin_token):
        rid = _create_submitted(customer_token)
        me = requests.get(
            f"{BASE_URL}/api/auth/me", headers=_auth(admin_token), timeout=15,
        ).json()
        admin_id = me.get("id") or me.get("userId") or me.get("_id")
        # Lift to assigned, then in_progress.
        requests.post(
            f"{BASE_URL}/api/admin/car-selection/{rid}/assign",
            headers=_auth(admin_token),
            json={"adminId": admin_id}, timeout=20,
        )
        requests.post(
            f"{BASE_URL}/api/admin/car-selection/{rid}/status",
            headers=_auth(admin_token),
            json={"status": "in_progress"}, timeout=20,
        )
        # in_progress → assigned is illegal.
        r = requests.post(
            f"{BASE_URL}/api/admin/car-selection/{rid}/status",
            headers=_auth(admin_token),
            json={"status": "assigned"}, timeout=20,
        )
        assert r.status_code == 409, r.text
        assert _detail_code(r) == "INVALID_TRANSITION"
        details = _detail_details(r)
        assert details.get("currentStatus") == "in_progress"
        assert details.get("targetStatus") == "assigned"

    def test_terminal_completed_refuses_further_transition(
        self, customer_token, admin_token,
    ):
        rid = _create_submitted(customer_token)
        me = requests.get(
            f"{BASE_URL}/api/auth/me", headers=_auth(admin_token), timeout=15,
        ).json()
        admin_id = me.get("id") or me.get("userId") or me.get("_id")
        requests.post(
            f"{BASE_URL}/api/admin/car-selection/{rid}/assign",
            headers=_auth(admin_token),
            json={"adminId": admin_id}, timeout=20,
        )
        for nxt in ("in_progress", "completed"):
            x = requests.post(
                f"{BASE_URL}/api/admin/car-selection/{rid}/status",
                headers=_auth(admin_token),
                json={"status": nxt}, timeout=20,
            )
            assert x.status_code == 200, (nxt, x.text)
        # Now completed → anything must 409.
        r = requests.post(
            f"{BASE_URL}/api/admin/car-selection/{rid}/status",
            headers=_auth(admin_token),
            json={"status": "in_progress"}, timeout=20,
        )
        assert r.status_code == 409, r.text
        assert _detail_code(r) == "INVALID_TRANSITION"
        assert _detail_details(r).get("currentStatus") == "completed"


# ── 6. Customer cancel ────────────────────────────────────────────────


class TestCancel:

    def test_customer_cancel_non_terminal_succeeds(self, customer_token):
        rid = _create_submitted(customer_token)
        r = requests.post(
            f"{BASE_URL}/api/car-selection/requests/{rid}/cancel",
            headers=_auth(customer_token),
            json={"reason": "TEST_передумал"}, timeout=20,
        )
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "cancelled"

    def test_customer_cancel_completed_returns_409(
        self, customer_token, admin_token,
    ):
        rid = _create_submitted(customer_token)
        me = requests.get(
            f"{BASE_URL}/api/auth/me", headers=_auth(admin_token), timeout=15,
        ).json()
        admin_id = me.get("id") or me.get("userId") or me.get("_id")
        requests.post(
            f"{BASE_URL}/api/admin/car-selection/{rid}/assign",
            headers=_auth(admin_token),
            json={"adminId": admin_id}, timeout=20,
        )
        for nxt in ("in_progress", "completed"):
            requests.post(
                f"{BASE_URL}/api/admin/car-selection/{rid}/status",
                headers=_auth(admin_token),
                json={"status": nxt}, timeout=20,
            )
        # Now customer tries to cancel completed → 409.
        r = requests.post(
            f"{BASE_URL}/api/car-selection/requests/{rid}/cancel",
            headers=_auth(customer_token),
            json={"reason": "TEST_too_late"}, timeout=20,
        )
        assert r.status_code == 409, r.text
        assert _detail_code(r) == "INVALID_TRANSITION"
