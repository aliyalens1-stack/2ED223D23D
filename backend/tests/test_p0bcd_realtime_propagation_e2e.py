"""P0.b.C.d — Realtime propagation: snapshot-equivalence acceptance.

Doctrine:
  * Realtime pushes PROJECTED events, never raw timeline rows.
  * Wire payload of `event` field MUST equal the corresponding entry
    in REST `GET /.../timeline` response `events[]`. **This is THE
    architectural invariant of C.d** — diverging breaks the
    "REST is source of truth, realtime is acceleration" contract.
  * Channel == projection scope. Customer subscribers NEVER receive
    provider's payload. Filtering is server-side at emit time.
  * REST remains source of truth: dropping a WS frame loses nothing.

These tests exercise the publisher function directly (not via real
WebSocket transport). A `_FakeWS` captures envelopes; the publisher
treats it as a real WebSocket. This keeps tests fast, deterministic,
and independent of any event-loop-bound transport state. Real
WebSocket session lifecycle (`/stream`) is exercised separately
via starlette TestClient in `test_ws_session_*`.
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List

import jwt
import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient

from app.core.config import JWT_SECRET, JWT_ALGO


MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


# ─────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────


@pytest_asyncio.fixture
async def db():
    c = AsyncIOMotorClient(MONGO_URL)
    yield c[DB_NAME]
    c.close()


@pytest_asyncio.fixture
async def clean_hubs():
    """Drain every hub before AND after each test so subscribers from
    one test never leak into the next."""
    from app.booking.realtime import (
        HUB_CUSTOMER, HUB_PROVIDER, HUB_INSPECTOR, HUB_ADMIN,
    )
    for hub in (HUB_CUSTOMER, HUB_PROVIDER, HUB_INSPECTOR, HUB_ADMIN):
        async with hub._lock:                         # noqa: SLF001
            hub._subs.clear()                         # noqa: SLF001
    yield
    for hub in (HUB_CUSTOMER, HUB_PROVIDER, HUB_INSPECTOR, HUB_ADMIN):
        async with hub._lock:                         # noqa: SLF001
            hub._subs.clear()                         # noqa: SLF001


# ─────────────────────────────────────────────────────────────────────
# Fake WebSocket — captures envelopes sent to it.
# ─────────────────────────────────────────────────────────────────────


class _FakeWS:
    """Minimal stand-in for `fastapi.WebSocket`. Only `send_text` is
    used by the publisher's `_safe_send`. We store decoded JSON for
    easy assertions."""

    def __init__(self, label: str = "ws") -> None:
        self.label = label
        self.sent: List[Dict[str, Any]] = []

    async def send_text(self, raw: str) -> None:
        self.sent.append(json.loads(raw))


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────


def _decode_sub(token: str) -> str:
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO]).get("sub")


def _hdr(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _ts(i: int) -> str:
    base = datetime(2026, 5, 20, 9, 0, 0, tzinfo=timezone.utc)
    return base.replace(microsecond=i * 1000).isoformat()


async def _seed_booking_for_customer_provider(
    db, *, customer_id: str, provider_id: str
) -> str:
    bid = f"bk_{uuid.uuid4().hex[:12]}"
    await db.web_bookings.insert_one({
        "id": bid,
        "customerId": customer_id,
        "providerId": provider_id,
        "providerSlug": "test-provider-slug",
        "providerName": "Test Provider",
        "serviceName": "Diagnostics",
        "status": "matched",
        "platformCut": 30,
        "providerCost": 220,
        "internalNotes": "admin: VIP",
        "createdAt": datetime.now(timezone.utc).isoformat(),
    })
    return bid


def _build_row(
    booking_id: str, *, action: str, actor_role: str, actor_id: str,
    from_status: str, to_status: str, meta: Dict[str, Any],
    booking_scope: str = "web_booking",
    timestamp_idx: int = 0,
) -> Dict[str, Any]:
    return {
        "id": uuid.uuid4().hex,
        "bookingId": booking_id,
        "bookingScope": booking_scope,
        "action": action,
        "actorId": actor_id,
        "actorRole": actor_role,
        "fromStatus": from_status,
        "toStatus": to_status,
        "meta": meta,
        "timestamp": _ts(timestamp_idx),
    }


# ══════════════════════════════════════════════════════════════════════
# 1. THE invariant: realtime payload == REST payload (per event)
# ══════════════════════════════════════════════════════════════════════


async def test_snapshot_equivalence_customer(
    client, customer_token, customer_user_id, provider_user_id, db, clean_hubs,
):
    """Project a row via REST GET, then publish it via realtime to a
    subscribed customer; the realtime envelope's `event` field MUST
    equal the corresponding REST `events[0]`."""
    from app.booking.realtime import HUB_CUSTOMER, publish_timeline_event

    customer_id = customer_user_id
    bid = await _seed_booking_for_customer_provider(
        db, customer_id=customer_id, provider_id=provider_user_id,
    )

    # 1) Seed a single visible row + read it via REST.
    row = _build_row(
        bid, action="mark_on_route", actor_role="provider",
        actor_id=provider_user_id, from_status="confirmed",
        to_status="on_route",
        meta={"eta": 12, "platformCut": 30, "internalNote": "VIP"},
    )
    await db.booking_timeline.insert_one(dict(row))

    r = await client.get(
        f"/api/customer/bookings/{bid}/timeline",
        headers=_hdr(customer_token),
    )
    assert r.status_code == 200, r.text
    rest_events = r.json()["events"]
    assert len(rest_events) == 1
    rest_event = rest_events[0]

    # 2) Subscribe a fake customer WS, then publish the same row.
    fake_ws = _FakeWS("customer")
    await HUB_CUSTOMER.add(
        fake_ws, {"bookingId": bid, "viewerId": customer_id},
    )
    summary = await publish_timeline_event(db, row)

    # 3) Snapshot equivalence — the wire `event` MUST match REST.
    assert len(summary["customer"]) == 1, summary
    pushed = summary["customer"][0]
    assert pushed["type"] == "timeline.updated"
    assert pushed["scope"] == "customer"
    assert pushed["bookingId"] == bid
    assert pushed["event"] == rest_event, (
        f"Realtime payload diverged from REST!\n"
        f"  REST: {rest_event}\n"
        f"  WS:   {pushed['event']}"
    )

    # And the same was actually written to the fake socket.
    assert fake_ws.sent == [pushed]


async def test_snapshot_equivalence_provider(
    client, provider_token, customer_user_id, provider_user_id, db, clean_hubs,
):
    from app.booking.realtime import HUB_PROVIDER, publish_timeline_event

    provider_id = provider_user_id
    bid = await _seed_booking_for_customer_provider(
        db, customer_id=customer_user_id, provider_id=provider_id,
    )

    row = _build_row(
        bid, action="mark_completed", actor_role="provider",
        actor_id=provider_id, from_status="in_progress", to_status="completed",
        meta={"payoutAmount": 190, "platformCut": 30,
              "customerNote": "buzzer broken"},
    )
    await db.booking_timeline.insert_one(dict(row))

    r = await client.get(
        f"/api/provider/bookings/{bid}/timeline",
        headers=_hdr(provider_token),
    )
    assert r.status_code == 200
    rest_event = r.json()["events"][0]

    fake_ws = _FakeWS("provider")
    await HUB_PROVIDER.add(
        fake_ws, {"bookingId": bid, "viewerIds": [provider_id]},
    )
    summary = await publish_timeline_event(db, row)
    assert len(summary["provider"]) == 1
    pushed = summary["provider"][0]
    assert pushed["scope"] == "provider"
    assert pushed["event"] == rest_event


async def test_snapshot_equivalence_inspector(
    client, provider_token, db, clean_hubs,
):
    """Inspector channel uses jobId addressing. Subscriber ctx carries
    the pre-resolved requestId; emit-time match is a dict lookup."""
    from app.booking.realtime import HUB_INSPECTOR, publish_timeline_event

    inspector_id = _decode_sub(provider_token)
    job_id = f"job_{uuid.uuid4().hex[:12]}"
    request_id = f"car_{uuid.uuid4().hex[:12]}"

    await db.inspection_jobs.insert_one({
        "_id": job_id, "inspectorId": inspector_id, "requestId": request_id,
        "status": "claimed", "createdAt": datetime.now(timezone.utc),
    })
    await db.car_requests.insert_one({
        "_id": request_id, "userId": "cust-1", "providerId": "prov-x",
        "status": "in_progress", "createdAt": datetime.now(timezone.utc),
    })

    row = _build_row(
        request_id, action="mark_completed", actor_role="inspector",
        actor_id=inspector_id, from_status="in_progress", to_status="completed",
        meta={"reportId": "rep_xyz", "inspectorPayoutAmount": 45,
              "payoutAmount": 190,                  # provider's, scrubbed
              "platformCut": 30, "customerNote": "buzzer broken"},
        booking_scope="car_request",
    )
    await db.booking_timeline.insert_one(dict(row))

    r = await client.get(
        f"/api/inspector/jobs/{job_id}/timeline",
        headers=_hdr(provider_token),
    )
    assert r.status_code == 200
    rest_event = r.json()["events"][0]

    fake_ws = _FakeWS("inspector")
    await HUB_INSPECTOR.add(fake_ws, {
        "jobId": job_id, "requestId": request_id,
        "viewerIds": [inspector_id],
    })
    summary = await publish_timeline_event(db, row)
    assert len(summary["inspector"]) == 1
    pushed = summary["inspector"][0]
    assert pushed["scope"] == "inspector"
    assert pushed["jobId"] == job_id
    assert "bookingId" not in pushed, "inspector wire MUST NOT echo bookingId"
    assert pushed["event"] == rest_event


# ══════════════════════════════════════════════════════════════════════
# 2. Cross-actor opacity — subscribers don't get other actors' payloads
# ══════════════════════════════════════════════════════════════════════


async def test_customer_subscriber_never_sees_admin_internals(
    customer_user_id, provider_user_id, db, clean_hubs,
):
    """When admin transitions a booking, customer's WS event must NOT
    contain admin actor id or internalNotes — same scrubbing as REST."""
    from app.booking.realtime import HUB_CUSTOMER, publish_timeline_event

    bid = await _seed_booking_for_customer_provider(
        db, customer_id=customer_user_id, provider_id=provider_user_id,
    )
    fake_ws = _FakeWS("customer")
    await HUB_CUSTOMER.add(
        fake_ws, {"bookingId": bid, "viewerId": customer_user_id},
    )
    # Admin manually marks arrived (recovery) with leaky meta.
    row = _build_row(
        bid, action="mark_arrived", actor_role="admin",
        actor_id="admin-secret-9001", from_status="on_route", to_status="arrived",
        meta={"reason": "manual recovery", "internalNotes": "GPS dropout",
              "trustScore": 0.42, "platformCut": 30},
    )
    summary = await publish_timeline_event(db, row)

    assert len(summary["customer"]) == 1
    pushed = summary["customer"][0]
    serialized = repr(pushed)
    assert "admin-secret-9001" not in serialized
    assert "internalNotes" not in serialized
    assert "trustScore" not in serialized
    assert "platformCut" not in serialized


async def test_filtered_actions_emit_nothing_to_actor_channels(
    customer_user_id, provider_user_id, db, clean_hubs,
):
    """`mark_matched` is hidden from customer projection → no customer
    envelope. `mark_confirmed` is hidden from inspector → no inspector
    envelope. But admin channel ALWAYS sees raw."""
    from app.booking.realtime import (
        HUB_CUSTOMER, HUB_PROVIDER, HUB_INSPECTOR, HUB_ADMIN,
        publish_timeline_event,
    )

    bid = await _seed_booking_for_customer_provider(
        db, customer_id=customer_user_id, provider_id=provider_user_id,
    )

    # Wire inspector subscriber as well, even though the row is from a
    # different booking_scope; we'll create the matching job+request.
    request_id = bid  # use same id for simplicity — web_booking scope only
    inspector_ws = _FakeWS("inspector")
    await HUB_INSPECTOR.add(inspector_ws, {
        "jobId": "fake_job", "requestId": request_id,
        "viewerIds": ["any-inspector"],
    })
    customer_ws = _FakeWS("customer")
    await HUB_CUSTOMER.add(customer_ws, {
        "bookingId": bid, "viewerId": customer_user_id,
    })
    provider_ws = _FakeWS("provider")
    await HUB_PROVIDER.add(provider_ws, {
        "bookingId": bid, "viewerIds": [provider_user_id],
    })
    admin_ws = _FakeWS("admin")
    await HUB_ADMIN.add(admin_ws, {"bookingId": bid})

    # mark_matched — hidden from CUSTOMER (system-internal).
    row = _build_row(
        bid, action="mark_matched", actor_role="system",
        actor_id="matcher", from_status="requested", to_status="matched",
        meta={},
    )
    summary = await publish_timeline_event(db, row)

    # Customer: NOTHING.
    assert summary["customer"] == []
    assert customer_ws.sent == []
    # Provider: SEES it (mark_matched is on provider whitelist as "matched").
    assert len(summary["provider"]) == 1
    assert summary["provider"][0]["event"]["key"] == "matched"
    # Inspector: SEES it relabeled as "assigned".
    assert len(summary["inspector"]) == 1
    assert summary["inspector"][0]["event"]["key"] == "assigned"
    # Admin: ALWAYS sees raw row.
    assert len(summary["admin"]) == 1
    assert summary["admin"][0]["event"]["action"] == "mark_matched"
    assert summary["admin"][0]["event"]["actorId"] == "matcher"


async def test_foreign_provider_subscriber_gets_nothing(
    customer_user_id, provider_user_id, db, clean_hubs,
):
    """A provider subscribed to a booking they don't own gets ZERO
    envelopes — even though the WS connection is open. Opacity
    enforced server-side at emit time."""
    from app.booking.realtime import HUB_PROVIDER, publish_timeline_event

    bid = await _seed_booking_for_customer_provider(
        db, customer_id=customer_user_id, provider_id=provider_user_id,
    )
    foreign_ws = _FakeWS("foreign-provider")
    await HUB_PROVIDER.add(foreign_ws, {
        "bookingId": bid, "viewerIds": ["some-other-provider-id"],
    })
    row = _build_row(
        bid, action="mark_on_route", actor_role="provider",
        actor_id=provider_user_id, from_status="confirmed", to_status="on_route",
        meta={"eta": 12},
    )
    summary = await publish_timeline_event(db, row)
    assert summary["provider"] == []
    assert foreign_ws.sent == []


async def test_subscriber_to_different_booking_id_gets_nothing(
    customer_user_id, provider_user_id, db, clean_hubs,
):
    """Customer subscribed to bookingA must NOT receive events from
    bookingB even if they're the same user."""
    from app.booking.realtime import HUB_CUSTOMER, publish_timeline_event

    bid_a = await _seed_booking_for_customer_provider(
        db, customer_id=customer_user_id, provider_id=provider_user_id,
    )
    bid_b = await _seed_booking_for_customer_provider(
        db, customer_id=customer_user_id, provider_id=provider_user_id,
    )
    fake = _FakeWS("customer-on-A")
    await HUB_CUSTOMER.add(fake, {
        "bookingId": bid_a, "viewerId": customer_user_id,
    })
    row_for_b = _build_row(
        bid_b, action="mark_on_route", actor_role="provider",
        actor_id=provider_user_id, from_status="confirmed", to_status="on_route",
        meta={"eta": 7},
    )
    summary = await publish_timeline_event(db, row_for_b)
    assert summary["customer"] == []
    assert fake.sent == []


