"""Sprint 1D.1 — Inspector Auto Requests Capability Gate tests.

Validates:
- Capability gate on /api/inspector/* (401 unauth, 403 customer/admin, 200 provider)
- Dual-write of inspectorAccountId alongside inspectorId in inspection_jobs
- Ownership still enforced by service layer (inspectorId)
- Smoke tests for Sprint 1C endpoints + biz domain endpoints
"""
from __future__ import annotations
import os
import uuid
from datetime import datetime, timezone

import time
import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8001").rstrip("/")
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

ADMIN_EMAIL = "admin@autoservice.com"
ADMIN_PASS = "Admin123!"


# ── Helpers ──────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def db():
    client = MongoClient(MONGO_URL)
    return client[DB_NAME]


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


def _tok(body):
    """Token field can be 'accessToken' (current) or 'token' (legacy)."""
    return body.get("accessToken") or body.get("token")


def _login(s, email, password):
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, f"login failed for {email}: {r.status_code} {r.text}"
    t = _tok(r.json())
    assert t, f"no token in login response: {r.json()}"
    return t


def _register(s, role, retries=4):
    email = f"TEST_1d1_{uuid.uuid4().hex[:8]}@example.com"
    payload = {"email": email, "password": "test1234", "role": role,
               "firstName": "T", "lastName": "U"}
    last = None
    for i in range(retries):
        r = s.post(f"{BASE_URL}/api/auth/register", json=payload)
        last = r
        if r.status_code in (200, 201):
            body = r.json()
            t = _tok(body)
            assert t, f"no token in register response: {body}"
            return t, body.get("user", {}), email
        if r.status_code == 429:
            try:
                retry = int(r.json().get("details", {}).get("retryAfter", 30))
            except Exception:
                retry = 30
            time.sleep(min(retry + 1, 65))
            continue
        break
    raise AssertionError(f"register {role} failed after retries: {last.status_code} {last.text}")


# Module-level cached registrations to avoid burning rate limit (5/min)
_CACHE: dict = {}


def _get_or_register(s, role, key="default"):
    ck = (role, key)
    if ck in _CACHE:
        return _CACHE[ck]
    _CACHE[ck] = _register(s, role)
    return _CACHE[ck]


