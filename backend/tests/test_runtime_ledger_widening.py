"""Integration tests for Phase D Pass 1C — Evidence widening + Inspection established.

Step 8B wires two canonical emits and tightens substrate semantics:

  1. `EVIDENCE_CONTINUITY_WIDENED`
     • Fired from `job_media._persist_and_emit` when the upload's
       operational `category` maps to a canonical `EvidenceSegment`
       value (exterior / cabin / mechanical / roadtest / documentation).
     • Categories outside the map (damage, odometer, vin, other, None)
       are NOT continuity boundaries and produce no ledger event.
     • Coalesce on (job_id, segment): ONE event per canonical segment,
       ever. 14 photos in `exterior` → 1 event. Delete + re-upload →
       still 1 event (the boundary was already crossed).

  2. `INSPECTION_CONTINUITY_ESTABLISHED`
     • Fired from `reports.submit_report` on `inspecting → done`.
     • Topology-order invariant enforced at the ledger boundary: emit()
       rejects this event unless a prior `entered_accumulation` event
       exists for the same subject. This blocks bypass paths that
       would flip a job to `done` without going through `inspecting`.

Doctrine guarantees these tests cement:
  • Rule 4 — Low-cardinality: 14 uploads in same segment → 1 event.
  • Closed-enum boundary: arbitrary uploader labels rejected at emit().
  • Topology-order: completion-emit requires predecessor in storage.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
# Force-isolate to a dedicated test DB (Q2-R1 reliability fix).
os.environ["DB_NAME"] = "test_runtime_ledger_widening_db"

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from app.core.context import ctx  # noqa: E402
from app.runtime_ledger import (  # noqa: E402
    EventType,
    EvidenceSegment,
    emit,
    ensure_indexes,
    get_events,
)
from app.runtime_ledger import COLLECTION as LEDGER_COLLECTION  # noqa: E402

from app.auto_requests import job_media  # noqa: E402


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Fixtures ─────────────────────────────────────────────────────────


@pytest_asyncio.fixture(autouse=True)
async def _isolated_db():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    ctx.db = db
    await db[LEDGER_COLLECTION].drop()
    await ensure_indexes()
    yield
    await db[LEDGER_COLLECTION].drop()
    client.close()


# ── EVIDENCE_CONTINUITY_WIDENED — duplicate uploads collapse ────────


@pytest.mark.asyncio
async def test_duplicate_uploads_in_same_segment_collapse_to_one_event():
    """14 emits with the same (job, segment) → exactly 1 stored event.

    Mirrors the real upload flow at the EMIT layer: each photo upload
    in `_persist_and_emit` fires emit(EVIDENCE_CONTINUITY_WIDENED,
    segment="exterior"). The ledger MUST coalesce all of them.
    """
    job_id = str(uuid.uuid4())
    first_eid, created_first = await emit(
        EventType.EVIDENCE_CONTINUITY_WIDENED,
        subject_id=job_id,
        segment=EvidenceSegment.EXTERIOR.value,
        payload={},
    )
    assert created_first is True

    for _ in range(13):
        eid, created = await emit(
            EventType.EVIDENCE_CONTINUITY_WIDENED,
            subject_id=job_id,
            segment=EvidenceSegment.EXTERIOR.value,
            payload={},
        )
        assert created is False, "Rule 4: subsequent emits must coalesce"
        assert eid == first_eid, "coalesced emit must return the existing event id"

    events = await get_events(
        event_type=EventType.EVIDENCE_CONTINUITY_WIDENED, subject_id=job_id
    )
    assert len(events) == 1, (
        f"14 uploads in same segment → expected 1 event, got {len(events)}"
    )
    assert events[0]["segment"] == EvidenceSegment.EXTERIOR.value
    assert events[0]["payload"] == {}, "payload must be empty (no upload counting)"


# ── EVIDENCE_CONTINUITY_WIDENED — cross-segment widening allowed ────


@pytest.mark.asyncio
async def test_cross_segment_widening_produces_distinct_events():
    """exterior then cabin → 2 events. Each canonical segment is its
    own continuity boundary; crossing into a new segment widens the
    inspection's continuity topology."""
    job_id = str(uuid.uuid4())

    _, c1 = await emit(
        EventType.EVIDENCE_CONTINUITY_WIDENED,
        subject_id=job_id,
        segment=EvidenceSegment.EXTERIOR.value,
        payload={},
    )
    _, c2 = await emit(
        EventType.EVIDENCE_CONTINUITY_WIDENED,
        subject_id=job_id,
        segment=EvidenceSegment.CABIN.value,
        payload={},
    )
    assert c1 is True and c2 is True

    events = await get_events(
        event_type=EventType.EVIDENCE_CONTINUITY_WIDENED, subject_id=job_id
    )
    assert len(events) == 2
    segments = {e["segment"] for e in events}
    assert segments == {"exterior", "cabin"}