# ══════════════════════════════════════════════════════════════════════
# 3. Admin channel — raw forensic surface
# ══════════════════════════════════════════════════════════════════════


async def test_admin_channel_receives_raw_row(
    customer_user_id, provider_user_id, db, clean_hubs,
):
    """Admin scope sees the RAW timeline row — every internal field
    preserved (forensic surface). NO projection, NO scrubbing."""
    from app.booking.realtime import HUB_ADMIN, publish_timeline_event

    bid = await _seed_booking_for_customer_provider(
        db, customer_id=customer_user_id, provider_id=provider_user_id,
    )
    admin_ws = _FakeWS("admin")
    await HUB_ADMIN.add(admin_ws, {"bookingId": bid})

    row = _build_row(
        bid, action="mark_in_progress", actor_role="admin",
        actor_id="admin-internal-9001", from_status="arrived", to_status="in_progress",
        meta={"reason": "manual recovery", "internalNotes": "case 47",
              "trustScore": 0.42, "platformCut": 30, "fraudFlag": False},
    )
    summary = await publish_timeline_event(db, row)
    assert len(summary["admin"]) == 1
    pushed = summary["admin"][0]
    assert pushed["scope"] == "admin"
    # Raw row preserved verbatim (minus _id).
    serialized = repr(pushed["event"])
    assert "admin-internal-9001" in serialized
    assert "internalNotes" in serialized
    assert "case 47" in serialized
    assert "trustScore" in serialized
    assert "platformCut" in serialized
    # Action + actor + status fields all carry through.
    assert pushed["event"]["action"] == "mark_in_progress"
    assert pushed["event"]["actorRole"] == "admin"
    assert pushed["event"]["fromStatus"] == "arrived"
    assert pushed["event"]["toStatus"] == "in_progress"


