"""Sprint 3 Step 2 — Notifications projector + polling endpoints.

Coverage (acceptance criteria from review request):
  1. Deterministic projection — same timeline event → same rows
  2. Unread counter stable
  3. /api/notifications/since?after=ISO strict createdAt > after
  4. mark-read atomic + idempotent (writes readAt, filters isRead:False)
  5. No dup rows after replay — unique partial index (userId, sourceTimelineId)
  6. Restart-safe — indexes created in lifespan
  7. Zero regressions on legacy /api/notifications
  8. customer_disputed now also creates inspector notif
  9. Smoke: admin SPA + web SPA static serving
"""
from __future__ import annotations

import os
import time
import uuid
from datetime import datetime, timezone, timedelta

import httpx
import pytest
from motor.motor_asyncio import AsyncIOMotorClient

from conftest import auth_headers, BACKEND_URL, _sync_post  # type: ignore


MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


def _mk_user() -> dict:
    email = f"notif-{int(time.time()*1000)}-{uuid.uuid4().hex[:6]}@test.local"
    body = _sync_post(
        "/api/auth/register",
        {
            "email": email, "password": "test1234",
            "firstName": "Notif", "lastName": "User",
            "role": "provider_owner",
        },
    )
    body["_email"] = email
    return body


async def _db():
    cli = AsyncIOMotorClient(MONGO_URL)
    return cli, cli[DB_NAME]


def _iso_now(offset_sec: int = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=offset_sec)).isoformat()


async def _seed_timeline_event(db, *, kind: str, inspector_id: str | None = None,
                               metadata: dict | None = None) -> dict:
    """Insert a synthetic timeline_events row that the projector can pick up."""
    ev = {
        "id": "TEST_tl_" + uuid.uuid4().hex,
        "kind": kind,
        "inspectorId": inspector_id,
        "metadata": metadata or {},
        "severity": "info",
        "title": f"TEST event {kind}",
        "text": f"TEST body for {kind}",
        "timestamp": _iso_now(),
        "createdAt": _iso_now(),
        "actor": {"type": "system", "label": "test"},
    }
    await db.timeline_events.insert_one(dict(ev))
    return ev


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
        r = await client.post("/api/auth/login",
                              json={"email": "admin@autoservice.com",
                                    "password": "Admin123!"})
        assert r.status_code == 200
        assert "accessToken" in r.json()

    @pytest.mark.asyncio
    async def test_admin_spa_serves(self, client):
        r = await client.get("/api/admin-panel/")
        # Either 200 (built SPA) or 404 if build missing — but should not 5xx
        assert r.status_code in (200, 301, 302, 307, 308, 404), r.text[:200]

    @pytest.mark.asyncio
    async def test_web_spa_serves(self, client):
        r = await client.get("/api/web-app/")
        assert r.status_code in (200, 301, 302, 307, 308, 404), r.text[:200]


# ─────────────────────────────────────────────────────────────────────
# /api/notifications/unread-count
# ─────────────────────────────────────────────────────────────────────
class TestUnreadCount:
    @pytest.mark.asyncio
    async def test_unread_count_401_no_token(self, client):
        r = await client.get("/api/notifications/unread-count")
        assert r.status_code in (401, 403)

    @pytest.mark.asyncio
    async def test_unread_count_zero_on_fresh_user(self, client):
        u = _mk_user()
        r = await client.get("/api/notifications/unread-count",
                             headers=auth_headers(u["accessToken"]))
        assert r.status_code == 200
        body = r.json()
        assert "unread" in body
        assert isinstance(body["unread"], int)
        assert body["unread"] == 0


