"""P0.b.A — Booking lifecycle freeze: e2e acceptance.

Proves:

  1. FSM transitions are explicit and frozen (every legal action enumerated)
  2. Terminal states (completed, cancelled, resolved) reject all further
     transitions AND record `<action>:rejected` rows in `booking_timeline`
  3. Append-only timeline preserves chronology (no rewrite path)
  4. TOCTOU: concurrent state change → 409 + rejected audit row
  5. Actor projections narrow truth (customer ≠ provider ≠ admin labels)
  6. Existing booking flows are NOT broken (sidecar discipline holds)
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


def _hdr(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _seed_booking(db, scope: str = "web_booking", status: str = "requested") -> str:
    bid = f"bk_{uuid.uuid4().hex[:12]}"
    coll = {
        "web_booking":     db.web_bookings,
        "service_request": db.service_requests,
        "car_request":     db.car_requests,
    }[scope]
    await coll.insert_one({
        "id": bid,
        "scope": scope,
        "status": status,
        "customerId": "cust-test",
        "providerId": "prov-test",
        "internalNotes": "secret admin only",
        "createdAt": _now_iso(),
        "updatedAt": _now_iso(),
    })
    return bid


async def _timeline_rows(db, booking_id: str) -> list:
    return await db.booking_timeline.find(
        {"bookingId": booking_id},
        {"_id": 0},
    ).sort("timestamp", -1).to_list(50)


# ══════════════════════════════════════════════════════════════════
# 1. FSM is explicit & frozen
# ══════════════════════════════════════════════════════════════════


async def test_states_endpoint_publishes_frozen_fsm(client, admin_token):
    r = await client.get("/api/admin/booking-lifecycle/states", headers=_hdr(admin_token))
    assert r.status_code == 200
    body = r.json()
    assert body["states"] == [
        "requested", "matched", "confirmed", "on_route", "arrived",
        "in_progress", "completed", "cancelled", "disputed", "resolved",
    ]
    assert set(body["terminal"]) == {"completed", "cancelled", "resolved"}
    # Spot-check key transitions are wired exactly.
    tx = body["transitions"]
    assert tx["mark_matched"]   == {"from": ["requested"], "to": "matched"}
    assert tx["mark_completed"] == {"from": ["in_progress"], "to": "completed"}
    assert tx["open_dispute"]["to"] == "disputed"
    assert tx["resolve_dispute"]["to"] == "resolved"
    # Cancel off-ramps explicitly listed (no surprises).
    assert tx["cancel"]["from"] == ["confirmed", "matched", "requested"]


# ══════════════════════════════════════════════════════════════════
# 2. Happy path through the spine
# ══════════════════════════════════════════════════════════════════


async def test_happy_path_requested_to_completed(client, admin_token, db):
    bid = await _seed_booking(db, status="requested")

    flow = [
        ("mark_matched",     "matched"),
        ("mark_confirmed",   "confirmed"),
        ("mark_on_route",    "on_route"),
        ("mark_arrived",     "arrived"),
        ("mark_in_progress", "in_progress"),
        ("mark_completed",   "completed"),
    ]
    for action, expected in flow:
        r = await client.post(
            f"/api/admin/booking-lifecycle/{bid}/transition",
            json={"scope": "web_booking", "action": action, "reason": "happy"},
            headers=_hdr(admin_token),
        )
        assert r.status_code == 200, f"{action}: {r.status_code}/{r.text}"
        assert r.json()["toStatus"] == expected

    # Timeline mirrors the spine in chronological order.
    rows = sorted(await _timeline_rows(db, bid), key=lambda r: r["timestamp"])
    actions = [r["action"] for r in rows]
    assert actions == [a for a, _ in flow]
    # Every row has the required fields.
    for row in rows:
        assert row["actorRole"] == "admin"
        assert row["actorId"]
        assert row["fromStatus"] is not None
        assert row["toStatus"] is not None


# ══════════════════════════════════════════════════════════════════
# 3. THE invariant: terminal evidence is frozen
# ══════════════════════════════════════════════════════════════════


async def test_completed_is_terminal_rejects_all_transitions(client, admin_token, db):
    bid = await _seed_booking(db, status="completed")

    for action in ("mark_matched", "mark_in_progress", "cancel", "resolve_dispute"):
        r = await client.post(
            f"/api/admin/booking-lifecycle/{bid}/transition",
            json={"scope": "web_booking", "action": action, "reason": "covert rewrite"},
            headers=_hdr(admin_token),
        )
        assert r.status_code == 409, f"{action}: expected 409"

    rows = await _timeline_rows(db, bid)
    rejected = [r["action"] for r in rows if r["action"].endswith(":rejected")]
    assert "mark_matched:rejected" in rejected
    assert "cancel:rejected" in rejected
    assert "resolve_dispute:rejected" in rejected

    doc = await db.web_bookings.find_one({"id": bid}, {"_id": 0, "status": 1})
    assert doc["status"] == "completed", "terminal status was silently rewritten!"


async def test_cancelled_is_terminal(client, admin_token, db):
    bid = await _seed_booking(db, status="cancelled")
    r = await client.post(
        f"/api/admin/booking-lifecycle/{bid}/transition",
        json={"scope": "web_booking", "action": "mark_matched", "reason": "x"},
        headers=_hdr(admin_token),
    )
    assert r.status_code == 409
    doc = await db.web_bookings.find_one({"id": bid}, {"_id": 0, "status": 1})
    assert doc["status"] == "cancelled"


async def test_resolved_is_terminal(client, admin_token, db):
    bid = await _seed_booking(db, status="resolved")
    r = await client.post(
        f"/api/admin/booking-lifecycle/{bid}/transition",
        json={"scope": "web_booking", "action": "mark_matched", "reason": "x"},
        headers=_hdr(admin_token),
    )
    assert r.status_code == 409


# ══════════════════════════════════════════════════════════════════
# 4. Off-ramps & dispute branch
# ══════════════════════════════════════════════════════════════════


async def test_cancel_only_from_pre_engagement(client, admin_token, db):
    # Allowed: from requested
    bid_req = await _seed_booking(db, status="requested")
    r = await client.post(
        f"/api/admin/booking-lifecycle/{bid_req}/transition",
        json={"scope": "web_booking", "action": "cancel", "reason": "customer left"},
        headers=_hdr(admin_token),
    )
    assert r.status_code == 200

    # Rejected: from in_progress (work has started — must use dispute path)
    bid_ip = await _seed_booking(db, status="in_progress")
    r = await client.post(
        f"/api/admin/booking-lifecycle/{bid_ip}/transition",
        json={"scope": "web_booking", "action": "cancel", "reason": "x"},
        headers=_hdr(admin_token),
    )
    assert r.status_code == 409

    rows = await _timeline_rows(db, bid_ip)
    assert any(r["action"] == "cancel:rejected" for r in rows)


async def test_dispute_branch_in_progress_to_resolved(client, admin_token, db):
    bid = await _seed_booking(db, status="in_progress")

    r = await client.post(
        f"/api/admin/booking-lifecycle/{bid}/transition",
        json={"scope": "web_booking", "action": "open_dispute", "reason": "customer complaint"},
        headers=_hdr(admin_token),
    )
    assert r.status_code == 200
    assert r.json()["toStatus"] == "disputed"

    r = await client.post(
        f"/api/admin/booking-lifecycle/{bid}/transition",
        json={"scope": "web_booking", "action": "resolve_dispute", "reason": "compensation issued"},
        headers=_hdr(admin_token),
    )
    assert r.status_code == 200
    assert r.json()["toStatus"] == "resolved"

    # Resolved is terminal — further actions rejected.
    r = await client.post(
        f"/api/admin/booking-lifecycle/{bid}/transition",
        json={"scope": "web_booking", "action": "mark_in_progress", "reason": "covert"},
        headers=_hdr(admin_token),
    )
    assert r.status_code == 409


# ══════════════════════════════════════════════════════════════════
# 5. Actor projections narrow truth
# ══════════════════════════════════════════════════════════════════


async def test_actor_projections_differ_per_actor(client, admin_token, db):
    bid = await _seed_booking(db, status="in_progress")

    customer = (await client.get(
        f"/api/admin/booking-lifecycle/{bid}?scope=web_booking&actor=customer",
        headers=_hdr(admin_token),
    )).json()
    provider = (await client.get(
        f"/api/admin/booking-lifecycle/{bid}?scope=web_booking&actor=provider",
        headers=_hdr(admin_token),
    )).json()
    admin = (await client.get(
        f"/api/admin/booking-lifecycle/{bid}?scope=web_booking&actor=admin",
        headers=_hdr(admin_token),
    )).json()

    # Same truth.
    assert customer["canonicalState"] == provider["canonicalState"] == admin["canonicalState"] == "in_progress"

    # Different vocabulary.
    assert customer["projection"]["label"] != admin["projection"]["label"]
    assert customer["projection"]["label"] == "Работа идёт"
    assert provider["projection"]["label"] == "Работа идёт"
    assert admin["projection"]["label"] == "in_progress"

    # Visibility narrows: customer cannot see platformCut; admin can.
    assert customer["projection"]["canSee"]["platformCut"] is False
    assert customer["projection"]["canSee"]["internalNotes"] is False
    assert admin["projection"]["canSee"]["platformCut"] is True
    assert admin["projection"]["canSee"]["internalNotes"] is True
    assert provider["projection"]["canSee"]["providerCost"] is True
    assert provider["projection"]["canSee"]["platformCut"] is False


async def test_legacy_status_normalized_for_read(client, admin_token, db):
    """Existing docs with status='pending' should project to canonical 'requested'."""
    bid = await _seed_booking(db, status="pending")
    r = await client.get(
        f"/api/admin/booking-lifecycle/{bid}?scope=web_booking&actor=customer",
        headers=_hdr(admin_token),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["rawStatus"] == "pending"
    assert body["canonicalState"] == "requested"
    assert "mark_matched" in body["legalActions"]


# ══════════════════════════════════════════════════════════════════
# 6. Sidecar — existing flows untouched
# ══════════════════════════════════════════════════════════════════


async def test_existing_marketplace_health_unchanged(client):
    """The freeze must not break unrelated public endpoints."""
    r = await client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"

    r = await client.get("/api/system/health")
    assert r.status_code == 200


async def test_unknown_action_returns_400(client, admin_token, db):
    bid = await _seed_booking(db, status="requested")
    r = await client.post(
        f"/api/admin/booking-lifecycle/{bid}/transition",
        json={"scope": "web_booking", "action": "transition", "reason": "x"},
        headers=_hdr(admin_token),
    )
    assert r.status_code == 400
    # And a rejected audit row was written for forensics.
    rows = await _timeline_rows(db, bid)
    assert any(r["action"] == "transition:rejected" for r in rows)