# ══════════════════════════════════════════════════════════════════════
# 4. observe_transition → realtime sidecar wiring
# ══════════════════════════════════════════════════════════════════════


async def test_observe_transition_triggers_realtime_emit(
    customer_user_id, provider_user_id, db, clean_hubs,
):
    """End-to-end: a real `observe_transition()` call propagates to
    subscribed actors. This is the wire we actually rely on for
    business mutations (cancel / accept / job_action / dispute /
    report).
    """
    from app.booking.realtime import (
        HUB_CUSTOMER, HUB_PROVIDER, HUB_ADMIN,
    )
    from app.booking.attach import observe_transition
    from app.core.context import ctx

    bid = await _seed_booking_for_customer_provider(
        db, customer_id=customer_user_id, provider_id=provider_user_id,
    )
    customer_ws = _FakeWS("c")
    provider_ws = _FakeWS("p")
    admin_ws = _FakeWS("a")
    await HUB_CUSTOMER.add(customer_ws, {"bookingId": bid, "viewerId": customer_user_id})
    await HUB_PROVIDER.add(provider_ws, {"bookingId": bid, "viewerIds": [provider_user_id]})
    await HUB_ADMIN.add(admin_ws, {"bookingId": bid})

    # Need ctx.db for the publish_timeline_event's owner-resolution
    # (it reads via `db` arg here; we pass `db` directly to
    # observe_transition so this is fine — no ctx required).

    inserted = await observe_transition(
        db,
        booking_id=bid, booking_scope="web_booking",
        action="mark_on_route", from_status="confirmed", to_status="on_route",
        actor_id=provider_user_id, actor_role="provider",
        source="test.unit", source_request_id=f"rid-{uuid.uuid4().hex[:8]}",
        meta={"eta": 9, "platformCut": 30},
    )
    assert inserted is not None

    # All three subscribers received exactly one envelope.
    assert len(customer_ws.sent) == 1
    assert len(provider_ws.sent) == 1
    assert len(admin_ws.sent) == 1

    # Customer wire matches what REST would project.
    assert customer_ws.sent[0]["event"]["key"] == "on_route"
    assert customer_ws.sent[0]["event"]["meta"] == {"eta": 9}
    assert "platformCut" not in repr(customer_ws.sent[0])

    # Provider wire — own action.
    assert provider_ws.sent[0]["event"]["key"] == "on_route"
    assert provider_ws.sent[0]["event"]["isSelfAction"] is True

    # Admin wire — raw.
    assert admin_ws.sent[0]["event"]["action"] == "mark_on_route"
    assert "platformCut" in repr(admin_ws.sent[0])