def _me(s, token):
    r = s.get(f"{BASE_URL}/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, f"/auth/me failed: {r.text}"
    return r.json()


def _seed_job(db, city="Berlin", customer_id="seed-customer"):
    req_id = str(uuid.uuid4())
    job_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    db.car_requests.insert_one({
        "_id": req_id, "userId": customer_id, "type": "inspection",
        "city": city, "cities": [city], "country": "DE",
        "brand": "BMW", "model": "X5", "budget": 30000,
        "links": ["https://example.com/car/1"], "status": "open",
        "jobsTotal": 1, "jobsClaimed": 0, "jobsDone": 0,
        "createdAt": now, "updatedAt": now,
    })
    db.inspection_jobs.insert_one({
        "_id": job_id, "requestId": req_id, "city": city, "country": "DE",
        "type": "inspection", "inspectorId": None, "status": "open",
        "brand": "BMW", "model": "X5", "budget": 30000,
        "links": ["https://example.com/car/1"], "createdAt": now,
    })
    return req_id, job_id


# Endpoints that must be 403 for authenticated customer (lacks 'inspect' cap)
GATED_ENDPOINTS = [
    ("GET", "/api/inspector/jobs"),
    ("GET", "/api/inspector/jobs/my"),
    ("GET", "/api/inspector/jobs/some-id"),
    ("POST", "/api/inspector/jobs/some-id/claim"),
    ("POST", "/api/inspector/jobs/some-id/on-route"),
    ("POST", "/api/inspector/jobs/some-id/arrived"),
    ("POST", "/api/inspector/jobs/some-id/start-inspection"),
    ("POST", "/api/inspector/jobs/some-id/cancel"),
    ("POST", "/api/inspector/jobs/some-id/report"),
    ("POST", "/api/inspector/jobs/some-id/complete"),
    ("GET", "/api/inspector/checklist"),
]


# ── Capability gate negative ────────────────────────────────────────

class TestCapabilityGateNegative:
    def test_no_token_401(self, s):
        r = s.get(f"{BASE_URL}/api/inspector/jobs")
        assert r.status_code == 401, f"expected 401 unauth got {r.status_code}: {r.text}"

    def test_admin_token_403(self, s):
        token = _login(s, ADMIN_EMAIL, ADMIN_PASS)
        r = s.get(f"{BASE_URL}/api/inspector/jobs",
                  headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 403, f"expected 403 for admin got {r.status_code}: {r.text}"
        body = r.text.lower()
        assert "capability required" in body and "inspect" in body, \
            f"expected 'capability required (inspect)' in body, got: {r.text}"

    def test_customer_token_403(self, s):
        token, _, _ = _get_or_register(s, "customer")
        r = s.get(f"{BASE_URL}/api/inspector/jobs",
                  headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 403, f"expected 403 for customer got {r.status_code}: {r.text}"

    def test_all_gated_endpoints_403_for_customer(self, s):
        token, _, _ = _get_or_register(s, "customer")
        h = {"Authorization": f"Bearer {token}"}
        results = {}
        for method, path in GATED_ENDPOINTS:
            url = f"{BASE_URL}{path}"
            if method == "GET":
                r = s.get(url, headers=h)
            else:
                # send minimal valid body for /report
                if path.endswith("/report"):
                    body = {"score": 7.0, "verdict": "recommended",
                            "summary": "x" * 20, "checklist": [], "issues": []}
                    r = s.post(url, headers=h, json=body)
                else:
                    r = s.post(url, headers=h, json={})
            results[f"{method} {path}"] = r.status_code
        failed = {k: v for k, v in results.items() if v != 403}
        assert not failed, f"endpoints did not return 403 for customer: {failed}"


# ── Capability gate positive ────────────────────────────────────────

class TestCapabilityGatePositive:
    def test_provider_can_list_jobs(self, s):
        token, _, _ = _get_or_register(s, "provider_owner", "p1")
        r = s.get(f"{BASE_URL}/api/inspector/jobs",
                  headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200, f"provider listing failed: {r.status_code} {r.text}"
        body = r.json()
        assert "jobs" in body and "count" in body
        assert isinstance(body["jobs"], list)
        assert isinstance(body["count"], int)

    def test_provider_can_get_checklist(self, s):
        token, _, _ = _get_or_register(s, "provider_owner", "p1")
        r = s.get(f"{BASE_URL}/api/inspector/checklist",
                  headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200, f"checklist failed: {r.status_code} {r.text}"
        body = r.json()
        assert "items" in body and len(body["items"]) > 0


# ── Lifecycle & dual-write ──────────────────────────────────────────

class TestLifecycleDualWrite:
    def test_full_lifecycle_with_dual_write(self, s, db):
        token, user, _ = _get_or_register(s, "provider_owner", "p1")
        me = _me(s, token)
        active_account = me.get("activeAccount") or {}
        account_id = active_account.get("id")
        user_id = me.get("user", {}).get("id") or user.get("id")
        assert account_id, f"missing activeAccount.id in /me: {me}"
        assert user_id, f"missing user.id: {me}"

        h = {"Authorization": f"Bearer {token}"}

        # Seed job
        req_id, job_id = _seed_job(db)

        # claim
        r = s.post(f"{BASE_URL}/api/inspector/jobs/{job_id}/claim", headers=h)
        assert r.status_code == 200, f"claim failed: {r.status_code} {r.text}"
        body = r.json()
        # NOTE: spec says claim response should include inspectorAccountId, but
        # router code does `if isinstance(res, dict)` while service returns a
        # Pydantic InspectionJobOut → field is silently dropped from response.
        # Mongo persistence below is what actually matters; flag the response
        # gap as a separate assertion at the end of this test.
        claim_resp_has_account_id = body["job"].get("inspectorAccountId") == account_id

        doc = db.inspection_jobs.find_one({"_id": job_id})
        assert doc["inspectorId"] == user_id, f"inspectorId mismatch: {doc.get('inspectorId')} vs {user_id}"
        assert doc["inspectorAccountId"] == account_id, f"inspectorAccountId mismatch: {doc.get('inspectorAccountId')}"

        # on-route
        r = s.post(f"{BASE_URL}/api/inspector/jobs/{job_id}/on-route", headers=h)
        assert r.status_code == 200, f"on-route failed: {r.text}"
        doc = db.inspection_jobs.find_one({"_id": job_id})
        assert doc["inspectorAccountId"] == account_id

        # arrived
        r = s.post(f"{BASE_URL}/api/inspector/jobs/{job_id}/arrived", headers=h)
        assert r.status_code == 200, f"arrived failed: {r.text}"

        # start-inspection
        r = s.post(f"{BASE_URL}/api/inspector/jobs/{job_id}/start-inspection", headers=h)
        assert r.status_code == 200, f"start-inspection failed: {r.text}"
        doc = db.inspection_jobs.find_one({"_id": job_id})
        assert doc["status"] == "inspecting"
        assert doc["inspectorAccountId"] == account_id

        # report
        report_payload = {
            "score": 7.5,
            "verdict": "recommended",
            "summary": "Vehicle is in good condition overall, minor issues only.",
            "checklist": [],
            "issues": [],
        }
        r = s.post(f"{BASE_URL}/api/inspector/jobs/{job_id}/report",
                   headers=h, json=report_payload)
        assert r.status_code == 200, f"report failed: {r.status_code} {r.text}"
        report = r.json()["report"]
        assert report.get("inspectorAccountId") == account_id, \
            f"report response missing inspectorAccountId: {report}"
        report_id = report.get("id")
        # Verify both docs in mongo
        job_doc = db.inspection_jobs.find_one({"_id": job_id})
        assert job_doc["inspectorAccountId"] == account_id
        assert job_doc["status"] == "done"
        rep_doc = db.inspection_reports.find_one({"_id": report_id})
        assert rep_doc is not None
        assert rep_doc.get("inspectorAccountId") == account_id, \
            f"report doc missing inspectorAccountId: {rep_doc}"

        # account_id must differ from user_id (sprint 1C real account)
        assert account_id != user_id, \
            f"account_id should differ from user_id (Sprint 1C): both={account_id}"

        # Final: surface the response-shape bug at the END (mongo flow already validated)
        assert claim_resp_has_account_id, (
            "BUG: claim response missing inspectorAccountId — router does "
            "`if isinstance(res, dict)` but svc.claim_job returns a Pydantic "
            "InspectionJobOut, so the field is silently dropped. Mongo persistence "
            "is OK; only the response shape regresses against spec."
        )

    def test_cancel_clears_inspector_account_id(self, s, db):
        token, _, _ = _get_or_register(s, "provider_owner", "p1")
        me = _me(s, token)
        account_id = me["activeAccount"]["id"]
        h = {"Authorization": f"Bearer {token}"}

        _, job_id = _seed_job(db, city="Munich")
        # claim
        r = s.post(f"{BASE_URL}/api/inspector/jobs/{job_id}/claim", headers=h)
        assert r.status_code == 200
        doc = db.inspection_jobs.find_one({"_id": job_id})
        assert doc["inspectorAccountId"] == account_id

        # cancel
        r = s.post(f"{BASE_URL}/api/inspector/jobs/{job_id}/cancel",
                   headers=h, json={"reason": "test"})
        assert r.status_code == 200, f"cancel failed: {r.text}"
        doc = db.inspection_jobs.find_one({"_id": job_id})
        # inspectorId is None and inspectorAccountId is None after cancel
        assert doc.get("inspectorId") is None, f"expected inspectorId=None, got {doc.get('inspectorId')}"
        assert doc.get("inspectorAccountId") is None, \
            f"expected inspectorAccountId=None after cancel, got {doc.get('inspectorAccountId')}"


# ── Ownership: capability does NOT bypass ownership ─────────────────

class TestOwnership:
    def test_provider_b_cannot_transition_provider_a_job(self, s, db):
        token_a, _, _ = _get_or_register(s, "provider_owner", "p1")
        token_b, _, _ = _get_or_register(s, "provider_owner", "p2")
        h_a = {"Authorization": f"Bearer {token_a}"}
        h_b = {"Authorization": f"Bearer {token_b}"}

        _, job_id = _seed_job(db, city="Hamburg")
        # A claims
        r = s.post(f"{BASE_URL}/api/inspector/jobs/{job_id}/claim", headers=h_a)
        assert r.status_code == 200
        # B tries to advance — must be 403 not_your_job
        r = s.post(f"{BASE_URL}/api/inspector/jobs/{job_id}/on-route", headers=h_b)
        assert r.status_code == 403, \
            f"expected 403 (not your job) for provider B, got {r.status_code}: {r.text}"


# ── Smoke / non-regression ──────────────────────────────────────────

class TestSmokeNonRegression:
    def test_health(self, s):
        r = s.get(f"{BASE_URL}/api/health")
        assert r.status_code == 200, f"/api/health: {r.status_code}"

    def test_cities(self, s):
        r = s.get(f"{BASE_URL}/api/cities")
        assert r.status_code == 200, f"/api/cities: {r.status_code}"

    def test_marketplace_providers(self, s):
        r = s.get(f"{BASE_URL}/api/marketplace/providers")
        assert r.status_code == 200, f"/api/marketplace/providers: {r.status_code}"

    def test_admin_panel_root(self, s):
        r = s.get(f"{BASE_URL}/api/admin-panel/")
        assert r.status_code == 200, f"/api/admin-panel/: {r.status_code}"

    def test_web_app_root(self, s):
        r = s.get(f"{BASE_URL}/api/web-app/")
        assert r.status_code == 200, f"/api/web-app/: {r.status_code}"

    def test_login_admin(self, s):
        token = _login(s, ADMIN_EMAIL, ADMIN_PASS)
        assert token

    def test_register_returns_token_and_me_works(self, s):
        token, _, email = _register(s, "customer")
        me = _me(s, token)
        assert me["user"]["email"].lower() == email.lower()

    def test_switch_account_works(self, s):
        token, _, _ = _get_or_register(s, "provider_owner", "p1")
        me = _me(s, token)
        accounts = me.get("accounts", []) or []
        if not accounts:
            pytest.skip("no accounts list returned by /me")
        target = accounts[0]["id"]
        r = s.post(f"{BASE_URL}/api/auth/switch-account",
                   headers={"Authorization": f"Bearer {token}"},
                   json={"accountId": target})
        assert r.status_code == 200, f"switch-account failed: {r.status_code} {r.text}"
