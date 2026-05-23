"""P0.b.C.a — Customer-facing timeline projection: e2e acceptance.

Verifies the trust contract:

  Customer ONLY sees:
    - their own actions (cancel)
    - provider operational milestones (confirmed, on_route, arrived,
      in_progress, completed)
    - dispute existence (open/resolve)

  Customer NEVER sees:
    - `*:rejected` rows
    - internalNotes, platformCut, refundReason, otherPartyId
    - admin actor ids
    - moderation metadata
    - system-internal events (mark_matched)
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


async def _seed_booking_for_customer(db, customer_id: str) -> str:
    bid = f"bk_{uuid.uuid4().hex[:12]}"
    await db.web_bookings.insert_one({
        "id": bid,
        "customerId": customer_id,
        "providerSlug": "test-provider",
        "providerName": "Test Provider",
        "serviceName": "Diagnostics",
        "status": "requested",
        "internalNotes": "admin: customer is VIP, give discount",
        "platformCut": 30,
        "createdAt": _now_iso(),
    })
    return bid


async def _seed_timeline_rows(db, booking_id: str, customer_id: str) -> None:
    """Plant a mixed bag of rows covering every customer visibility branch."""
    base_ts = datetime.now(timezone.utc)
    rows = [
        # 1) System-internal matching — HIDDEN from customer
        {"action": "mark_matched", "actorRole": "system", "actorId": "matcher",
         "fromStatus": "requested", "toStatus": "matched", "meta": {}},
        # 2) Provider confirmed — VISIBLE
        {"action": "mark_confirmed", "actorRole": "provider", "actorId": "prov-1",
         "fromStatus": "matched", "toStatus": "confirmed",
         "meta": {"providerCost": 220, "platformCut": 30, "internalNote": "VIP"}},
        # 3) Customer's own cancel attempt rejected (rare race) — HIDDEN
        {"action": "cancel:rejected", "actorRole": "customer", "actorId": customer_id,
         "fromStatus": "confirmed", "toStatus": None,
         "meta": {"error": "status_not_cancellable"}},
        # 4) Provider on the way — VISIBLE
        {"action": "mark_on_route", "actorRole": "provider", "actorId": "prov-1",
         "fromStatus": "confirmed", "toStatus": "on_route",
         "meta": {"eta": 10, "platformCut": 30}},
        # 5) Admin manual transition (e.g. recovery) — admin actor id MUST NOT leak
        {"action": "mark_arrived", "actorRole": "admin", "actorId": "admin-sara",
         "fromStatus": "on_route", "toStatus": "arrived",
         "meta": {"reason": "manual recovery", "internalNotes": "GPS dropout"}},
        # 6) Work started — VISIBLE
        {"action": "mark_in_progress", "actorRole": "provider", "actorId": "prov-1",
         "fromStatus": "arrived", "toStatus": "in_progress", "meta": {}},
        # 7) Completed — VISIBLE
        {"action": "mark_completed", "actorRole": "provider", "actorId": "prov-1",
         "fromStatus": "in_progress", "toStatus": "completed", "meta": {}},
        # 8) Admin attempted rewrite — must produce ZERO surface output
        {"action": "mark_in_progress:rejected", "actorRole": "admin", "actorId": "admin-sara",
         "fromStatus": "completed", "toStatus": None,
         "meta": {"error": "Booking is terminal (completed)", "reason": "covert"}},
    ]
    docs = []
    for i, row in enumerate(rows):
        ts = base_ts.replace(microsecond=i * 1000).isoformat()
        docs.append({
            "id": uuid.uuid4().hex,
            "bookingId": booking_id,
            "bookingScope": "web_booking",
            "action": row["action"],
            "actorId": row["actorId"],
            "actorRole": row["actorRole"],
            "fromStatus": row["fromStatus"],
            "toStatus": row["toStatus"],
            "meta": row["meta"],
            "timestamp": ts,
        })
    if docs:
        await db.booking_timeline.insert_many(docs)


# ══════════════════════════════════════════════════════════════════
# 1. Endpoint contract
# ══════════════════════════════════════════════════════════════════


async def test_endpoint_requires_auth(client):
    r = await client.get("/api/customer/bookings/bk_does_not_exist/timeline")
    assert r.status_code == 401


async def test_endpoint_returns_404_for_missing_booking(client, admin_token):
    r = await client.get(
        "/api/customer/bookings/bk_nonexistent_xyz/timeline",
        headers=_hdr(admin_token),
    )
    assert r.status_code == 404


# ══════════════════════════════════════════════════════════════════
# 2. THE trust contract: customer sees ONLY whitelisted events
# ══════════════════════════════════════════════════════════════════


async def test_customer_sees_only_safe_events(client, admin_token, db):
    """admin_token's subject acts as a customer here (booking customerId=admin uid)."""
    # Decode admin_token to get the subject id without an extra round-trip.
    import jwt
    from app.core.config import JWT_SECRET, JWT_ALGO
    customer_id = jwt.decode(admin_token, JWT_SECRET, algorithms=[JWT_ALGO]).get("sub")

    bid = await _seed_booking_for_customer(db, customer_id)
    await _seed_timeline_rows(db, bid, customer_id)

    r = await client.get(
        f"/api/customer/bookings/{bid}/timeline",
        headers=_hdr(admin_token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    events = body["events"]
    assert body["bookingId"] == bid
    assert body["count"] == len(events)

    # Expected chronological order of visible events:
    #   confirmed → on_route → arrived → in_progress → completed
    keys = [e["key"] for e in events]
    assert keys == ["confirmed", "on_route", "arrived", "in_progress", "completed"], keys
    assert len(events) == 5

    # ── Negative checks (the trust-sensitive ones) ───────────────
    serialized = repr(events)
    assert "platformCut" not in serialized, "platformCut leaked!"
    assert "internalNote" not in serialized, "internalNote leaked!"
    assert "internalNotes" not in serialized, "internalNotes leaked!"
    assert "admin-sara" not in serialized, "admin actor id leaked!"
    assert "rejected" not in serialized, "rejected attempt leaked!"
    assert "providerCost" not in serialized, "providerCost leaked!"
    assert "covert" not in serialized, "rewrite-attempt evidence leaked!"

    # Provider actor id should not appear either — customer sees "the provider".
    assert "prov-1" not in serialized, "provider actor id leaked!"


async def test_customer_sees_own_cancel(client, admin_token, db):
    """Customer's own cancel is shown — and marked isSelfAction=True."""
    import jwt
    from app.core.config import JWT_SECRET, JWT_ALGO
    customer_id = jwt.decode(admin_token, JWT_SECRET, algorithms=[JWT_ALGO]).get("sub")

    bid = await _seed_booking_for_customer(db, customer_id)
    # Customer's own cancel — single timeline row
    await db.booking_timeline.insert_one({
        "id": uuid.uuid4().hex,
        "bookingId": bid,
        "bookingScope": "web_booking",
        "action": "cancel",
        "actorId": customer_id,
        "actorRole": "customer",
        "fromStatus": "requested",
        "toStatus": "cancelled",
        "meta": {"reason": "no longer needed"},
        "timestamp": _now_iso(),
    })

    r = await client.get(
        f"/api/customer/bookings/{bid}/timeline",
        headers=_hdr(admin_token),
    )
    body = r.json()
    events = body["events"]
    assert len(events) == 1
    assert events[0]["key"] == "cancelled"
    assert events[0]["isSelfAction"] is True
    assert events[0]["label"] == "Вы отменили заказ"
    assert events[0]["meta"] == {"reason": "no longer needed"}


async def test_admin_cancel_does_not_leak_admin_identity(client, admin_token, db):
    """When admin cancels via moderation, customer sees the event but
    NOT the admin id, and isSelfAction is False."""
    import jwt
    from app.core.config import JWT_SECRET, JWT_ALGO
    customer_id = jwt.decode(admin_token, JWT_SECRET, algorithms=[JWT_ALGO]).get("sub")

    bid = await _seed_booking_for_customer(db, customer_id)
    await db.booking_timeline.insert_one({
        "id": uuid.uuid4().hex,
        "bookingId": bid,
        "bookingScope": "web_booking",
        "action": "cancel",
        "actorId": "admin-9001-secret-id",
        "actorRole": "admin",
        "fromStatus": "confirmed",
        "toStatus": "cancelled",
        "meta": {"reason": "fraud detected", "internalNotes": "linked to chargeback case 47"},
        "timestamp": _now_iso(),
    })

    r = await client.get(
        f"/api/customer/bookings/{bid}/timeline",
        headers=_hdr(admin_token),
    )
    body = r.json()
    events = body["events"]
    assert len(events) == 1
    e = events[0]
    assert e["key"] == "cancelled"
    assert e["isSelfAction"] is False
    serialized = repr(e)
    assert "admin-9001" not in serialized
    assert "fraud" in serialized   # the reason itself is safe to surface
    assert "internalNotes" not in serialized
    assert "chargeback" not in serialized


# ══════════════════════════════════════════════════════════════════
# 3. Authorization — booking must belong to caller
# ══════════════════════════════════════════════════════════════════


async def test_403_when_booking_belongs_to_someone_else(client, admin_token, db):
    bid = await _seed_booking_for_customer(db, customer_id="other-user-id-xyz")
    r = await client.get(
        f"/api/customer/bookings/{bid}/timeline",
        headers=_hdr(admin_token),
    )
    assert r.status_code == 403


# ══════════════════════════════════════════════════════════════════
# 4. Chronological order — UI scanning safety
# ══════════════════════════════════════════════════════════════════


async def test_events_returned_chronologically(client, admin_token, db):
    import jwt
    from app.core.config import JWT_SECRET, JWT_ALGO
    customer_id = jwt.decode(admin_token, JWT_SECRET, algorithms=[JWT_ALGO]).get("sub")

    bid = await _seed_booking_for_customer(db, customer_id)
    await _seed_timeline_rows(db, bid, customer_id)

    r = await client.get(
        f"/api/customer/bookings/{bid}/timeline",
        headers=_hdr(admin_token),
    )
    events = r.json()["events"]
    timestamps = [e["at"] for e in events]
    # Strictly ascending.
    assert timestamps == sorted(timestamps)


# ══════════════════════════════════════════════════════════════════
# 5. Activity-feed trap: no "viewed/hovered/page-opened" events
# ══════════════════════════════════════════════════════════════════


async def test_unknown_actions_are_silently_dropped_not_rendered(client, admin_token, db):
    """If the timeline ever gets a row for `provider_viewed_booking` or
    similar activity-feed noise, customer projection MUST drop it."""
    import jwt
    from app.core.config import JWT_SECRET, JWT_ALGO
    customer_id = jwt.decode(admin_token, JWT_SECRET, algorithms=[JWT_ALGO]).get("sub")

    bid = await _seed_booking_for_customer(db, customer_id)
    await db.booking_timeline.insert_many([
        {
            "id": uuid.uuid4().hex,
            "bookingId": bid,
            "bookingScope": "web_booking",
            "action": "provider_viewed_booking",
            "actorId": "prov-1",
            "actorRole": "provider",
            "fromStatus": None,
            "toStatus": None,
            "meta": {},
            "timestamp": _now_iso(),
        },
        {
            "id": uuid.uuid4().hex,
            "bookingId": bid,
            "bookingScope": "web_booking",
            "action": "customer_opened_page",
            "actorId": customer_id,
            "actorRole": "customer",
            "fromStatus": None,
            "toStatus": None,
            "meta": {},
            "timestamp": _now_iso(),
        },
    ])

    r = await client.get(
        f"/api/customer/bookings/{bid}/timeline",
        headers=_hdr(admin_token),
    )
    assert r.status_code == 200
    assert r.json()["events"] == []


# ══════════════════════════════════════════════════════════════════
# 6. Empty timeline is a valid response
# ══════════════════════════════════════════════════════════════════


async def test_empty_timeline_returns_empty_events(client, admin_token, db):
    import jwt
    from app.core.config import JWT_SECRET, JWT_ALGO
    customer_id = jwt.decode(admin_token, JWT_SECRET, algorithms=[JWT_ALGO]).get("sub")

    bid = await _seed_booking_for_customer(db, customer_id)
    r = await client.get(
        f"/api/customer/bookings/{bid}/timeline",
        headers=_hdr(admin_token),
    )
    assert r.status_code == 200
    body = r.json()
    assert body == {"bookingId": bid, "events": [], "count": 0}