async def test_observe_transition_dedup_does_not_re_emit(
    customer_user_id, provider_user_id, db, clean_hubs,
):
    """The idempotent upsert returns None on duplicate; realtime must
    NOT re-fire for the duplicate. Otherwise the customer would see
    "Provider arrived" twice."""
    from app.booking.realtime import HUB_CUSTOMER
    from app.booking.attach import observe_transition

    bid = await _seed_booking_for_customer_provider(
        db, customer_id=customer_user_id, provider_id=provider_user_id,
    )
    fake = _FakeWS("c")
    await HUB_CUSTOMER.add(fake, {"bookingId": bid, "viewerId": customer_user_id})

    rid = f"rid-{uuid.uuid4().hex[:8]}"
    common = dict(
        booking_id=bid, booking_scope="web_booking",
        action="mark_arrived", from_status="on_route", to_status="arrived",
        actor_id=provider_user_id, actor_role="provider",
        source="test.unit", source_request_id=rid, meta={},
    )
    first = await observe_transition(db, **common)
    second = await observe_transition(db, **common)
    assert first is not None
    assert second is None     # dedup
    assert len(fake.sent) == 1


# ══════════════════════════════════════════════════════════════════════
# 5. Best-effort: subscriber failure doesn't sabotage emit fanout
# ══════════════════════════════════════════════════════════════════════


