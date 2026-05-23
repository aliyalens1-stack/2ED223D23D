"""Sprint 3 Step 4 — Live Assignments backend acceptance tests.

Covers:
  - Pure compute_rank determinism
  - Smoke + auth gates
  - Admin create flow (incl. hardFloor exclusion + manualOverride)
  - Inspector live listing (sorted by score desc)
  - Accept happy path → job claimed, sibling cancel, timeline + customer event
  - Accept idempotency, expired path, forbidden, conflict (one accepted per job)
  - Decline idempotency, decline reason, cannot-decline-accepted
  - Admin list with filters + statusCounts
  - Admin cancel (incl. 409 on accepted)
  - Notifications fanout for assignment_offered → inspector
"""
from __future__ import annotations
import os
import asyncio
import time
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import jwt as pyjwt
import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8001")
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")
JWT_SECRET = os.environ.get("JWT_SECRET", "auto_service_jwt_secret_key_2025_very_secure")
JWT_ALGO = "HS256"

ADMIN_EMAIL = "admin@autoservice.com"
ADMIN_PASSWORD = "Admin123!"

# Berlin coords
JOB_LAT, JOB_LNG = 52.5200, 13.4050


# ─────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────

def _mint_inspector_token(uid: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": uid,
        "email": f"{uid}@test.local",
        "role": "inspector",
        "kind": "inspector",
        "accountId": uid,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=1)).timestamp()),
    }
    return pyjwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


@pytest.fixture(scope="module")
def admin_token() -> str:
    with httpx.Client(base_url=BACKEND_URL, timeout=15.0) as c:
        r = c.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return r.json()["accessToken"]


@pytest.fixture
def admin_headers(admin_token: str) -> dict:
    return {"Authorization": f"Bearer {admin_token}"}


@pytest_asyncio.fixture
async def db():
    client = AsyncIOMotorClient(MONGO_URL)
    yield client[DB_NAME]
    client.close()


@pytest_asyncio.fixture
async def seed(db):
    """Seed test inspector, customer, job. Track created docs for cleanup."""
    insp_id = "asg_test_insp1"
    cust_id = "asg_test_cust1"
    job_id = "asg_test_job1"

    await db.users.replace_one(
        {"_id": insp_id},
        {
            "_id": insp_id,
            "email": "asg_insp1@test.local",
            "name": "ASG Inspector",
            "role": "inspector",
            "accountKind": "inspector",
            "isOnline": True,
            "verified": True,
            "reputation": {"score": 80, "tier": "gold", "hardFloor": False, "verificationScore": 90},
            "maxJobsPerDay": 5,
            "location": {"lat": JOB_LAT, "lng": JOB_LNG},
        },
        upsert=True,
    )
    await db.users.replace_one(
        {"_id": cust_id},
        {"_id": cust_id, "email": "asg_cust1@test.local", "role": "customer", "accountKind": "customer"},
        upsert=True,
    )
    await db.inspection_jobs.replace_one(
        {"_id": job_id},
        {"_id": job_id, "status": "pending", "customerId": cust_id},
        upsert=True,
    )
    yield {"inspectorId": insp_id, "customerId": cust_id, "jobId": job_id}

    # Cleanup
    await db.users.delete_one({"_id": insp_id})
    await db.users.delete_one({"_id": cust_id})
    await db.inspection_jobs.delete_one({"_id": job_id})
    await db.inspection_assignments.delete_many({"jobId": job_id})
    await db.timeline_events.delete_many({"jobId": job_id})
    await db.notifications.delete_many({"userId": insp_id})
    await db.notifications.delete_many({"userId": cust_id})


# ─────────────────────────────────────────────────────────────────────
# Smoke + Auth
# ─────────────────────────────────────────────────────────────────────

class TestSmoke:
    def test_health(self):
        r = httpx.get(f"{BACKEND_URL}/api/health", timeout=10)
        assert r.status_code == 200
        body = r.json()
        assert body.get("status") == "ok"
        assert body.get("db") == "connected"

    def test_live_requires_auth(self):
        r = httpx.get(f"{BACKEND_URL}/api/inspector/assignments/live", timeout=10)
        assert r.status_code == 401


# ─────────────────────────────────────────────────────────────────────
# Pure compute_rank determinism
# ─────────────────────────────────────────────────────────────────────