# ─────────────────────────────────────────────────────────────────────
# /api/notifications/since — polling endpoint with strict `after` filter
# ─────────────────────────────────────────────────────────────────────
class TestSincePolling:
    @pytest.mark.asyncio
    async def test_since_without_after_returns_envelope(self, client):
        u = _mk_user()
        r = await client.get("/api/notifications/since",
                             headers=auth_headers(u["accessToken"]))
        assert r.status_code == 200
        body = r.json()
        assert "items" in body and isinstance(body["items"], list)
        assert "unread" in body and isinstance(body["unread"], int)
        assert "serverTime" in body

    @pytest.mark.asyncio
    async def test_since_after_strict_gt(self, client):
        """after=ISO must filter strict createdAt > after (not >=)."""
        u = _mk_user()
        uid_v = u["user"]["id"]
        cli, db = await _db()
        try:
            ts_a = _iso_now(-60)
            ts_b = _iso_now(-30)
            ts_c = _iso_now(-10)
            # Three notifications at three timestamps
            for ts in (ts_a, ts_b, ts_c):
                await db.notifications.insert_one({
                    "id": "TEST_n_" + uuid.uuid4().hex,
                    "userId": uid_v,
                    "type": "test", "kind": "test",
                    "title": "T", "body": "B", "text": "B",
                    "severity": "info", "metadata": {},
                    "isRead": False, "readAt": None,
                    "createdAt": ts,
                })
            # after = ts_b → must return only ts_c (strict >)
            # NOTE: use params= (not f-string) so httpx URL-encodes the '+' in
            # the timezone offset. Without encoding the '+' decodes to space
            # server-side and the comparison string becomes lexicographically
            # smaller, breaking the strict-gt filter.
            r = await client.get(
                "/api/notifications/since",
                params={"after": ts_b, "limit": 50},
                headers=auth_headers(u["accessToken"]),
            )
            assert r.status_code == 200
            items = r.json()["items"]
            assert len(items) == 1, f"strict > expected 1 item, got {len(items)}: {[i['createdAt'] for i in items]}"
            assert items[0]["createdAt"] == ts_c
            assert r.json()["unread"] == 3
        finally:
            await db.notifications.delete_many({"userId": uid_v})
            cli.close()


# ─────────────────────────────────────────────────────────────────────
# Idempotency & deterministic projection via backfill
# ─────────────────────────────────────────────────────────────────────
class TestProjectionIdempotency:
    @pytest.mark.asyncio
    async def test_backfill_requires_admin(self, client):
        r = await client.post("/api/admin/notifications/backfill")
        assert r.status_code in (401, 403)

    @pytest.mark.asyncio
    async def test_unique_index_present(self):
        cli, db = await _db()
        try:
            idx = await db.notifications.index_information()
            # Index name `proj_unique_user_source` from projector.ensure_indexes
            assert "proj_unique_user_source" in idx, (
                f"Unique partial index missing. Have: {list(idx.keys())}"
            )
            info = idx["proj_unique_user_source"]
            assert info.get("unique") is True
            # Partial filter expression must scope to sourceTimelineId rows
            pfe = info.get("partialFilterExpression")
            assert pfe and "sourceTimelineId" in pfe
        finally:
            cli.close()

    @pytest.mark.asyncio
    async def test_backfill_creates_then_idempotent_replay(self, client, admin_token):
        u = _mk_user()
        uid_v = u["user"]["id"]
        cli, db = await _db()
        try:
            # Insert a synthetic timeline event whose recipient is our user.
            ev = await _seed_timeline_event(
                db, kind="verification_approved", inspector_id=uid_v,
                metadata={"docId": "TEST_doc"},
            )

            # First backfill — should insert at least 1 notification for us
            r1 = await client.post(
                "/api/admin/notifications/backfill?limit=2000",
                headers=auth_headers(admin_token),
            )
            assert r1.status_code == 200, r1.text
            body1 = r1.json()
            assert "scanned" in body1 and "inserted" in body1
            assert body1["scanned"] >= 1
            first_insert = body1["inserted"]
            assert first_insert >= 1

            # Verify a notification row exists pointing at this event for our user
            row = await db.notifications.find_one(
                {"userId": uid_v, "sourceTimelineId": ev["id"]}
            )
            assert row is not None
            assert row["kind"] == "verification_approved"
            assert row["isRead"] is False
            assert row["readAt"] is None
            assert "title" in row and "body" in row

            # Deterministic: re-running backfill must NOT create dup row for us
            r2 = await client.post(
                "/api/admin/notifications/backfill?limit=2000",
                headers=auth_headers(admin_token),
            )
            assert r2.status_code == 200
            # Count rows for our user/source — must be exactly 1
            same = await db.notifications.count_documents(
                {"userId": uid_v, "sourceTimelineId": ev["id"]}
            )
            assert same == 1, f"Idempotency violated: {same} rows for one event"

            # Unread count for user should reflect projection
            ru = await client.get("/api/notifications/unread-count",
                                  headers=auth_headers(u["accessToken"]))
            assert ru.status_code == 200
            assert ru.json()["unread"] >= 1
        finally:
            await db.notifications.delete_many({"userId": uid_v})
            await db.timeline_events.delete_many({"inspectorId": uid_v})
            cli.close()

    @pytest.mark.asyncio
    async def test_customer_disputed_projects_to_inspector(self, client, admin_token):
        """Recent fix: customer_disputed added to INSPECTOR_KINDS."""
        u = _mk_user()
        uid_v = u["user"]["id"]
        cli, db = await _db()
        try:
            ev = await _seed_timeline_event(
                db, kind="customer_disputed", inspector_id=uid_v,
                metadata={"jobId": "TEST_job_" + uuid.uuid4().hex},
            )
            r = await client.post(
                "/api/admin/notifications/backfill?limit=2000",
                headers=auth_headers(admin_token),
            )
            assert r.status_code == 200
            row = await db.notifications.find_one(
                {"userId": uid_v, "sourceTimelineId": ev["id"]}
            )
            assert row is not None, "customer_disputed must project to inspector"
            assert row["kind"] == "customer_disputed"
        finally:
            await db.notifications.delete_many({"userId": uid_v})
            await db.timeline_events.delete_many({"inspectorId": uid_v})
            cli.close()


