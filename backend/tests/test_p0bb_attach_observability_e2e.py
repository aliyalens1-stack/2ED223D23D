"""P0.b.B — observability attachment: e2e acceptance.

Validates the sprint discipline:

  attach, don't rewrite
  observe, don't orchestrate
  record, don't control

Acceptance criteria from the brief:
  1. At least 3 real mutation paths write the timeline:
       cancel, provider accept, provider job action complete  ✓
  2. Timeline entries carry: bookingId, action, from, to, actorId,
     actorRole, source, timestamp, accepted/rejected
  3. Existing e2e still green (P0.b.A + P0.d, run separately)
  4. Idempotent: repeated identical call does not create duplicate row
  5. Terminal state immutability (P0.b.A) still green
  6. Existing endpoint contract unchanged: same status codes, same body
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient


MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


@pytest_asyncio.fixture
async def db():
    c = AsyncIOMotorClient(MONGO_URL)
    yield c[DB_NAME]
    c.close()


def _hdr(token: str = None, request_id: str = None) -> dict:
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    if request_id:
        h["X-Request-Id"] = request_id
    return h


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _seed_web_booking(db, status: str = "pending") -> str:
    bid = f"bk_{uuid.uuid4().hex[:12]}"
    await db.web_bookings.insert_one({
        "id": bid,
        "providerSlug": "test-provider",
        "providerName": "Test Provider",
        "serviceName": "Diagnostics",
        "status": status,
        "providerAccepted": status not in ("pending",),
        "statusHistory": [{"status": status, "at": _now_iso()}],
        "createdAt": _now_iso(),
    })
    return bid


async def _timeline_rows(db, booking_id: str) -> list:
    return await db.booking_timeline.find(
        {"bookingId": booking_id},
        {"_id": 0},
    ).sort("timestamp", -1).to_list(50)


# ══════════════════════════════════════════════════════════════════
# 1. cancel endpoint — accepted path writes timeline
# ══════════════════════════════════════════════════════════════════


async def test_cancel_writes_timeline_row(client, db):
    bid = await _seed_web_booking(db, status="pending")
    r = await client.post(
        f"/api/marketplace/bookings/{bid}/cancel",
        json={"reason": "changed mind"},
        headers=_hdr(),
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "cancelled"

    rows = await _timeline_rows(db, bid)
    assert len(rows) >= 1
    row = next(r for r in rows if r["action"] == "cancel")
    assert row["bookingScope"] == "web_booking"
    assert row["fromStatus"] == "requested"     # canonical from legacy 'pending'
    assert row["toStatus"] == "cancelled"
    assert row["actorRole"] == "customer"
    assert row["source"] == "marketplace.bookings.cancel"
    assert row["meta"]["reason"] == "changed mind"
    assert row["rawFromStatus"] == "pending"
    assert row["rawToStatus"] == "cancelled"


async def test_cancel_rejected_writes_audit_row(client, db):
    """Booking in `completed` cannot be cancelled — but the attempt is logged."""
    bid = await _seed_web_booking(db, status="completed")
    r = await client.post(
        f"/api/marketplace/bookings/{bid}/cancel",
        json={"reason": "covert"},
        headers=_hdr(),
    )
    assert r.status_code == 400      # existing contract unchanged

    rows = await _timeline_rows(db, bid)
    assert any(
        r["action"] == "cancel:rejected" and r["meta"].get("error") == "status_not_cancellable"
        for r in rows
    )


# ══════════════════════════════════════════════════════════════════
# 2. provider accept — accepted + rejected paths
# ══════════════════════════════════════════════════════════════════


async def test_provider_accept_writes_timeline(client, db):
    bid = await _seed_web_booking(db, status="pending")
    r = await client.post(
        f"/api/marketplace/provider/requests/{bid}/accept",
        json={},
        headers=_hdr(),
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "confirmed"

    rows = await _timeline_rows(db, bid)
    row = next(r for r in rows if r["action"] == "mark_confirmed")
    assert row["fromStatus"] == "requested"
    assert row["toStatus"] == "confirmed"
    assert row["actorRole"] == "provider"
    assert row["source"] == "marketplace.provider.accept"


async def test_provider_accept_race_records_rejected(client, db):
    """Second accept on an already-confirmed booking → 400 + rejected row."""
    bid = await _seed_web_booking(db, status="confirmed")
    r = await client.post(
        f"/api/marketplace/provider/requests/{bid}/accept",
        json={},
        headers=_hdr(),
    )
    assert r.status_code == 400

    rows = await _timeline_rows(db, bid)
    assert any(r["action"] == "mark_confirmed:rejected" for r in rows)


# ══════════════════════════════════════════════════════════════════
# 3. provider job action — depart / arrive / start / complete
# ══════════════════════════════════════════════════════════════════


async def test_provider_job_action_complete_writes_timeline(client, db):
    bid = await _seed_web_booking(db, status="in_progress")
    r = await client.post(
        f"/api/marketplace/provider/current-job/{bid}/action",
        json={"action": "complete"},
        headers=_hdr(),
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "completed"

    rows = await _timeline_rows(db, bid)
    row = next(r for r in rows if r["action"] == "mark_completed")
    assert row["fromStatus"] == "in_progress"
    assert row["toStatus"] == "completed"
    assert row["actorRole"] == "provider"
    assert row["source"] == "marketplace.provider.job_action.complete"


async def test_provider_job_action_depart(client, db):
    bid = await _seed_web_booking(db, status="confirmed")
    r = await client.post(
        f"/api/marketplace/provider/current-job/{bid}/action",
        json={"action": "depart"},
        headers=_hdr(),
    )
    assert r.status_code == 200

    rows = await _timeline_rows(db, bid)
    assert any(r["action"] == "mark_on_route" and r["toStatus"] == "on_route" for r in rows)


# ══════════════════════════════════════════════════════════════════
# 4. Idempotency
# ══════════════════════════════════════════════════════════════════


async def test_idempotent_with_request_id(client, db):
    """Same X-Request-Id replays produce ONE timeline row."""
    bid = await _seed_web_booking(db, status="completed")  # rejected path
    rid = f"req-{uuid.uuid4().hex[:8]}"

    # Fire three identical rejected attempts.
    for _ in range(3):
        r = await client.post(
            f"/api/marketplace/bookings/{bid}/cancel",
            json={"reason": "spam"},
            headers=_hdr(request_id=rid),
        )
        assert r.status_code == 400

    rows = [r for r in await _timeline_rows(db, bid) if r["action"] == "cancel:rejected"]
    assert len(rows) == 1, f"expected idempotent single row, got {len(rows)}"
    assert rows[0]["sourceRequestId"] == rid


async def test_content_based_dedup_when_no_request_id(client, db):
    """Without X-Request-Id, identical (booking, action, from, to, source) deduplicates."""
    bid = await _seed_web_booking(db, status="cancelled")  # rejected path again

    for _ in range(3):
        r = await client.post(
            f"/api/marketplace/bookings/{bid}/cancel",
            json={"reason": "spam"},
            headers=_hdr(),
        )
        assert r.status_code == 400

    rows = [r for r in await _timeline_rows(db, bid) if r["action"] == "cancel:rejected"]
    # Without requestId: content-based dedup on (bookingId, source, action, fromStatus, toStatus).
    # Three identical attempts → at most one row.
    assert len(rows) == 1


# ══════════════════════════════════════════════════════════════════
# 5. Existing endpoint contract unchanged
# ══════════════════════════════════════════════════════════════════


async def test_cancel_response_shape_unchanged(client, db):
    bid = await _seed_web_booking(db, status="pending")
    r = await client.post(
        f"/api/marketplace/bookings/{bid}/cancel",
        json={"reason": "test"},
        headers=_hdr(),
    )
    assert r.status_code == 200
    body = r.json()
    # Contract: existed before P0.b.B; must not change.
    assert set(body.keys()) == {"status", "bookingId"}
    assert body == {"status": "cancelled", "bookingId": bid}


async def test_provider_accept_response_shape_unchanged(client, db):
    bid = await _seed_web_booking(db, status="pending")
    r = await client.post(
        f"/api/marketplace/provider/requests/{bid}/accept",
        json={},
        headers=_hdr(),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "confirmed"
    assert body["bookingId"] == bid


# ══════════════════════════════════════════════════════════════════
# 6. Sidecar safety: timeline write failure does NOT break business flow
# ══════════════════════════════════════════════════════════════════


async def test_timeline_write_failure_does_not_break_existing_flow(client, db, monkeypatch):
    """If timeline write fails, the existing endpoint still returns 200."""
    bid = await _seed_web_booking(db, status="pending")

    # Force observe_transition's underlying db call to fail.
    from app.booking import attach as attach_mod

    async def broken_update_one(*args, **kwargs):
        raise RuntimeError("simulated mongo failure")

    # We monkeypatch the bound `db.booking_timeline.update_one` indirectly:
    # observe_transition takes its own `db` argument, so we patch the module
    # at the call site to swap the collection accessor.
    from app.marketplace import providers as providers_mod
    original = providers_mod.observe_transition

    async def fail_observe(*args, **kwargs):
        # Simulate the internal best-effort failure path: log + return None.
        # The real function already catches all exceptions; we mimic that by
        # raising and letting the endpoint's outer try/except swallow it.
        raise RuntimeError("simulated observe failure")

    monkeypatch.setattr(providers_mod, "observe_transition", fail_observe)

    r = await client.post(
        f"/api/marketplace/bookings/{bid}/cancel",
        json={"reason": "verify safety"},
        headers=_hdr(),
    )
    # Existing contract MUST hold even when observability fails.
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "cancelled", "bookingId": bid}

    # On-disk booking is still cancelled.
    doc = await db.web_bookings.find_one({"id": bid}, {"_id": 0, "status": 1})
    assert doc["status"] == "cancelled"

    monkeypatch.setattr(providers_mod, "observe_transition", original)
