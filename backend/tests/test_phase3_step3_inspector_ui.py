"""Phase 3 Step 3 — Inspector UI backend contract tests.

Covers the new backend-side additions:
1) GET /api/inspector/exposures auto-resolves inspectorId from user token.
2) Response includes activeJobsCount, maxActiveJobs=5, canAccept.
3) POST /api/inspector/exposures/{id}/accept enforces hard ceiling of 5 active
   jobs with 409 and detail containing 'too_many_active_jobs'.

All seeded inspection_jobs are cleaned up in teardown.
"""
from __future__ import annotations
import os
import time
from datetime import datetime, timedelta, timezone

import pytest
import requests
from pymongo import MongoClient

BASE_URL = "http://localhost:8001"
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

ADMIN_CREDS = {"email": "admin@autoservice.com", "password": "Admin123!"}
CUST_CREDS = {"email": "customer@test.com", "password": "Customer123!"}
PROV_CREDS = {"email": "provider@test.com", "password": "Provider123!"}

PROVIDER_ORG_ID = "69f7c4f75c1180bf8f1406f2"  # per spec — ownerId == provider user id

MAX_ACTIVE_JOBS = 5
SEED_TAG = "TEST_PH3_STEP3"  # used to identify & cleanup seeded jobs


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
    admin_token, _ = admin_auth
    _, cust_user = cust_auth
    requests.post(
        f"{BASE_URL}/api/admin/credits/adjust",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"userId": cust_user["id"], "delta": 100, "note": f"{SEED_TAG}_credits"},
        timeout=10,
    )


@pytest.fixture(scope="module", autouse=True)
def ensure_flag_enabled(db):
    db.feature_flags.update_one(
        {"key": "use_exposures"},
        {"$set": {"enabled": True}},
        upsert=True,
    )
    time.sleep(6)  # let the in-process 5s cache expire
    yield


@pytest.fixture(autouse=True)
def cleanup_seeded_jobs(db):
    """Delete any seeded inspection_jobs/exposures/requests before AND after each test."""
    def _clean():
        db.inspection_jobs.delete_many({"seedTag": SEED_TAG})
        db.inspector_exposures.delete_many({"seedTag": SEED_TAG})
        db.car_requests.delete_many({"seedTag": SEED_TAG})
    _clean()
    yield
    _clean()


# ─────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────
def _create_inspection_request(token, brand="TEST_PH3S3_BMW"):
    body = {
        "type": "inspection",
        "brand": brand,
        "model": "X5",
        "links": ["https://mobile.de/listing/test-ph3s3"],
        "cities": ["Berlin"],
        "country": "DE",
        "urgency": "asap",
    }
    return requests.post(
        f"{BASE_URL}/api/customer/requests",
        headers={"Authorization": f"Bearer {token}"},
        json=body,
        timeout=15,
    )


def _seed_active_jobs(db, inspector_id: str, n: int):
    """Directly insert n claimed inspection_jobs for the given inspector."""
    now = datetime.now(timezone.utc)
    docs = []
    for i in range(n):
        docs.append({
            "_id": f"{SEED_TAG}_{inspector_id}_{i}_{int(now.timestamp())}",
            "requestId": f"{SEED_TAG}_req_{i}",
            "inspectorId": inspector_id,
            "status": "claimed",
            "city": "berlin",
            "claimedAt": now,
            "createdAt": now,
            "seedTag": SEED_TAG,
        })
    if docs:
        db.inspection_jobs.insert_many(docs)
    return [d["_id"] for d in docs]


