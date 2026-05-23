"""Sprint 2 Step 5 follow-up — status-class-aware idempotency policy.

Verifies the new policy lives in /app/backend/prod_readiness.py and is wired
through the middleware in /app/backend/server.py:

    2xx  → cached for IDEMPOTENCY_TTL_HOURS (24h)
    4xx  → cached for IDEMPOTENCY_4XX_TTL_SECONDS (90s)
    5xx  → placeholder DELETED (no caching)

Response headers on a replay:
    x-idempotent-replay: true
    x-idempotent-status-class: 2xx | 4xx
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timezone, timedelta

import pytest
import requests
from dotenv import dotenv_values


BASE_URL = os.environ.get(
    "BACKEND_URL",
    "https://platform-mobile-hub.preview.emergentagent.com",
).rstrip("/")

ADMIN_EMAIL = "admin@autoservice.com"
ADMIN_PASSWORD = "Admin123!"


# ────────────────────────────────────────────────────────────────────
# Fixtures
# ────────────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def admin_token(session: requests.Session) -> str:
    r = session.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=15,
    )
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text[:200]}"
    j = r.json()
    tok = j.get("accessToken") or j.get("token") or j.get("access_token")
    assert tok, f"no token in admin login response: {j}"
    return tok


@pytest.fixture(scope="module")
def mongo_db():
    env = dotenv_values("/app/backend/.env")
    mongo_url = env.get("MONGO_URL") or os.environ.get("MONGO_URL")
    db_name = env.get("DB_NAME") or os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        pytest.skip("MONGO_URL/DB_NAME not available")
    from pymongo import MongoClient
    client = MongoClient(mongo_url, serverSelectionTimeoutMS=5000)
    yield client[db_name]
    client.close()


def _parse_expires(value):
    """Mongo stored expiresAt may be datetime, ISO string, or BSON date."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except Exception:
            return None
    return None


def _parse_created(value):
    return _parse_expires(value)


# ────────────────────────────────────────────────────────────────────
# 2xx policy — durable 24h cache
# ────────────────────────────────────────────────────────────────────
class TestPolicy2xx:
    def test_2xx_cached_24h_with_replay_headers(self, session, mongo_db):
        key = f"TEST_idem_2xx_{uuid.uuid4().hex}"
        url = f"{BASE_URL}/api/marketplace/quick-request"
        body = {
            "cityKey": "berlin",
            "serviceKey": "car_wash",
            "contact": {"name": "TEST_policy", "phone": "+491234567890"},
        }
        headers = {"Idempotency-Key": key, "Content-Type": "application/json"}

        r1 = session.post(url, json=body, headers=headers, timeout=20)
        assert 200 <= r1.status_code < 300, f"r1 not 2xx: {r1.status_code} {r1.text[:200]}"
        # No replay header on the first response
        assert r1.headers.get("x-idempotent-replay") != "true"

        r2 = session.post(url, json=body, headers=headers, timeout=20)
        assert r2.status_code == r1.status_code
        assert r2.headers.get("x-idempotent-replay") == "true"
        assert r2.headers.get("x-idempotent-status-class") == "2xx"
        assert r2.json() == r1.json(), "cached body must match first response"

        # Mongo: expiresAt ≈ 24h from createdAt
        rec = mongo_db.idempotency_keys.find_one({"key": key})
        assert rec is not None, "idempotency record missing in mongo"
        assert rec.get("status") == "completed"
        assert rec.get("statusCode") == r1.status_code
        created = _parse_created(rec.get("createdAt"))
        expires = _parse_expires(rec.get("expiresAt"))
        assert created and expires, f"createdAt/expiresAt missing: {rec}"
        delta = (expires - created).total_seconds()
        # Allow generous tolerance — 23h..25h window
        assert 23 * 3600 <= delta <= 25 * 3600, (
            f"2xx TTL must be ~24h; got {delta}s"
        )


