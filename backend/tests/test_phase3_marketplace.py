"""Phase 3 — Soft Marketplace backend tests.

Covers:
- request → exposures fan-out (visible, expiresAt ~60min, ranked by score)
- per-request override useExposures=false
- accept flow (claim job, expire siblings, bump counters)
- duplicate accept (409)
- reject flow
- ownership check (403)
- feature flag toggle (Mongo direct)
- anti-abuse rate limit (21/min → 429)
- Mongo indexes verification
- background loops in logs
"""
from __future__ import annotations
import os
import time
import pytest
import requests
from pymongo import MongoClient

BASE_URL = "http://localhost:8001"
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

ADMIN_CREDS = {"email": "admin@autoservice.com", "password": "Admin123!"}
CUST_CREDS = {"email": "customer@test.com", "password": "Customer123!"}
PROV_CREDS = {"email": "provider@test.com", "password": "Provider123!"}


# ─────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def db():
    cli = MongoClient(MONGO_URL)
    return cli[DB_NAME]


def _login(creds):
    r = requests.post(f"{BASE_URL}/api/auth/login", json=creds, timeout=10)
    assert r.status_code == 200, f"login failed for {creds['email']}: {r.text}"
    j = r.json()
    return j["accessToken"], j["user"]


@pytest.fixture(scope="module")
def admin_auth():
    return _login(ADMIN_CREDS)


@pytest.fixture(scope="module")
def cust_auth():
    return _login(CUST_CREDS)


@pytest.fixture(scope="module")
def prov_auth():
    return _login(PROV_CREDS)


@pytest.fixture(scope="module", autouse=True)
def grant_credits(admin_auth, cust_auth):
    """Grant 100 inspection credits to customer."""
    admin_token, _ = admin_auth
    _, cust_user = cust_auth
    r = requests.post(
        f"{BASE_URL}/api/admin/credits/adjust",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"userId": cust_user["id"], "delta": 100, "note": "TEST_phase3"},
        timeout=10,
    )
    assert r.status_code in (200, 201), f"credits/adjust failed: {r.status_code} {r.text}"


@pytest.fixture(scope="module", autouse=True)
def ensure_flag_enabled(db):
    """Make sure use_exposures flag is enabled at start (and reset cache)."""
    db.feature_flags.update_one(
        {"key": "use_exposures"},
        {"$set": {"enabled": True}},
        upsert=True,
    )
    time.sleep(6)  # let in-process 5s cache expire
    yield
    db.feature_flags.update_one(
        {"key": "use_exposures"},
        {"$set": {"enabled": True}},
        upsert=True,
    )


# ─────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────
def _create_inspection_request(token, useExposures=None, brand="TEST_BMW", model="X5"):
    body = {
        "type": "inspection",
        "brand": brand,
        "model": model,
        "links": ["https://mobile.de/listing/test-123"],
        "cities": ["Berlin"],
        "country": "DE",
        "urgency": "asap",
    }
    if useExposures is not None:
        body["useExposures"] = useExposures
    r = requests.post(
        f"{BASE_URL}/api/customer/requests",
        headers={"Authorization": f"Bearer {token}"},
        json=body,
        timeout=15,
    )
    return r


# ─────────────────────────────────────────────────────────
# 1. Mongo indexes
# ─────────────────────────────────────────────────────────
class TestIndexes:
    def test_exposure_indexes_present(self, db):
        idx = db.inspector_exposures.index_information()
        names_keys = [tuple(v["key"]) for v in idx.values()]
        # Verify each required compound index exists
        assert (("inspectorId", 1), ("status", 1), ("expiresAt", 1)) in names_keys
        assert (("jobId", 1), ("status", 1)) in names_keys
        assert (("requestId", 1), ("status", 1)) in names_keys
        # Unique (jobId, inspectorId)
        unique_idx = [v for v in idx.values() if tuple(v["key"]) == (("jobId", 1), ("inspectorId", 1))]
        assert unique_idx, "missing (jobId, inspectorId) index"
        assert unique_idx[0].get("unique") is True