async def test_publisher_continues_when_one_subscriber_fails(
    customer_user_id, provider_user_id, db, clean_hubs,
):
    """If one subscriber's send_text raises, the publisher must still
    deliver to all other subscribers and return cleanly. Realtime is
    acceleration; one bad client must not block the rest of the fanout
    or surface an error to the business mutation."""
    from app.booking.realtime import HUB_CUSTOMER, publish_timeline_event

    class _ExplodingWS:
        async def send_text(self, _raw: str) -> None:
            raise RuntimeError("simulated bad consumer")

    bid = await _seed_booking_for_customer_provider(
        db, customer_id=customer_user_id, provider_id=provider_user_id,
    )
    bad = _ExplodingWS()
    good = _FakeWS("good")
    await HUB_CUSTOMER.add(bad, {"bookingId": bid, "viewerId": customer_user_id})
    await HUB_CUSTOMER.add(good, {"bookingId": bid, "viewerId": customer_user_id})

    row = _build_row(
        bid, action="mark_on_route", actor_role="provider",
        actor_id=provider_user_id, from_status="confirmed", to_status="on_route",
        meta={"eta": 5},
    )
    # No exception out of publish.
    summary = await publish_timeline_event(db, row)
    # The good subscriber received its envelope.
    assert len(good.sent) == 1
    # The summary reflects ONE successful customer push (the good one).
    assert len(summary["customer"]) == 1