# ────────────────────────────────────────────────────────────────────
# 4xx policy — short 90s cache (NOT 24h)
# ────────────────────────────────────────────────────────────────────
class TestPolicy4xx:
    def test_4xx_cached_short_with_replay_headers(self, session, admin_token, mongo_db):
        key = f"TEST_idem_4xx_{uuid.uuid4().hex}"
        fake_id = f"nonexistent-{uuid.uuid4().hex[:10]}"
        url = f"{BASE_URL}/api/inspector/jobs/{fake_id}/draft"
        headers = {
            "Authorization": f"Bearer {admin_token}",
            "Idempotency-Key": key,
            "Content-Type": "application/json",
        }
        body = {"trigger": "manual"}

        r1 = session.post(url, json=body, headers=headers, timeout=20)
        assert 400 <= r1.status_code < 500, f"expected 4xx on first call: {r1.status_code}"

        r2 = session.post(url, json=body, headers=headers, timeout=20)
        assert r2.status_code == r1.status_code, (
            f"replay must return same 4xx (NOT 409); r1={r1.status_code} r2={r2.status_code} body={r2.text[:200]}"
        )
        assert r2.headers.get("x-idempotent-replay") == "true"
        assert r2.headers.get("x-idempotent-status-class") == "4xx"

        rec = mongo_db.idempotency_keys.find_one({"key": key})
        assert rec is not None
        assert rec.get("status") == "completed"
        assert rec.get("statusCode") == r1.status_code
        created = _parse_created(rec.get("createdAt"))
        expires = _parse_expires(rec.get("expiresAt"))
        assert created and expires, f"missing timestamps: {rec}"
        delta = (expires - created).total_seconds()
        # Must be ~90s, certainly under 120s, NOT 24h
        assert delta < 120, f"4xx TTL must be short (<120s), got {delta}s — 24h bug regression!"
        assert 60 <= delta <= 120, f"4xx TTL should be ~90s, got {delta}s"

    def test_4xx_retry_recovery_after_expiry(self, session, admin_token, mongo_db):
        """After expiresAt is in the past, the same key on the same endpoint
        must run the handler fresh (defensive expiry filter in lookup)."""
        key = f"TEST_idem_4xx_expire_{uuid.uuid4().hex}"
        fake_id = f"nonexistent-{uuid.uuid4().hex[:10]}"
        url = f"{BASE_URL}/api/inspector/jobs/{fake_id}/draft"
        headers = {
            "Authorization": f"Bearer {admin_token}",
            "Idempotency-Key": key,
            "Content-Type": "application/json",
        }
        body = {"trigger": "manual"}

        r1 = session.post(url, json=body, headers=headers, timeout=20)
        assert 400 <= r1.status_code < 500
        rec = mongo_db.idempotency_keys.find_one({"key": key})
        assert rec is not None

        # Force expiresAt into the past — simulate replay after TTL
        past = datetime.now(timezone.utc) - timedelta(seconds=5)
        mongo_db.idempotency_keys.update_one({"key": key}, {"$set": {"expiresAt": past}})

        r2 = session.post(url, json=body, headers=headers, timeout=20)
        # Must NOT be a replay — defensive filter treats expired as gone
        assert r2.headers.get("x-idempotent-replay") != "true", (
            f"expired 4xx record must not replay; headers={dict(r2.headers)}"
        )
        # Status will likely be same 4xx because the underlying condition
        # (no such job) hasn't changed — what matters is that handler ran
        # again. Verify by checking a fresh record exists with new createdAt.
        rec2 = mongo_db.idempotency_keys.find_one({"key": key})
        assert rec2 is not None
        new_created = _parse_created(rec2.get("createdAt"))
        old_created = _parse_created(rec.get("createdAt"))
        assert new_created and old_created
        assert new_created > old_created, (
            f"expected fresh record after expiry; old={old_created} new={new_created}"
        )