# ── EVIDENCE_CONTINUITY_WIDENED — re-upload does not widen ──────────


@pytest.mark.asyncio
async def test_reupload_in_same_segment_does_not_widen():
    """Delete + re-upload in the same segment → still 1 event.

    The continuity boundary was already crossed when the first photo
    in `exterior` was uploaded. Operational churn (the inspector
    deleted a blurry photo and re-uploaded a sharper one) is not a
    new continuity transition. The ledger MUST NOT re-fire.
    """
    job_id = str(uuid.uuid4())

    # First upload widens the boundary.
    _, c1 = await emit(
        EventType.EVIDENCE_CONTINUITY_WIDENED,
        subject_id=job_id,
        segment=EvidenceSegment.MECHANICAL.value,
        payload={},
    )
    assert c1 is True

    # Simulate delete-then-reupload: the operational layer deleted the
    # media row, but the ledger event remains (append-only). A fresh
    # upload in the same segment must coalesce, NOT widen.
    _, c2 = await emit(
        EventType.EVIDENCE_CONTINUITY_WIDENED,
        subject_id=job_id,
        segment=EvidenceSegment.MECHANICAL.value,
        payload={},
    )
    assert c2 is False, "re-upload in same segment must NOT create a new event"

    events = await get_events(
        event_type=EventType.EVIDENCE_CONTINUITY_WIDENED, subject_id=job_id
    )
    assert len(events) == 1, (
        f"delete-then-reupload in same segment → expected 1 event (the "
        f"boundary was already crossed), got {len(events)}"
    )


# ── EVIDENCE_CONTINUITY_WIDENED — arbitrary labels rejected ─────────


@pytest.mark.asyncio
async def test_non_canonical_segment_is_rejected_at_emit():
    """Arbitrary uploader labels are NOT continuity-segment values.

    Doctrine guarantee: the ledger never knows about labels like
    "damage" / "odometer" / "session-A" / "blurry-retry-3". emit()
    refuses them at the storage boundary.
    """
    job_id = str(uuid.uuid4())
    for bad_segment in ("damage", "odometer", "session-A", "engine"):
        # `engine` is an OPERATIONAL category; the canonical continuity
        # name is `mechanical`. The mapping happens at the wiring
        # point in `job_media._persist_and_emit`, NOT inside the ledger.
        with pytest.raises(ValueError, match="closed enum"):
            await emit(
                EventType.EVIDENCE_CONTINUITY_WIDENED,
                subject_id=job_id,
                segment=bad_segment,
                payload={},
            )

    # No bad emits made it through.
    events = await get_events(
        event_type=EventType.EVIDENCE_CONTINUITY_WIDENED, subject_id=job_id
    )
    assert len(events) == 0


@pytest.mark.asyncio
async def test_evidence_widened_requires_segment_argument():
    """Calling emit() for EVIDENCE_CONTINUITY_WIDENED without a
    `segment=` argument must be rejected at the storage boundary —
    the continuity boundary cannot be inferred from operational state."""
    job_id = str(uuid.uuid4())
    with pytest.raises(ValueError, match="requires `segment="):
        await emit(
            EventType.EVIDENCE_CONTINUITY_WIDENED,
            subject_id=job_id,
            payload={},
        )


