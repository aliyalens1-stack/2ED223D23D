"""P0.b.C.c — Inspector-facing timeline projection: e2e acceptance.

Verifies the inspector trust contract:

  Inspector SHOULD see:
    - mark_matched → "Осмотр назначен" (NOT "Назначено вам" from provider!)
    - mark_on_route / mark_arrived / mark_in_progress / mark_completed
      with inspection-centric labels and tones
    - cancel (own / customer / provider / admin — contextual label)
    - open_dispute / resolve_dispute

  Inspector MUST NEVER see:
    - mark_confirmed (provider's accept, not inspector's milestone)
    - `*:rejected` rows
    - platformCut / providerCost / payoutAmount (provider's money,
      not inspector's)
    - customerNote (notes for provider surface, not inspector)
    - refundAmount / refund internals
    - internalNotes / adminNote / moderation comments
    - trustScore / fraudFlag / rankingScore
    - admin actor ids
    - activity-feed noise

Plus the snapshot test (full rendered payload) — guards against
field-leak when new `booking_timeline.meta` keys land.

Endpoint design: `GET /api/inspector/jobs/{jobId}/timeline`. Inspector
thinks in job ids, not bookingIds — that's the surface semantics.
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


def _ts(i: int) -> str:
    """Deterministic ascending timestamps for snapshot stability."""
    base = datetime(2026, 5, 20, 9, 0, 0, tzinfo=timezone.utc)
    return base.replace(microsecond=i * 1000).isoformat()


async def _seed_inspector_job(db, *, inspector_id: str) -> tuple[str, str]:
    """Create an inspection_job + a car_request linked to it.

    Returns (job_id, request_id).
    """
    job_id = f"job_{uuid.uuid4().hex[:12]}"
    request_id = f"car_{uuid.uuid4().hex[:12]}"
    await db.inspection_jobs.insert_one({
        "_id": job_id,
        "inspectorId": inspector_id,
        "requestId": request_id,
        "status": "claimed",
        "city": "Berlin",
        "brand": "BMW",
        "model": "320d",
        "internalNotes": "admin: VIP customer",  # ← test scrubbing
        "platformCut": 30,                       # ← test scrubbing
        "createdAt": datetime.now(timezone.utc),
    })
    await db.car_requests.insert_one({
        "_id": request_id,
        "status": "in_progress",
        "userId": "cust-abc",
        "providerId": "prov-other",
        "createdAt": datetime.now(timezone.utc),
    })
    return job_id, request_id


async def _seed_full_lifecycle(
    db, request_id: str, *, inspector_id: str
) -> None:
    """Plant rows covering every inspector visibility branch
    on the underlying booking_timeline (keyed by request_id).
    """
    # Note: the bookingId on booking_timeline rows points at the
    # car_request id (the underlying booking aggregate). The
    # inspector router will translate jobId → requestId internally.
    rows = [
        # 0) Job assigned by matcher — VISIBLE as "Осмотр назначен"
        ("mark_matched", "system", "matcher-bot",
         "requested", "matched",
         {"platformCut": 30, "rankingScore": 0.87, "trustScore": 0.91}),
        # 1) Provider confirmed booking — HIDDEN (not inspector's event)
        ("mark_confirmed", "provider", "prov-other-1",
         "matched", "confirmed",
         {"platformCut": 30, "providerCost": 220, "internalNote": "VIP"}),
        # 2) Inspector starts moving — VISIBLE, isSelfAction=True
        ("mark_on_route", "inspector", inspector_id,
         "confirmed", "on_route",
         {"eta": 15, "platformCut": 30}),
        # 3) Competitor inspector's failed accept (TOCTOU race) — HIDDEN
        ("mark_on_route:rejected", "inspector", "other-inspector",
         "on_route", None, {"error": "Race"}),
        # 4) Inspector arrived — VISIBLE
        ("mark_arrived", "inspector", inspector_id,
         "on_route", "arrived", {"note": "Buzzer answered"}),
        # 5) Admin override (legacy recovery) — VISIBLE event, NO admin id
        ("mark_in_progress", "admin", "admin-sara-9001",
         "arrived", "in_progress",
         {"reason": "manual recovery", "internalNotes": "GPS dropout",
          "trustScore": 0.42, "fraudFlag": False}),
        # 6) Inspector completed (from reports.submit attach) — VISIBLE
        ("mark_completed", "inspector", inspector_id,
         "in_progress", "completed",
         {"reportId": "rep_xyz", "platformCut": 30,
          "payoutAmount": 190,           # provider's payout — NOT inspector's!
          "customerNote": "buzzer broken",  # notes meant for provider
          "inspectorPayoutAmount": 45}),
        # 7) Admin tried to rewrite terminal — HIDDEN
        ("mark_in_progress:rejected", "admin", "admin-sara-9001",
         "completed", None, {"error": "Booking is terminal"}),
    ]
    docs = []
    for i, (action, role, actor, fr, to, meta) in enumerate(rows):
        docs.append({
            "id": uuid.uuid4().hex,
            "bookingId": request_id,
            "bookingScope": "car_request",
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
# 1. Endpoint contract — auth, 404 opacity, jobId addressing
# ══════════════════════════════════════════════════════════════════════


async def test_endpoint_requires_auth(client):
    r = await client.get("/api/inspector/jobs/job_does_not_exist/timeline")
    assert r.status_code == 401


async def test_endpoint_returns_404_for_missing_job(client, provider_token):
    r = await client.get(
        "/api/inspector/jobs/job_nonexistent_xyz/timeline",
        headers=_hdr(provider_token),
    )
    assert r.status_code == 404


async def test_endpoint_returns_404_for_unassigned_job(client, provider_token, db):
    """Job with no inspectorId field — inspector cannot claim it."""
    job_id = f"job_{uuid.uuid4().hex[:12]}"
    await db.inspection_jobs.insert_one({
        "_id": job_id,
        "requestId": f"car_{uuid.uuid4().hex[:8]}",
        "status": "open",
        # no inspectorId at all
        "createdAt": datetime.now(timezone.utc),
    })
    r = await client.get(
        f"/api/inspector/jobs/{job_id}/timeline",
        headers=_hdr(provider_token),
    )
    assert r.status_code == 404


async def test_endpoint_returns_404_for_other_inspectors_job(
    client, provider_token, db
):
    """Foreign-owned job must return 404 (not 403) to avoid leaking
    the existence of competitor jobs. Same opacity discipline as
    provider router."""
    job_id, _ = await _seed_inspector_job(db, inspector_id="some-other-inspector")
    r = await client.get(
        f"/api/inspector/jobs/{job_id}/timeline",
        headers=_hdr(provider_token),
    )
    assert r.status_code == 404


async def test_empty_timeline_returns_empty_events(client, provider_token, db):
    inspector_id = _decode_sub(provider_token)
    job_id, _ = await _seed_inspector_job(db, inspector_id=inspector_id)
    r = await client.get(
        f"/api/inspector/jobs/{job_id}/timeline",
        headers=_hdr(provider_token),
    )
    assert r.status_code == 200
    body = r.json()
    assert body == {"jobId": job_id, "events": [], "count": 0}
    # Inspector surface MUST NOT echo bookingId / requestId in response.
    assert "bookingId" not in body
    assert "requestId" not in body


async def test_job_without_request_link_returns_empty(client, provider_token, db):
    """A job without a `requestId` link returns empty events
    (no booking aggregate to read chronology from)."""
    inspector_id = _decode_sub(provider_token)
    job_id = f"job_{uuid.uuid4().hex[:12]}"
    await db.inspection_jobs.insert_one({
        "_id": job_id,
        "inspectorId": inspector_id,
        # no requestId
        "status": "open",
        "createdAt": datetime.now(timezone.utc),
    })
    r = await client.get(
        f"/api/inspector/jobs/{job_id}/timeline",
        headers=_hdr(provider_token),
    )
    assert r.status_code == 200
    assert r.json() == {"jobId": job_id, "events": [], "count": 0}


# ══════════════════════════════════════════════════════════════════════
# 2. THE trust contract: inspector sees ONLY whitelisted events
# ══════════════════════════════════════════════════════════════════════


async def test_inspector_sees_inspection_centric_chronology(
    client, provider_token, db
):
    inspector_id = _decode_sub(provider_token)
    job_id, request_id = await _seed_inspector_job(db, inspector_id=inspector_id)
    await _seed_full_lifecycle(db, request_id, inspector_id=inspector_id)

    r = await client.get(
        f"/api/inspector/jobs/{job_id}/timeline",
        headers=_hdr(provider_token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    events = body["events"]

    # mark_confirmed is deliberately HIDDEN — provider's event, not
    # inspector's. The chronology jumps from `assigned` straight to
    # `on_route`.
    keys = [e["key"] for e in events]
    assert keys == [
        "assigned",
        "on_route",
        "arrived",
        "inspecting",
        "completed",
    ], keys
    assert body["count"] == 5

    # Labels are inspection-centric (DIFFERENT from provider's).
    by_key = {e["key"]: e for e in events}
    assert by_key["assigned"]["label"] == "Осмотр назначен"
    assert by_key["on_route"]["label"] == "В пути на осмотр"
    assert by_key["arrived"]["label"] == "На месте"
    assert by_key["inspecting"]["label"] == "Осмотр начат"
    assert by_key["completed"]["label"] == "Отчёт отправлен"

    # Inspector tone vocabulary — different from provider's
    # (action_required/in_flight/settled) and from customer's
    # (positive/celebratory).
    assert by_key["assigned"]["tone"] == "ready"
    assert by_key["on_route"]["tone"] == "travel"
    assert by_key["arrived"]["tone"] == "on_site"
    assert by_key["inspecting"]["tone"] == "documenting"
    assert by_key["completed"]["tone"] == "submitted"

    # isSelfAction must be correct.
    assert by_key["assigned"]["isSelfAction"] is False  # system matcher
    assert by_key["on_route"]["isSelfAction"] is True   # inspector
    assert by_key["arrived"]["isSelfAction"] is True    # inspector
    assert by_key["inspecting"]["isSelfAction"] is False  # admin row in seed
    assert by_key["completed"]["isSelfAction"] is True  # inspector

    # mark_confirmed at _ts(1) is HIDDEN — provider's event, not inspector's.


async def test_inspector_never_sees_pricing_internals(
    client, provider_token, db
):
    inspector_id = _decode_sub(provider_token)
    job_id, request_id = await _seed_inspector_job(db, inspector_id=inspector_id)
    await _seed_full_lifecycle(db, request_id, inspector_id=inspector_id)

    r = await client.get(
        f"/api/inspector/jobs/{job_id}/timeline",
        headers=_hdr(provider_token),
    )
    serialized = repr(r.json()["events"])

    # Non-negotiables — all of these are planted in seed.
    assert "platformCut" not in serialized,    "platformCut leaked!"
    assert "providerCost" not in serialized,   "providerCost leaked!"
    assert "internalNote" not in serialized,   "internalNote leaked!"
    assert "internalNotes" not in serialized,  "internalNotes leaked!"
    assert "rankingScore" not in serialized,   "rankingScore leaked!"
    assert "trustScore" not in serialized,     "trustScore leaked!"
    assert "fraudFlag" not in serialized,      "fraudFlag leaked!"
    assert "admin-sara-9001" not in serialized, "admin actor id leaked!"
    assert "rejected" not in serialized,       "rejected attempt leaked!"
    # Inspector MUST NOT see provider's payout. inspectorPayoutAmount
    # is allowed, payoutAmount (provider's) is NOT.
    assert "'payoutAmount'" not in serialized, "provider payoutAmount leaked!"
    # Inspector MUST NOT see customerNote (those are for provider).
    assert "customerNote" not in serialized,   "customerNote leaked!"
    assert "buzzer broken" not in serialized,  "customer note text leaked!"
    # Inspector MUST NOT see other-inspector ids.
    assert "other-inspector" not in serialized, "competitor inspector id leaked!"
    assert "prov-other-1" not in serialized,    "provider actor id leaked!"


async def test_inspector_sees_eta_and_payout_and_reportid(
    client, provider_token, db
):
    """Whitelisted meta keys for inspector: eta, reason, note,
    reportId, inspectorPayoutAmount."""
    inspector_id = _decode_sub(provider_token)
    job_id, request_id = await _seed_inspector_job(db, inspector_id=inspector_id)
    await _seed_full_lifecycle(db, request_id, inspector_id=inspector_id)

    r = await client.get(
        f"/api/inspector/jobs/{job_id}/timeline",
        headers=_hdr(provider_token),
    )
    by_key = {e["key"]: e for e in r.json()["events"]}

    assert by_key["on_route"]["meta"] == {"eta": 15}
    assert by_key["arrived"]["meta"] == {"note": "Buzzer answered"}
    assert by_key["inspecting"]["meta"] == {"reason": "manual recovery"}
    assert by_key["completed"]["meta"] == {
        "reportId": "rep_xyz",
        "inspectorPayoutAmount": 45,
    }


async def test_unknown_actions_silently_dropped(client, provider_token, db):
    inspector_id = _decode_sub(provider_token)
    job_id, request_id = await _seed_inspector_job(db, inspector_id=inspector_id)
    await db.booking_timeline.insert_many([
        {"id": uuid.uuid4().hex, "bookingId": request_id, "bookingScope": "car_request",
         "action": "inspector_opened_page", "actorId": inspector_id,
         "actorRole": "inspector", "fromStatus": None, "toStatus": None,
         "meta": {}, "timestamp": _ts(0)},
        {"id": uuid.uuid4().hex, "bookingId": request_id, "bookingScope": "car_request",
         "action": "system_heartbeat", "actorId": "system",
         "actorRole": "system", "fromStatus": None, "toStatus": None,
         "meta": {}, "timestamp": _ts(1)},
        # Even the provider's mark_confirmed is silently dropped for inspector
        {"id": uuid.uuid4().hex, "bookingId": request_id, "bookingScope": "car_request",
         "action": "mark_confirmed", "actorId": "prov-other",
         "actorRole": "provider", "fromStatus": "matched", "toStatus": "confirmed",
         "meta": {}, "timestamp": _ts(2)},
    ])
    r = await client.get(
        f"/api/inspector/jobs/{job_id}/timeline",
        headers=_hdr(provider_token),
    )
    assert r.status_code == 200
    assert r.json()["events"] == []


# ══════════════════════════════════════════════════════════════════════
# 3. Cancel — contextual labelling (4 cases)
# ══════════════════════════════════════════════════════════════════════


async def test_own_cancel_marked_self(client, provider_token, db):
    inspector_id = _decode_sub(provider_token)
    job_id, request_id = await _seed_inspector_job(db, inspector_id=inspector_id)
    await db.booking_timeline.insert_one({
        "id": uuid.uuid4().hex, "bookingId": request_id, "bookingScope": "car_request",
        "action": "cancel", "actorId": inspector_id, "actorRole": "inspector",
        "fromStatus": "on_route", "toStatus": "cancelled",
        "meta": {"reason": "vehicle breakdown"},
        "timestamp": _ts(0),
    })
    r = await client.get(
        f"/api/inspector/jobs/{job_id}/timeline",
        headers=_hdr(provider_token),
    )
    e = r.json()["events"][0]
    assert e["label"] == "Вы отменили выезд"
    assert e["isSelfAction"] is True
    assert e["tone"] == "closed"
    assert e["meta"] == {"reason": "vehicle breakdown"}


async def test_customer_cancel_labelled_correctly(client, provider_token, db):
    inspector_id = _decode_sub(provider_token)
    job_id, request_id = await _seed_inspector_job(db, inspector_id=inspector_id)
    await db.booking_timeline.insert_one({
        "id": uuid.uuid4().hex, "bookingId": request_id, "bookingScope": "car_request",
        "action": "cancel", "actorId": "cust-abc", "actorRole": "customer",
        "fromStatus": "matched", "toStatus": "cancelled",
        "meta": {"reason": "found cheaper option", "internalNotes": "leaked"},
        "timestamp": _ts(0),
    })
    r = await client.get(
        f"/api/inspector/jobs/{job_id}/timeline",
        headers=_hdr(provider_token),
    )
    e = r.json()["events"][0]
    assert e["label"] == "Клиент отменил"
    assert e["tone"] == "attention"
    assert e["isSelfAction"] is False
    assert e["meta"] == {"reason": "found cheaper option"}
    assert "internalNotes" not in repr(e)


async def test_provider_cancel_labelled_correctly(client, provider_token, db):
    """Inspector cares about provider-side cancels operationally
    (SLA, scheduling impact)."""
    inspector_id = _decode_sub(provider_token)
    job_id, request_id = await _seed_inspector_job(db, inspector_id=inspector_id)
    await db.booking_timeline.insert_one({
        "id": uuid.uuid4().hex, "bookingId": request_id, "bookingScope": "car_request",
        "action": "cancel", "actorId": "prov-other", "actorRole": "provider",
        "fromStatus": "confirmed", "toStatus": "cancelled",
        "meta": {"reason": "scheduling_conflict"},
        "timestamp": _ts(0),
    })
    r = await client.get(
        f"/api/inspector/jobs/{job_id}/timeline",
        headers=_hdr(provider_token),
    )
    e = r.json()["events"][0]
    assert e["label"] == "Провайдер отменил"
    assert e["tone"] == "attention"
    assert e["isSelfAction"] is False


async def test_admin_cancel_hides_admin_identity(client, provider_token, db):
    inspector_id = _decode_sub(provider_token)
    job_id, request_id = await _seed_inspector_job(db, inspector_id=inspector_id)
    await db.booking_timeline.insert_one({
        "id": uuid.uuid4().hex, "bookingId": request_id, "bookingScope": "car_request",
        "action": "cancel", "actorId": "admin-9001-secret-id", "actorRole": "admin",
        "fromStatus": "confirmed", "toStatus": "cancelled",
        "meta": {"reason": "platform_action",
                 "internalNotes": "linked to chargeback case 47",
                 "trustScore": 0.1},
        "timestamp": _ts(0),
    })
    r = await client.get(
        f"/api/inspector/jobs/{job_id}/timeline",
        headers=_hdr(provider_token),
    )
    e = r.json()["events"][0]
    assert e["label"] == "Отменено администрацией"
    assert e["tone"] == "attention"
    assert e["isSelfAction"] is False
    serialized = repr(e)
    assert "admin-9001" not in serialized
    assert "internalNotes" not in serialized
    assert "chargeback" not in serialized
    assert "trustScore" not in serialized
    assert e["meta"] == {"reason": "platform_action"}


# ══════════════════════════════════════════════════════════════════════
# 4. Dispute events surface — internals don't
# ══════════════════════════════════════════════════════════════════════


async def test_dispute_lifecycle_visible(client, provider_token, db):
    inspector_id = _decode_sub(provider_token)
    job_id, request_id = await _seed_inspector_job(db, inspector_id=inspector_id)
    await db.booking_timeline.insert_many([
        {"id": uuid.uuid4().hex, "bookingId": request_id, "bookingScope": "car_request",
         "action": "open_dispute", "actorId": "cust-abc", "actorRole": "customer",
         "fromStatus": "completed", "toStatus": "disputed",
         "meta": {"reason": "quality_issue", "internalNotes": "moderation review",
                  "disputeId": "dsp-1"},
         "timestamp": _ts(0)},
        {"id": uuid.uuid4().hex, "bookingId": request_id, "bookingScope": "car_request",
         "action": "resolve_dispute", "actorId": "admin-mod-3", "actorRole": "admin",
         "fromStatus": "disputed", "toStatus": "resolved",
         "meta": {"resolution": "partial_refund",
                  "payoutAmount": 100,     # provider's, NOT inspector's
                  "refundAmount": 50,
                  "adminNote": "internal ruling rationale"},
         "timestamp": _ts(1)},
    ])
    r = await client.get(
        f"/api/inspector/jobs/{job_id}/timeline",
        headers=_hdr(provider_token),
    )
    events = r.json()["events"]
    keys = [e["key"] for e in events]
    assert keys == ["dispute_opened", "dispute_resolved"]
    assert events[0]["tone"] == "attention"
    assert events[0]["label"] == "Открыт спор по осмотру"
    # disputeId is NOT on inspector's safe-meta whitelist
    # (cross-aggregate id). Reason IS.
    assert events[0]["meta"] == {"reason": "quality_issue"}

    assert events[1]["tone"] == "closed"
    # Provider's payoutAmount + refundAmount + adminNote + resolution
    # — NONE of these are on inspector's whitelist.
    assert events[1]["meta"] == {}
    serialized = repr(events)
    assert "admin-mod-3" not in serialized
    assert "internalNotes" not in serialized
    assert "adminNote" not in serialized
    assert "moderation" not in serialized
    assert "ruling" not in serialized
    assert "refundAmount" not in serialized
    # disputeId scrubbed too — it's a cross-aggregate id.
    assert "dsp-1" not in serialized


# ══════════════════════════════════════════════════════════════════════
# 5. Snapshot test — full rendered payload (the architectural invariant)
# ══════════════════════════════════════════════════════════════════════


async def test_full_payload_snapshot(client, provider_token, db):
    """Inline snapshot of the entire rendered timeline. Future meta
    fields landing on `booking_timeline` will break this assertion
    unless explicitly added to the inspector whitelist AND reflected
    here. Strongest possible architectural guard."""
    inspector_id = _decode_sub(provider_token)
    job_id, request_id = await _seed_inspector_job(db, inspector_id=inspector_id)
    await _seed_full_lifecycle(db, request_id, inspector_id=inspector_id)

    r = await client.get(
        f"/api/inspector/jobs/{job_id}/timeline",
        headers=_hdr(provider_token),
    )
    body = r.json()

    expected_events = [
        {
            "key": "assigned",
            "label": "Осмотр назначен",
            "description": "Подтвердите и выезжайте.",
            "tone": "ready",
            "at": _ts(0),
            "isSelfAction": False,
            "meta": {},
        },
        # mark_confirmed at _ts(1) is HIDDEN (provider event, not
        # inspector's). Chronology jumps to on_route.
        {
            "key": "on_route",
            "label": "В пути на осмотр",
            "description": "Двигайтесь к объекту.",
            "tone": "travel",
            "at": _ts(2),
            "isSelfAction": True,
            "meta": {"eta": 15},
        },
        # mark_on_route:rejected at _ts(3) — HIDDEN.
        {
            "key": "arrived",
            "label": "На месте",
            "description": "Готовьтесь к осмотру.",
            "tone": "on_site",
            "at": _ts(4),
            "isSelfAction": True,
            "meta": {"note": "Buzzer answered"},
        },
        {
            "key": "inspecting",
            "label": "Осмотр начат",
            "description": "Проходите чек-лист.",
            "tone": "documenting",
            "at": _ts(5),
            "isSelfAction": False,  # admin-driven row in seed
            "meta": {"reason": "manual recovery"},
        },
        {
            "key": "completed",
            "label": "Отчёт отправлен",
            "description": "Осмотр завершён.",
            "tone": "submitted",
            "at": _ts(6),
            "isSelfAction": True,
            "meta": {"reportId": "rep_xyz", "inspectorPayoutAmount": 45},
        },
        # mark_in_progress:rejected at _ts(7) — HIDDEN.
    ]

    assert body == {
        "jobId": job_id,
        "events": expected_events,
        "count": 5,
    }


# ══════════════════════════════════════════════════════════════════════
# 6. Chronological order is ascending
# ══════════════════════════════════════════════════════════════════════


async def test_events_returned_chronologically(client, provider_token, db):
    inspector_id = _decode_sub(provider_token)
    job_id, request_id = await _seed_inspector_job(db, inspector_id=inspector_id)
    await _seed_full_lifecycle(db, request_id, inspector_id=inspector_id)

    r = await client.get(
        f"/api/inspector/jobs/{job_id}/timeline",
        headers=_hdr(provider_token),
    )
    timestamps = [e["at"] for e in r.json()["events"]]
    assert timestamps == sorted(timestamps)


# ══════════════════════════════════════════════════════════════════════
# 7. Ownership via accountId variant
# ══════════════════════════════════════════════════════════════════════


async def test_ownership_matches_via_account_id(client, provider_token, db):
    """Caller's accountId can match the job's inspectorAccountId."""
    account_id = _decode_account(provider_token)
    if not account_id:
        pytest.skip("provider_token has no accountId claim")
    job_id = f"job_{uuid.uuid4().hex[:12]}"
    request_id = f"car_{uuid.uuid4().hex[:12]}"
    await db.inspection_jobs.insert_one({
        "_id": job_id,
        "inspectorAccountId": account_id,
        "requestId": request_id,
        "status": "claimed",
        "createdAt": datetime.now(timezone.utc),
    })
    await db.car_requests.insert_one({
        "_id": request_id,
        "status": "in_progress",
        "createdAt": datetime.now(timezone.utc),
    })
    r = await client.get(
        f"/api/inspector/jobs/{job_id}/timeline",
        headers=_hdr(provider_token),
    )
    assert r.status_code == 200