# ─────────────────────────────────────────────────────────────────────
# mark-read atomic + idempotent (writes readAt, filters isRead:False)
# ─────────────────────────────────────────────────────────────────────
class TestMarkRead:
    @pytest.mark.asyncio
    async def test_mark_read_twice_idempotent_with_readAt(self, client):
        u = _mk_user()
        uid_v = u["user"]["id"]
        cli, db = await _db()
        try:
            nid = "TEST_n_" + uuid.uuid4().hex
            await db.notifications.insert_one({
                "id": nid, "userId": uid_v,
                "type": "test", "kind": "test",
                "title": "T", "body": "B",
                "isRead": False, "readAt": None,
                "createdAt": _iso_now(),
            })

            r1 = await client.post(f"/api/notifications/{nid}/read",
                                   headers=auth_headers(u["accessToken"]))
            assert r1.status_code == 200, r1.text
            body1 = r1.json()
            assert body1.get("ok") is True
            assert body1.get("alreadyRead") in (None, False)

            # readAt must be persisted
            row = await db.notifications.find_one({"id": nid})
            assert row["isRead"] is True
            assert row["readAt"] is not None and isinstance(row["readAt"], str)

            # Second call: still 200, alreadyRead=true
            r2 = await client.post(f"/api/notifications/{nid}/read",
                                   headers=auth_headers(u["accessToken"]))
            assert r2.status_code == 200
            body2 = r2.json()
            assert body2.get("ok") is True
            assert body2.get("alreadyRead") is True
        finally:
            await db.notifications.delete_many({"userId": uid_v})
            cli.close()

    @pytest.mark.asyncio
    async def test_mark_read_nonexistent_returns_404(self, client):
        u = _mk_user()
        r = await client.post(
            "/api/notifications/__doesnotexist__/read",
            headers=auth_headers(u["accessToken"]),
        )
        assert r.status_code == 404

    @pytest.mark.asyncio
    async def test_read_all_idempotent_modified_zero_second(self, client):
        u = _mk_user()
        uid_v = u["user"]["id"]
        cli, db = await _db()
        try:
            # Seed 3 unread for this user
            for _ in range(3):
                await db.notifications.insert_one({
                    "id": "TEST_n_" + uuid.uuid4().hex,
                    "userId": uid_v,
                    "type": "test", "kind": "test",
                    "title": "T", "body": "B",
                    "isRead": False, "readAt": None,
                    "createdAt": _iso_now(),
                })

            r1 = await client.post("/api/notifications/read-all",
                                   headers=auth_headers(u["accessToken"]))
            assert r1.status_code == 200, r1.text
            b1 = r1.json()
            assert b1.get("ok") is True
            assert b1.get("modified") == 3

            r2 = await client.post("/api/notifications/read-all",
                                   headers=auth_headers(u["accessToken"]))
            assert r2.status_code == 200
            assert r2.json().get("modified") == 0

            # All rows have readAt set
            cnt = await db.notifications.count_documents(
                {"userId": uid_v, "readAt": {"$ne": None}, "isRead": True}
            )
            assert cnt == 3
        finally:
            await db.notifications.delete_many({"userId": uid_v})
            cli.close()


# ─────────────────────────────────────────────────────────────────────
# Legacy /api/notifications regression
# ─────────────────────────────────────────────────────────────────────
class TestLegacyEndpoint:
    @pytest.mark.asyncio
    async def test_legacy_list_envelope_intact(self, client):
        u = _mk_user()
        r = await client.get("/api/notifications",
                             headers=auth_headers(u["accessToken"]))
        assert r.status_code == 200
        body = r.json()
        assert "notifications" in body and isinstance(body["notifications"], list)
        assert "unread" in body and isinstance(body["unread"], int)

    @pytest.mark.asyncio
    async def test_legacy_requires_auth(self, client):
        r = await client.get("/api/notifications")
        assert r.status_code in (401, 403)
