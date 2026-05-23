"""Phase C.3 — Provider Workspace REST API for candidate cars on selection requests."""
from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException

from app.auto_requests import candidates as csvc
from app.auto_requests import service as svc
from app.auto_requests.auth import get_user_id_optional, get_user_id_required
from app.auto_requests.candidates import CandidateIn, CandidateOut

# ─────────────────────────────────────────────────────────────────────
# Provider side — attach / list / update / archive candidates
# ─────────────────────────────────────────────────────────────────────
provider_router = APIRouter(prefix="/api/provider", tags=["candidates:provider"])


@provider_router.post("/requests/{request_id}/candidates", response_model=CandidateOut)
async def attach_candidate(request_id: str, data: CandidateIn,
                           uid: str = Depends(get_user_id_optional)):
    req = await svc.get_request(request_id)
    if not req:
        raise HTTPException(404, "request not found")
    if getattr(req, "type", None) != "selection":
        raise HTTPException(400, "candidates apply to selection requests only")
    return await csvc.create_candidate(request_id, uid, data)


@provider_router.get("/requests/{request_id}/candidates", response_model=list[CandidateOut])
async def list_request_candidates(request_id: str):
    req = await svc.get_request(request_id)
    if not req:
        raise HTTPException(404, "request not found")
    return await csvc.list_candidates(request_id)


@provider_router.patch("/candidates/{candidate_id}", response_model=CandidateOut)
async def update_one(candidate_id: str, data: CandidateIn):
    out = await csvc.update_candidate(candidate_id, data)
    if not out:
        raise HTTPException(404, "candidate not found")
    return out


@provider_router.delete("/candidates/{candidate_id}")
async def archive_one(candidate_id: str):
    ok = await csvc.archive_candidate(candidate_id)
    if not ok:
        raise HTTPException(404, "candidate not found")
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────
# Customer side — read-only comparison view
# ─────────────────────────────────────────────────────────────────────
customer_router = APIRouter(prefix="/api/customer", tags=["candidates:customer"])


@customer_router.get("/requests/{request_id}/candidates")
async def my_request_candidates(request_id: str, uid: str = Depends(get_user_id_required)):
    """Customer compares candidates attached to their own request."""
    req = await svc.get_request(request_id)
    if not req:
        raise HTTPException(404, "request not found")
    owner_id = getattr(req, "userId", None)
    if owner_id and owner_id != uid:
        raise HTTPException(403, "not your request")
    items = await csvc.list_candidates(request_id)
    # Comparison helper: sort by recommended desc, then score desc.
    items_sorted = sorted(
        items,
        key=lambda c: (1 if c.recommended else 0, c.score or 0),
        reverse=True,
    )
    return {
        "requestId": request_id,
        "count": len(items_sorted),
        "candidates": [c.model_dump() for c in items_sorted],
    }