# ─────────────────────────────────────────────────────────
# 2. Create request → exposures
# ─────────────────────────────────────────────────────────
class TestExposureCreation:
    def test_create_inspection_creates_visible_exposures(self, cust_auth, db):
        token, _ = cust_auth
        r = _create_inspection_request(token)
        assert r.status_code in (200, 201), r.text
        data = r.json()
        req_id = data["id"]
        # tiny wait — exposure creation is awaited inside create_request, but be safe
        time.sleep(0.5)
        exposures = list(db.inspector_exposures.find({"requestId": req_id}))
        assert 1 <= len(exposures) <= 5, f"expected 1..5 exposures, got {len(exposures)}"
        for e in exposures:
            assert e["status"] == "visible"
            assert e["waveReason"] == "initial"
            assert e["expiresAt"] is not None
        # ranks 1..N strictly desc by score
        sorted_e = sorted(exposures, key=lambda x: x["rank"])
        scores = [e["score"] for e in sorted_e]
        assert scores == sorted(scores, reverse=True), "exposures not ranked by score desc"

    def test_use_exposures_false_skips_creation(self, cust_auth, db):
        token, _ = cust_auth
        r = _create_inspection_request(token, useExposures=False, brand="TEST_NO_EXP")
        assert r.status_code in (200, 201), r.text
        req_id = r.json()["id"]
        time.sleep(0.5)
        exposures = list(db.inspector_exposures.find({"requestId": req_id}))
        assert len(exposures) == 0, f"expected 0 exposures, got {len(exposures)}"
        # but jobs must still exist (fan-out runs)
        jobs = list(db.inspection_jobs.find({"requestId": req_id}))
        assert len(jobs) >= 1


