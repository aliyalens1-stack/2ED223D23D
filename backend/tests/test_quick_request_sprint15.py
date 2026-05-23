"""Sprint 15 — Realtime Quick-Request Auto-Distribution backend tests.

Covers:
- POST /api/quick-request/resolve
- GET  /api/quick-request/{id}
- GET  /api/quick-request/inbox/{providerSlug}
- POST /api/quick-request/{id}/accept (atomic, conflict)
- POST /api/quick-request/{id}/reject
- Auto-expire via timeout
- Existing endpoints remain green
"""
import os
import time
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8001").rstrip("/")
TIMEOUT = 30


# ─── Module-level state shared between tests ────────────────────────
_state = {}


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ─── Existing endpoints regression ──────────────────────────────────
class TestExistingEndpoints:
    def test_health(self, session):
        r = session.get(f"{BASE_URL}/api/health", timeout=TIMEOUT)
        assert r.status_code == 200, r.text

    def test_marketplace_providers(self, session):
        r = session.get(f"{BASE_URL}/api/marketplace/providers", timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        data = r.json()
        # Must have providers list to drive top-3 distribution
        assert "providers" in data or isinstance(data, list)

    def test_marketplace_stats(self, session):
        r = session.get(f"{BASE_URL}/api/marketplace/stats", timeout=TIMEOUT)
        assert r.status_code == 200, r.text

    def test_zones(self, session):
        r = session.get(f"{BASE_URL}/api/zones", timeout=TIMEOUT)
        assert r.status_code == 200, r.text


# ─── POST /api/quick-request/resolve ────────────────────────────────
class TestQuickRequestResolve:
    def test_resolve_returns_search_payload(self, session):
        r = session.post(
            f"{BASE_URL}/api/quick-request/resolve",
            json={"text": "car wont start", "location": {"lat": 50.4501, "lng": 30.5234}},
            timeout=TIMEOUT,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        # Sprint 15 contract
        assert "requestId" in data and isinstance(data["requestId"], str)
        assert data.get("status") == "searching"
        assert data.get("expiresInSec") == 60
        assert isinstance(data.get("targetProviders"), list)
        assert len(data["targetProviders"]) <= 3
        assert isinstance(data.get("solutions"), list)
        assert len(data["solutions"]) <= 5
        # Save for next tests
        _state["request_id"] = data["requestId"]
        _state["targets"] = data["targetProviders"]
        _state["solutions"] = data["solutions"]

    def test_resolve_payload_has_problem_classification(self, session):
        r = session.post(
            f"{BASE_URL}/api/quick-request/resolve",
            json={"text": "battery is dead"},
            timeout=TIMEOUT,
        )
        assert r.status_code == 200
        data = r.json()
        assert "problemType" in data
        assert "problemLabel" in data


# ─── GET /api/quick-request/{id} ────────────────────────────────────
class TestQuickRequestStatus:
    def test_status_returns_searching_with_seconds_left(self, session):
        rid = _state.get("request_id")
        if not rid:
            pytest.skip("resolve not run")
        r = session.get(f"{BASE_URL}/api/quick-request/{rid}", timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["requestId"] == rid
        assert d["status"] in ("searching", "assigned")
        assert "secondsLeft" in d
        assert isinstance(d["secondsLeft"], int)
        if d["status"] == "searching":
            assert d["secondsLeft"] > 0

    def test_status_404_for_unknown_id(self, session):
        r = session.get(f"{BASE_URL}/api/quick-request/does-not-exist-xyz", timeout=TIMEOUT)
        assert r.status_code == 404


# ─── GET /api/quick-request/inbox/{providerSlug} ────────────────────
class TestProviderInbox:
    def test_inbox_shows_pending_offer(self, session):
        targets = _state.get("targets") or []
        if not targets:
            pytest.skip("no targets from resolve")
        slug = targets[0]
        r = session.get(f"{BASE_URL}/api/quick-request/inbox/{slug}", timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        d = r.json()
        assert "items" in d and "count" in d
        # Our request should be visible to top-3 providers
        rids = [it["requestId"] for it in d["items"]]
        assert _state["request_id"] in rids, f"request {_state['request_id']} not in inbox of {slug}: {rids}"
        # Item shape
        item = next(it for it in d["items"] if it["requestId"] == _state["request_id"])
        assert "problemLabel" in item
        assert "secondsLeft" in item and item["secondsLeft"] > 0
        assert "priceEstimate" in item

    def test_inbox_empty_for_unknown_provider(self, session):
        r = session.get(f"{BASE_URL}/api/quick-request/inbox/__nonexistent__", timeout=TIMEOUT)
        assert r.status_code == 200
        assert r.json().get("count", 0) == 0


# ─── POST /accept (atomic) ──────────────────────────────────────────
class TestAcceptAtomic:
    def test_first_accept_wins_creates_booking(self, session):
        # Fresh request to avoid coupling
        r = session.post(
            f"{BASE_URL}/api/quick-request/resolve",
            json={"text": "car wont start"},
            timeout=TIMEOUT,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        rid = data["requestId"]
        targets = data["targetProviders"]
        if len(targets) < 2:
            pytest.skip("need >=2 target providers for conflict test")

        # First provider accepts
        r1 = session.post(
            f"{BASE_URL}/api/quick-request/{rid}/accept",
            json={"providerSlug": targets[0]},
            timeout=TIMEOUT,
        )
        assert r1.status_code == 200, r1.text
        d1 = r1.json()
        assert d1.get("success") is True
        assert d1.get("status") == "assigned"
        booking_id = d1.get("bookingId")
        assert booking_id

        # Second provider gets 409
        r2 = session.post(
            f"{BASE_URL}/api/quick-request/{rid}/accept",
            json={"providerSlug": targets[1]},
            timeout=TIMEOUT,
        )
        assert r2.status_code == 409, r2.text
        assert "taken" in r2.text.lower() or "assigned" in r2.text.lower()

        # GET status reflects assigned + bookingId
        r3 = session.get(f"{BASE_URL}/api/quick-request/{rid}", timeout=TIMEOUT)
        assert r3.status_code == 200
        d3 = r3.json()
        assert d3["status"] == "assigned"
        assert d3["bookingId"] == booking_id
        assert d3["providerId"] == targets[0]

        _state["assigned_request_id"] = rid
        _state["booking_id"] = booking_id


# ─── POST /reject ───────────────────────────────────────────────────
class TestReject:
    def test_reject_keeps_request_searching(self, session):
        r = session.post(
            f"{BASE_URL}/api/quick-request/resolve",
            json={"text": "car wont start"},
            timeout=TIMEOUT,
        )
        rid = r.json()["requestId"]
        targets = r.json()["targetProviders"]
        if not targets:
            pytest.skip("no targets")
        r1 = session.post(
            f"{BASE_URL}/api/quick-request/{rid}/reject",
            json={"providerSlug": targets[0]},
            timeout=TIMEOUT,
        )
        assert r1.status_code == 200
        assert r1.json().get("success") is True
        # Status should still be searching
        r2 = session.get(f"{BASE_URL}/api/quick-request/{rid}", timeout=TIMEOUT)
        assert r2.json()["status"] == "searching"
        # Inbox of the rejecting provider should NOT include this request
        r3 = session.get(f"{BASE_URL}/api/quick-request/inbox/{targets[0]}", timeout=TIMEOUT)
        rids = [it["requestId"] for it in r3.json()["items"]]
        assert rid not in rids


# ─── Auto-expire (60s) — too slow for normal CI; run as opt-in ──────
@pytest.mark.slow
class TestAutoExpire:
    def test_auto_expire_after_timeout(self, session):
        if os.environ.get("RUN_SLOW") != "1":
            pytest.skip("set RUN_SLOW=1 to run 60s expiry test")
        r = session.post(
            f"{BASE_URL}/api/quick-request/resolve",
            json={"text": "ac not cooling"},
            timeout=TIMEOUT,
        )
        rid = r.json()["requestId"]
        time.sleep(63)
        r2 = session.get(f"{BASE_URL}/api/quick-request/{rid}", timeout=TIMEOUT)
        d = r2.json()
        assert d["status"] == "expired"
        assert d["secondsLeft"] == 0
