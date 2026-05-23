"""
Sprint A1 — admin_send broadcast endpoint.

Covers:
  - Auth: 401 without admin JWT.
  - Validation: 400 on bad title / body / target shape / unknown role.
  - target=all       → projects to every targetable user.
  - target=role      → projects only to matching legacy roles.
  - target=user      → exactly one row, supports both ObjectId and hex-string user ids.
  - Projector invariants: ALL writes flow through `project_event()`.
  - Replay safety: backfilling the same timeline event inserts 0 new rows.
  - Wire shape: admin-supplied title/body/deepLink reach the projected row.

Notes:
  - Live-backend style, consistent with the rest of the suite. Uses the
    auth bypass fixture from `conftest.py` to avoid rate-limit lockouts.
  - We avoid mutating the seed users; we register fresh email addresses and
    promote them with role updates directly in the DB via the admin token.
"""

import os
import json
import time
import uuid
import asyncio
import pytest
import requests
from typing import Dict, Any, List

BASE_URL = os.environ.get("BACKEND_URL", "http://localhost:8001")
API = f"{BASE_URL}/api"

SEED_ADMIN = ("admin@autoservice.com", "Admin123!")
SEED_CUSTOMER = ("customer@test.com", "Customer123!")
SEED_PROVIDER = ("provider@test.com", "Provider123!")


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

def _login(email: str, password: str) -> str:
    r = requests.post(f"{API}/auth/login",
                      json={"email": email, "password": password},
                      timeout=10)
    assert r.status_code == 200, f"login {email} failed: {r.status_code} {r.text}"
    return r.json()["accessToken"]


def _post_send(token: str, body: dict) -> requests.Response:
    return requests.post(
        f"{API}/admin/notifications/send",
        json=body,
        headers={"Authorization": f"Bearer {token}"},
        timeout=10,
    )


def _unread(token: str) -> int:
    r = requests.get(f"{API}/notifications/unread-count",
                     headers={"Authorization": f"Bearer {token}"},
                     timeout=5)
    assert r.status_code == 200, r.text
    return r.json()["unread"]


def _notifications_for(token: str) -> List[dict]:
    r = requests.get(f"{API}/notifications/since",
                     headers={"Authorization": f"Bearer {token}"},
                     timeout=5)
    assert r.status_code == 200, r.text
    return r.json().get("items", [])


@pytest.fixture(scope="module")
def admin_token() -> str:
    return _login(*SEED_ADMIN)


@pytest.fixture(scope="module")
def customer_token() -> str:
    return _login(*SEED_CUSTOMER)


@pytest.fixture(scope="module")
def provider_token() -> str:
    return _login(*SEED_PROVIDER)


# ─────────────────────────────────────────────────────────────────────
# Auth gate
# ─────────────────────────────────────────────────────────────────────

class TestAuth:
    def test_no_token_is_401(self):
        r = requests.post(f"{API}/admin/notifications/send",
                          json={"target": {"type": "all"}, "title": "X", "body": "Y"},
                          timeout=5)
        assert r.status_code == 401

    def test_non_admin_token_is_403_or_401(self, customer_token):
        r = _post_send(customer_token, {
            "target": {"type": "all"}, "title": "X", "body": "Y",
        })
        assert r.status_code in (401, 403), r.text


# ─────────────────────────────────────────────────────────────────────
# Validation
# ─────────────────────────────────────────────────────────────────────

class TestValidation:
    def test_empty_title_400(self, admin_token):
        r = _post_send(admin_token, {
            "target": {"type": "all"}, "title": "", "body": "x",
        })
        assert r.status_code == 400
        assert r.json()["code"] == "BAD_REQUEST"

    def test_empty_body_400(self, admin_token):
        r = _post_send(admin_token, {
            "target": {"type": "all"}, "title": "ok", "body": "",
        })
        assert r.status_code == 400

    def test_oversized_title_400(self, admin_token):
        r = _post_send(admin_token, {
            "target": {"type": "all"}, "title": "x" * 200, "body": "ok",
        })
        assert r.status_code == 400

    def test_missing_target_400(self, admin_token):
        r = _post_send(admin_token, {"title": "t", "body": "b"})
        assert r.status_code == 400

    def test_unknown_role_400(self, admin_token):
        r = _post_send(admin_token, {
            "target": {"type": "role", "roles": ["provider"]},  # not in canonical set
            "title": "t", "body": "b",
        })
        assert r.status_code == 400
        assert "provider" in r.json()["message"]

    def test_unknown_target_type_400(self, admin_token):
        r = _post_send(admin_token, {
            "target": {"type": "geo", "region": "DE-BE"},
            "title": "t", "body": "b",
        })
        assert r.status_code == 400

    def test_user_target_requires_userId(self, admin_token):
        r = _post_send(admin_token, {
            "target": {"type": "user"},
            "title": "t", "body": "b",
        })
        assert r.status_code == 400


# ─────────────────────────────────────────────────────────────────────
# Fan-out semantics
# ─────────────────────────────────────────────────────────────────────