def _insert_fresh_exposure_for_org(db, inspector_id: str):
    """Directly insert a visible exposure + open inspection_job for a fresh request.

    Returns (exposure_id, job_id, request_id). All docs tagged with SEED_TAG for cleanup.
    Avoids dependency on ranking pipeline (provider org may not be in city top-5).
    """
    import uuid
    now = datetime.now(timezone.utc)
    request_id = f"{SEED_TAG}_req_{uuid.uuid4().hex[:12]}"
    job_id = f"{SEED_TAG}_job_{uuid.uuid4().hex[:12]}"
    exposure_id = str(uuid.uuid4())
    # Minimal request doc so list_visible_exposures enrichment doesn't blow up
    db.car_requests.insert_one({
        "_id": request_id,
        "type": "inspection",
        "brand": "TEST_CEIL",
        "model": "X",
        "status": "open",
        "createdAt": now,
        "updatedAt": now,
        "jobsClaimed": 0,
        "seedTag": SEED_TAG,
    })
    db.inspection_jobs.insert_one({
        "_id": job_id,
        "requestId": request_id,
        "city": "berlin",
        "status": "open",
        "createdAt": now,
        "seedTag": SEED_TAG,
    })
    db.inspector_exposures.insert_one({
        "_id": exposure_id,
        "requestId": request_id,
        "jobId": job_id,
        "city": "berlin",
        "inspectorId": inspector_id,
        "inspectorName": "TEST_SEEDED",
        "rank": 1,
        "score": 0.9,
        "scoreParts": {},
        "status": "visible",
        "waveReason": "initial",
        "exposedAt": now,
        "expiresAt": now + timedelta(minutes=60),
        "seedTag": SEED_TAG,
    })
    return exposure_id, job_id, request_id


# ─────────────────────────────────────────────────────────
class TestAutoResolveInspectorId:
    def test_default_returns_org_id_for_provider_owner(self, prov_auth):
        token, user = prov_auth
        assert user["role"] == "provider_owner"
        r = requests.get(
            f"{BASE_URL}/api/inspector/exposures",
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
        )
        assert r.status_code == 200, r.text
        j = r.json()
        # Core schema
        for k in ("exposures", "count", "activeJobsCount", "maxActiveJobs", "canAccept", "inspectorId"):
            assert k in j, f"missing field {k}"
        assert isinstance(j["exposures"], list)
        assert j["count"] == len(j["exposures"])
        assert j["maxActiveJobs"] == MAX_ACTIVE_JOBS
        assert isinstance(j["canAccept"], bool)
        # inspectorId must be the org, NOT the user id
        assert j["inspectorId"] == PROVIDER_ORG_ID, (
            f"expected org id {PROVIDER_ORG_ID}, got {j['inspectorId']}"
        )
        assert j["inspectorId"] != user["id"]

    def test_inspector_id_matches_org_owner_in_db(self, db):
        from bson import ObjectId
        # _id is stored as ObjectId — convert PROVIDER_ORG_ID hex string
        org = db.organizations.find_one({"_id": ObjectId(PROVIDER_ORG_ID)}, {"ownerId": 1})
        assert org is not None, f"org {PROVIDER_ORG_ID} not found"
        _, user = _login(PROV_CREDS)
        assert org["ownerId"] == user["id"], (
            f"org.ownerId={org['ownerId']} != user.id={user['id']}"
        )

    def test_override_takes_precedence(self, prov_auth):
        token, _ = prov_auth
        bogus = "OVERRIDE_INSP_ID_xyz"
        r = requests.get(
            f"{BASE_URL}/api/inspector/exposures",
            params={"inspectorId": bogus},
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
        )
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["inspectorId"] == bogus, f"override ignored: {j['inspectorId']}"


# ─────────────────────────────────────────────────────────
# 2. canAccept reflects activeJobsCount < 5
# ─────────────────────────────────────────────────────────
class TestCanAcceptGating:
    def test_can_accept_flips_with_active_jobs(self, prov_auth, db):
        token, _ = prov_auth
        # Baseline: no seeded active jobs → canAccept=true
        r = requests.get(
            f"{BASE_URL}/api/inspector/exposures",
            params={"inspectorId": PROVIDER_ORG_ID},
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
        )
        assert r.status_code == 200
        j0 = r.json()
        base_active = j0["activeJobsCount"]
        # Seed enough jobs so total >=5
        need = max(0, MAX_ACTIVE_JOBS - base_active)
        seeded = _seed_active_jobs(db, PROVIDER_ORG_ID, need if need > 0 else MAX_ACTIVE_JOBS)

        r2 = requests.get(
            f"{BASE_URL}/api/inspector/exposures",
            params={"inspectorId": PROVIDER_ORG_ID},
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
        )
        j1 = r2.json()
        assert j1["activeJobsCount"] >= MAX_ACTIVE_JOBS, (
            f"expected active>=5, got {j1['activeJobsCount']}"
        )
        assert j1["canAccept"] is False, "canAccept must be False at ceiling"

        # Flip one seeded job to 'done' → should drop below ceiling if we had exactly ceiling
        if seeded:
            db.inspection_jobs.update_one(
                {"_id": seeded[0]},
                {"$set": {"status": "done"}},
            )
        r3 = requests.get(
            f"{BASE_URL}/api/inspector/exposures",
            params={"inspectorId": PROVIDER_ORG_ID},
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
        )
        j2 = r3.json()
        # If base_active was 0 and we seeded exactly 5, count drops to 4 → canAccept=true
        if base_active == 0:
            assert j2["activeJobsCount"] == MAX_ACTIVE_JOBS - 1
            assert j2["canAccept"] is True


