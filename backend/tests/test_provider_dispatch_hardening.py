"""Provider Dispatch Hardening + Action Idempotency — backend tests.

Sprint scope coverage:
  1. Ownership check          — foreign booking → 403
  2. Atomic transition guard  — invalid transition → 409
  3. Diagnostics              — missing booking → 404, missing auth → 401
  4. Side-effects only on real transition — same-state replay is silent
  5. Idempotency-Key          — repeat with same key returns cached envelope
                                without re-firing side-effects; collision → 409

Each test seeds its own booking with `id = "bk-test-<uuid>"` so suites can
run in parallel and tests are independent.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import httpx
import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient

from tests.conftest import BACKEND_URL, BYPASS_HEADERS, auth_headers


# ─────────────────────────────────────────────────────────────────
# DB helper — direct Mongo access for fixture seeding + assertions
# ─────────────────────────────────────────────────────────────────

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


@pytest_asyncio.fixture
async def mongo():
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    yield db
    client.close()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _make_org(mongo, *, owner_user_id: str, slug: str | None = None) -> str:
    slug = slug or f"org-test-{uuid.uuid4().hex[:10]}"
    await mongo.organizations.insert_one({
        "slug": slug,
        "name": f"Test Org {slug}",
        "ownerId": owner_user_id,
        "status": "active",
        "createdAt": _now_iso(),
    })
    return slug


async def _make_booking(
    mongo,
    *,
    provider_slug: str,
    status: str = "confirmed",
    price: int = 4500,
) -> str:
    booking_id = f"bk-test-{uuid.uuid4().hex[:12]}"
    await mongo.bookings.insert_one({
        "id": booking_id,
        "providerSlug": provider_slug,
        "status": status,
        "priceEstimate": price,
        "createdAt": _now_iso(),
        "updatedAt": _now_iso(),
        "statusHistory": [{"status": status, "at": _now_iso()}],
    })
    return booking_id


async def _cleanup(mongo, *, slugs: list[str], booking_ids: list[str]) -> None:
    if slugs:
        await mongo.organizations.delete_many({"slug": {"$in": slugs}})
    if booking_ids:
        await mongo.bookings.delete_many({"id": {"$in": booking_ids}})
    await mongo.idempotency_keys.delete_many({"bookingId": {"$in": booking_ids}})


# ─────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_action_requires_auth(mongo, provider_user_id):
    """No Bearer token → 401, no DB touch."""
    slug = await _make_org(mongo, owner_user_id=provider_user_id)
    bid = await _make_booking(mongo, provider_slug=slug)
    try:
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0, headers=BYPASS_HEADERS) as c:
            r = await c.post(f"/api/provider/booking/{bid}/action", json={"action": "start"})
        assert r.status_code == 401, r.text
        # Booking status must be untouched.
        fresh = await mongo.bookings.find_one({"id": bid}, {"_id": 0, "status": 1, "statusHistory": 1})
        assert fresh["status"] == "confirmed"
        assert len(fresh["statusHistory"]) == 1
    finally:
        await _cleanup(mongo, slugs=[slug], booking_ids=[bid])


@pytest.mark.asyncio
async def test_action_missing_booking_404(mongo, provider_token):
    """Unknown booking_id → 404."""
    bogus_id = f"bk-test-missing-{uuid.uuid4().hex[:8]}"
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
        r = await c.post(
            f"/api/provider/booking/{bogus_id}/action",
            json={"action": "start"},
            headers=auth_headers(provider_token),
        )
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_action_foreign_booking_forbidden(
    mongo, provider_token, provider_user_id,
):
    """Booking owned by some other org → 403.

    Caller is `provider_user_id`. We mint a *different* organization that
    `provider_user_id` does NOT own and attach the booking to it.
    """
    other_slug = f"org-other-{uuid.uuid4().hex[:10]}"
    foreign_user_id = f"foreign-user-{uuid.uuid4().hex[:10]}"
    await mongo.organizations.insert_one({
        "slug": other_slug, "ownerId": foreign_user_id,
        "status": "active", "createdAt": _now_iso(),
    })
    bid = await _make_booking(mongo, provider_slug=other_slug)
    try:
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
            r = await c.post(
                f"/api/provider/booking/{bid}/action",
                json={"action": "start"},
                headers=auth_headers(provider_token),
            )
        assert r.status_code == 403, r.text
        # Booking untouched.
        fresh = await mongo.bookings.find_one({"id": bid}, {"_id": 0, "status": 1, "statusHistory": 1})
        assert fresh["status"] == "confirmed"
        assert len(fresh["statusHistory"]) == 1
    finally:
        await _cleanup(mongo, slugs=[other_slug], booking_ids=[bid])


@pytest.mark.asyncio
async def test_action_invalid_transition_409(
    mongo, provider_token, provider_user_id,
):
    """confirmed → completed (skipping in_progress) → 409, no mutation."""
    slug = await _make_org(mongo, owner_user_id=provider_user_id)
    bid = await _make_booking(mongo, provider_slug=slug, status="confirmed")
    try:
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
            r = await c.post(
                f"/api/provider/booking/{bid}/action",
                json={"action": "complete"},
                headers=auth_headers(provider_token),
            )
        assert r.status_code == 409, r.text
        fresh = await mongo.bookings.find_one({"id": bid}, {"_id": 0, "status": 1, "completedAt": 1})
        assert fresh["status"] == "confirmed"
        assert fresh.get("completedAt") is None
    finally:
        await _cleanup(mongo, slugs=[slug], booking_ids=[bid])


@pytest.mark.asyncio
async def test_action_invalid_verb_400(
    mongo, provider_token, provider_user_id,
):
    """Unknown action verb → 400."""
    slug = await _make_org(mongo, owner_user_id=provider_user_id)
    bid = await _make_booking(mongo, provider_slug=slug)
    try:
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
            r = await c.post(
                f"/api/provider/booking/{bid}/action",
                json={"action": "teleport"},
                headers=auth_headers(provider_token),
            )
        assert r.status_code == 400, r.text
    finally:
        await _cleanup(mongo, slugs=[slug], booking_ids=[bid])


@pytest.mark.asyncio
async def test_action_happy_path_start_then_complete(
    mongo, provider_token, provider_user_id,
):
    """Valid: confirmed → in_progress (start) → completed (complete)."""
    slug = await _make_org(mongo, owner_user_id=provider_user_id)
    bid = await _make_booking(mongo, provider_slug=slug, price=5500)
    try:
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
            r1 = await c.post(
                f"/api/provider/booking/{bid}/action",
                json={"action": "start"},
                headers=auth_headers(provider_token),
            )
            assert r1.status_code == 200, r1.text
            env1 = r1.json()
            assert env1["from"] == "confirmed"
            assert env1["to"] == "in_progress"
            assert env1["replayed"] is False

            r2 = await c.post(
                f"/api/provider/booking/{bid}/action",
                json={"action": "complete"},
                headers=auth_headers(provider_token),
            )
            assert r2.status_code == 200, r2.text
            env2 = r2.json()
            assert env2["to"] == "completed"
            assert env2["earnedNow"] == 5500
            assert env2["replayed"] is False
    finally:
        await _cleanup(mongo, slugs=[slug], booking_ids=[bid])


@pytest.mark.asyncio
async def test_same_state_replay_is_silent(
    mongo, provider_token, provider_user_id,
):
    """Calling the same action twice (no Idempotency-Key) must NOT push a
    second statusHistory entry, must NOT advance `completedAt`, must return
    `replayed: true` on the second call."""
    slug = await _make_org(mongo, owner_user_id=provider_user_id)
    bid = await _make_booking(mongo, provider_slug=slug)
    try:
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
            r1 = await c.post(
                f"/api/provider/booking/{bid}/action",
                json={"action": "start"},
                headers=auth_headers(provider_token),
            )
            assert r1.status_code == 200, r1.text
            after_first = await mongo.bookings.find_one(
                {"id": bid}, {"_id": 0, "statusHistory": 1, "startedAt": 1}
            )
            first_started_at = after_first["startedAt"]
            first_hist_len = len(after_first["statusHistory"])

            # Second identical call — observationally silent.
            r2 = await c.post(
                f"/api/provider/booking/{bid}/action",
                json={"action": "start"},
                headers=auth_headers(provider_token),
            )
            assert r2.status_code == 200, r2.text
            env2 = r2.json()
            assert env2["replayed"] is True
            assert env2["from"] == "in_progress"
            assert env2["to"] == "in_progress"

            after_second = await mongo.bookings.find_one(
                {"id": bid}, {"_id": 0, "statusHistory": 1, "startedAt": 1}
            )
            assert after_second["startedAt"] == first_started_at
            assert len(after_second["statusHistory"]) == first_hist_len
    finally:
        await _cleanup(mongo, slugs=[slug], booking_ids=[bid])


@pytest.mark.asyncio
async def test_idempotency_key_replay_returns_cached_envelope(
    mongo, provider_token, provider_user_id,
):
    """Same Idempotency-Key on retry: backend returns the same envelope and
    DOES NOT touch the booking or status history.

    To prove the cache (not the same-state branch) is doing the work, we
    mutate the booking back to `confirmed` between the two calls. If the
    backend re-ran the transition, statusHistory would grow; if the cache
    is doing its job, the response is replayed verbatim and the DB stays
    at `confirmed` (since we reverted)."""
    slug = await _make_org(mongo, owner_user_id=provider_user_id)
    bid = await _make_booking(mongo, provider_slug=slug)
    idem_key = f"wb_bk_{bid}_start_test{uuid.uuid4().hex[:6]}"
    try:
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
            r1 = await c.post(
                f"/api/provider/booking/{bid}/action",
                json={"action": "start"},
                headers=auth_headers(provider_token, extra={"Idempotency-Key": idem_key}),
            )
            assert r1.status_code == 200, r1.text
            env1 = r1.json()
            assert env1["to"] == "in_progress"

            # Wind back to expose whether the second call re-runs.
            await mongo.bookings.update_one(
                {"id": bid}, {"$set": {"status": "confirmed"}},
            )

            r2 = await c.post(
                f"/api/provider/booking/{bid}/action",
                json={"action": "start"},
                headers=auth_headers(provider_token, extra={"Idempotency-Key": idem_key}),
            )
            assert r2.status_code == 200, r2.text
            env2 = r2.json()
            assert env2 == env1, f"cached envelope mismatch:\n  first={env1}\n  retry={env2}"

            # DB must still be `confirmed` (no re-execution).
            fresh = await mongo.bookings.find_one({"id": bid}, {"_id": 0, "status": 1})
            assert fresh["status"] == "confirmed"
    finally:
        await _cleanup(mongo, slugs=[slug], booking_ids=[bid])


@pytest.mark.asyncio
async def test_idempotency_key_collision_mismatch_409(
    mongo, provider_token, provider_user_id,
):
    """Same key reused for a *different* (booking, action) tuple → 409.

    This catches buggy clients that reuse keys carelessly.
    """
    slug = await _make_org(mongo, owner_user_id=provider_user_id)
    bid_a = await _make_booking(mongo, provider_slug=slug)
    bid_b = await _make_booking(mongo, provider_slug=slug)
    shared_key = f"wb_collision_{uuid.uuid4().hex[:8]}"
    try:
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
            r1 = await c.post(
                f"/api/provider/booking/{bid_a}/action",
                json={"action": "start"},
                headers=auth_headers(provider_token, extra={"Idempotency-Key": shared_key}),
            )
            assert r1.status_code == 200, r1.text

            # Reuse the same key against a different booking → mismatch.
            r2 = await c.post(
                f"/api/provider/booking/{bid_b}/action",
                json={"action": "start"},
                headers=auth_headers(provider_token, extra={"Idempotency-Key": shared_key}),
            )
            assert r2.status_code == 409, r2.text

            # bid_b must remain untouched.
            fresh_b = await mongo.bookings.find_one({"id": bid_b}, {"_id": 0, "status": 1})
            assert fresh_b["status"] == "confirmed"
    finally:
        await _cleanup(mongo, slugs=[slug], booking_ids=[bid_a, bid_b])
