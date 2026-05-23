"""Integration tests for Phase D Pass 1D-A — Report interpretation delivered.

Step 8C-A wires one canonical emit and tightens substrate semantics:

  `REPORT_INTERPRETATION_DELIVERED`
    • Fired from `customer_continuity.router` when the customer-facing
      continuity endpoint first returns `ok: true` with a maturity
      that has crystallised past pre-interpretive phases.
    • Emit only when `maturity ∈ {established, delivered}` — i.e. a
      report has been submitted/approved (or final-delivered). The
      pre-interpretive maturities (`forming`, `accumulating`) and the
      absent `insufficient` case do NOT emit.
    • Subject is JOB (not REPORT). The customer-facing interpretation
      is per-job, not per internal report version.
    • Coalesce on `(job_id)` → one event per job, ever — every
      subsequent customer fetch silent no-ops at the storage layer.
    • Predecessor invariant: requires prior
      `INSPECTION_CONTINUITY_ESTABLISHED` for the same subject.
    • Payload MUST be empty — section count is frozen in the mapper
      and tested there, not in the ledger.

Pass 1D-A cements the boundary between operational substrate and
customer cognition substrate: the ledger marks the moment a restrained
interpretation crystallised, NOT the moment the customer viewed it.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
# Force-isolate to a dedicated test DB (Q2-R1 reliability fix).
os.environ["DB_NAME"] = "test_runtime_ledger_interpretation_db"

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from app.core.context import ctx  # noqa: E402
from app.runtime_ledger import (  # noqa: E402
    EventType,
    emit,
    ensure_indexes,
    get_events,
)
from app.runtime_ledger import COLLECTION as LEDGER_COLLECTION  # noqa: E402

from app.customer_continuity.router import get_inspection_continuity  # noqa: E402


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Fixtures ─────────────────────────────────────────────────────────


@pytest_asyncio.fixture(autouse=True)
async def _isolated_db():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    ctx.db = db
    await db[LEDGER_COLLECTION].drop()
    await db.inspection_jobs.drop()
    await db.timeline_events.drop()
    await db.users.drop()
    await ensure_indexes()
    yield
    await db[LEDGER_COLLECTION].drop()
    await db.inspection_jobs.drop()
    await db.timeline_events.drop()
    await db.users.drop()
    client.close()


async def _seed_job_with_timeline(
    *,
    customer_id: str,
    kinds: list[str],
    job_status: str = "done",
    job_id: str | None = None,
) -> str:
    """Seed an inspection job owned by `customer_id` with timeline events.

    Returns the job_id. `kinds` controls which timeline-event kinds are
    present, which is what drives `derive_maturity` in the mapper.
    """
    db = ctx.db
    jid = job_id or str(uuid.uuid4())
    now = _now()
    await db.inspection_jobs.insert_one({
        "_id": jid,
        "id": jid,
        "customerId": customer_id,
        "requestId": str(uuid.uuid4()),
        "city": "berlin",
        "status": job_status,
        "inspectorId": None,
        "brand": "BMW",
        "model": "320d",
        "createdAt": now,
    })
    for i, kind in enumerate(kinds):
        await db.timeline_events.insert_one({
            "_id": str(uuid.uuid4()),
            "jobId": jid,
            "kind": kind,
            "timestamp": now,
            "order": i,
        })
    return jid


class _StubCtx:
    """Minimal stand-in for `IdentityContext` — only `user_id` is read
    by the endpoint. We bypass the `require_account_kind` dependency by
    calling the endpoint function directly with this stub."""

    def __init__(self, user_id: str):
        self.user_id = user_id


async def _seed_predecessor(job_id: str) -> None:
    """Plant the INSPECTION_CONTINUITY_ESTABLISHED event the ledger
    requires before REPORT_INTERPRETATION_DELIVERED can land."""
    await emit(
        EventType.INSPECTION_CONTINUITY_ENTERED_ACCUMULATION,
        subject_id=job_id,
        payload={},
    )
    await emit(
        EventType.INSPECTION_CONTINUITY_ESTABLISHED,
        subject_id=job_id,
        payload={},
    )


# ── Positive path — established / delivered emit once ───────────────


@pytest.mark.asyncio
async def test_established_maturity_emits_interpretation_delivered():
    """Maturity `established` (kinds contain `report_submitted`) → emit fires once."""
    customer_id = "customer-1"
    job_id = await _seed_job_with_timeline(
        customer_id=customer_id,
        kinds=["assignment_claimed", "media_uploaded", "report_submitted"],
        job_status="report_ready",  # not yet in delivered set; established branch
    )
    await _seed_predecessor(job_id)

    resp = await get_inspection_continuity(
        job_id=job_id, ctx_=_StubCtx(customer_id),  # type: ignore[arg-type]
    )
    assert resp["ok"] is True
    assert resp["maturity"] == "established"

    events = await get_events(
        event_type=EventType.REPORT_INTERPRETATION_DELIVERED, subject_id=job_id
    )
    assert len(events) == 1
    ev = events[0]
    assert ev["subjectType"] == "job"  # Pass 1D-A: subject is JOB, not REPORT
    assert ev["subjectId"] == job_id
    assert ev["continuity"] == "interpretation"
    assert ev["payload"] == {}, "payload must be empty — section count frozen at mapper"


@pytest.mark.asyncio
async def test_delivered_maturity_emits_interpretation_delivered():
    """Maturity `delivered` (job.status=completed) → emit fires once."""
    customer_id = "customer-1"
    job_id = await _seed_job_with_timeline(
        customer_id=customer_id,
        kinds=["assignment_claimed", "media_uploaded", "report_submitted"],
        job_status="completed",  # → derive_maturity returns 'delivered'
    )
    await _seed_predecessor(job_id)

    resp = await get_inspection_continuity(
        job_id=job_id, ctx_=_StubCtx(customer_id),  # type: ignore[arg-type]
    )
    assert resp["maturity"] == "delivered"

    events = await get_events(
        event_type=EventType.REPORT_INTERPRETATION_DELIVERED, subject_id=job_id
    )
    assert len(events) == 1


@pytest.mark.asyncio
async def test_repeated_customer_fetch_coalesces_to_single_event():
    """10 consecutive customer reads → exactly 1 ledger event.

    The endpoint emits on every ok:true response; the ledger coalesces
    them. Customer "viewing" the interpretation does not multiply
    events — the boundary was crossed once.
    """
    customer_id = "customer-1"
    job_id = await _seed_job_with_timeline(
        customer_id=customer_id,
        kinds=["assignment_claimed", "media_uploaded", "report_submitted"],
        job_status="report_ready",
    )
    await _seed_predecessor(job_id)

    for _ in range(10):
        resp = await get_inspection_continuity(
            job_id=job_id, ctx_=_StubCtx(customer_id),  # type: ignore[arg-type]
        )
        assert resp["ok"] is True

    events = await get_events(
        event_type=EventType.REPORT_INTERPRETATION_DELIVERED, subject_id=job_id
    )
    assert len(events) == 1, (
        f"10 customer fetches must coalesce to 1 ledger event, got {len(events)}"
    )


# ── Negative invariants — pre-interpretive maturities ───────────────


@pytest.mark.asyncio
async def test_forming_maturity_does_not_emit():
    """Maturity `forming` (coordination only) is NOT interpretation delivered.

    The customer-facing endpoint may return ok:true with maturity=forming
    when the inspection has only just been coordinated. The ledger MUST
    NOT record this — interpretation has not yet become available.
    """
    customer_id = "customer-1"
    job_id = await _seed_job_with_timeline(
        customer_id=customer_id,
        kinds=["assignment_claimed"],  # only coordination → forming
        job_status="claimed",
    )
    # Predecessor IS seeded — to make the test focus on the maturity
    # gate, not on predecessor failure. The point: even with the
    # predecessor present, forming maturity must not emit.
    await _seed_predecessor(job_id)

    resp = await get_inspection_continuity(
        job_id=job_id, ctx_=_StubCtx(customer_id),  # type: ignore[arg-type]
    )
    assert resp["ok"] is True
    assert resp["maturity"] == "forming"

    events = await get_events(
        event_type=EventType.REPORT_INTERPRETATION_DELIVERED, subject_id=job_id
    )
    assert len(events) == 0, (
        "forming maturity must NOT emit — interpretation has not yet become available"
    )


@pytest.mark.asyncio
async def test_accumulating_maturity_does_not_emit():
    """Maturity `accumulating` = interpretation is FORMING, not delivered.

    The mapper-doctrine ladder has interpretation as `accumulating`
    while evidence is being recorded and draft is being generated.
    This is pre-delivery — the ledger does NOT emit.
    """
    customer_id = "customer-1"
    job_id = await _seed_job_with_timeline(
        customer_id=customer_id,
        kinds=["media_uploaded", "draft_generated"],  # → accumulating
        job_status="inspecting",
    )
    await _seed_predecessor(job_id)

    resp = await get_inspection_continuity(
        job_id=job_id, ctx_=_StubCtx(customer_id),  # type: ignore[arg-type]
    )
    assert resp["maturity"] == "accumulating"

    events = await get_events(
        event_type=EventType.REPORT_INTERPRETATION_DELIVERED, subject_id=job_id
    )
    assert len(events) == 0, (
        "accumulating maturity must NOT emit — interpretation is forming, "
        "not yet delivered"
    )


@pytest.mark.asyncio
async def test_insufficient_maturity_returns_ok_false_and_does_not_emit():
    """`ok:false` path: no allowlisted timeline events → no emit, no leak."""
    customer_id = "customer-1"
    job_id = await _seed_job_with_timeline(
        customer_id=customer_id,
        kinds=[],  # nothing allowlisted → insufficient → ok:false
        job_status="open",
    )
    await _seed_predecessor(job_id)  # predecessor present, still no emit

    resp = await get_inspection_continuity(
        job_id=job_id, ctx_=_StubCtx(customer_id),  # type: ignore[arg-type]
    )
    assert resp == {"ok": False, "reason": "insufficient_continuity"}

    events = await get_events(
        event_type=EventType.REPORT_INTERPRETATION_DELIVERED, subject_id=job_id
    )
    assert len(events) == 0


# ── Predecessor invariant — storage-layer guard ─────────────────────


@pytest.mark.asyncio
async def test_emit_without_predecessor_raises_at_storage_boundary():
    """REPORT_INTERPRETATION_DELIVERED requires a prior
    INSPECTION_CONTINUITY_ESTABLISHED for the same subject. emit()
    refuses the write directly — independent of any wiring path."""
    job_id = str(uuid.uuid4())
    with pytest.raises(ValueError, match="topology order violated"):
        await emit(
            EventType.REPORT_INTERPRETATION_DELIVERED,
            subject_id=job_id,
            payload={},
        )

    events = await get_events(
        event_type=EventType.REPORT_INTERPRETATION_DELIVERED, subject_id=job_id
    )
    assert len(events) == 0


# ── Payload firewall — section count forbidden ──────────────────────


@pytest.mark.asyncio
async def test_interpretation_payload_rejects_section_count():
    """Pass 1D-A tightening: section count is frozen at the mapper and
    tested there. The ledger MUST NOT carry it — passing sectionCount
    in payload is now explicitly forbidden to prevent drift into
    cognition-surface metrics."""
    job_id = str(uuid.uuid4())
    await _seed_predecessor(job_id)
    with pytest.raises(ValueError, match="sectionCount"):
        await emit(
            EventType.REPORT_INTERPRETATION_DELIVERED,
            subject_id=job_id,
            payload={"sectionCount": 4},
        )


@pytest.mark.asyncio
async def test_interpretation_payload_rejects_any_non_empty_payload():
    """Payload must be empty — the dedup key (job_id) IS the boundary."""
    job_id = str(uuid.uuid4())
    await _seed_predecessor(job_id)
    with pytest.raises(ValueError, match="must be empty"):
        await emit(
            EventType.REPORT_INTERPRETATION_DELIVERED,
            subject_id=job_id,
            payload={"customField": 1},
        )


# ── Doctrine boundary — cross-customer isolation ────────────────────


@pytest.mark.asyncio
async def test_cross_customer_endpoint_call_does_not_emit():
    """Customer A cannot trigger an interpretation event on customer B's job.

    The endpoint returns 404 for cross-customer reads (no info leak).
    The ledger MUST NOT see any emit attempt — the endpoint short-
    circuits before the emit block is reached.
    """
    from fastapi import HTTPException

    job_id = await _seed_job_with_timeline(
        customer_id="customer-A",
        kinds=["assignment_claimed", "media_uploaded", "report_submitted"],
        job_status="report_ready",
    )
    await _seed_predecessor(job_id)

    with pytest.raises(HTTPException) as ei:
        await get_inspection_continuity(
            job_id=job_id, ctx_=_StubCtx("customer-B"),  # type: ignore[arg-type]
        )
    assert ei.value.status_code == 404

    events = await get_events(
        event_type=EventType.REPORT_INTERPRETATION_DELIVERED, subject_id=job_id
    )
    assert len(events) == 0