# ─────────────────────────────────────────────────────────
# 3. Accept enforces hard ceiling → 409 too_many_active_jobs
# ─────────────────────────────────────────────────────────
class TestAcceptHardCeiling:
    def test_accept_409_when_at_ceiling(self, prov_auth, db):
        p_token, _ = prov_auth
        # Seed a fresh visible exposure (+job, +request) for the provider org.
        # This bypasses the Berlin-ranking constraint (provider org is in Kyiv).
        exp_id, job_id, req_id = _insert_fresh_exposure_for_org(db, PROVIDER_ORG_ID)

        # Seed 5 claimed jobs → ceiling hit
        _seed_active_jobs(db, PROVIDER_ORG_ID, MAX_ACTIVE_JOBS)

        # Reset rate-limit window
        db.inspector_exposure_events.delete_many({"inspectorId": PROVIDER_ORG_ID})

        r = requests.post(
            f"{BASE_URL}/api/inspector/exposures/{exp_id}/accept",
            headers={"Authorization": f"Bearer {p_token}"},
            timeout=10,
        )
        assert r.status_code == 409, f"expected 409, got {r.status_code} {r.text}"
        body = r.json()
        # Error envelope uses {error, code, message, details} (global handler transforms HTTPException)
        msg = body.get("message") or body.get("detail") or ""
        assert "too_many_active_jobs" in msg or "5/5" in msg, (
            f"detail/message missing ceiling marker: body={body}"
        )

        # Verify exposure untouched — ceiling blocks BEFORE mutating exposure
        exp_after = db.inspector_exposures.find_one({"_id": exp_id})
        assert exp_after["status"] == "visible", (
            f"exposure mutated on ceiling-block: {exp_after['status']}"
        )
        # And the job still open
        job_after = db.inspection_jobs.find_one({"_id": job_id})
        assert job_after["status"] == "open"

    def test_accept_ok_when_below_ceiling(self, prov_auth, db):
        """Happy path: no active jobs → accept succeeds (atomicity regression)."""
        p_token, _ = prov_auth
        # Seed a fresh exposure for provider org; NO active-job seeding
        exp_id, job_id, _req_id = _insert_fresh_exposure_for_org(db, PROVIDER_ORG_ID)

        # Confirm canAccept=true (no seeded active jobs; real seed may still have some,
        # so accept the actual API truth rather than hardcoding)
        r = requests.get(
            f"{BASE_URL}/api/inspector/exposures",
            headers={"Authorization": f"Bearer {p_token}"},
            timeout=10,
        )
        j = r.json()
        if not j["canAccept"]:
            pytest.skip(f"natural active jobs >= ceiling ({j['activeJobsCount']}); cannot test happy path")

        # Reset rate-limit window
        db.inspector_exposure_events.delete_many({"inspectorId": PROVIDER_ORG_ID})

        r2 = requests.post(
            f"{BASE_URL}/api/inspector/exposures/{exp_id}/accept",
            headers={"Authorization": f"Bearer {p_token}"},
            timeout=10,
        )
        assert r2.status_code == 200, f"happy accept failed: {r2.status_code} {r2.text}"
        body = r2.json()
        assert body["status"] == "accepted"
        assert body["exposure"]["jobId"] == job_id

        # Verify job claimed
        job = db.inspection_jobs.find_one({"_id": job_id})
        assert job["status"] == "claimed"
        assert job["inspectorId"] == PROVIDER_ORG_ID
        # Exposure marked accepted
        exp_after = db.inspector_exposures.find_one({"_id": exp_id})
        assert exp_after["status"] == "accepted"