# ─────────────────────────────────────────────────────────
# 3. Inspector lists / accept / reject / matching
# ─────────────────────────────────────────────────────────
class TestExposureLifecycle:
    @pytest.fixture(scope="class")
    def fresh_request(self, cust_auth, db):
        token, _ = cust_auth
        r = _create_inspection_request(token, brand="TEST_LIFE")
        assert r.status_code in (200, 201)
        req_id = r.json()["id"]
        time.sleep(0.5)
        exposures = list(db.inspector_exposures.find({"requestId": req_id, "status": "visible"}))
        assert len(exposures) > 0, "fixture: no exposures created"
        return req_id, exposures

    def test_inspector_lists_only_their_visible(self, fresh_request, prov_auth):
        req_id, exposures = fresh_request
        token, _ = prov_auth
        org_id = exposures[0]["inspectorId"]
        r = requests.get(
            f"{BASE_URL}/api/inspector/exposures",
            params={"inspectorId": org_id},
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
        )
        assert r.status_code == 200, r.text
        items = r.json()["exposures"]
        assert len(items) >= 1
        # Find ours
        ours = next((x for x in items if x["requestId"] == req_id), None)
        assert ours is not None, "did not see our exposure in inspector list"
        assert "request" in ours
        for fld in ("brand", "model", "country", "urgency", "links"):
            assert fld in ours["request"]

    def test_matching_status_ownership_403(self, fresh_request, admin_auth):
        """Admin (different uid) requests customer's request → 403."""
        req_id, _ = fresh_request
        admin_token, _ = admin_auth
        r = requests.get(
            f"{BASE_URL}/api/customer/requests/{req_id}/matching",
            headers={"Authorization": f"Bearer {admin_token}"},
            timeout=10,
        )
        assert r.status_code == 403, f"expected 403, got {r.status_code} {r.text}"

    def test_matching_status_owner_ok(self, fresh_request, cust_auth):
        req_id, _ = fresh_request
        token, _ = cust_auth
        r = requests.get(
            f"{BASE_URL}/api/customer/requests/{req_id}/matching",
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
        )
        assert r.status_code == 200, r.text
        j = r.json()
        assert "exposures" in j and "jobs" in j and "label" in j
        for k in ("total", "visible", "accepted", "rejected", "expired"):
            assert k in j["exposures"]
        for k in ("total", "inProgress", "done"):
            assert k in j["jobs"]

    def test_accept_flow(self, cust_auth, prov_auth, db):
        """Fresh request → accept first exposure → verify all side effects."""
        c_token, _ = cust_auth
        p_token, _ = prov_auth
        r = _create_inspection_request(c_token, brand="TEST_ACCEPT")
        assert r.status_code in (200, 201)
        req_id = r.json()["id"]
        time.sleep(0.5)
        exps = list(db.inspector_exposures.find({"requestId": req_id, "status": "visible"}))
        assert exps, "no exposures to accept"
        target = exps[0]
        org_id = target["inspectorId"]
        exp_id = target["_id"]
        job_id = target["jobId"]
        sibling_count = sum(1 for e in exps if e["jobId"] == job_id and e["_id"] != exp_id)

        # Accept
        r = requests.post(
            f"{BASE_URL}/api/inspector/exposures/{exp_id}/accept",
            params={"inspectorId": org_id},
            headers={"Authorization": f"Bearer {p_token}"},
            timeout=10,
        )
        assert r.status_code == 200, f"accept failed: {r.status_code} {r.text}"
        body = r.json()
        assert body.get("exposure", {}).get("jobId") == job_id

        # Side effects
        e_after = db.inspector_exposures.find_one({"_id": exp_id})
        assert e_after["status"] == "accepted"
        if sibling_count > 0:
            siblings = list(db.inspector_exposures.find(
                {"jobId": job_id, "_id": {"$ne": exp_id}}
            ))
            for s in siblings:
                assert s["status"] == "expired", f"sibling not expired: {s['status']}"
                assert s.get("expiredReason") == "job_claimed_by_other"
        # Job claimed
        job = db.inspection_jobs.find_one({"_id": job_id})
        assert job["status"] == "claimed"
        assert job["inspectorId"] == org_id
        # Request counters
        req = db.car_requests.find_one({"_id": req_id})
        assert req["jobsClaimed"] >= 1
        assert req["status"] == "in_progress"

        # Second accept on same exposure → 409
        r2 = requests.post(
            f"{BASE_URL}/api/inspector/exposures/{exp_id}/accept",
            params={"inspectorId": org_id},
            headers={"Authorization": f"Bearer {p_token}"},
            timeout=10,
        )
        assert r2.status_code == 409, f"expected 409 on duplicate accept, got {r2.status_code}"

    def test_reject_flow(self, cust_auth, prov_auth, db):
        c_token, _ = cust_auth
        p_token, _ = prov_auth
        r = _create_inspection_request(c_token, brand="TEST_REJECT")
        assert r.status_code in (200, 201)
        req_id = r.json()["id"]
        time.sleep(0.5)
        exps = list(db.inspector_exposures.find({"requestId": req_id, "status": "visible"}))
        assert exps
        target = exps[0]
        r = requests.post(
            f"{BASE_URL}/api/inspector/exposures/{target['_id']}/reject",
            params={"inspectorId": target["inspectorId"]},
            headers={"Authorization": f"Bearer {p_token}"},
            timeout=10,
        )
        assert r.status_code == 200, r.text
        e = db.inspector_exposures.find_one({"_id": target["_id"]})
        assert e["status"] == "rejected"
        assert e.get("rejectedAt") is not None