# ══════════════════════════════════════════════════════════════════════
# 6. WS session lifecycle — live smoke against running supervisor
# ══════════════════════════════════════════════════════════════════════
#
# We deliberately do NOT use `TestClient(app)` here. That path spawns
# the full app lifespan (orchestrator background loops, feedback
# processor, etc.) and tearing it down inside a unit test races with
# those tasks. Instead we hit the actually-running supervisor backend
# over the network — same surface a real frontend client uses.


async def test_customer_ws_rejects_missing_token():
    """Smoke against the running supervisor backend: WS upgrade must
    fail when no `?token=` query param is provided."""
    import websockets
    backend_ws = os.environ.get(
        "BACKEND_WS_URL", "ws://localhost:8001"
    )
    url = f"{backend_ws}/api/customer/bookings/bk_any/timeline/stream"
    try:
        async with websockets.connect(url) as _:
            pytest.fail("WS connect should have been rejected without token")
    except Exception:
        # Any rejection path is acceptable — handshake failure, 4401
        # close code, or HTTP-level rejection.
        pass


async def test_customer_ws_hello_frame_live(customer_token):
    """Live smoke: connect with a valid token → server sends hello."""
    import websockets
    backend_ws = os.environ.get(
        "BACKEND_WS_URL", "ws://localhost:8001"
    )
    url = (
        f"{backend_ws}/api/customer/bookings/bk_smoke/timeline/stream"
        f"?token={customer_token}"
    )
    async with websockets.connect(url) as ws:
        first = await ws.recv()
        msg = json.loads(first)
        assert msg["type"] == "hello"
        assert msg["payload"]["scope"] == "customer"
        assert msg["payload"]["bookingId"] == "bk_smoke"
