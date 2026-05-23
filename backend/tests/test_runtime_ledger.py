"""Tests for Phase D Pass 1 — Runtime Continuity Ledger.

These tests cement the doctrine:
  1. Bounded canonical event types (Rule 2)
  2. Payload wording firewall (Rule 5)
  3. Append-only — duplicate dedupKey is silently coalesced, no
     document mutation (Rules 3 + 4)
  4. Low-cardinality coalescing on repeated emits (Rule 4)
  5. emit() never accepts an unknown event type
"""
from __future__ import annotations

import asyncio
import os
import uuid

import pytest
import pytest_asyncio

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
# Force-isolate to a dedicated test DB (Q2-R1 reliability fix).
os.environ["DB_NAME"] = "test_runtime_ledger_db"

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from app.core.context import ctx  # noqa: E402
from app.core import db as core_db  # noqa: E402
from app.runtime_ledger import (  # noqa: E402
    EventType,
    canonical_types,
    emit,
    ensure_indexes,
    get_events,
)
from app.runtime_ledger import COLLECTION  # noqa: E402


# ── Fixtures ─────────────────────────────────────────────────────────


@pytest_asyncio.fixture(autouse=True)
async def _isolated_db():
    """Bind a clean test DB and drop the ledger collection before and after.

    Function-scoped — pytest-asyncio creates a fresh event loop per test
    by default, so motor clients must be created within the same loop.
    """
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    ctx.db = db
    await db[COLLECTION].drop()
    await ensure_indexes()
    yield
    await db[COLLECTION].drop()
    client.close()


# ── Rule 2 — Bounded canonical event types ─────────────────────────


@pytest.mark.asyncio
async def test_canonical_types_are_bounded():
    types = canonical_types()
    assert 6 <= len(types) <= 10, (
        f"Pass 1 scope: 6–10 canonical types, got {len(types)}: {types}"
    )
    assert len(set(types)) == len(types), "duplicate canonical types"


@pytest.mark.asyncio
async def test_canonical_types_describe_continuity():
    """Names must describe topology transitions, not operational motion.

    Word-boundary check, not substring — `verification_review_entered`
    legitimately contains `view` as a substring of `review`, which is a
    structural noun (a review surface), not an operational motion.
    """
    import re
    forbidden_words = {
        "click", "button", "view", "screen", "tab", "page",
        "api", "uploaded", "downloaded", "opened", "pressed",
    }
    for t in canonical_types():
        tokens = set(re.split(r"[^a-z]+", t.lower()))
        leaked = tokens & forbidden_words
        assert not leaked, (
            f"event name {t!r} contains operational-motion token(s) {leaked}"
        )


@pytest.mark.asyncio
async def test_emit_rejects_unknown_event_type():
    with pytest.raises(ValueError):
        await emit("totally_made_up_event", subject_id="x", payload={})  # type: ignore[arg-type]


# ── Rule 5 — Payload wording firewall ──────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad_key",
    ["message", "summary", "text", "description", "interpretation",
     "recommendation", "userMessage", "body", "html", "prose",
     "title", "subtitle", "label"],
)
async def test_payload_rejects_forbidden_wording_keys(bad_key):
    with pytest.raises(ValueError, match="forbidden wording key"):
        await emit(
            EventType.INSPECTION_CONTEXT_ESTABLISHED,
            subject_id=str(uuid.uuid4()),
            payload={"requestType": "inspection", bad_key: "anything"},
        )


@pytest.mark.asyncio
async def test_payload_rejects_long_strings():
    long_value = "x" * 250
    with pytest.raises(ValueError, match="does not store prose"):
        await emit(
            EventType.INSPECTION_CONTEXT_ESTABLISHED,
            subject_id=str(uuid.uuid4()),
            payload={"requestType": "inspection", "extra": long_value},
        )


@pytest.mark.asyncio
async def test_payload_rejects_forbidden_keys_in_nested_dicts():
    with pytest.raises(ValueError, match="forbidden wording key"):
        await emit(
            EventType.INSPECTION_CONTEXT_ESTABLISHED,
            subject_id=str(uuid.uuid4()),
            payload={"requestType": "inspection", "meta": {"summary": "x"}},
        )