# ─────────────────────────────────────────────────────────
# 4. Anti-abuse: 21st action → 429
# ─────────────────────────────────────────────────────────
class TestAntiAbuse:
    def test_21_actions_returns_429(self, cust_auth, prov_auth, db):
        c_token, _ = cust_auth
        p_token, _ = prov_auth

        # Wipe rate-limit events for a fresh inspector window
        # Pick an inspector id that shows up in fresh exposures
        # Create enough requests to have >=21 exposures for ONE inspector
        org_id = None
        exposure_ids = []
        # Each request creates exactly 1 job → up to 5 exposures (different inspectors).
        # We need ≥21 exposures targeting ONE inspector → need ≥21 requests in the same city.
        for i in range(30):
            r = _create_inspection_request(c_token, brand=f"TEST_AB_{i}")
            assert r.status_code in (200, 201)
            req_id = r.json()["id"]
            time.sleep(0.2)
            exps = list(db.inspector_exposures.find({"requestId": req_id, "status": "visible"}))
            if not exps:
                continue
            if org_id is None:
                # Use the inspector with most exposures across requests
                org_id = exps[0]["inspectorId"]
            for e in exps:
                if e["inspectorId"] == org_id:
                    exposure_ids.append(e["_id"])
            if len(exposure_ids) >= 25:
                break

        assert org_id is not None and len(exposure_ids) >= 21, (
            f"need ≥21 exposures for one inspector, got {len(exposure_ids)}"
        )

        # Reset rate-limit window for this inspector
        db.inspector_exposure_events.delete_many({"inspectorId": org_id})

        statuses = []
        for i, eid in enumerate(exposure_ids[:21]):
            r = requests.post(
                f"{BASE_URL}/api/inspector/exposures/{eid}/reject",
                params={"inspectorId": org_id},
                headers={"Authorization": f"Bearer {p_token}"},
                timeout=10,
            )
            statuses.append(r.status_code)
        # First 20 should not be 429; the 21st must be 429
        assert statuses[20] == 429, f"21st action should be 429, got statuses={statuses}"
        # And there should be a logged event in mongo
        evt_count = db.inspector_exposure_events.count_documents({"inspectorId": org_id})
        assert evt_count >= 20

        # Cleanup so other tests can act
        db.inspector_exposure_events.delete_many({"inspectorId": org_id})


# ─────────────────────────────────────────────────────────
# 5. Feature flag toggle (Mongo direct)
# ─────────────────────────────────────────────────────────
class TestFeatureFlag:
    def test_disable_flag_skips_exposure_creation(self, cust_auth, db):
        token, _ = cust_auth
        # Disable
        db.feature_flags.update_one(
            {"key": "use_exposures"},
            {"$set": {"enabled": False}},
            upsert=True,
        )
        # Wait for in-process 5s cache to expire
        time.sleep(6)
        try:
            r = _create_inspection_request(token, brand="TEST_FLAG_OFF")
            assert r.status_code in (200, 201)
            req_id = r.json()["id"]
            time.sleep(0.5)
            exps = list(db.inspector_exposures.find({"requestId": req_id}))
            assert len(exps) == 0, f"flag off but {len(exps)} exposures created"
            jobs = list(db.inspection_jobs.find({"requestId": req_id}))
            assert len(jobs) >= 1, "jobs fan-out should still happen"
        finally:
            # Re-enable
            db.feature_flags.update_one(
                {"key": "use_exposures"},
                {"$set": {"enabled": True}},
                upsert=True,
            )
            time.sleep(6)

        # Verify re-enable works
        r = _create_inspection_request(token, brand="TEST_FLAG_ON")
        req_id2 = r.json()["id"]
        time.sleep(0.5)
        exps2 = list(db.inspector_exposures.find({"requestId": req_id2}))
        assert len(exps2) >= 1, "after re-enable, exposures should be created"


# ─────────────────────────────────────────────────────────
# 6. Background loops in logs
# ─────────────────────────────────────────────────────────
class TestBackgroundLoops:
    def test_loops_started_in_logs(self):
        log_paths = [
            "/var/log/supervisor/backend.err.log",
            "/var/log/supervisor/backend.out.log",
        ]
        text = ""
        for p in log_paths:
            if os.path.exists(p):
                try:
                    with open(p, "r", errors="ignore") as f:
                        text += f.read()
                except Exception:
                    pass
        assert "expire_loop started" in text, "expire_loop not started in logs"
        assert "batching_loop started" in text, "batching_loop not started in logs"
        assert "stats_recompute_loop started" in text, "stats_recompute_loop not started in logs"
