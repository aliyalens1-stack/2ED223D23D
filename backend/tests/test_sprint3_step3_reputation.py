"""Sprint 3 Step 3 — Reputation Engine acceptance tests.

Covers the review-request matrix:
  - Smoke (/api/health, admin login)
  - Admin overview shape
  - Inspector endpoint auth
  - 404 on non-existent recompute target
  - Determinism: same inputs → same score, idempotent users.reputation overwrite
  - End-to-end: seeded timeline events → expected sub-metrics + hard floor
  - Tier-change timeline emit (reputation_promoted/dropped/flagged)
  - Inspector history + lazy first compute
  - Pure tier_for_score boundary checks
  - Static SPA + Step 2 regression smoke

Inspectors are seeded directly into MongoDB to avoid auth setup overhead.
JWTs are minted via issue_test_jwt from conftest.
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timezone, timedelta

import pytest
from motor.motor_asyncio import AsyncIOMotorClient

from conftest import auth_headers  # type: ignore


MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

def _iso(offset_sec: int = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=offset_sec)).isoformat()


async def _db():
    cli = AsyncIOMotorClient(MONGO_URL)
    return cli, cli[DB_NAME]


async def _seed_inspector(db, uid: str | None = None, email: str | None = None) -> str:
    uid = uid or ("rep_test_" + uuid.uuid4().hex[:10])
    email = email or f"TEST_rep_{uid}@example.local"
    await db.users.replace_one(
        {"_id": uid},
        {
            "_id": uid,
            "role": "inspector",
            "name": "TEST Inspector " + uid[-6:],
            "email": email,
            "accountKind": "inspector",
        },
        upsert=True,
    )
    return uid


async def _seed_event(db, *, kind: str, inspector_id: str,
                      report_id: str | None = None, offset: int = 0):
    ev = {
        "id": "TEST_rep_evt_" + uuid.uuid4().hex,
        "namespace": "inspector",
        "kind": kind,
        "inspectorId": inspector_id,
        "reportId": report_id,
        "severity": "info",
        "title": f"TEST {kind}",
        "text": f"TEST body {kind}",
        "actor": {"type": "system", "label": "test"},
        "metadata": {},
        "timestamp": _iso(offset),
        "createdAt": _iso(offset),
    }
    await db.timeline_events.insert_one(ev)
    return ev


async def _cleanup(db, uid: str):
    await db.users.delete_many({"_id": uid})
    await db.timeline_events.delete_many({"inspectorId": uid})
    await db.reputation_snapshots.delete_many({"userId": uid})


def _inspector_token(uid: str, email: str = "TEST_rep@example.local") -> str:
    """Mint a JWT for an inspector seeded directly in Mongo (no register)."""
    from app.core.identity_runtime import AccountView, issue_account_jwt
    av = AccountView(
        id="acct_" + uid,
        userId=uid,
        kind="inspector",
        status="active",
        displayName="TEST Insp",
        avatar=None,
        publicSlug=None,
        organizationId=None,
        legacyRole="inspector",
        isPrimary=True,
        isLegacyShim=False,
        stats={},
        capabilities=[],
    )
    return issue_account_jwt(
        user_id=uid,
        user_email=email,
        legacy_role="inspector",
        account=av,
        days_valid=1,
    )


# ─────────────────────────────────────────────────────────────────────
# Smoke + auth
# ─────────────────────────────────────────────────────────────────────
class TestSmoke:
    @pytest.mark.asyncio
    async def test_health(self, client):
        r = await client.get("/api/health")
        assert r.status_code == 200
        body = r.json()
        assert body.get("status") == "ok"
        assert body.get("db") == "connected"

    @pytest.mark.asyncio
    async def test_admin_login(self, client):
        r = await client.post(
            "/api/auth/login",
            json={"email": "admin@autoservice.com", "password": "Admin123!"},
        )
        assert r.status_code == 200
        assert "accessToken" in r.json()

    @pytest.mark.asyncio
    async def test_admin_spa_serves(self, client):
        r = await client.get("/api/admin-panel/")
        assert r.status_code in (200, 301, 302, 307, 308)

    @pytest.mark.asyncio
    async def test_admin_spa_reputation_route(self, client):
        # Hash routing — same index.html served
        r = await client.get("/api/admin-panel/reputation")
        assert r.status_code in (200, 301, 302, 307, 308, 404)

    @pytest.mark.asyncio
    async def test_web_spa_serves(self, client):
        r = await client.get("/api/web-app/")
        assert r.status_code in (200, 301, 302, 307, 308, 404)

    @pytest.mark.asyncio
    async def test_step2_regression_notifications_since_requires_auth(self, client):
        r = await client.get("/api/notifications/since")
        assert r.status_code in (401, 403)


# ─────────────────────────────────────────────────────────────────────
# Pure tier_for_score boundaries
# ─────────────────────────────────────────────────────────────────────
class TestPureTier:
    def test_tier_boundaries(self):
        from app.reputation.engine import tier_for_score
        assert tier_for_score(0) == "bronze"
        assert tier_for_score(39) == "bronze"
        assert tier_for_score(40) == "silver"
        assert tier_for_score(64) == "silver"
        assert tier_for_score(65) == "gold"
        assert tier_for_score(84) == "gold"
        assert tier_for_score(85) == "platinum"
        assert tier_for_score(100) == "platinum"

    def test_cap_tier(self):
        from app.reputation.engine import cap_tier
        assert cap_tier("platinum", "silver") == "silver"
        assert cap_tier("gold", "silver") == "silver"
        assert cap_tier("silver", "silver") == "silver"
        assert cap_tier("bronze", "silver") == "bronze"

    def test_compute_score_neutral(self):
        from app.reputation.engine import compute_score, SUB_METRIC_KEYS
        # All defaults (sparse) -> 100
        assert compute_score({k: 100 for k in SUB_METRIC_KEYS}) == 100
        assert compute_score({k: 0 for k in SUB_METRIC_KEYS}) == 0


# ─────────────────────────────────────────────────────────────────────
# Admin endpoints — auth + shape
# ─────────────────────────────────────────────────────────────────────
class TestAdminEndpoints:
    @pytest.mark.asyncio
    async def test_admin_overview_requires_admin(self, client):
        r = await client.get("/api/admin/reputation")
        assert r.status_code in (401, 403)

    @pytest.mark.asyncio
    async def test_admin_overview_shape(self, client, admin_token):
        r = await client.get(
            "/api/admin/reputation",
            headers=auth_headers(admin_token),
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert isinstance(body.get("top"), list)
        assert isinstance(body.get("risky"), list)
        assert isinstance(body.get("flaggedTotal"), int)
        tc = body.get("tierCounts")
        assert isinstance(tc, dict)
        for t in ("bronze", "silver", "gold", "platinum"):
            assert t in tc
            assert isinstance(tc[t], int)

    @pytest.mark.asyncio
    async def test_recompute_nonexistent_404(self, client, admin_token):
        r = await client.post(
            "/api/admin/reputation/recompute/__no_such_user__",
            headers=auth_headers(admin_token),
        )
        assert r.status_code == 404

    @pytest.mark.asyncio
    async def test_recompute_requires_admin(self, client):
        r = await client.post("/api/admin/reputation/recompute/anyone")
        assert r.status_code in (401, 403)


# ─────────────────────────────────────────────────────────────────────
# Inspector endpoint auth
# ─────────────────────────────────────────────────────────────────────
class TestInspectorAuth:
    @pytest.mark.asyncio
    async def test_inspector_reputation_requires_auth(self, client):
        r = await client.get("/api/inspector/reputation")
        assert r.status_code in (401, 403)

    @pytest.mark.asyncio
    async def test_inspector_history_requires_auth(self, client):
        r = await client.get("/api/inspector/reputation/history")
        assert r.status_code in (401, 403)


# ─────────────────────────────────────────────────────────────────────
# Determinism + idempotent overwrite
# ─────────────────────────────────────────────────────────────────────
class TestDeterminism:
    @pytest.mark.asyncio
    async def test_recompute_twice_same_score_and_overwrite(self, client, admin_token):
        cli, db = await _db()
        uid = await _seed_inspector(db)
        try:
            r1 = await client.post(
                f"/api/admin/reputation/recompute/{uid}",
                headers=auth_headers(admin_token),
            )
            assert r1.status_code == 200, r1.text
            b1 = r1.json()["reputation"]
            score1 = b1["score"]
            tier1 = b1["tier"]
            # All 7 sub-metrics + meta fields present
            for k in (
                "inspectionQuality", "evidenceCompleteness", "customerAcceptance",
                "disputeRate", "aiAlignment", "responseDiscipline", "verificationScore",
            ):
                assert k in b1
            assert "score" in b1 and "tier" in b1 and "computedAt" in b1

            # Brand-new inspector with no events -> SPARSE_DEFAULT=100 everywhere
            assert score1 == 100
            assert tier1 == "platinum"

            r2 = await client.post(
                f"/api/admin/reputation/recompute/{uid}",
                headers=auth_headers(admin_token),
            )
            assert r2.status_code == 200
            b2 = r2.json()["reputation"]
            # Same inputs → same score
            assert b2["score"] == score1
            assert b2["tier"] == tier1

            # users.reputation should hold ONE doc (idempotent $set)
            doc = await db.users.find_one({"_id": uid}, {"reputation": 1})
            assert doc and isinstance(doc.get("reputation"), dict)
            assert doc["reputation"]["score"] == score1

            # reputation_snapshots is append-only → should grow
            n_snaps = await db.reputation_snapshots.count_documents({"userId": uid})
            assert n_snaps >= 2, f"history should grow, got {n_snaps}"
        finally:
            await _cleanup(db, uid)
            cli.close()


# ─────────────────────────────────────────────────────────────────────
# End-to-end seeded timeline → expected score + hard floor
# ─────────────────────────────────────────────────────────────────────
class TestEndToEndSeeded:
    @pytest.mark.asyncio
    async def test_seeded_events_and_hard_floor(self, client, admin_token):
        cli, db = await _db()
        uid = await _seed_inspector(db)
        try:
            # 5 submitted, 3 approved, 1 rejected
            for i in range(5):
                await _seed_event(db, kind="report_submitted", inspector_id=uid,
                                  report_id=f"TEST_r_{i}")
            for i in range(3):
                await _seed_event(db, kind="report_approved", inspector_id=uid,
                                  report_id=f"TEST_r_{i}")
            await _seed_event(db, kind="report_rejected", inspector_id=uid,
                              report_id="TEST_r_3")
            # 2 customer_accepted, 1 customer_disputed (no later accepted → open)
            await _seed_event(db, kind="customer_accepted", inspector_id=uid,
                              report_id="TEST_r_0")
            await _seed_event(db, kind="customer_accepted", inspector_id=uid,
                              report_id="TEST_r_1")
            await _seed_event(db, kind="customer_disputed", inspector_id=uid,
                              report_id="TEST_r_dispute_open")

            r = await client.post(
                f"/api/admin/reputation/recompute/{uid}",
                headers=auth_headers(admin_token),
            )
            assert r.status_code == 200, r.text
            snap = r.json()["reputation"]

            # inspectionQuality = approved/submitted = 3/5 → 60
            assert snap["inspectionQuality"] == 60, snap
            # customerAcceptance = accepted/(accepted+disputed) = 2/3 → 67
            assert snap["customerAcceptance"] == 67, snap
            # disputeRate (inverse) = 100 - round(100*1/3) = 67
            assert snap["disputeRate"] == 67, snap
            # Hard floor active
            assert snap["hardFloor"] is True
            assert snap["hardFloorReason"] == "open_dispute"
            # rawTier may be >= silver but capped at silver
            assert snap["tier"] == "silver"

            # Timeline should contain reputation_flagged (first activation)
            # OR reputation_dropped/promoted depending on prev_tier
            flagged = await db.timeline_events.count_documents({
                "inspectorId": uid,
                "kind": {"$in": [
                    "reputation_flagged", "reputation_promoted", "reputation_dropped",
                ]},
            })
            assert flagged >= 1, "Tier/floor change must emit a reputation_* event"
        finally:
            await _cleanup(db, uid)
            cli.close()

    @pytest.mark.asyncio
    async def test_resolved_dispute_clears_hard_floor(self, client, admin_token):
        """A later customer_accepted on the same reportId resolves the open dispute."""
        cli, db = await _db()
        uid = await _seed_inspector(db)
        try:
            # Disputed at t-60, accepted at t-10 on same reportId
            await _seed_event(db, kind="customer_disputed", inspector_id=uid,
                              report_id="TEST_r_resolved", offset=-60)
            await _seed_event(db, kind="customer_accepted", inspector_id=uid,
                              report_id="TEST_r_resolved", offset=-10)
            r = await client.post(
                f"/api/admin/reputation/recompute/{uid}",
                headers=auth_headers(admin_token),
            )
            assert r.status_code == 200
            snap = r.json()["reputation"]
            assert snap["hardFloor"] is False, snap


        finally:
            await _cleanup(db, uid)
            cli.close()


# ─────────────────────────────────────────────────────────────────────
# Inspector endpoints with a real token (lazy first compute, history)
# ─────────────────────────────────────────────────────────────────────
class TestInspectorEndpoints:
    @pytest.mark.asyncio
    async def test_lazy_first_compute_returns_neutral_for_fresh_inspector(self, client):
        cli, db = await _db()
        uid = await _seed_inspector(db)
        try:
            token = _inspector_token(uid)
            r = await client.get(
                "/api/inspector/reputation",
                headers=auth_headers(token),
            )
            assert r.status_code == 200, r.text
            body = r.json()
            assert "reputation" in body and "coaching" in body
            rep = body["reputation"]
            assert rep["score"] == 100
            assert rep["tier"] == "platinum"
            # all sub-metrics neutral
            for k in (
                "inspectionQuality", "evidenceCompleteness", "customerAcceptance",
                "disputeRate", "aiAlignment", "responseDiscipline", "verificationScore",
            ):
                assert rep[k] == 100, k
            # Coaching: nothing hurts, all helps (>=85)
            assert isinstance(body["coaching"].get("hurts"), list)
            assert isinstance(body["coaching"].get("helps"), list)
            assert len(body["coaching"]["hurts"]) == 0
        finally:
            await _cleanup(db, uid)
            cli.close()

    @pytest.mark.asyncio
    async def test_history_sorted_desc(self, client, admin_token):
        cli, db = await _db()
        uid = await _seed_inspector(db)
        try:
            # Two recomputes → two history rows
            for _ in range(2):
                await client.post(
                    f"/api/admin/reputation/recompute/{uid}",
                    headers=auth_headers(admin_token),
                )
                await asyncio.sleep(0.01)
            token = _inspector_token(uid)
            r = await client.get(
                "/api/inspector/reputation/history",
                headers=auth_headers(token),
            )
            assert r.status_code == 200
            body = r.json()
            items = body.get("items", [])
            assert len(items) >= 2
            # sorted by computedAt desc
            cas = [it["computedAt"] for it in items]
            assert cas == sorted(cas, reverse=True), cas
            # required keys per item
            for it in items:
                assert "score" in it and "tier" in it
                assert "computedAt" in it and "subMetrics" in it
        finally:
            await _cleanup(db, uid)
            cli.close()