# ── Rules 3 + 4 — Append-only + Low-cardinality ────────────────────


@pytest.mark.asyncio
async def test_emit_creates_event():
    sid = str(uuid.uuid4())
    eid, created = await emit(
        EventType.INSPECTION_CONTEXT_ESTABLISHED,
        subject_id=sid,
        payload={"requestType": "inspection"},
    )
    assert created is True
    assert isinstance(eid, str) and len(eid) > 0


@pytest.mark.asyncio
async def test_dedup_key_coalesces_repeated_emits():
    """14 evidence emits in the same segment → ONE event (Rule 4).

    Pass 1C: segment MUST be one of the closed `EvidenceSegment` enum
    values. Arbitrary session labels (e.g. "session-A") are rejected
    at the storage boundary.
    """
    sid = str(uuid.uuid4())
    segment = "exterior"  # canonical EvidenceSegment value
    first, created_first = await emit(
        EventType.EVIDENCE_CONTINUITY_WIDENED,
        subject_id=sid,
        segment=segment,
        payload={},
    )
    assert created_first is True

    coalesced_ids = set()
    for _ in range(2, 15):
        eid, created = await emit(
            EventType.EVIDENCE_CONTINUITY_WIDENED,
            subject_id=sid,
            segment=segment,
            payload={},
        )
        assert created is False, (
            f"Rule 4 violation: emit created a new event instead of coalescing"
        )
        coalesced_ids.add(eid)

    assert coalesced_ids == {first}, "coalesced emits must return the existing event id"

    events = await get_events(
        event_type=EventType.EVIDENCE_CONTINUITY_WIDENED, subject_id=sid
    )
    assert len(events) == 1, (
        f"Rule 4 violation: 14 emits produced {len(events)} stored events (expected 1)"
    )


@pytest.mark.asyncio
async def test_different_segments_do_not_coalesce():
    sid = str(uuid.uuid4())
    _, c1 = await emit(
        EventType.EVIDENCE_CONTINUITY_WIDENED,
        subject_id=sid, segment="exterior",
        payload={},
    )
    _, c2 = await emit(
        EventType.EVIDENCE_CONTINUITY_WIDENED,
        subject_id=sid, segment="cabin",
        payload={},
    )
    assert c1 is True and c2 is True
    events = await get_events(
        event_type=EventType.EVIDENCE_CONTINUITY_WIDENED, subject_id=sid
    )
    assert len(events) == 2


@pytest.mark.asyncio
async def test_events_are_immutable_in_storage():
    """Rule 3: the stored document must not change after emit."""
    db = ctx.db
    sid = str(uuid.uuid4())
    eid, _ = await emit(
        EventType.INSPECTION_CONTEXT_ESTABLISHED,
        subject_id=sid,
        payload={"requestType": "inspection"},
    )
    before = await db[COLLECTION].find_one({"_id": eid}, {"_id": 0})
    assert before is not None
    payload_after_emit = before["payload"]
    payload_after_emit["requestType"] = "selection"
    after = await db[COLLECTION].find_one({"_id": eid}, {"_id": 0})
    assert after is not None
    assert after["payload"]["requestType"] == "inspection", (
        "Rule 3: mutation of caller's payload must not affect stored event"
    )


@pytest.mark.asyncio
async def test_get_events_returns_recent_first():
    sid = str(uuid.uuid4())
    await emit(
        EventType.INSPECTION_CONTEXT_ESTABLISHED, subject_id=sid,
        payload={"requestType": "inspection"},
    )
    await asyncio.sleep(0.01)
    await emit(
        EventType.EVIDENCE_CONTINUITY_WIDENED, subject_id=sid,
        segment="exterior", payload={},
    )
    events = await get_events(subject_id=sid)
    assert len(events) == 2
    assert events[0]["type"] == "evidence_continuity_widened"
    assert events[1]["type"] == "inspection_context_established"