class TestPureRank:
    def test_compute_rank_deterministic(self):
        from app.assignments.engine import compute_rank, RANK_WEIGHTS

        s1, b1 = compute_rank(reputation_score=80, is_online=True, verified=True, distance_km=10.0)
        s2, b2 = compute_rank(reputation_score=80, is_online=True, verified=True, distance_km=10.0)
        assert s1 == s2 and b1 == b2
        # Manual recompute: rep80*.45 + (60)*.25 + 100*.20 + 100*.10
        assert b1["reputationScore"] == 80
        assert b1["availabilityScore"] == 100
        assert b1["verificationScore"] == 100
        # distance at 10km of 25km decay → 100*(1-10/25)=60
        assert b1["distanceScore"] == 60
        expected = round(80 * 0.45 + 60 * 0.25 + 100 * 0.20 + 100 * 0.10)
        assert s1 == expected

    def test_compute_rank_offline_unverified_far(self):
        from app.assignments.engine import compute_rank
        s, b = compute_rank(reputation_score=0, is_online=False, verified=False, distance_km=99.0)
        assert b["distanceScore"] == 0
        assert b["availabilityScore"] == 0
        assert b["verificationScore"] == 0
        assert s == 0


# ─────────────────────────────────────────────────────────────────────
# Create + Live listing
# ─────────────────────────────────────────────────────────────────────

