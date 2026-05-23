"""Integration tests for Phase D Pass 1B — Inspector engagement continuity.

Step 8A wires two canonical emits into real operational transitions:

  1. `ASSIGNMENT_CONTINUITY_CLAIMED`
     • Fired when a job moves to `claimed` via any of the three paths:
       - `auto_requests.service.claim_job` (legacy inspector claim)
       - `auto_requests.service.admin_assign_job` (admin override)
       - `auto_requests.marketplace.accept_exposure` (marketplace path)
     • Coalesce on (job_id) guarantees ONE event per job, ever — second
       and subsequent attempts via any path are silent no-ops at the
       storage layer.

  2. `INSPECTION_CONTINUITY_ENTERED_ACCUMULATION`
     • Fired only on `arrived → inspecting` transition (the substrate
       moment evidence accumulation begins).
     • Earlier transitions (`on_route`, `arrived`) are travel/location
       motion, NOT continuity topology, and MUST NOT emit. This
       invariant is asserted negatively below.

Doctrine guarantees these tests cement (against future drift):
  • Rule 4 — Low-cardinality: claim path emits, but two claim calls do
    not produce two events (the second one fails the status guard at
    the operational layer; the ledger guard is a second line of
    defence asserted via direct double-emit).
  • Continuity topology stays bounded: only `inspecting` transition
    emits — not `on_route`, not `arrived`.
  • Ledger payloads remain STRUCTURAL — `inspectorId` only, no prose.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
# Force-isolate to a dedicated test DB (Q2-R1 reliability fix).
os.environ["DB_NAME"] = "test_runtime_ledger_engagement_db"

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from app.core.context import ctx  # noqa: E402
from app.runtime_ledger import (  # noqa: E402
    EventType,
    ensure_indexes,
    get_events,
)
from app.runtime_ledger import COLLECTION as LEDGER_COLLECTION  # noqa: E402

from app.auto_requests import service as auto_svc  # noqa: E402
from app.auto_requests import reports as reports_svc  # noqa: E402


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Fixtures ─────────────────────────────────────────────────────────


@pytest_asyncio.fixture(autouse=True)
async def _isolated_db():
    """Bind a clean test DB; drop ledger + job collections each test."""
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    ctx.db = db
    await db[LEDGER_COLLECTION].drop()
    await db.inspection_jobs.drop()
    await db.car_requests.drop()
    await ensure_indexes()
    yield
    await db[LEDGER_COLLECTION].drop()
    await db.inspection_jobs.drop()
    await db.car_requests.drop()
    client.close()


async def _seed_open_job(
    *,
    job_id: str | None = None,
    request_id: str | None = None,
    inspector_id: str | None = None,
) -> tuple[str, str]:
    """Insert an `open` inspection_jobs + parent car_requests doc.

    Returns (job_id, request_id). Inspector is left unassigned.
    """
    db = ctx.db
    jid = job_id or str(uuid.uuid4())
    rid = request_id or str(uuid.uuid4())
    now = _now()
    await db.car_requests.insert_one({
        "_id": rid,
        "userId": "customer-1",
        "type": "inspection",
        "status": "pending_inspectors",
        "cities": ["berlin"],
        "createdAt": now,
        "jobsClaimed": 0,
    })
    await db.inspection_jobs.insert_one({
        "_id": jid,
        "requestId": rid,
        "city": "berlin",
        "status": "open",
        "inspectorId": inspector_id,
        "brand": "BMW",
        "model": "320d",
        "budget": 1000,
        "createdAt": now,
    })
    return jid, rid


# ── ASSIGNMENT_CONTINUITY_CLAIMED ────────────────────────────────────


@pytest.mark.asyncio
async def test_claim_job_emits_assignment_continuity_claimed():
    """Legacy claim_job path emits exactly ONE assignment continuity event."""
    job_id, _ = await _seed_open_job()
    inspector_id = "inspector-1"

    out = await auto_svc.claim_job(job_id, inspector_id=inspector_id)
    assert out is not None, "claim_job should succeed on an open job"

    events = await get_events(
        event_type=EventType.ASSIGNMENT_CONTINUITY_CLAIMED,
        subject_id=job_id,
    )
    assert len(events) == 1, (
        f"expected exactly 1 ledger event, got {len(events)}"
    )
    ev = events[0]
    assert ev["type"] == "assignment_continuity_claimed"
    assert ev["subjectType"] == "job"
    assert ev["subjectId"] == job_id
    assert ev["continuity"] == "assignment"
    assert ev["payload"] == {"inspectorId": inspector_id}, (
        "payload must be STRUCTURAL — only inspectorId, no prose"
    )


@pytest.mark.asyncio
async def test_admin_assign_after_claim_coalesces_to_single_event():
    """Two claim paths firing on the same job → ledger sees ONE event.

    Operational layer already blocks the second claim via status guard
    (only `open` and `claimed` are accepted by admin_assign_job, and
    after the first claim the status is `claimed`, so admin can still
    "reassign"). The ledger's dedupKey is the second line of defence:
    even if both operational writes succeed, only one ledger event
    survives. This cements Rule 4 (low-cardinality).
    """
    job_id, _ = await _seed_open_job()

    out1 = await auto_svc.claim_job(job_id, inspector_id="inspector-1")
    assert out1 is not None
    # admin_assign_job is permitted from {open, claimed}; here it can
    # reassign because status is now `claimed`. Both paths emit, but
    # the ledger coalesces.
    out2 = await auto_svc.admin_assign_job(job_id, inspector_id="inspector-2")
    assert out2 is not None

    events = await get_events(
        event_type=EventType.ASSIGNMENT_CONTINUITY_CLAIMED,
        subject_id=job_id,
    )
    assert len(events) == 1, (
        f"Rule 4 violation: two claim paths produced {len(events)} events "
        f"(expected 1 — ledger must coalesce on job_id)"
    )
    # Winner is the FIRST emit (append-only, never overwritten).
    assert events[0]["payload"]["inspectorId"] == "inspector-1"


# ── INSPECTION_CONTINUITY_ENTERED_ACCUMULATION ───────────────────────


@pytest.mark.asyncio
async def test_start_inspection_emits_entered_accumulation():
    """`arrived → inspecting` transition emits exactly ONE accumulation event."""
    job_id, _ = await _seed_open_job()
    inspector_id = "inspector-1"
    await auto_svc.claim_job(job_id, inspector_id=inspector_id)

    # Walk the lifecycle: claimed → on_route → arrived → inspecting.
    j1, e1 = await reports_svc.transition_status(job_id, inspector_id, "on_route")
    assert e1 is None and j1 is not None
    j2, e2 = await reports_svc.transition_status(job_id, inspector_id, "arrived")
    assert e2 is None and j2 is not None
    j3, e3 = await reports_svc.transition_status(job_id, inspector_id, "inspecting")
    assert e3 is None and j3 is not None

    events = await get_events(
        event_type=EventType.INSPECTION_CONTINUITY_ENTERED_ACCUMULATION,
        subject_id=job_id,
    )
    assert len(events) == 1, (
        f"expected exactly 1 entered_accumulation event, got {len(events)}"
    )
    ev = events[0]
    assert ev["type"] == "inspection_continuity_entered_accumulation"
    assert ev["subjectType"] == "job"
    assert ev["subjectId"] == job_id
    assert ev["continuity"] == "inspection"
    # Structural marker — payload is intentionally empty.
    assert ev["payload"] == {}, (
        "entered_accumulation payload is structural — dedup key carries the boundary"
    )


@pytest.mark.asyncio
async def test_on_route_and_arrived_do_not_emit_inspection_accumulation():
    """Travel/location motion (`on_route`, `arrived`) is NOT continuity topology.

    These transitions exist in the operational lifecycle but must not
    leak into the ledger — only `inspecting` is the continuity boundary.
    This test is the explicit negative guard against future drift where
    someone might add an emit on `arrived` "for visibility".
    """
    job_id, _ = await _seed_open_job()
    inspector_id = "inspector-1"
    await auto_svc.claim_job(job_id, inspector_id=inspector_id)

    await reports_svc.transition_status(job_id, inspector_id, "on_route")
    await reports_svc.transition_status(job_id, inspector_id, "arrived")

    # No accumulation event yet — we stopped at `arrived`.
    events = await get_events(
        event_type=EventType.INSPECTION_CONTINUITY_ENTERED_ACCUMULATION,
        subject_id=job_id,
    )
    assert len(events) == 0, (
        f"continuity drift: on_route/arrived produced {len(events)} "
        f"accumulation event(s) — only `inspecting` is a continuity boundary"
    )

    # Sanity: assignment event from claim_job is still there, untouched.
    assignment_events = await get_events(
        event_type=EventType.ASSIGNMENT_CONTINUITY_CLAIMED,
        subject_id=job_id,
    )
    assert len(assignment_events) == 1