# ────────────────────────────────────────────────────────────────────
# 5xx policy — placeholder must be deleted
# Tested via direct import of idempotency_commit (5xx is hard to engineer
# reliably from a live endpoint).
# ────────────────────────────────────────────────────────────────────
class TestPolicy5xx:
    def test_5xx_purges_placeholder(self, mongo_db):
        from prod_readiness import idempotency_commit

        key = f"TEST_idem_5xx_{uuid.uuid4().hex}"
        # Seed an in_progress record (as middleware would)
        now = datetime.now(timezone.utc)
        mongo_db.idempotency_keys.insert_one({
            "key": key,
            "path": "/api/payments",
            "method": "POST",
            "status": "in_progress",
            "createdAt": now.isoformat(),
            "expiresAt": now + timedelta(hours=24),
        })
        assert mongo_db.idempotency_keys.find_one({"key": key}) is not None

        # Build a minimal Request-like object that exposes only what
        # idempotency_commit reads: headers (idempotency-key), url.path, method.
        class _URL:
            path = "/api/payments"

        class _Req:
            headers = {"idempotency-key": key}
            url = _URL()
            method = "POST"

        # Async motor DB is required by idempotency_commit — use the same
        # AsyncIOMotorClient pattern as production.
        from motor.motor_asyncio import AsyncIOMotorClient
        env = dotenv_values("/app/backend/.env")
        mongo_url = env.get("MONGO_URL")
        db_name = env.get("DB_NAME")
        async_client = AsyncIOMotorClient(mongo_url)
        async_db = async_client[db_name]

        async def _run():
            await idempotency_commit(async_db, _Req(), 500, b'{"error":"boom"}')

        asyncio.get_event_loop().run_until_complete(_run())
        async_client.close()

        # Record must be GONE
        rec = mongo_db.idempotency_keys.find_one({"key": key})
        assert rec is None, f"5xx must purge placeholder; still present: {rec}"


# ────────────────────────────────────────────────────────────────────
# Concurrency — second simultaneous request must get 409 IDEMPOTENCY_IN_PROGRESS
# ────────────────────────────────────────────────────────────────────
class TestConcurrencyInProgress:
    def test_parallel_requests_one_gets_409(self, session, admin_token):
        """The slow endpoint /api/marketplace/quick-request takes long
        enough that two concurrent POSTs with the same Idempotency-Key
        should observe the in_progress placeholder.

        We use 5 parallel attempts to maximise the chance of overlap.
        At least one must succeed (2xx OR cached 2xx replay), and at
        least one of the others must be 409 IDEMPOTENCY_IN_PROGRESS
        OR a cached replay — never two raw handler executions.
        """
        import concurrent.futures
        key = f"TEST_idem_concurrent_{uuid.uuid4().hex}"
        url = f"{BASE_URL}/api/marketplace/quick-request"
        body = {
            "cityKey": "berlin",
            "serviceKey": "car_wash",
            "contact": {"name": "TEST_concurrent", "phone": "+491234567891"},
        }
        headers = {"Idempotency-Key": key, "Content-Type": "application/json"}

        def _fire():
            return requests.post(url, json=body, headers=headers, timeout=20)

        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
            results = list(ex.map(lambda _: _fire(), range(5)))

        statuses = [r.status_code for r in results]
        replays = [r.headers.get("x-idempotent-replay") == "true" for r in results]
        in_progress_count = sum(1 for r in results
                                if r.status_code == 409
                                and r.json().get("code") == "IDEMPOTENCY_IN_PROGRESS")
        success_count = sum(1 for s in statuses if 200 <= s < 300)

        # Sanity: no responses dropped or corrupted
        assert all(s in (200, 201, 202, 409) for s in statuses), (
            f"unexpected status codes: {statuses}"
        )
        # At least one must succeed
        assert success_count >= 1, f"no successful response among parallel: {statuses}"
        # Either we got at least one IDEMPOTENCY_IN_PROGRESS,
        # OR all subsequent calls were cached replays (also acceptable).
        cached_replays = sum(1 for x in replays if x)
        assert in_progress_count + cached_replays >= 1, (
            f"no dedupe observed across parallel; statuses={statuses} replays={replays}"
        )


# ────────────────────────────────────────────────────────────────────
# Regression — health, admin login, audit endpoint
# ────────────────────────────────────────────────────────────────────
class TestRegression:
    def test_health(self, session):
        r = session.get(f"{BASE_URL}/api/health", timeout=10)
        assert r.status_code == 200, r.text[:200]

    def test_admin_login(self, session):
        r = session.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
            timeout=15,
        )
        assert r.status_code == 200
        j = r.json()
        assert j.get("accessToken") or j.get("token") or j.get("access_token")

    def test_offline_replay_log_audit_endpoint(self, session, admin_token):
        r = session.get(
            f"{BASE_URL}/api/admin/offline-replay/recent?limit=5",
            headers={"Authorization": f"Bearer {admin_token}"},
            timeout=10,
        )
        assert r.status_code == 200
        body = r.json()
        assert "items" in body