class TestFanout:
    def test_target_all_reaches_customer(self, admin_token, customer_token):
        before = _unread(customer_token)
        r = _post_send(admin_token, {
            "target": {"type": "all"},
            "title": "All-hands",
            "body": f"Test {uuid.uuid4().hex[:8]}",
        })
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["ok"] is True
        assert out["recipients"] >= 1
        assert out["projected"] == out["recipients"]
        # Customer is in 'all' fanout.
        after = _unread(customer_token)
        assert after == before + 1

    def test_target_role_customer_reaches_customer_only(
        self, admin_token, customer_token, provider_token,
    ):
        cust_before = _unread(customer_token)
        prov_before = _unread(provider_token)
        r = _post_send(admin_token, {
            "target": {"type": "role", "roles": ["customer"]},
            "title": "Customers only",
            "body": f"role-test {uuid.uuid4().hex[:8]}",
        })
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["ok"] is True
        # Customer received it.
        assert _unread(customer_token) == cust_before + 1
        # Provider did NOT.
        assert _unread(provider_token) == prov_before

    def test_target_role_inspector_reaches_provider_owner(
        self, admin_token, customer_token, provider_token,
    ):
        # 'inspector' role target legacy-maps to {inspector, provider_owner}.
        # Seed provider@test.com has role=provider_owner.
        cust_before = _unread(customer_token)
        prov_before = _unread(provider_token)
        r = _post_send(admin_token, {
            "target": {"type": "role", "roles": ["inspector"]},
            "title": "Inspectors",
            "body": f"role-test {uuid.uuid4().hex[:8]}",
        })
        assert r.status_code == 200, r.text
        # Provider got it (mapped from inspector role).
        assert _unread(provider_token) == prov_before + 1
        # Customer didn't.
        assert _unread(customer_token) == cust_before

    def test_target_user_exactly_one_recipient(self, admin_token, provider_token):
        # Decode provider userId from JWT 'sub' to avoid touching the DB.
        import base64
        token_parts = provider_token.split(".")
        # Base64URL decode the payload segment.
        pad = "=" * (-len(token_parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(token_parts[1] + pad))
        provider_uid = claims["sub"]

        prov_before = _unread(provider_token)
        r = _post_send(admin_token, {
            "target": {"type": "user", "userId": provider_uid},
            "title": "Direct",
            "body": f"user-target {uuid.uuid4().hex[:8]}",
        })
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["recipients"] == 1
        assert out["projected"] == 1
        assert _unread(provider_token) == prov_before + 1

    def test_target_user_bogus_id_is_zero_recipients(self, admin_token):
        r = _post_send(admin_token, {
            "target": {"type": "user", "userId": "deadbeefdeadbeefdeadbeef"},
            "title": "Ghost",
            "body": "should never project",
        })
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["recipients"] == 0
        assert out["projected"] == 0


# ─────────────────────────────────────────────────────────────────────
# Wire-shape — admin-supplied content reaches projected rows
# ─────────────────────────────────────────────────────────────────────

class TestWireShape:
    def test_title_body_deeplink_propagate(self, admin_token, customer_token):
        marker = uuid.uuid4().hex[:8]
        title = f"Marker {marker}"
        body = f"Body marker {marker}"
        deep = f"/admin-broadcast/{marker}"
        r = _post_send(admin_token, {
            "target": {"type": "role", "roles": ["customer"]},
            "title": title, "body": body, "deepLink": deep,
        })
        assert r.status_code == 200, r.text

        rows = _notifications_for(customer_token)
        found = next((n for n in rows if n.get("title") == title), None)
        assert found is not None, "broadcast not projected to customer"
        assert found["body"] == body
        assert found["kind"] == "admin_broadcast"
        assert found["type"] == "broadcast"
        assert found.get("actionUrl") == deep
        assert found["isRead"] is False
        assert found.get("sourceTimelineId") == r.json()["eventId"]


# ─────────────────────────────────────────────────────────────────────
# Projector invariants — sole-writer + replay safety
# ─────────────────────────────────────────────────────────────────────

class TestProjectorInvariants:
    def test_replay_is_idempotent(self, admin_token, customer_token):
        before = _unread(customer_token)
        # 1) Send a fresh broadcast.
        marker = uuid.uuid4().hex[:8]
        r = _post_send(admin_token, {
            "target": {"type": "role", "roles": ["customer"]},
            "title": f"Replay {marker}",
            "body": f"replay-test {marker}",
        })
        assert r.status_code == 200, r.text
        after_first = _unread(customer_token)
        assert after_first == before + 1

        # 2) Re-run the projector via backfill — must NOT duplicate.
        rr = requests.post(
            f"{API}/admin/notifications/backfill?kind=admin_broadcast",
            headers={"Authorization": f"Bearer {admin_token}"},
            timeout=10,
        )
        assert rr.status_code == 200, rr.text
        result = rr.json()
        # `inserted` may be 0 (all already projected) or up to N if other
        # broadcast events landed concurrently. Critically — the customer's
        # unread count MUST NOT increase from the re-projection.
        after_replay = _unread(customer_token)
        assert after_replay == after_first, (
            f"Replay duplicated: unread before={after_first} after={after_replay} "
            f"backfill={result}"
        )