# ── EVIDENCE_CONTINUITY_WIDENED — category mapping is closed ────────


@pytest.mark.asyncio
async def test_category_to_segment_map_is_closed_and_correct():
    """The wiring-layer map from operational `category` to canonical
    `EvidenceSegment` is the ONLY place operational labels become
    ledger segments. Non-mapped categories produce no event.

    This is a unit test on the static map — no async emit needed.
    """
    canonical = {e.value for e in EvidenceSegment}
    # All values in the map must be canonical EvidenceSegment values.
    for cat, seg in job_media._CATEGORY_TO_CONTINUITY_SEGMENT.items():
        assert seg in canonical, (
            f"category {cat!r} mapped to {seg!r} which is NOT a canonical "
            f"EvidenceSegment value (closed enum: {sorted(canonical)})"
        )
    # Operational categories that are explicitly NOT continuity
    # boundaries must NOT be in the map.
    for non_boundary in ("damage", "odometer", "vin", "other"):
        assert non_boundary not in job_media._CATEGORY_TO_CONTINUITY_SEGMENT, (
            f"{non_boundary!r} is operational, not a continuity boundary — "
            f"must NOT appear in the segment map"
        )


# ── INSPECTION_CONTINUITY_ESTABLISHED — topology-order guard ────────


@pytest.mark.asyncio
async def test_inspection_established_without_accumulation_is_rejected():
    """A completion-event cannot exist without its predecessor.

    Topology order is a doctrine invariant enforced at the storage
    boundary in `service.emit()`. Even if a future bug wired
    INSPECTION_CONTINUITY_ESTABLISHED into an operational path that
    bypassed `inspecting`, the ledger would refuse the write.
    """
    job_id = str(uuid.uuid4())
    with pytest.raises(ValueError, match="topology order violated"):
        await emit(
            EventType.INSPECTION_CONTINUITY_ESTABLISHED,
            subject_id=job_id,
            payload={},
        )

    # Nothing got written.
    events = await get_events(
        event_type=EventType.INSPECTION_CONTINUITY_ESTABLISHED, subject_id=job_id
    )
    assert len(events) == 0


@pytest.mark.asyncio
async def test_inspection_established_succeeds_after_accumulation():
    """Once the predecessor exists, the completion event is accepted
    and is itself coalescing (one per job, ever)."""
    job_id = str(uuid.uuid4())

    # Predecessor first.
    await emit(
        EventType.INSPECTION_CONTINUITY_ENTERED_ACCUMULATION,
        subject_id=job_id,
        payload={},
    )

    # Completion now permitted.
    eid_a, created_a = await emit(
        EventType.INSPECTION_CONTINUITY_ESTABLISHED,
        subject_id=job_id,
        payload={},
    )
    assert created_a is True

    # Second emit (e.g. duplicate submit_report race) coalesces.
    eid_b, created_b = await emit(
        EventType.INSPECTION_CONTINUITY_ESTABLISHED,
        subject_id=job_id,
        payload={},
    )
    assert created_b is False and eid_b == eid_a

    events = await get_events(
        event_type=EventType.INSPECTION_CONTINUITY_ESTABLISHED, subject_id=job_id
    )
    assert len(events) == 1


# ── Payload firewall — counts forbidden ─────────────────────────────


@pytest.mark.asyncio
async def test_evidence_widened_rejects_evidence_count_payload():
    """Pass 1C tightening: the ledger does NOT count uploads. Passing
    `evidenceCount` (a Pass 1 placeholder) is now explicitly forbidden
    to prevent drift into media telemetry."""
    job_id = str(uuid.uuid4())
    with pytest.raises(ValueError, match="dedup key"):
        await emit(
            EventType.EVIDENCE_CONTINUITY_WIDENED,
            subject_id=job_id,
            segment=EvidenceSegment.DOCUMENTATION.value,
            payload={"evidenceCount": 7},
        )
