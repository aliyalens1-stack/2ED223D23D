"""
Sprint 3 · Step 1 — Verification Admin Queue.

Closes the supply-side trust loop:
    inspector uploads doc → admin sees in queue → approve/reject →
    inspector sees status + reason → trust snapshot updated → timeline event.

Owns:
    GET    /api/admin/verification-queue
    GET    /api/admin/verification-queue/{id}
    POST   /api/admin/verification-queue/{id}/approve
    POST   /api/admin/verification-queue/{id}/reject

Touches but does NOT own:
    `inspector_verifications` — written by inspector cabinet (existing).
    `timeline_events`         — append_event helper.
    `users`                   — verification snapshot stored under
                                `verification` key (NOT a new collection
                                to avoid extra reads on every inspector
                                profile fetch).

Status taxonomy (spec-aligned + back-compat):
    missing | uploaded | pending_review | approved | rejected
    | needs_resubmission | expired

`approved` is the canonical Sprint-3 spelling. Pre-existing rows may use
`verified` — both are accepted on read and normalised to `approved` in
API responses so the admin UI sees a single vocabulary.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.core.db import get_db
from app.core.security import verify_admin_token
from app.core.attribution import (
    AttributionContext,
    get_attribution_context,
    record_admin_mutation,
)
from app.inspector.timeline import append_event


router = APIRouter()


# ─────────────────────────────────────────────────────────────────────
# Constants — kept in sync with app.inspector.cabinet.VERIFICATION_KINDS.
# `REQUIRED_FOR_VERIFIED` is the minimum subset that must be approved for
# `verified=true` on the inspector profile snapshot.
# ─────────────────────────────────────────────────────────────────────

VERIFICATION_KINDS = [
    "passport", "businessRegistration", "insurance",
    "taxId", "toolsProof", "tuvCertificate",
]
REQUIRED_FOR_VERIFIED = ["passport", "insurance", "taxId"]

# Canonical statuses for Sprint 3 onwards.
STATUS_MISSING = "missing"
STATUS_UPLOADED = "uploaded"
STATUS_PENDING = "pending_review"
STATUS_UNDER_REVIEW = "under_review"
STATUS_APPROVED = "approved"
STATUS_REJECTED = "rejected"
STATUS_RESUBMISSION = "needs_resubmission"
STATUS_EXPIRED = "expired"
ALL_STATUSES = {
    STATUS_MISSING, STATUS_UPLOADED, STATUS_PENDING, STATUS_UNDER_REVIEW,
    STATUS_APPROVED, STATUS_REJECTED, STATUS_RESUBMISSION, STATUS_EXPIRED,
}

# Standard rejection reasons (extensible). UI shows these as a chip
# selector but free-text `note` is the actionable detail.
REJECTION_REASONS = {
    "document_blurry",
    "document_expired",
    "wrong_document_type",
    "name_mismatch",
    "incomplete_scan",
    "low_quality",
    "suspicious",
    "other",
}


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalise_status(raw: Optional[str]) -> str:
    """Map legacy `verified` to Sprint-3 `approved`. Unknown → uploaded."""
    if raw is None:
        return STATUS_UPLOADED
    if raw == "verified":
        return STATUS_APPROVED
    if raw in ALL_STATUSES:
        return raw
    return STATUS_UPLOADED


async def ensure_indexes(db) -> None:
    """Idempotent index creation for the queue read paths."""
    try:
        await db.inspector_verifications.create_index([("status", 1), ("uploadedAt", -1)])
        await db.inspector_verifications.create_index([("userId", 1), ("kind", 1)])
        # Rejection history collection (append-only audit trail).
        await db.verification_rejection_history.create_index(
            [("userId", 1), ("createdAt", -1)]
        )
        await db.verification_rejection_history.create_index(
            [("docId", 1), ("createdAt", -1)]
        )
    except Exception:
        pass


async def _fetch_inspector_snapshot(db, user_id: str) -> Dict[str, Any]:
    """
    Lightweight inspector profile snapshot for the queue detail drawer.
    Pulled from `users` collection. Falls back to a stub so the drawer
    never crashes on a stale row.
    """
    user = await db.users.find_one({"_id": user_id}, {"_id": 0, "passwordHash": 0})
    if not user:
        # Try ObjectId form (older rows). Fail gracefully.
        try:
            from bson import ObjectId  # type: ignore
            user = await db.users.find_one({"_id": ObjectId(user_id)}, {"_id": 0, "passwordHash": 0})
        except Exception:
            user = None
    if not user:
        return {"id": user_id, "name": "(unknown)", "email": None, "role": None}
    return {
        "id": user_id,
        "name": " ".join(filter(None, [user.get("firstName"), user.get("lastName")])) or user.get("email") or "(no name)",
        "email": user.get("email"),
        "phone": user.get("phone"),
        "role": user.get("role"),
        "createdAt": user.get("createdAt"),
        "verification": user.get("verification") or {},
    }


async def _fetch_rejection_history(db, doc_id: str, user_id: str) -> List[Dict[str, Any]]:
    """Past rejection events for either this specific doc OR the user+kind."""
    out: List[Dict[str, Any]] = []
    async for r in db.verification_rejection_history.find(
        {"docId": doc_id}, {"_id": 0}
    ).sort("createdAt", -1).limit(20):
        out.append(r)
    if out:
        return out
    # If the doc is brand-new, fall back to user-level history (helps
    # admins spot repeat offenders / common rejection reasons).
    async for r in db.verification_rejection_history.find(
        {"userId": user_id}, {"_id": 0}
    ).sort("createdAt", -1).limit(10):
        out.append(r)
    return out


def _serialise_doc(row: Dict[str, Any], *, include_data: bool = False) -> Dict[str, Any]:
    """Common serialisation. `data` is heavy (base64) so it's opt-in.

    Sprint Verif-2: new GridFS-backed docs surface `hasFile` so the
    admin UI can render an authenticated <img> from the file endpoint
    instead of inlining `data:base64`. We keep `data` opt-in for legacy
    docs (pre-GridFS) that still carry inline bytes.
    """
    storage = row.get("storage") or {}
    has_file = bool(storage.get("fileId")) or bool(row.get("data"))
    out = {
        "id": str(row.get("_id")),
        "userId": row.get("userId"),
        "kind": row.get("kind"),
        "status": _normalise_status(row.get("status")),
        "fileName": row.get("fileName"),
        "mimeType": row.get("mimeType"),
        "sizeBytes": row.get("sizeBytes"),
        "note": row.get("note"),
        "uploadedAt": row.get("uploadedAt"),
        "reviewedAt": row.get("reviewedAt"),
        "rejectionReason": row.get("rejectionReason"),
        "rejectionNote": row.get("rejectionNote"),
        "reviewerId": row.get("reviewerId"),
        "hasFile": has_file,
    }
    if include_data:
        # Legacy callers (older admin builds) still expect inline base64.
        # We keep this branch alive but skip for GridFS-stored docs to
        # avoid loading large blobs into memory for the list/detail JSON.
        if not storage.get("fileId"):
            out["data"] = row.get("data")
    return out


async def recompute_inspector_verification_snapshot(db, user_id: str) -> Dict[str, Any]:
    """
    Recompute trust snapshot stored on the user document:
        {
          "verified": bool,
          "verifiedDocuments": [kind, ...],
          "verificationScore": int 0..100,
          "updatedAt": ISO,
        }

    `verified` requires every kind in REQUIRED_FOR_VERIFIED to be approved.
    `verificationScore` is the share of approved kinds over the full
    REQUIRED_FOR_VERIFIED set, scaled to 0–100. Optional kinds (e.g.
    toolsProof, tuvCertificate, businessRegistration) lift the score
    when approved but are not gating.
    """
    approved_kinds: List[str] = []
    async for r in db.inspector_verifications.find(
        {"userId": user_id, "status": {"$in": ["approved", "verified"]}},
        {"_id": 0, "kind": 1, "status": 1},
    ):
        k = r.get("kind")
        if k and k not in approved_kinds:
            approved_kinds.append(k)

    required_ok = sum(1 for k in REQUIRED_FOR_VERIFIED if k in approved_kinds)
    verified = required_ok == len(REQUIRED_FOR_VERIFIED)
    # Score: 70% weight on required kinds, 30% bonus for any other approved.
    base = (required_ok / len(REQUIRED_FOR_VERIFIED)) * 70.0
    optional_approved = [k for k in approved_kinds if k not in REQUIRED_FOR_VERIFIED]
    optional_universe = [k for k in VERIFICATION_KINDS if k not in REQUIRED_FOR_VERIFIED]
    bonus = (len(optional_approved) / max(1, len(optional_universe))) * 30.0
    score = int(round(base + bonus))

    snap = {
        "verified": verified,
        "verifiedDocuments": approved_kinds,
        "verificationScore": max(0, min(100, score)),
        "updatedAt": _now_iso(),
    }

    # Best-effort update — never block approve/reject on this write.
    try:
        await db.users.update_one(
            {"_id": user_id},
            {"$set": {"verification": snap}},
        )
    except Exception:
        try:
            from bson import ObjectId  # type: ignore
            await db.users.update_one(
                {"_id": ObjectId(user_id)},
                {"$set": {"verification": snap}},
            )
        except Exception:
            pass
    return snap


# ─────────────────────────────────────────────────────────────────────
# Request schemas
# ─────────────────────────────────────────────────────────────────────

class RejectBody(BaseModel):
    reason: str = Field(..., min_length=1, max_length=64)
    note: Optional[str] = Field(None, max_length=1000)


class ApproveBody(BaseModel):
    note: Optional[str] = Field(None, max_length=1000)


# ─────────────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────────────

@router.get("/api/admin/verification-queue")
async def list_queue(
    request: Request,
    status: Optional[str] = Query(None, description="Filter by status; default: actionable items"),
    kind: Optional[str] = Query(None, description="Filter by document kind"),
    search: Optional[str] = Query(None, description="Inspector email/name contains"),
    limit: int = Query(50, ge=1, le=200),
    skip: int = Query(0, ge=0),
    _: dict = Depends(verify_admin_token),
):
    """
    Default sort: oldest pending first (so the queue is FIFO by upload time).
    Default filter: `pending_review` + `uploaded` (the actionable bucket).
    """
    db = get_db()
    q: Dict[str, Any] = {}
    if status:
        if status not in ALL_STATUSES and status != "actionable":
            raise HTTPException(400, f"unknown status: {status}")
        if status == "actionable":
            q["status"] = {"$in": [STATUS_PENDING, STATUS_UPLOADED, STATUS_RESUBMISSION, STATUS_UNDER_REVIEW]}
        elif status == STATUS_APPROVED:
            # Both spellings until DB is fully migrated.
            q["status"] = {"$in": [STATUS_APPROVED, "verified"]}
        else:
            q["status"] = status
    else:
        # Sensible default — admins want to see what needs action.
        q["status"] = {"$in": [STATUS_PENDING, STATUS_UPLOADED, STATUS_RESUBMISSION]}
    if kind:
        if kind not in VERIFICATION_KINDS:
            raise HTTPException(400, f"unknown kind: {kind}")
        q["kind"] = kind

    cursor = (
        db.inspector_verifications
        .find(q, {"data": 0})  # exclude heavy base64 from list view
        .sort("uploadedAt", 1)
        .skip(skip)
        .limit(limit)
    )
    rows: List[Dict[str, Any]] = [r async for r in cursor]
    total = await db.inspector_verifications.count_documents(q)

    # Decorate with inspector snapshot (email/name) — single batched lookup.
    user_ids = list({r.get("userId") for r in rows if r.get("userId")})
    snapshots: Dict[str, Dict[str, Any]] = {}
    if user_ids:
        async for u in db.users.find(
            {"_id": {"$in": user_ids}},
            {"_id": 1, "firstName": 1, "lastName": 1, "email": 1, "phone": 1, "verification": 1},
        ):
            uid = str(u.get("_id"))
            snapshots[uid] = {
                "id": uid,
                "name": " ".join(filter(None, [u.get("firstName"), u.get("lastName")])) or u.get("email") or "(no name)",
                "email": u.get("email"),
                "phone": u.get("phone"),
                "verification": u.get("verification") or {},
            }

    items: List[Dict[str, Any]] = []
    for r in rows:
        base = _serialise_doc(r)
        base["inspector"] = snapshots.get(r.get("userId"), {
            "id": r.get("userId"),
            "name": "(unknown)",
            "email": None,
            "phone": None,
            "verification": {},
        })
        items.append(base)

    # Roll-up counts for the dashboard chips.
    counts: Dict[str, int] = {}
    for s in [STATUS_PENDING, STATUS_UPLOADED, STATUS_APPROVED, STATUS_REJECTED,
              STATUS_RESUBMISSION, STATUS_EXPIRED]:
        cq = (
            {"status": {"$in": [STATUS_APPROVED, "verified"]}} if s == STATUS_APPROVED
            else {"status": s}
        )
        counts[s] = await db.inspector_verifications.count_documents(cq)

    return {"items": items, "total": total, "counts": counts, "limit": limit, "skip": skip}


@router.get("/api/admin/verification-queue/{doc_id}")
async def get_queue_item(
    doc_id: str,
    request: Request,
    _: dict = Depends(verify_admin_token),
):
    db = get_db()
    row = await db.inspector_verifications.find_one({"_id": doc_id})
    if not row:
        raise HTTPException(404, "document not found")
    inspector = await _fetch_inspector_snapshot(db, row.get("userId"))
    history = await _fetch_rejection_history(db, doc_id, row.get("userId"))
    return {
        "document": _serialise_doc(row, include_data=True),
        "inspector": inspector,
        "rejectionHistory": history,
    }


@router.get("/api/admin/verification-queue/{doc_id}/file")
async def get_queue_item_file(
    doc_id: str,
    request: Request,
    _: dict = Depends(verify_admin_token),
):
    """Sprint Verif-2: stream document bytes from GridFS to admin reviewers.

    Auth-gated by `verify_admin_token` — same level as approve/reject. We
    intentionally do NOT add a signed URL: admin queue is rendered behind
    the admin SPA which already attaches the admin JWT to every request.
    """
    from fastapi.responses import Response
    db = get_db()
    row = await db.inspector_verifications.find_one({"_id": doc_id})
    if not row:
        raise HTTPException(404, "document not found")
    mime = row.get("mimeType") or "application/octet-stream"
    storage = row.get("storage") or {}
    file_id = storage.get("fileId")
    if file_id:
        try:
            from bson import ObjectId
            from motor.motor_asyncio import AsyncIOMotorGridFSBucket
            bucket = AsyncIOMotorGridFSBucket(db, bucket_name=storage.get("bucket", "verification"))
            stream = await bucket.open_download_stream(ObjectId(file_id))
            data = await stream.read()
            return Response(content=data, media_type=mime)
        except Exception:
            pass
    # Legacy fallback (pre-GridFS uploads).
    b64 = row.get("data")
    if b64:
        try:
            import base64 as _b64
            return Response(content=_b64.b64decode(b64), media_type=mime)
        except Exception:
            pass
    raise HTTPException(404, "file bytes not available")


@router.post("/api/admin/verification-queue/{doc_id}/enter-review")
async def enter_review_endpoint(
    doc_id: str,
    request: Request,
    admin_ctx: dict = Depends(verify_admin_token),
    ctx_attr: AttributionContext = Depends(get_attribution_context),
):
    """
    Phase D Pass 1D-B — explicit governance transition.

    Crosses a document from `pending_review`/`uploaded`/`needs_resubmission`
    into `under_review` and records this as the governance-custody
    boundary in the runtime ledger. This is the ONLY entry point that
    emits `verification_review_entered` — GET-detail must NOT.

    Idempotent: a second call on an already-under-review document
    returns the existing state without re-emitting (ledger coalesces
    on doc_id anyway, but the operational layer short-circuits to
    avoid the wasted write).

    Terminal states (`approved`/`rejected`) are refused — re-opening
    a closed verification needs a different flow (resubmission upload).
    """
    db = get_db()
    admin_id = admin_ctx.get("sub") if isinstance(admin_ctx, dict) else None
    result = await enter_review(doc_id, admin_id=admin_id, db=db)
    # P6.B.3 — Attribution: governance transition into under_review.
    try:
        await record_admin_mutation(
            db, ctx_attr,
            action="verification.enter_review",
            domain="user",
            entity_id=str(doc_id),
            extra={"alreadyUnderReview": bool(result.get("alreadyUnderReview"))
                                          if isinstance(result, dict) else None},
        )
    except Exception as _attr_e:
        import logging as _lg
        _lg.getLogger(__name__).warning(f"[verification_queue] attribution enter_review failed: {_attr_e}")
    return result


async def enter_review(
    doc_id: str,
    *,
    admin_id: Optional[str],
    db: Any = None,
) -> Dict[str, Any]:
    """
    Internal helper — operational + ledger transition. Importable so
    other flows (e.g. a future batch-claim) can call it without going
    through HTTP. Same semantics as the endpoint.
    """
    if db is None:
        db = get_db()
    row = await db.inspector_verifications.find_one({"_id": doc_id})
    if not row:
        raise HTTPException(404, "document not found")

    cur_status = _normalise_status(row.get("status"))
    if cur_status in {STATUS_APPROVED, STATUS_REJECTED}:
        raise HTTPException(
            409,
            f"document is already in terminal state ({cur_status}); "
            f"re-opening requires resubmission",
        )

    if cur_status == STATUS_UNDER_REVIEW:
        # Idempotent fast-path — no DB write, no ledger emit. The
        # ledger already coalesces, but we short-circuit to keep this
        # cheap when admins refresh.
        return {
            "document": _serialise_doc(row),
            "alreadyUnderReview": True,
        }

    now = _now_iso()
    # Atomic transition guard — refuse to widen across a terminal flip
    # that may have happened between our read and write.
    res = await db.inspector_verifications.find_one_and_update(
        {
            "_id": doc_id,
            "status": {
                "$in": [
                    STATUS_PENDING, STATUS_UPLOADED, STATUS_RESUBMISSION,
                    # Some legacy rows may have None / unknown status —
                    # treat them as enterable.
                    None,
                ]
            },
        },
        {
            "$set": {
                "status": STATUS_UNDER_REVIEW,
                "reviewStartedAt": now,
                "reviewerId": admin_id,
            }
        },
        return_document=True,
    )
    if not res:
        # A race with approve/reject won. The current doc state is
        # already terminal or already under_review.
        fresh = await db.inspector_verifications.find_one({"_id": doc_id})
        return {
            "document": _serialise_doc(fresh or row),
            "alreadyUnderReview": (
                _normalise_status((fresh or {}).get("status")) == STATUS_UNDER_REVIEW
            ),
        }

    # Phase D Pass 1D-B — verification continuity entered.
    # Governance topology, NOT analytics. Subject is the DOCUMENT
    # (verification subject). Coalesce on (doc_id) → one event per
    # document, ever. The closed `DocumentKind` enum at the storage
    # boundary refuses any payload that drifts from the canonical
    # taxonomy. Best-effort: ledger failure does NOT roll back the
    # status transition — operational substrate stays source of record.
    try:
        from app.runtime_ledger import emit as _rl_emit, EventType as _RLEventType
        await _rl_emit(
            _RLEventType.VERIFICATION_REVIEW_ENTERED,
            subject_id=doc_id,
            payload={"documentKind": row.get("kind")},
            emitted_by=admin_id,
        )
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning(
            f"runtime_ledger emit (verification_review_entered) failed "
            f"for doc {doc_id}: {exc}"
        )

    return {
        "document": _serialise_doc(res),
        "alreadyUnderReview": False,
    }


@router.post("/api/admin/verification-queue/{doc_id}/approve")
async def approve_document(
    doc_id: str,
    body: ApproveBody,
    request: Request,
    admin_ctx: dict = Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
):
    db = get_db()
    row = await db.inspector_verifications.find_one({"_id": doc_id})
    if not row:
        raise HTTPException(404, "document not found")
    if _normalise_status(row.get("status")) == STATUS_APPROVED:
        # Idempotent — return the existing state.
        snap = await recompute_inspector_verification_snapshot(db, row.get("userId"))
        return {
            "document": _serialise_doc(row),
            "verification": snap,
            "alreadyApproved": True,
        }

    now = _now_iso()
    upd = {
        "status": STATUS_APPROVED,
        "reviewedAt": now,
        "reviewerId": admin_ctx.get("sub") if isinstance(admin_ctx, dict) else None,
        "rejectionReason": None,
        "rejectionNote": None,
    }
    await db.inspector_verifications.update_one({"_id": doc_id}, {"$set": upd})

    # Recompute trust snapshot on the inspector profile.
    snap = await recompute_inspector_verification_snapshot(db, row.get("userId"))

    # Timeline event — inspector & admin actor.
    try:
        await append_event(
            kind="verification_approved",
            inspector_id=row.get("userId"),
            actor_type="admin",
            actor_id=admin_ctx.get("sub") if isinstance(admin_ctx, dict) else None,
            actor_label=admin_ctx.get("email") if isinstance(admin_ctx, dict) else "admin",
            severity="success",
            title=f"Документ «{row.get('kind')}» подтверждён",
            text=body.note or None,
            metadata={
                "docId": doc_id,
                "kind": row.get("kind"),
                "verificationScore": snap.get("verificationScore"),
                "verified": snap.get("verified"),
            },
            stable_key=f"verify:{doc_id}:approved",
        )
    except Exception:
        pass

    # P6.B — Attribution saturation: governance trail row for approval.
    try:
        await record_admin_mutation(
            db,
            ctx,
            action="verification.approve",
            domain="user",
            entity_id=row.get("userId") or doc_id,
            causal_entity={"kind": "verification_doc", "id": doc_id},
            extra={
                "docKind": row.get("kind"),
                "verified": snap.get("verified"),
                "verificationScore": snap.get("verificationScore"),
                "note": body.note,
            },
        )
    except Exception:
        pass
    fresh = await db.inspector_verifications.find_one({"_id": doc_id})
    return {
        "document": _serialise_doc(fresh or row, include_data=False),
        "verification": snap,
    }


@router.post("/api/admin/verification-queue/{doc_id}/reject")
async def reject_document(
    doc_id: str,
    body: RejectBody,
    request: Request,
    admin_ctx: dict = Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
):
    if body.reason not in REJECTION_REASONS:
        raise HTTPException(400, f"unknown rejection reason: {body.reason}")

    db = get_db()
    row = await db.inspector_verifications.find_one({"_id": doc_id})
    if not row:
        raise HTTPException(404, "document not found")

    now = _now_iso()
    reviewer_id = admin_ctx.get("sub") if isinstance(admin_ctx, dict) else None

    upd = {
        "status": STATUS_REJECTED,
        "reviewedAt": now,
        "reviewerId": reviewer_id,
        "rejectionReason": body.reason,
        "rejectionNote": body.note,
    }
    await db.inspector_verifications.update_one({"_id": doc_id}, {"$set": upd})

    # Audit trail — append-only.
    try:
        await db.verification_rejection_history.insert_one({
            "id": uuid.uuid4().hex,
            "docId": doc_id,
            "userId": row.get("userId"),
            "kind": row.get("kind"),
            "reason": body.reason,
            "note": body.note,
            "reviewerId": reviewer_id,
            "createdAt": now,
        })
    except Exception:
        pass

    # Recompute snapshot — a rejection can flip `verified` from true→false
    # if the rejected doc was previously approved (re-review case).
    snap = await recompute_inspector_verification_snapshot(db, row.get("userId"))

    try:
        await append_event(
            kind="verification_rejected",
            inspector_id=row.get("userId"),
            actor_type="admin",
            actor_id=reviewer_id,
            actor_label=admin_ctx.get("email") if isinstance(admin_ctx, dict) else "admin",
            severity="warning",
            title=f"Документ «{row.get('kind')}» отклонён",
            text=body.note or body.reason,
            metadata={
                "docId": doc_id,
                "kind": row.get("kind"),
                "reason": body.reason,
                "verificationScore": snap.get("verificationScore"),
            },
            stable_key=f"verify:{doc_id}:rejected:{now}",
        )
    except Exception:
        pass

    # P6.B — Attribution saturation: governance trail row for rejection.
    try:
        await record_admin_mutation(
            db,
            ctx,
            action="verification.reject",
            domain="user",
            entity_id=row.get("userId") or doc_id,
            causal_entity={"kind": "verification_doc", "id": doc_id},
            extra={
                "docKind": row.get("kind"),
                "reason": body.reason,
                "note": body.note,
                "verified": snap.get("verified"),
            },
        )
    except Exception:
        pass

    fresh = await db.inspector_verifications.find_one({"_id": doc_id})
    return {
        "document": _serialise_doc(fresh or row, include_data=False),
        "verification": snap,
    }
