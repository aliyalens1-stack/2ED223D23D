"""Integration tests for Phase D Pass 1D-B — Verification review entered.

Step 8C-B wires one canonical emit through an explicit governance
transition, NOT a read side-effect:

  `VERIFICATION_REVIEW_ENTERED`
    • Fired from `admin.verification_queue.enter_review` (the explicit
      `pending_review → under_review` transition).
    • NOT fired from `GET /api/admin/verification-queue/{id}` —
      opening a detail drawer is UI telemetry, not custody transition.
    • NOT fired from approve / reject. A document that goes directly
      from `pending_review → approved` did NOT cross the governance
      review boundary; the ledger must not lie about it.
    • Subject is VERIFICATION (the document under review).
    • Coalesce on `(doc_id)` → one event per document, ever.
    • Payload: `{"documentKind": <enum>}` — closed `DocumentKind`
      enum (passport / businessRegistration / insurance / taxId /
      toolsProof / tuvCertificate). Any extra keys forbidden.

Doctrine guarantees:
  • Governance topology, NOT analytics: payload has NO rejection
    reason, severity, admin note, trust score, or copy.
  • Storage-boundary closed enum: arbitrary kinds rejected at emit().
  • Explicit transition, NOT GET side effect.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
# Force-isolate to a dedicated test DB even when DB_NAME is already set by
# .env (Q2-R1 reliability fix — prevent `db.users.drop()` from wiping the
# production seed users in `test_database`).
os.environ["DB_NAME"] = "test_runtime_ledger_verification_db"

from fastapi import HTTPException  # noqa: E402
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from app.core.context import ctx  # noqa: E402
from app.runtime_ledger import (  # noqa: E402
    EventType,
    DocumentKind,
    emit,
    ensure_indexes,
    get_events,
)
from app.runtime_ledger import COLLECTION as LEDGER_COLLECTION  # noqa: E402

from app.admin import verification_queue as vq  # noqa: E402


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Fixtures ─────────────────────────────────────────────────────────


@pytest_asyncio.fixture(autouse=True)
async def _isolated_db():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    ctx.db = db
    await db[LEDGER_COLLECTION].drop()
    await db.inspector_verifications.drop()
    await db.users.drop()
    await ensure_indexes()
    yield
    await db[LEDGER_COLLECTION].drop()
    await db.inspector_verifications.drop()
    await db.users.drop()
    client.close()


async def _seed_doc(
    *,
    kind: str = "passport",
    status: str = vq.STATUS_PENDING,
    user_id: str = "inspector-1",
    doc_id: str | None = None,
) -> str:
    db = ctx.db
    did = doc_id or str(uuid.uuid4())
    await db.inspector_verifications.insert_one({
        "_id": did,
        "userId": user_id,
        "kind": kind,
        "status": status,
        "fileName": "doc.jpg",
        "mimeType": "image/jpeg",
        "uploadedAt": _now_iso(),
    })
    return did


# ── Positive — explicit transition emits once ───────────────────────


@pytest.mark.asyncio
async def test_enter_review_emits_verification_review_entered():
    """enter_review on a `pending_review` doc fires exactly one ledger event."""
    doc_id = await _seed_doc(kind="passport", status=vq.STATUS_PENDING)

    res = await vq.enter_review(doc_id, admin_id="admin-1", db=ctx.db)
    assert res["alreadyUnderReview"] is False
    assert res["document"]["status"] == vq.STATUS_UNDER_REVIEW

    # Persisted state.
    row = await ctx.db.inspector_verifications.find_one({"_id": doc_id})
    assert row["status"] == vq.STATUS_UNDER_REVIEW
    assert row["reviewerId"] == "admin-1"
    assert row.get("reviewStartedAt") is not None

    # Ledger event.
    events = await get_events(
        event_type=EventType.VERIFICATION_REVIEW_ENTERED, subject_id=doc_id
    )
    assert len(events) == 1
    ev = events[0]
    assert ev["subjectType"] == "verification"
    assert ev["subjectId"] == doc_id
    assert ev["continuity"] == "verification"
    assert ev["payload"] == {"documentKind": "passport"}
    assert ev["emittedBy"] == "admin-1"


@pytest.mark.asyncio
async def test_enter_review_works_from_uploaded_and_resubmission_too():
    """`uploaded` and `needs_resubmission` are also valid entry states."""
    for src in (vq.STATUS_UPLOADED, vq.STATUS_RESUBMISSION):
        doc_id = await _seed_doc(kind="insurance", status=src)
        res = await vq.enter_review(doc_id, admin_id="admin-1", db=ctx.db)
        assert res["alreadyUnderReview"] is False
        assert res["document"]["status"] == vq.STATUS_UNDER_REVIEW
        events = await get_events(
            event_type=EventType.VERIFICATION_REVIEW_ENTERED, subject_id=doc_id
        )
        assert len(events) == 1, f"src={src}: expected 1 emit, got {len(events)}"


# ── Idempotency — repeated enter_review coalesces ───────────────────


@pytest.mark.asyncio
async def test_repeated_enter_review_coalesces_to_single_event():
    """5 enter_review calls on the same doc → exactly 1 ledger event."""
    doc_id = await _seed_doc(kind="taxId", status=vq.STATUS_PENDING)

    first = await vq.enter_review(doc_id, admin_id="admin-1", db=ctx.db)
    assert first["alreadyUnderReview"] is False

    for _ in range(4):
        res = await vq.enter_review(doc_id, admin_id="admin-2", db=ctx.db)
        assert res["alreadyUnderReview"] is True, (
            "second enter_review must short-circuit operational layer"
        )

    events = await get_events(
        event_type=EventType.VERIFICATION_REVIEW_ENTERED, subject_id=doc_id
    )
    assert len(events) == 1, (
        f"5 enter_review calls → expected 1 event, got {len(events)}"
    )
    # First emit wins; admin-1 holds custody.
    assert events[0]["emittedBy"] == "admin-1"


# ── GET detail must NOT emit ────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_detail_does_not_emit_verification_review_entered():
    """Calling get_queue_item (the GET-detail handler) MUST NOT emit.

    Opening the admin drawer / refreshing / preloading detail is UI
    telemetry, NOT a governance transition. The ledger must stay
    invisible to read paths.
    """
    doc_id = await _seed_doc(kind="passport", status=vq.STATUS_PENDING)

    # Stand-in for verify_admin_token's return shape — the handler only
    # uses it for the rejection path.
    admin_ctx = {"sub": "admin-1", "email": "admin@autoservice.com"}

    # Call get_queue_item directly. We bypass the FastAPI dependency
    # injection of `verify_admin_token` by calling the underlying
    # function. Calls happen multiple times to model real admin
    # behaviour (refresh / re-open).
    for _ in range(3):
        result = await vq.get_queue_item(doc_id=doc_id, request=None, _=admin_ctx)  # type: ignore[arg-type]
        assert result["document"]["id"] == doc_id
        # Doc status MUST stay pending_review — GET has no side effect.
        assert result["document"]["status"] == vq.STATUS_PENDING

    events = await get_events(
        event_type=EventType.VERIFICATION_REVIEW_ENTERED, subject_id=doc_id
    )
    assert len(events) == 0, (
        f"GET detail produced {len(events)} ledger event(s) — read paths "
        f"MUST NOT emit. This is a doctrine breach."
    )


# ── Approve / reject without enter_review must NOT emit ─────────────


@pytest.mark.asyncio
async def test_approve_without_enter_review_does_not_emit_review_entered():
    """A doc that goes directly pending_review → approved did NOT cross
    the governance review boundary. The ledger MUST NOT lie about it."""
    doc_id = await _seed_doc(kind="passport", status=vq.STATUS_PENDING)

    admin_ctx = {"sub": "admin-1", "email": "admin@autoservice.com"}
    body = vq.ApproveBody(note=None)
    await vq.approve_document(
        doc_id=doc_id, body=body, request=None, admin_ctx=admin_ctx,  # type: ignore[arg-type]
    )

    events = await get_events(
        event_type=EventType.VERIFICATION_REVIEW_ENTERED, subject_id=doc_id
    )
    assert len(events) == 0, (
        "approve without enter_review fired VERIFICATION_REVIEW_ENTERED — "
        "this means the doctrine boundary leaked into approve_document"
    )


@pytest.mark.asyncio
async def test_reject_without_enter_review_does_not_emit_review_entered():
    """Symmetric to approve: fast-rejected docs do not emit review-entered."""
    doc_id = await _seed_doc(kind="insurance", status=vq.STATUS_PENDING)

    admin_ctx = {"sub": "admin-1", "email": "admin@autoservice.com"}
    body = vq.RejectBody(reason="document_blurry", note=None)
    await vq.reject_document(
        doc_id=doc_id, body=body, request=None, admin_ctx=admin_ctx,  # type: ignore[arg-type]
    )

    events = await get_events(
        event_type=EventType.VERIFICATION_REVIEW_ENTERED, subject_id=doc_id
    )
    assert len(events) == 0


# ── Terminal-state protection ───────────────────────────────────────


@pytest.mark.asyncio
async def test_enter_review_on_approved_doc_is_refused():
    """A doc in a terminal state cannot enter review. 409 conflict."""
    doc_id = await _seed_doc(kind="passport", status=vq.STATUS_APPROVED)
    with pytest.raises(HTTPException) as ei:
        await vq.enter_review(doc_id, admin_id="admin-1", db=ctx.db)
    assert ei.value.status_code == 409
    events = await get_events(
        event_type=EventType.VERIFICATION_REVIEW_ENTERED, subject_id=doc_id
    )
    assert len(events) == 0


@pytest.mark.asyncio
async def test_enter_review_on_rejected_doc_is_refused():
    doc_id = await _seed_doc(kind="passport", status=vq.STATUS_REJECTED)
    with pytest.raises(HTTPException) as ei:
        await vq.enter_review(doc_id, admin_id="admin-1", db=ctx.db)
    assert ei.value.status_code == 409


@pytest.mark.asyncio
async def test_enter_review_on_missing_doc_is_404():
    with pytest.raises(HTTPException) as ei:
        await vq.enter_review("missing-doc", admin_id="admin-1", db=ctx.db)
    assert ei.value.status_code == 404


# ── Closed-enum payload firewall ────────────────────────────────────


@pytest.mark.asyncio
async def test_invalid_document_kind_rejected_at_storage_boundary():
    """Arbitrary documentKind values are refused by the ledger.

    Even if a future code path tried to emit with `documentKind="bla"`,
    the storage-layer validator catches it.
    """
    doc_id = str(uuid.uuid4())
    for bad in ("driverLicense", "bla", "PASSPORT", "passport_v2", ""):
        with pytest.raises(ValueError, match="not in the closed enum"):
            await emit(
                EventType.VERIFICATION_REVIEW_ENTERED,
                subject_id=doc_id,
                payload={"documentKind": bad},
            )


@pytest.mark.asyncio
async def test_verification_payload_rejects_extra_keys():
    """Governance topology, not analytics. Reason / severity / note /
    score / copy MUST NOT enter the ledger payload.

    Some keys (`title`) are caught by the upstream wording firewall;
    others (`reason`, `adminNote`, `trustScore`) by the structural
    validator. Both rejections are correct — we accept either error
    message here, the doctrine outcome is identical: the write fails.
    """
    doc_id = str(uuid.uuid4())
    forbidden_payloads = [
        {"documentKind": "passport", "reason": "blurry"},
        {"documentKind": "passport", "severity": "warning"},
        {"documentKind": "passport", "adminNote": "looks fake"},
        {"documentKind": "passport", "trustScore": 42},
        {"documentKind": "passport", "title": "Passport review"},
    ]
    for payload in forbidden_payloads:
        with pytest.raises(ValueError, match="forbids extra keys|forbidden wording key"):
            await emit(
                EventType.VERIFICATION_REVIEW_ENTERED,
                subject_id=doc_id,
                payload=payload,
            )


@pytest.mark.asyncio
async def test_verification_payload_requires_document_kind():
    doc_id = str(uuid.uuid4())
    with pytest.raises(ValueError, match="documentKind"):
        await emit(
            EventType.VERIFICATION_REVIEW_ENTERED,
            subject_id=doc_id,
            payload={},
        )


# ── DocumentKind enum mirrors operational taxonomy ──────────────────


def test_document_kind_enum_matches_verification_queue_kinds():
    """The closed `DocumentKind` enum must remain in lockstep with
    `verification_queue.VERIFICATION_KINDS`. Divergence is a doctrine
    decision that must be made deliberately — this test prevents
    accidental drift between operational schema and ledger taxonomy."""
    enum_values = {e.value for e in DocumentKind}
    op_values = set(vq.VERIFICATION_KINDS)
    assert enum_values == op_values, (
        f"DocumentKind enum ({sorted(enum_values)}) and "
        f"VERIFICATION_KINDS ({sorted(op_values)}) have drifted. "
        f"Pick one source of truth before adding new kinds."
    )


# ── Full continuity coverage smoke check ────────────────────────────


@pytest.mark.asyncio
async def test_enter_review_for_each_document_kind():
    """Sanity sweep: every canonical document kind can cross into
    review and emit successfully."""
    for kind in [k.value for k in DocumentKind]:
        doc_id = await _seed_doc(kind=kind, status=vq.STATUS_PENDING)
        await vq.enter_review(doc_id, admin_id="admin-1", db=ctx.db)
        events = await get_events(
            event_type=EventType.VERIFICATION_REVIEW_ENTERED, subject_id=doc_id
        )
        assert len(events) == 1
        assert events[0]["payload"] == {"documentKind": kind}