class TestCreateAndLive:
    @pytest.mark.asyncio
    async def test_admin_create_offers_assignment(self, seed, admin_headers, db):
        body = {
            "jobId": seed["jobId"], "inspectorId": seed["inspectorId"],
            "customerId": seed["customerId"], "priority": "normal",
            "estimatedEarnings": 149, "jobLat": JOB_LAT, "jobLng": JOB_LNG,
        }
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
            r = await c.post("/api/admin/assignments/create", json=body, headers=admin_headers)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["ok"] is True
        asg = data["assignment"]
        assert asg["status"] == "offered"
        assert asg["id"].startswith("asg_")
        assert asg["score"] > 0
        assert asg["ttlSeconds"] == 120
        assert asg["distanceKm"] == 0.0  # same coords
        assert "ranking" in asg
        assert asg["manualOverride"] is False

        # Live endpoint as inspector
        inspector_token = _mint_inspector_token(seed["inspectorId"])
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
            r2 = await c.get(
                "/api/inspector/assignments/live",
                headers={"Authorization": f"Bearer {inspector_token}"},
            )
        assert r2.status_code == 200
        live = r2.json()
        assert any(it["id"] == asg["id"] for it in live["items"])

        # Timeline event for assignment_offered exists
        await asyncio.sleep(0.2)
        ev = await db.timeline_events.find_one(
            {"kind": "assignment_offered", "metadata.assignmentId": asg["id"]}
        )
        assert ev is not None
        assert ev["inspectorId"] == seed["inspectorId"]
        assert ev["jobId"] == seed["jobId"]

        # Notification for inspector
        notif = await db.notifications.find_one(
            {"userId": seed["inspectorId"], "kind": "assignment_offered"}
        )
        assert notif is not None, "expected notification fanout to inspector"

    @pytest.mark.asyncio
    async def test_live_sorted_by_score_desc(self, db, admin_headers):
        # Two jobs, two assignments for same inspector, different scores
        insp_id = "asg_test_insp_sort"
        await db.users.replace_one(
            {"_id": insp_id},
            {"_id": insp_id, "role": "inspector", "isOnline": True, "verified": True,
             "reputation": {"score": 80, "hardFloor": False, "verificationScore": 90},
             "maxJobsPerDay": 10,
             "location": {"lat": JOB_LAT, "lng": JOB_LNG}},
            upsert=True,
        )
        try:
            for jid, lat in [("asg_sort_job_close", JOB_LAT), ("asg_sort_job_far", JOB_LAT + 0.2)]:
                await db.inspection_jobs.replace_one(
                    {"_id": jid}, {"_id": jid, "status": "pending"}, upsert=True
                )
                async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                    r = await c.post(
                        "/api/admin/assignments/create",
                        json={"jobId": jid, "inspectorId": insp_id, "priority": "normal",
                              "jobLat": lat, "jobLng": JOB_LNG},
                        headers=admin_headers,
                    )
                assert r.status_code == 200, r.text

            tok = _mint_inspector_token(insp_id)
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                r = await c.get("/api/inspector/assignments/live",
                                headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 200
            items = r.json()["items"]
            scores = [it["score"] for it in items]
            assert scores == sorted(scores, reverse=True), f"not sorted desc: {scores}"
        finally:
            await db.users.delete_one({"_id": insp_id})
            await db.inspection_jobs.delete_many({"_id": {"$in": ["asg_sort_job_close", "asg_sort_job_far"]}})
            await db.inspection_assignments.delete_many({"inspectorId": insp_id})
            await db.timeline_events.delete_many({"inspectorId": insp_id})
            await db.notifications.delete_many({"userId": insp_id})


# ─────────────────────────────────────────────────────────────────────
# Accept / Decline state machine
# ─────────────────────────────────────────────────────────────────────

async def _create_offer(seed, admin_headers, db, *, job_id=None, priority="normal"):
    """Helper: create an assignment row via admin endpoint, return assignment dict."""
    jid = job_id or seed["jobId"]
    if jid != seed["jobId"]:
        await db.inspection_jobs.replace_one(
            {"_id": jid}, {"_id": jid, "status": "pending"}, upsert=True
        )
    body = {
        "jobId": jid, "inspectorId": seed["inspectorId"],
        "customerId": seed["customerId"], "priority": priority,
        "estimatedEarnings": 149, "jobLat": JOB_LAT, "jobLng": JOB_LNG,
    }
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        r = await c.post("/api/admin/assignments/create", json=body, headers=admin_headers)
    assert r.status_code == 200, r.text
    return r.json()["assignment"]


class TestAcceptDecline:
    @pytest.mark.asyncio
    async def test_accept_happy_path(self, seed, admin_headers, db):
        asg = await _create_offer(seed, admin_headers, db)
        tok = _mint_inspector_token(seed["inspectorId"])
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
            r = await c.post(
                f"/api/inspector/assignments/{asg['id']}/accept",
                headers={"Authorization": f"Bearer {tok}"},
            )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["status"] == "accepted"
        assert data["assignment"]["status"] == "accepted"
        assert data["assignment"]["acceptedAt"] is not None

        # Job claimed
        job = await db.inspection_jobs.find_one({"_id": seed["jobId"]})
        assert job["status"] == "claimed"
        assert job["inspectorId"] == seed["inspectorId"]
        assert job.get("claimedAt") is not None

        # Timeline events
        await asyncio.sleep(0.2)
        ev_acc = await db.timeline_events.find_one(
            {"kind": "assignment_accepted", "metadata.assignmentId": asg["id"]}
        )
        assert ev_acc is not None
        ev_cust = await db.timeline_events.find_one(
            {"kind": "inspector_assigned", "jobId": seed["jobId"]}
        )
        assert ev_cust is not None

    @pytest.mark.asyncio
    async def test_accept_idempotent(self, seed, admin_headers, db):
        asg = await _create_offer(seed, admin_headers, db)
        tok = _mint_inspector_token(seed["inspectorId"])
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
            r1 = await c.post(f"/api/inspector/assignments/{asg['id']}/accept",
                              headers={"Authorization": f"Bearer {tok}"})
            r2 = await c.post(f"/api/inspector/assignments/{asg['id']}/accept",
                              headers={"Authorization": f"Bearer {tok}"})
        assert r1.json()["status"] == "accepted"
        assert r2.json()["status"] == "idempotent"

    @pytest.mark.asyncio
    async def test_decline_idempotent_and_reason(self, seed, admin_headers, db):
        asg = await _create_offer(seed, admin_headers, db)
        tok = _mint_inspector_token(seed["inspectorId"])
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
            r1 = await c.post(f"/api/inspector/assignments/{asg['id']}/decline",
                              json={"reason": "too far"},
                              headers={"Authorization": f"Bearer {tok}"})
            r2 = await c.post(f"/api/inspector/assignments/{asg['id']}/decline",
                              json={"reason": "again"},
                              headers={"Authorization": f"Bearer {tok}"})
        assert r1.status_code == 200
        assert r1.json()["status"] == "declined"
        assert r1.json()["assignment"]["declineReason"] == "too far"
        assert r2.status_code == 200
        assert r2.json()["status"] == "idempotent"

    @pytest.mark.asyncio
    async def test_cannot_decline_accepted(self, seed, admin_headers, db):
        asg = await _create_offer(seed, admin_headers, db)
        tok = _mint_inspector_token(seed["inspectorId"])
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
            r_acc = await c.post(f"/api/inspector/assignments/{asg['id']}/accept",
                                 headers={"Authorization": f"Bearer {tok}"})
            assert r_acc.json()["status"] == "accepted"
            r_dec = await c.post(f"/api/inspector/assignments/{asg['id']}/decline",
                                 headers={"Authorization": f"Bearer {tok}"})
        assert r_dec.status_code == 200
        assert r_dec.json()["status"] == "already_accepted"

    @pytest.mark.asyncio
    async def test_expired_cannot_accept(self, seed, admin_headers, db):
        # Insert directly with past expiresAt
        aid = f"asg_{uuid.uuid4().hex[:18]}"
        past = "2025-01-01T00:00:00+00:00"
        await db.inspection_assignments.insert_one({
            "id": aid, "jobId": seed["jobId"], "inspectorId": seed["inspectorId"],
            "customerId": seed["customerId"], "status": "offered",
            "priority": "normal", "expiresAt": past, "ttlSeconds": 60,
            "score": 50, "ranking": {}, "createdAt": past,
            "acceptedAt": None, "declinedAt": None, "manualOverride": False,
            "metadata": {},
        })
        tok = _mint_inspector_token(seed["inspectorId"])
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
            r = await c.post(f"/api/inspector/assignments/{aid}/accept",
                             headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 200
        assert r.json()["status"] == "expired"

    @pytest.mark.asyncio
    async def test_forbidden_different_inspector(self, seed, admin_headers, db):
        asg = await _create_offer(seed, admin_headers, db)
        other_tok = _mint_inspector_token("asg_test_other_insp")
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
            r = await c.post(f"/api/inspector/assignments/{asg['id']}/accept",
                             headers={"Authorization": f"Bearer {other_tok}"})
        assert r.status_code == 403

    @pytest.mark.asyncio
    async def test_one_job_one_accepted(self, seed, admin_headers, db):
        # Inspector A accepts first; inspector B's offer for same job should not
        # be acceptable (will become 'cancelled' as sibling).
        asg_a = await _create_offer(seed, admin_headers, db)

        insp_b = "asg_test_insp_b"
        await db.users.replace_one(
            {"_id": insp_b},
            {"_id": insp_b, "role": "inspector", "isOnline": True, "verified": True,
             "reputation": {"score": 70, "hardFloor": False, "verificationScore": 90},
             "maxJobsPerDay": 5,
             "location": {"lat": JOB_LAT, "lng": JOB_LNG}},
            upsert=True,
        )
        try:
            body = {
                "jobId": seed["jobId"], "inspectorId": insp_b,
                "customerId": seed["customerId"], "priority": "normal",
                "jobLat": JOB_LAT, "jobLng": JOB_LNG,
            }
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                r_create_b = await c.post("/api/admin/assignments/create",
                                          json=body, headers=admin_headers)
            assert r_create_b.status_code == 200
            asg_b = r_create_b.json()["assignment"]

            tok_a = _mint_inspector_token(seed["inspectorId"])
            tok_b = _mint_inspector_token(insp_b)
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                r_a = await c.post(f"/api/inspector/assignments/{asg_a['id']}/accept",
                                   headers={"Authorization": f"Bearer {tok_a}"})
                r_b = await c.post(f"/api/inspector/assignments/{asg_b['id']}/accept",
                                   headers={"Authorization": f"Bearer {tok_b}"})
            assert r_a.json()["status"] == "accepted"
            # B's offer was cancelled as sibling when A accepted → either "cancelled" or "conflict"
            assert r_b.json()["status"] in ("cancelled", "conflict"), r_b.json()

            # Exactly one accepted for the job
            accepted_count = await db.inspection_assignments.count_documents(
                {"jobId": seed["jobId"], "status": "accepted"}
            )
            assert accepted_count == 1
        finally:
            await db.users.delete_one({"_id": insp_b})
            await db.notifications.delete_many({"userId": insp_b})


# ─────────────────────────────────────────────────────────────────────
# Hard floor
# ─────────────────────────────────────────────────────────────────────

class TestHardFloor:
    @pytest.mark.asyncio
    async def test_hard_floor_blocks_without_override(self, db, admin_headers):
        insp_id = "asg_test_hf_insp"
        job_id = "asg_test_hf_job"
        await db.users.replace_one(
            {"_id": insp_id},
            {"_id": insp_id, "role": "inspector", "isOnline": True, "verified": True,
             "reputation": {"score": 30, "hardFloor": True, "verificationScore": 90},
             "maxJobsPerDay": 5, "location": {"lat": JOB_LAT, "lng": JOB_LNG}},
            upsert=True,
        )
        await db.inspection_jobs.replace_one(
            {"_id": job_id}, {"_id": job_id, "status": "pending"}, upsert=True
        )
        try:
            body = {"jobId": job_id, "inspectorId": insp_id, "priority": "normal",
                    "jobLat": JOB_LAT, "jobLng": JOB_LNG}
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                r1 = await c.post("/api/admin/assignments/create",
                                  json=body, headers=admin_headers)
            assert r1.status_code == 400, r1.text

            body["manualOverride"] = True
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                r2 = await c.post("/api/admin/assignments/create",
                                  json=body, headers=admin_headers)
            assert r2.status_code == 200, r2.text
            assert r2.json()["assignment"]["manualOverride"] is True
        finally:
            await db.users.delete_one({"_id": insp_id})
            await db.inspection_jobs.delete_one({"_id": job_id})
            await db.inspection_assignments.delete_many({"inspectorId": insp_id})
            await db.timeline_events.delete_many({"inspectorId": insp_id})
            await db.notifications.delete_many({"userId": insp_id})


# ─────────────────────────────────────────────────────────────────────
# Admin list + cancel
# ─────────────────────────────────────────────────────────────────────

class TestAdminListCancel:
    @pytest.mark.asyncio
    async def test_admin_list_filters_and_counts(self, seed, admin_headers, db):
        await _create_offer(seed, admin_headers, db)
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
            r = await c.get("/api/admin/assignments",
                            params={"status": "offered"}, headers=admin_headers)
        assert r.status_code == 200
        body = r.json()
        assert "statusCounts" in body
        for k in ("offered", "accepted", "declined", "expired", "cancelled"):
            assert k in body["statusCounts"]
        assert all(it["status"] == "offered" for it in body["items"])

    @pytest.mark.asyncio
    async def test_admin_cancel_and_409_on_accepted(self, seed, admin_headers, db):
        asg = await _create_offer(seed, admin_headers, db)
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
            r = await c.post(f"/api/admin/assignments/{asg['id']}/cancel",
                             headers=admin_headers)
        assert r.status_code == 200
        assert r.json()["status"] == "cancelled"

        # Accept another and try cancel → 409
        asg2 = await _create_offer(seed, admin_headers, db, job_id="asg_cancel_test_job2")
        tok = _mint_inspector_token(seed["inspectorId"])
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
            r_acc = await c.post(f"/api/inspector/assignments/{asg2['id']}/accept",
                                 headers={"Authorization": f"Bearer {tok}"})
            assert r_acc.json()["status"] == "accepted"
            r_cancel = await c.post(f"/api/admin/assignments/{asg2['id']}/cancel",
                                    headers=admin_headers)
        assert r_cancel.status_code == 409
        # Cleanup the secondary job
        await db.inspection_jobs.delete_one({"_id": "asg_cancel_test_job2"})
        await db.inspection_assignments.delete_many({"jobId": "asg_cancel_test_job2"})


# ─────────────────────────────────────────────────────────────────────
# Notifications regression
# ─────────────────────────────────────────────────────────────────────

class TestNotificationsRegression:
    def test_notifications_since_requires_auth(self):
        r = httpx.get(f"{BACKEND_URL}/api/notifications/since", timeout=10)
        assert r.status_code == 401

    def test_inspector_reputation_requires_auth(self):
        r = httpx.get(f"{BACKEND_URL}/api/inspector/reputation", timeout=10)
        assert r.status_code == 401

    def test_admin_reputation_ok(self, admin_headers):
        r = httpx.get(f"{BACKEND_URL}/api/admin/reputation", headers=admin_headers, timeout=10)
        assert r.status_code == 200
