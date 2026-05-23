"""P0.b.B+ — Chronology coverage: attach disputes + reports.complete.

Three mutation sites are wired to `observe_transition()`:

  1. POST /api/disputes                  → `open_dispute` row
  2. POST /api/admin/disputes/{id}/resolve → `resolve_dispute` row
  3. inspection report submission        → `mark_completed` row

Discipline guard-rails (per sprint brief):
  * Attach must be **best-effort** — request flow continues even if Mongo
    write fails (proven via monkeypatch).
  * Attach must be **local + explicit** at each mutation site. No
    centralized registry, no `auto_observe()` decorator.
  * Recorded rows must contain ONLY the operationally-material meta
    keys; admin notes / moderation internals MUST NOT propagate.
  * Customer + provider projections surface the new rows with their
    own labels (existing C.a / C.b semantics — unchanged).

These tests assert at the `booking_timeline` collection level (the
source-of-truth), not at the projection endpoint level. Projection
behaviour is already covered by `test_p0bca_*` and `test_p0bcb_*`.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from typing import Optional

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


@pytest_asyncio.fixture
async def ctx_db_initialized():
    """Initialize `ctx.db` with a FRESH motor client for in-process
    service-level calls. Per-function fresh because motor binds the
    client to the current event loop; pytest-asyncio gives each test
    its own loop, and reusing a stale client triggers
    "Event loop is closed". The supervisor-run backend has its own
    independent ctx.
    """
    from app.core.context import ctx
    prev = ctx.db
    client = AsyncIOMotorClient(MONGO_URL)
    ctx.db = client[DB_NAME]
    try:
        yield ctx.db
    finally:
        # Restore previous (likely None in a clean test process) so
        # subsequent tests that DON'T request this fixture see the
        # original state.
        ctx.db = prev
        client.close()


def _hdr(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────


async def _find_timeline_row(
    db,
    *,
    booking_id: str,
    action: str,
    source: Optional[str] = None,
) -> Optional[dict]:
    q = {"bookingId": booking_id, "action": action}
    if source is not None:
        q["source"] = source
    return await db.booking_timeline.find_one(q, {"_id": 0})


async def _seed_disputable_request(
    db, *, customer_id: str, provider_id: str
) -> tuple[str, str]:
    """Create a service_request + service_payment ready to be disputed."""
    req_id = f"req_{uuid.uuid4().hex[:12]}"
    pay_id = f"pay_{uuid.uuid4().hex[:12]}"
    await db.service_requests.insert_one({
        "id": req_id,
        "customerId": customer_id,
        "providerId": provider_id,
        "status": "in_progress",
        "amount": 200.0,
        "currency": "EUR",
        "createdAt": _now_iso(),
    })
    await db.service_payments.insert_one({
        "id": pay_id,
        "requestId": req_id,
        "status": "paid",
        "amount": 200.0,
        "currency": "EUR",
        "createdAt": _now_iso(),
    })
    return req_id, pay_id


# ══════════════════════════════════════════════════════════════════════
# 1. open_dispute → booking_timeline.action == 'open_dispute'
# ══════════════════════════════════════════════════════════════════════


async def test_open_dispute_attaches_to_booking_timeline(
    client, customer_token, customer_user_id, provider_user_id, db
):
    req_id, _ = await _seed_disputable_request(
        db, customer_id=customer_user_id, provider_id=provider_user_id,
    )

    r = await client.post(
        "/api/disputes",
        json={"requestId": req_id, "reason": "quality_issue",
              "description": "Brake squeal returned 2 days after service."},
        headers=_hdr(customer_token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("alreadyOpen") is False
    dispute_id = body["dispute"]["id"]

    # Canonical lifecycle row recorded.
    row = await _find_timeline_row(
        db, booking_id=req_id, action="open_dispute",
        source="disputes.open",
    )
    assert row is not None, "booking_timeline row missing for open_dispute"
    assert row["actorRole"] == "customer"
    assert row["actorId"] == customer_user_id
    assert row["toStatus"] == "disputed"
    assert row["bookingScope"] == "service_request"
    # Meta must include disputeId + reason; nothing else operationally needed.
    assert row["meta"]["disputeId"] == dispute_id
    assert row["meta"]["reason"] == "quality_issue"
    # The customer-typed `description` MUST NOT leak into booking_timeline.
    # Description belongs in the dispute doc only (forensic surface).
    assert "description" not in row["meta"]
    assert "Brake squeal" not in repr(row["meta"])


async def test_open_dispute_idempotent_via_request_id(
    client, customer_token, customer_user_id, provider_user_id, db
):
    """Re-issuing the same open with the same X-Request-Id is a no-op
    on `booking_timeline` (single row, not two)."""
    req_id, _ = await _seed_disputable_request(
        db, customer_id=customer_user_id, provider_id=provider_user_id,
    )
    rid = f"rid_{uuid.uuid4().hex[:10]}"
    headers = {**_hdr(customer_token), "X-Request-Id": rid}

    r1 = await client.post(
        "/api/disputes",
        json={"requestId": req_id, "reason": "communication"},
        headers=headers,
    )
    assert r1.status_code == 200

    # Second post — the dispute endpoint short-circuits with alreadyOpen=True
    # before any new write. The first row stays singular.
    r2 = await client.post(
        "/api/disputes",
        json={"requestId": req_id, "reason": "communication"},
        headers=headers,
    )
    assert r2.status_code == 200
    assert r2.json().get("alreadyOpen") is True

    rows = await db.booking_timeline.find(
        {"bookingId": req_id, "action": "open_dispute"}, {"_id": 0},
    ).to_list(length=10)
    assert len(rows) == 1, f"expected 1 open_dispute row, got {len(rows)}"


# ══════════════════════════════════════════════════════════════════════
# 2. resolve_dispute → booking_timeline.action == 'resolve_dispute'
# ══════════════════════════════════════════════════════════════════════


async def test_admin_resolve_dispute_attaches_to_booking_timeline(
    client, customer_token, customer_user_id, provider_user_id, admin_token, db
):
    req_id, _ = await _seed_disputable_request(
        db, customer_id=customer_user_id, provider_id=provider_user_id,
    )
    # Open via the real endpoint so the open row exists too.
    r = await client.post(
        "/api/disputes",
        json={"requestId": req_id, "reason": "not_completed"},
        headers=_hdr(customer_token),
    )
    assert r.status_code == 200
    dispute_id = r.json()["dispute"]["id"]

    # Resolve via admin endpoint with partial refund.
    r2 = await client.post(
        f"/api/admin/disputes/{dispute_id}/resolve",
        json={"action": "partial_refund", "partialRefundPercent": 40,
              "adminNote": "ruling: shared fault, see internal case 88"},
        headers=_hdr(admin_token),
    )
    assert r2.status_code == 200, r2.text

    row = await _find_timeline_row(
        db, booking_id=req_id, action="resolve_dispute",
        source="disputes.resolve",
    )
    assert row is not None, "booking_timeline row missing for resolve_dispute"
    assert row["actorRole"] == "admin"
    assert row["fromStatus"] == "disputed"
    assert row["toStatus"] == "resolved"
    # Operational meta surfaces:
    assert row["meta"]["disputeId"] == dispute_id
    assert row["meta"]["resolution"] == "partial_refund"
    # payoutAmount + refundAmount are operational signals (provider whitelist
    # surfaces payoutAmount). Both must be numeric, not None.
    assert isinstance(row["meta"]["payoutAmount"], (int, float))
    assert isinstance(row["meta"]["refundAmount"], (int, float))
    # adminNote is a moderation internal — must NOT be on the row.
    assert "adminNote" not in row["meta"]
    assert "internal case 88" not in repr(row["meta"])


# ══════════════════════════════════════════════════════════════════════
# 3. submit_report → booking_timeline.action == 'mark_completed'
#    (only when car_request actually flips to `completed`)
# ══════════════════════════════════════════════════════════════════════


async def _seed_inspection_job(
    db, *, customer_id: str, inspector_id: str, jobs_total: int = 1,
) -> tuple[str, str]:
    """Create a car_request + an inspection_job in 'inspecting' state."""
    req_id = f"car_{uuid.uuid4().hex[:12]}"
    job_id = f"job_{uuid.uuid4().hex[:12]}"
    await db.car_requests.insert_one({
        "_id": req_id,
        "userId": customer_id,
        "city": "Berlin",
        "brand": "BMW",
        "model": "320d",
        "status": "in_progress",
        "jobsTotal": jobs_total,
        "jobsDone": 0,
        "jobsClaimed": 1,
        "createdAt": datetime.now(timezone.utc),
        "updatedAt": datetime.now(timezone.utc),
    })
    await db.inspection_jobs.insert_one({
        "_id": job_id,
        "requestId": req_id,
        "inspectorId": inspector_id,
        "status": "inspecting",
        "reportId": None,
        "city": "Berlin",
        "brand": "BMW",
        "model": "320d",
        "createdAt": datetime.now(timezone.utc),
    })
    return req_id, job_id


def _checklist_minimum() -> list[dict]:
    """Build a minimal checklist payload covering all 60 keys at status=ok."""
    from app.auto_requests.checklist import CHECKLIST
    return [{"key": item["key"], "status": "ok", "comment": None}
            for item in CHECKLIST]


async def test_submit_report_attaches_completion_when_request_completes(
    db, ctx_db_initialized, customer_user_id, provider_user_id,
):
    """Submitting a report on a 1-of-1 job flips car_request → completed
    and records a `mark_completed` row on `booking_timeline`."""
    # Inspector identity reuse: pytest session creates a provider; for the
    # inspector lane we just need ANY inspector id that owns the job.
    inspector_id = provider_user_id
    req_id, job_id = await _seed_inspection_job(
        db, customer_id=customer_user_id, inspector_id=inspector_id, jobs_total=1,
    )

    # Call the service directly — endpoint requires `inspect` capability
    # which the session provider doesn't have. The service-level call is
    # the canonical mutation site and is what the endpoint delegates to.
    from app.auto_requests.reports import submit_report
    from app.auto_requests.schemas import SubmitReportRequest

    payload = SubmitReportRequest(
        score=8.5,
        verdict="recommended",
        checklist=_checklist_minimum(),
        issues=[],
        summary="Vehicle inspected. No major issues found.",
        repairEstimateMin=0,
        repairEstimateMax=0,
    )
    report, err = await submit_report(job_id, inspector_id, payload)
    assert err is None, f"submit_report failed: {err}"
    assert report is not None

    # The car_request must now be in `completed` state.
    req_after = await db.car_requests.find_one({"_id": req_id})
    assert req_after["status"] == "completed"

    # booking_timeline must have the `mark_completed` row.
    row = await _find_timeline_row(
        db, booking_id=req_id, action="mark_completed",
        source="auto_requests.reports.submit",
    )
    assert row is not None, "booking_timeline row missing for completion"
    assert row["actorRole"] == "inspector"
    assert row["actorId"] == inspector_id
    assert row["toStatus"] == "completed"
    assert row["bookingScope"] == "car_request"
    assert row["meta"]["reportId"] == report["id"]
    # Defensive — none of the report's verdict / score / summary should
    # be smuggled into booking_timeline. That belongs in the inspection
    # report aggregate, not on the booking chronology.
    serialized = repr(row["meta"])
    assert "verdict" not in serialized
    assert "summary" not in serialized
    assert "score" not in serialized
    assert "Vehicle inspected" not in serialized


async def test_submit_report_does_not_attach_on_partial_progress(
    db, ctx_db_initialized, customer_user_id, provider_user_id,
):
    """When jobsTotal=2 and only 1 is submitted, car_request goes to
    `report_ready` (not `completed`). No `mark_completed` row should
    appear on the booking_timeline. Surfacing `report_ready` would
    require a deliberate projection decision (deferred)."""
    inspector_id = provider_user_id
    req_id, job_id = await _seed_inspection_job(
        db, customer_id=customer_user_id, inspector_id=inspector_id, jobs_total=2,
    )
    # Add a second pending job so jobsTotal=2, jobsClaimed=2
    await db.car_requests.update_one(
        {"_id": req_id}, {"$set": {"jobsClaimed": 2}},
    )
    await db.inspection_jobs.insert_one({
        "_id": f"job2_{uuid.uuid4().hex[:8]}",
        "requestId": req_id,
        "inspectorId": "some-other-inspector",
        "status": "claimed",
        "reportId": None,
        "city": "Berlin", "brand": "BMW", "model": "320d",
        "createdAt": datetime.now(timezone.utc),
    })

    from app.auto_requests.reports import submit_report
    from app.auto_requests.schemas import SubmitReportRequest

    payload = SubmitReportRequest(
        score=7.0, verdict="recommended",
        checklist=_checklist_minimum(),
        issues=[], summary="Partial inspection completed.",
        repairEstimateMin=0, repairEstimateMax=0,
    )
    report, err = await submit_report(job_id, inspector_id, payload)
    assert err is None, f"submit_report failed: {err}"

    req_after = await db.car_requests.find_one({"_id": req_id})
    assert req_after["status"] == "report_ready"

    row = await _find_timeline_row(
        db, booking_id=req_id, action="mark_completed",
        source="auto_requests.reports.submit",
    )
    assert row is None, "mark_completed must NOT fire on partial progress"


# ══════════════════════════════════════════════════════════════════════
# 4. Best-effort discipline — observability failure does not break flow
# ══════════════════════════════════════════════════════════════════════


async def test_open_dispute_succeeds_when_booking_timeline_write_fails(
    client, customer_token, customer_user_id, provider_user_id, db, monkeypatch
):
    """If `observe_transition` raises, the dispute flow must still
    complete and return 200. The whole point of attach.py's best-effort
    discipline is that observability is *secondary* to operational
    continuity."""
    req_id, _ = await _seed_disputable_request(
        db, customer_id=customer_user_id, provider_id=provider_user_id,
    )

    async def _exploding(*_a, **_kw):
        raise RuntimeError("simulated mongo outage on booking_timeline")

    # Patch the imported symbol on the disputes router module — the
    # router does `from app.booking.attach import observe_transition`
    # inside the try block at call time, so we monkey-patch the source.
    monkeypatch.setattr(
        "app.booking.attach.observe_transition",
        _exploding,
    )

    r = await client.post(
        "/api/disputes",
        json={"requestId": req_id, "reason": "communication"},
        headers=_hdr(customer_token),
    )
    assert r.status_code == 200, r.text
    # Dispute itself still created.
    d = await db.disputes.find_one({"requestId": req_id, "status": "open"}, {"_id": 0})
    assert d is not None
