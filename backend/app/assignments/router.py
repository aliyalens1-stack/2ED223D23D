"""Sprint 3 Step 4 — Live Assignments HTTP surface.

Endpoints:
    Inspector
        GET  /api/inspector/assignments/live
        POST /api/inspector/assignments/{id}/accept
        POST /api/inspector/assignments/{id}/decline
    Admin
        POST /api/admin/assignments/create
        GET  /api/admin/assignments
        POST /api/admin/assignments/{id}/cancel

Lazy expiration runs on GET live and on POST accept — see engine.expire_stale.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.core.db import get_db
from app.core.security import verify_admin_token
# P6.B.3 — Attribution wiring.
from app.core.attribution import (
    AttributionContext,
    get_attribution_context,
    record_admin_mutation,
)
from app.auto_requests.auth import get_user_id_required
from app.assignments.engine import (
    accept_assignment,
    cancel_assignment,
    create_assignment,
    decline_assignment,
    expire_stale,
)


router = APIRouter()


# ─────────────────────────────────────────────────────────────────────
# Inspector
# ─────────────────────────────────────────────────────────────────────

@router.get("/api/inspector/assignments/live")
async def list_live(uid: str = Depends(get_user_id_required)) -> Dict[str, Any]:
    db = get_db()
    await expire_stale(db, inspector_id=uid)
    cursor = (
        db.inspection_assignments
        .find({"inspectorId": uid, "status": "offered"}, {"_id": 0})
        .sort([("score", -1), ("createdAt", 1)])
        .limit(20)
    )
    items = await cursor.to_list(length=20)
    return {"items": items, "count": len(items)}


class DeclineBody(BaseModel):
    reason: Optional[str] = Field(None, max_length=200)


@router.post("/api/inspector/assignments/{assignment_id}/accept")
async def post_accept(assignment_id: str, uid: str = Depends(get_user_id_required)) -> Dict[str, Any]:
    code, row = await accept_assignment(assignment_id, uid)
    return _shape_transition_response(code, row)


@router.post("/api/inspector/assignments/{assignment_id}/decline")
async def post_decline(
    assignment_id: str,
    body: DeclineBody = Body(default_factory=DeclineBody),
    uid: str = Depends(get_user_id_required),
) -> Dict[str, Any]:
    code, row = await decline_assignment(assignment_id, uid, reason=body.reason)
    return _shape_transition_response(code, row)


def _shape_transition_response(code: str, row: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Translate engine status code to HTTP-friendly response.

    We never raise 500 for legitimate state-machine outcomes — the
    inspector client distinguishes them via `status` in body.
    """
    if code == "notfound":
        raise HTTPException(404, "Assignment not found")
    if code == "forbidden":
        raise HTTPException(403, "Not your assignment")
    # All other terminal states are 200 with explicit status — keeps
    # client state machine simple and tests deterministic.
    return {"ok": True, "status": code, "assignment": row}


# ─────────────────────────────────────────────────────────────────────
# Admin
# ─────────────────────────────────────────────────────────────────────

class CreateAssignmentBody(BaseModel):
    jobId: str
    inspectorId: str
    customerId: Optional[str] = None
    vehicleId: Optional[str] = None
    priority: str = "normal"
    estimatedEarnings: Optional[float] = None
    currency: str = "EUR"
    ttlSeconds: Optional[int] = Field(None, ge=15, le=3600)
    jobLat: Optional[float] = None
    jobLng: Optional[float] = None
    manualOverride: bool = False


@router.post("/api/admin/assignments/create")
async def admin_create(
    body: CreateAssignmentBody,
    _: dict = Depends(verify_admin_token),
    ctx_attr: AttributionContext = Depends(get_attribution_context),
) -> Dict[str, Any]:
    loc = None
    if body.jobLat is not None and body.jobLng is not None:
        loc = (body.jobLat, body.jobLng)
    asg = await create_assignment(
        job_id=body.jobId,
        inspector_id=body.inspectorId,
        customer_id=body.customerId,
        vehicle_id=body.vehicleId,
        priority=body.priority,
        estimated_earnings=body.estimatedEarnings,
        currency=body.currency,
        ttl_seconds=body.ttlSeconds,
        job_location=loc,
        manual_override=body.manualOverride,
    )
    if not asg:
        raise HTTPException(400, "Cannot create assignment (inspector missing or hard-floored without manualOverride)")
    # P6.B.3 — Attribution.
    try:
        db = get_db()
        await record_admin_mutation(
            db, ctx_attr,
            action="assignment.create",
            domain="other",
            entity_id=str(asg.get("id") if isinstance(asg, dict) else "unknown"),
            extra={"jobId": body.jobId, "inspectorId": body.inspectorId,
                   "manualOverride": body.manualOverride,
                   "priority": body.priority},
        )
    except Exception as _attr_e:
        import logging as _lg
        _lg.getLogger(__name__).warning(f"[assignments] attribution assignment.create failed: {_attr_e}")
    return {"ok": True, "assignment": asg}


@router.get("/api/admin/assignments")
async def admin_list(
    status: Optional[str] = Query(None),
    job_id: Optional[str] = Query(None),
    inspector_id: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    _: dict = Depends(verify_admin_token),
) -> Dict[str, Any]:
    db = get_db()
    q: Dict[str, Any] = {}
    if status:      q["status"] = status
    if job_id:      q["jobId"] = job_id
    if inspector_id: q["inspectorId"] = inspector_id
    cursor = (
        db.inspection_assignments
        .find(q, {"_id": 0})
        .sort("createdAt", -1)
        .limit(limit)
    )
    items: List[Dict[str, Any]] = await cursor.to_list(length=limit)
    counts = {}
    for s in ("offered", "accepted", "declined", "expired", "cancelled"):
        counts[s] = await db.inspection_assignments.count_documents({"status": s})
    return {"items": items, "count": len(items), "statusCounts": counts}


@router.post("/api/admin/assignments/{assignment_id}/cancel")
async def admin_cancel(
    assignment_id: str,
    payload: dict = Depends(verify_admin_token),
    ctx_attr: AttributionContext = Depends(get_attribution_context),
) -> Dict[str, Any]:
    actor = (payload or {}).get("email") or (payload or {}).get("sub")
    code, row = await cancel_assignment(assignment_id, admin_actor=actor)
    if code == "notfound":
        raise HTTPException(404, "Assignment not found")
    if code == "already_accepted":
        raise HTTPException(409, "Cannot cancel an accepted assignment")
    # P6.B.3 — Attribution.
    try:
        db = get_db()
        await record_admin_mutation(
            db, ctx_attr,
            action="assignment.cancel",
            domain="other",
            entity_id=str(assignment_id),
            extra={"code": code,
                   "jobId": (row or {}).get("jobId") if isinstance(row, dict) else None,
                   "inspectorId": (row or {}).get("inspectorId") if isinstance(row, dict) else None},
        )
    except Exception as _attr_e:
        import logging as _lg
        _lg.getLogger(__name__).warning(f"[assignments] attribution assignment.cancel failed: {_attr_e}")
    return {"ok": True, "status": code, "assignment": row}


__all__ = ["router"]
