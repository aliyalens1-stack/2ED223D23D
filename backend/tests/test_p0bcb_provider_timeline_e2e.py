"""P0.b.C.b — Provider-facing timeline projection: e2e acceptance.

Verifies the provider trust contract:

  Provider SHOULD see:
    - mark_matched / mark_confirmed / mark_on_route / mark_arrived /
      mark_in_progress / mark_completed
    - own cancels (isSelfAction=True)
    - customer cancels (label="Клиент отменил")
    - admin cancels (label="Отменено администрацией", identity hidden)
    - open_dispute / resolve_dispute

  Provider MUST NEVER see:
    - `*:rejected` rows
    - platformCut / commission / providerCost / pricing internals
    - internalNotes / adminNote / moderation comments
    - admin actor ids
    - trustScore / fraudFlag / fraud heuristics
    - error / TOCTOU strings
    - activity-feed noise (unknown actions)

Plus the snapshot test (full rendered payload) — guards against
accidental field-leak when new meta fields land on `booking_timeline`.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import jwt
import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient

from app.core.config import JWT_SECRET, JWT_ALGO


MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


@pytest_asyncio.fixture
async def db():
    c = AsyncIOMotorClient(MONGO_URL)
    yield c[DB_NAME]
    c.close()


def _hdr(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _decode_sub(token: str) -> str:
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO]).get("sub")


def _decode_account(token: str) -> str:
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO]).get("accountId") or ""


async def _seed_booking_for_provider(db, *, provider_id: str) -> str:
    bid = f"bk_{uuid.uuid4().hex[:12]}"
    await db.web_bookings.insert_one({
        "id": bid,
        "customerId": "cust-some-other-user",
        "providerId": provider_id,
        "providerSlug": "test-provider-slug",
        "providerName": "Test Provider",
        "serviceName": "Diagnostics",
        "status": "matched",
        "internalNotes": "admin: VIP customer, watch behavior",
        "platformCut": 30,
        "providerCost": 220,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    })
    return bid


def _ts(i: int) -> str:
    """Deterministic ascending timestamps for snapshot stability."""
    base = datetime(2026, 5, 20, 9, 0, 0, tzinfo=timezone.utc)
    return base.replace(microsecond=i * 1000).isoformat()


async def _seed_full_lifecycle(db, booking_id: str, *, provider_id: str) -> None:
    """Plant rows covering every provider visibility branch."""
    rows = [
        # 0) System matcher routes the assignment — provider SEES this
        ("mark_matched", "system", "matcher-bot",
         "requested", "matched", {"platformCut": 30, "rankingScore": 0.87}),
        # 1) Customer opened the booking page — activity noise, HIDDEN
        ("customer_opened_page", "customer", "cust-some-other-user",
         None, None, {"ua": "iOS App"}),
        # 2) Provider confirmed — VISIBLE, isSelfAction=True
        ("mark_confirmed", "provider", provider_id,
         "matched", "confirmed", {"platformCut": 30, "providerCost": 220, "internalNote": "VIP"}),
        # 3) An earlier provider's failed accept attempt (TOCTOU race) — HIDDEN
        ("mark_confirmed:rejected", "provider", "prov-competitor",
         "confirmed", None, {"error": "Booking is terminal", "platformCut": 30}),
        # 4) Provider en route with ETA — VISIBLE, ETA surfaces
        ("mark_on_route", "provider", provider_id,
         "confirmed", "on_route", {"eta": 12, "platformCut": 30}),
        # 5) Admin manual override (recovery) — VISIBLE event, NO admin id
        ("mark_arrived", "admin", "admin-sara-9001",
         "on_route", "arrived",
         {"reason": "manual recovery", "internalNotes": "GPS dropout",
          "trustScore": 0.42, "fraudFlag": False}),
        # 6) Work started — VISIBLE
        ("mark_in_progress", "provider", provider_id,
         "arrived", "in_progress", {"note": "started on time", "platformCut": 30}),
        # 7) Completed with payout amount — VISIBLE, payout surfaces
        ("mark_completed", "provider", provider_id,
         "in_progress", "completed",
         {"payoutAmount": 190, "platformCut": 30, "customerNote": "buzzer broken"}),
        # 8) Admin tried to rewrite terminal state — HIDDEN
        ("mark_in_progress:rejected", "admin", "admin-sara-9001",
         "completed", None, {"error": "Booking is terminal", "reason": "covert"}),
    ]
    docs = []
    for i, (action, role, actor, fr, to, meta) in enumerate(rows):
        docs.append({
            "id": uuid.uuid4().hex,
            "bookingId": booking_id,
            "bookingScope": "web_booking",
            "action": action,
            "actorId": actor,
            "actorRole": role,
            "fromStatus": fr,
            "toStatus": to,
            "meta": meta,
            "timestamp": _ts(i),
        })
    await db.booking_timeline.insert_many(docs)


# ══════════════════════════════════════════════════════════════════════
# 1. Endpoint contract
# ══════════════════════════════════════════════════════════════════════


async def test_endpoint_requires_auth(client):
    r = await client.get("/api/provider/bookings/bk_does_not_exist/timeline")
    assert r.status_code == 401


async def test_endpoint_returns_404_for_missing_booking(client, provider_token):
    r = await client.get(
        "/api/provider/bookings/bk_nonexistent_xyz/timeline",
        headers=_hdr(provider_token),
    )
    assert r.status_code == 404


async def test_endpoint_returns_404_for_unassigned_booking(client, provider_token, db):
    """Booking with NO providerId at all — provider cannot claim it."""
    bid = f"bk_{uuid.uuid4().hex[:12]}"
    await db.web_bookings.insert_one({
        "id": bid,
        "customerId": "some-customer",
        # no providerId fields at all
        "status": "requested",
        "createdAt": datetime.now(timezone.utc).isoformat(),
    })
    r = await client.get(
        f"/api/provider/bookings/{bid}/timeline",
        headers=_hdr(provider_token),
    )
    assert r.status_code == 404


async def test_endpoint_returns_404_for_other_providers_booking(client, provider_token, db):
    """Booking assigned to a DIFFERENT provider must return 404 (not 403)
    to avoid leaking the existence of competitor bookings."""
    bid = await _seed_booking_for_provider(db, provider_id="prov-someone-else")
    r = await client.get(
        f"/api/provider/bookings/{bid}/timeline",
        headers=_hdr(provider_token),
    )
    assert r.status_code == 404


async def test_empty_timeline_returns_empty_events(client, provider_token, db):
    provider_id = _decode_sub(provider_token)
    bid = await _seed_booking_for_provider(db, provider_id=provider_id)
    r = await client.get(
        f"/api/provider/bookings/{bid}/timeline",
        headers=_hdr(provider_token),
    )
    assert r.status_code == 200
    body = r.json()
    assert body == {"bookingId": bid, "events": [], "count": 0}


# ══════════════════════════════════════════════════════════════════════
# 2. THE trust contract: provider sees ONLY whitelisted events
# ══════════════════════════════════════════════════════════════════════


async def test_provider_sees_operational_chronology(client, provider_token, db):
    provider_id = _decode_sub(provider_token)
    bid = await _seed_booking_for_provider(db, provider_id=provider_id)
    await _seed_full_lifecycle(db, bid, provider_id=provider_id)

    r = await client.get(
        f"/api/provider/bookings/{bid}/timeline",
        headers=_hdr(provider_token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    events = body["events"]

    # Expected visible chronology (in order):
    keys = [e["key"] for e in events]
    assert keys == [
        "matched",
        "confirmed",
        "on_route",
        "arrived",
        "in_progress",
        "completed",
    ], keys
    assert body["count"] == 6

    # isSelfAction must be True for provider-owned milestones, False
    # for system/admin events.
    by_key = {e["key"]: e for e in events}
    assert by_key["matched"]["isSelfAction"] is False
    assert by_key["confirmed"]["isSelfAction"] is True
    assert by_key["on_route"]["isSelfAction"] is True
    assert by_key["arrived"]["isSelfAction"] is False   # admin recovery
    assert by_key["in_progress"]["isSelfAction"] is True
    assert by_key["completed"]["isSelfAction"] is True


async def test_provider_never_sees_pricing_internals(client, provider_token, db):
    provider_id = _decode_sub(provider_token)
    bid = await _seed_booking_for_provider(db, provider_id=provider_id)
    await _seed_full_lifecycle(db, bid, provider_id=provider_id)

    r = await client.get(
        f"/api/provider/bookings/{bid}/timeline",
        headers=_hdr(provider_token),
    )
    serialized = repr(r.json()["events"])

    # Non-negotiables — every one of these has actually been planted
    # in the seed rows; the projection must scrub them all.
    assert "platformCut" not in serialized,    "platformCut leaked!"
    assert "providerCost" not in serialized,   "providerCost leaked!"
    assert "internalNote" not in serialized,   "internalNote leaked!"
    assert "internalNotes" not in serialized,  "internalNotes leaked!"
    assert "rankingScore" not in serialized,   "rankingScore leaked!"
    assert "trustScore" not in serialized,     "trustScore leaked!"
    assert "fraudFlag" not in serialized,      "fraudFlag leaked!"
    assert "admin-sara-9001" not in serialized, "admin actor id leaked!"
    assert "rejected" not in serialized,       "rejected attempt leaked!"
    assert "covert" not in serialized,         "rewrite-attempt evidence leaked!"


async def test_provider_sees_eta_and_payout(client, provider_token, db):
    """`eta`, `payoutAmount`, `customerNote`, `note` are explicit
    operational signals the provider relies on."""
    provider_id = _decode_sub(provider_token)
    bid = await _seed_booking_for_provider(db, provider_id=provider_id)
    await _seed_full_lifecycle(db, bid, provider_id=provider_id)

    r = await client.get(
        f"/api/provider/bookings/{bid}/timeline",
        headers=_hdr(provider_token),
    )
    by_key = {e["key"]: e for e in r.json()["events"]}

    assert by_key["on_route"]["meta"] == {"eta": 12}
    assert by_key["arrived"]["meta"] == {"reason": "manual recovery"}
    assert by_key["in_progress"]["meta"] == {"note": "started on time"}
    assert by_key["completed"]["meta"] == {
        "payoutAmount": 190,
        "customerNote": "buzzer broken",
    }


async def test_unknown_actions_silently_dropped(client, provider_token, db):
    """Future telemetry rows (e.g. `provider_viewed_booking`) must NOT
    fall through into the operational timeline."""
    provider_id = _decode_sub(provider_token)
    bid = await _seed_booking_for_provider(db, provider_id=provider_id)
    await db.booking_timeline.insert_many([
        {"id": uuid.uuid4().hex, "bookingId": bid, "bookingScope": "web_booking",
         "action": "provider_viewed_booking", "actorId": provider_id,
         "actorRole": "provider", "fromStatus": None, "toStatus": None,
         "meta": {}, "timestamp": _ts(0)},
        {"id": uuid.uuid4().hex, "bookingId": bid, "bookingScope": "web_booking",
         "action": "system_heartbeat", "actorId": "system",
         "actorRole": "system", "fromStatus": None, "toStatus": None,
         "meta": {}, "timestamp": _ts(1)},
    ])
    r = await client.get(
        f"/api/provider/bookings/{bid}/timeline",
        headers=_hdr(provider_token),
    )
    assert r.status_code == 200
    assert r.json()["events"] == []


# ══════════════════════════════════════════════════════════════════════
# 3. Cancel — contextual labelling, admin identity scrubbed
# ══════════════════════════════════════════════════════════════════════


async def test_customer_cancel_labelled_correctly(client, provider_token, db):
    provider_id = _decode_sub(provider_token)
    bid = await _seed_booking_for_provider(db, provider_id=provider_id)
    await db.booking_timeline.insert_one({
        "id": uuid.uuid4().hex, "bookingId": bid, "bookingScope": "web_booking",
        "action": "cancel", "actorId": "cust-some-other-user",
        "actorRole": "customer", "fromStatus": "confirmed", "toStatus": "cancelled",
        "meta": {"reason": "found cheaper option", "internalNotes": "leaked"},
        "timestamp": _ts(0),
    })
    r = await client.get(
        f"/api/provider/bookings/{bid}/timeline",
        headers=_hdr(provider_token),
    )
    events = r.json()["events"]
    assert len(events) == 1
    e = events[0]
    assert e["key"] == "cancelled"
    assert e["label"] == "Клиент отменил"
    assert e["isSelfAction"] is False
    assert e["meta"] == {"reason": "found cheaper option"}
    assert "internalNotes" not in repr(e)


async def test_admin_cancel_hides_admin_identity(client, provider_token, db):
    provider_id = _decode_sub(provider_token)
    bid = await _seed_booking_for_provider(db, provider_id=provider_id)
    await db.booking_timeline.insert_one({
        "id": uuid.uuid4().hex, "bookingId": bid, "bookingScope": "web_booking",
        "action": "cancel", "actorId": "admin-9001-secret-id",
        "actorRole": "admin", "fromStatus": "confirmed", "toStatus": "cancelled",
        "meta": {"reason": "platform_action",
                 "internalNotes": "linked to chargeback case 47",
                 "trustScore": 0.1},
        "timestamp": _ts(0),
    })
    r = await client.get(
        f"/api/provider/bookings/{bid}/timeline",
        headers=_hdr(provider_token),
    )
    events = r.json()["events"]
    assert len(events) == 1
    e = events[0]
    assert e["key"] == "cancelled"
    assert e["label"] == "Отменено администрацией"
    assert e["tone"] == "alert"
    assert e["isSelfAction"] is False
    serialized = repr(e)
    assert "admin-9001" not in serialized
    assert "internalNotes" not in serialized
    assert "chargeback" not in serialized
    assert "trustScore" not in serialized
    # The reason itself is operational and surfaces — it's how the
    # provider learns "cancelled, no fault of yours".
    assert e["meta"] == {"reason": "platform_action"}


async def test_own_cancel_marked_self(client, provider_token, db):
    provider_id = _decode_sub(provider_token)
    bid = await _seed_booking_for_provider(db, provider_id=provider_id)
    await db.booking_timeline.insert_one({
        "id": uuid.uuid4().hex, "bookingId": bid, "bookingScope": "web_booking",
        "action": "cancel", "actorId": provider_id,
        "actorRole": "provider", "fromStatus": "confirmed", "toStatus": "cancelled",
        "meta": {"reason": "vehicle breakdown"},
        "timestamp": _ts(0),
    })
    r = await client.get(
        f"/api/provider/bookings/{bid}/timeline",
        headers=_hdr(provider_token),
    )
    e = r.json()["events"][0]
    assert e["label"] == "Вы отменили заказ"
    assert e["isSelfAction"] is True
    assert e["meta"] == {"reason": "vehicle breakdown"}


# ══════════════════════════════════════════════════════════════════════
# 4. Dispute events surface — internals don't
# ══════════════════════════════════════════════════════════════════════


async def test_dispute_lifecycle_visible(client, provider_token, db):
    provider_id = _decode_sub(provider_token)
    bid = await _seed_booking_for_provider(db, provider_id=provider_id)
    await db.booking_timeline.insert_many([
        {"id": uuid.uuid4().hex, "bookingId": bid, "bookingScope": "web_booking",
         "action": "open_dispute", "actorId": "cust-some-other-user",
         "actorRole": "customer", "fromStatus": "completed", "toStatus": "disputed",
         "meta": {"reason": "quality", "internalNotes": "moderation: review evidence"},
         "timestamp": _ts(0)},
        {"id": uuid.uuid4().hex, "bookingId": bid, "bookingScope": "web_booking",
         "action": "resolve_dispute", "actorId": "admin-mod-3",
         "actorRole": "admin", "fromStatus": "disputed", "toStatus": "resolved",
         "meta": {"outcome": "refund_partial", "internalNotes": "ruling rationale"},
         "timestamp": _ts(1)},
    ])
    r = await client.get(
        f"/api/provider/bookings/{bid}/timeline",
        headers=_hdr(provider_token),
    )
    events = r.json()["events"]
    keys = [e["key"] for e in events]
    assert keys == ["dispute_opened", "dispute_resolved"]
    assert events[0]["tone"] == "alert"
    assert events[0]["meta"] == {"reason": "quality"}
    # `outcome` is NOT on the safe-meta whitelist for provider — admin
    # ruling internals stay opaque.
    assert events[1]["meta"] == {}
    serialized = repr(events)
    assert "admin-mod-3" not in serialized
    assert "moderation" not in serialized
    assert "internalNotes" not in serialized
    assert "ruling" not in serialized


# ══════════════════════════════════════════════════════════════════════
# 5. Snapshot test — full rendered payload (the architectural invariant)
# ══════════════════════════════════════════════════════════════════════


async def test_full_payload_snapshot(client, provider_token, db):
    """Snapshot of the entire rendered timeline. This is the strongest
    guard against accidental field-leak when future contributors add
    new `booking_timeline.meta` keys: any new key MUST be either added
    explicitly to the whitelist (and reflected in this snapshot) or
    invisible by default.
    """
    provider_id = _decode_sub(provider_token)
    bid = await _seed_booking_for_provider(db, provider_id=provider_id)
    await _seed_full_lifecycle(db, bid, provider_id=provider_id)

    r = await client.get(
        f"/api/provider/bookings/{bid}/timeline",
        headers=_hdr(provider_token),
    )
    body = r.json()

    expected_events = [
        {
            "key": "matched",
            "label": "Назначено вам",
            "description": "Новая задача. Подтвердите или откажитесь.",
            "tone": "action_required",
            "at": _ts(0),
            "isSelfAction": False,
            "meta": {},
        },
        {
            "key": "confirmed",
            "label": "Вы приняли заказ",
            "description": "Готовьтесь к выезду по графику.",
            "tone": "neutral",
            "at": _ts(2),
            "isSelfAction": True,
            "meta": {},
        },
        {
            "key": "on_route",
            "label": "В пути",
            "description": "Клиент уведомлён.",
            "tone": "in_flight",
            "at": _ts(4),
            "isSelfAction": True,
            "meta": {"eta": 12},
        },
        {
            "key": "arrived",
            "label": "На месте",
            "description": "Можно приступать к работе.",
            "tone": "in_flight",
            "at": _ts(5),
            "isSelfAction": False,
            "meta": {"reason": "manual recovery"},
        },
        {
            "key": "in_progress",
            "label": "Работа идёт",
            "description": "Зафиксируйте завершение по факту.",
            "tone": "in_flight",
            "at": _ts(6),
            "isSelfAction": True,
            "meta": {"note": "started on time"},
        },
        {
            "key": "completed",
            "label": "Работа завершена",
            "description": "Ожидается подтверждение и выплата.",
            "tone": "settled",
            "at": _ts(7),
            "isSelfAction": True,
            "meta": {"payoutAmount": 190, "customerNote": "buzzer broken"},
        },
    ]

    assert body == {
        "bookingId": bid,
        "events": expected_events,
        "count": 6,
    }


# ══════════════════════════════════════════════════════════════════════
# 6. Chronological order is ascending
# ══════════════════════════════════════════════════════════════════════


async def test_events_returned_chronologically(client, provider_token, db):
    provider_id = _decode_sub(provider_token)
    bid = await _seed_booking_for_provider(db, provider_id=provider_id)
    await _seed_full_lifecycle(db, bid, provider_id=provider_id)
    r = await client.get(
        f"/api/provider/bookings/{bid}/timeline",
        headers=_hdr(provider_token),
    )
    timestamps = [e["at"] for e in r.json()["events"]]
    assert timestamps == sorted(timestamps)


# ══════════════════════════════════════════════════════════════════════
# 7. Ownership via accountId / providerSlug variants
# ══════════════════════════════════════════════════════════════════════


async def test_ownership_matches_via_account_id(client, provider_token, db):
    """Caller's accountId can be the booking's providerId."""
    account_id = _decode_account(provider_token)
    if not account_id:
        pytest.skip("provider_token has no accountId claim")
    bid = await _seed_booking_for_provider(db, provider_id=account_id)
    r = await client.get(
        f"/api/provider/bookings/{bid}/timeline",
        headers=_hdr(provider_token),
    )
    assert r.status_code == 200
