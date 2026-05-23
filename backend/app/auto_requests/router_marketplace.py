"""Phase 3 — Marketplace API: exposures + matching status.

Anti-abuse: `/accept` and `/reject` log every action to `inspector_exposure_events`
(TTL 24h via exposures_cron.ensure_exposure_indexes). If an inspector exceeds
`ANTI_ABUSE_MAX_PER_MIN` action rate, we return 429 — prevents click-spamming
every exposure without thought.

Phase 3 Step 3: anti-monopoly cap is ALSO enforced at accept-time via
MAX_ACTIVE_JOBS_PER_INSPECTOR. This keeps greedy inspectors from hoarding
jobs even if the scoring penalty alone fails to gate them.
"""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Query

from app.auto_requests import marketplace as mkt
from app.auto_requests.auth import get_user_id_required
from app.auto_requests import service as svc
from app.core.db import get_db


ANTI_ABUSE_MAX_PER_MIN = 20  # accept+reject combined
MAX_ACTIVE_JOBS_PER_INSPECTOR = 5  # hard ceiling (soft-monopoly guard)


async def resolve_inspector_org_id(user_id: str, override: str | None = None) -> str:
    """Resolve inspector_id used by exposures.

    Precedence:
      1. Explicit ?inspectorId=... query (org owners managing multiple orgs)
      2. organizations.ownerId == user_id (provider_owner users have 1 org)
      3. Fallback: the raw user_id (useful for inspector-role users where userId == inspectorId)
    """
    if override:
        return override
    db = get_db()
    org = await db.organizations.find_one({"ownerId": user_id}, {"_id": 1})
    if org:
        return str(org["_id"])
    return user_id


async def count_active_jobs(inspector_id: str) -> int:
    db = get_db()
    return int(await db.inspection_jobs.count_documents({
        "inspectorId": inspector_id,
        "status": {"$in": ["claimed", "on_route", "arrived", "inspecting"]},
    }))


async def _record_action_or_429(inspector_id: str, action: str) -> None:
    """Log action + enforce rate limit. Raises HTTPException 429 when exceeded."""
    db = get_db()
    now = datetime.now(timezone.utc)
    one_min_ago = now - timedelta(minutes=1)
    recent = await db.inspector_exposure_events.count_documents({
        "inspectorId": inspector_id,
        "ts": {"$gte": one_min_ago},
    })
    if recent >= ANTI_ABUSE_MAX_PER_MIN:
        raise HTTPException(429, f"rate_limited: max {ANTI_ABUSE_MAX_PER_MIN} exposure actions/min")
    await db.inspector_exposure_events.insert_one({
        "inspectorId": inspector_id,
        "action": action,
        "ts": now,
    })


inspector_router = APIRouter(prefix="/api/inspector/exposures", tags=["marketplace:inspector"])
customer_router = APIRouter(prefix="/api/customer/requests", tags=["marketplace:customer"])


# ─── Inspector side ─────────────────────────────────────────────────

@inspector_router.get("")
async def list_my_exposures(
    uid: str = Depends(get_user_id_required),
    inspectorId: str | None = Query(default=None, description="Optional override — defaults to org owned by current user"),
):
    """Return visible exposures for the authenticated inspector + stats needed by UI.

    Response includes `activeJobsCount` and `maxActiveJobs` so the mobile UI
    can gate the "Взять" button without an extra round-trip.
    """
    target = await resolve_inspector_org_id(uid, inspectorId)
    exposures = await mkt.list_visible_exposures_for_inspector(target)
    active = await count_active_jobs(target)
    return {
        "exposures": exposures,
        "count": len(exposures),
        "activeJobsCount": active,
        "maxActiveJobs": MAX_ACTIVE_JOBS_PER_INSPECTOR,
        "canAccept": active < MAX_ACTIVE_JOBS_PER_INSPECTOR,
        "inspectorId": target,
    }


@inspector_router.post("/{exposure_id}/accept")
async def accept(exposure_id: str, uid: str = Depends(get_user_id_required), inspectorId: str | None = Query(default=None)):
    target = await resolve_inspector_org_id(uid, inspectorId)
    await _record_action_or_429(target, "accept")
    # Anti-monopoly: hard ceiling regardless of scoring penalty
    active = await count_active_jobs(target)
    if active >= MAX_ACTIVE_JOBS_PER_INSPECTOR:
        raise HTTPException(409, f"too_many_active_jobs: {active}/{MAX_ACTIVE_JOBS_PER_INSPECTOR}. "
                                  "Finish current jobs before taking new ones.")
    res = await mkt.accept_exposure(exposure_id, target)
    if not res:
        raise HTTPException(409, "exposure not acceptable (expired, taken by other, or not yours)")
    return {"status": "accepted", "exposure": res}


@inspector_router.post("/{exposure_id}/reject")
async def reject(exposure_id: str, uid: str = Depends(get_user_id_required), inspectorId: str | None = Query(default=None)):
    target = await resolve_inspector_org_id(uid, inspectorId)
    await _record_action_or_429(target, "reject")
    ok = await mkt.reject_exposure(exposure_id, target)
    if not ok:
        raise HTTPException(404, "exposure not found or not yours")
    return {"status": "rejected"}


# ─── Customer side ──────────────────────────────────────────────────

@customer_router.get("/{request_id}/matching")
async def matching_status(request_id: str, uid: str = Depends(get_user_id_required)):
    """Customer-visible matching progress for a request.

    Enforces ownership: customer can see their own requests only.
    """
    req = await svc.get_request(request_id)
    if not req:
        raise HTTPException(404, "request not found")
    if req.userId and req.userId != uid:
        raise HTTPException(403, "not your request")
    return await mkt.matching_status_for_request(request_id)
