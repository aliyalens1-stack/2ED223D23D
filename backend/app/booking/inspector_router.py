"""P0.b.C.c — Inspector-facing booking timeline.

Endpoint:

    GET /api/inspector/jobs/{job_id}/timeline

INTENTIONALLY separate from `/api/customer/...`, `/api/provider/...`,
and `/api/admin/booking-lifecycle/...`. Different auth, different
projection module, independent evolution path.

Key design choice — endpoint is keyed by **jobId**, not bookingId:

  Inspector mental model is "this is MY inspection job", not "this is
  a booking in some marketplace state". The job is the durable
  identifier the inspector carries through their cabinet view; the
  underlying car_request is a broader commercial aggregate that the
  inspector doesn't really care about.

  We translate jobId → job.requestId → booking_timeline rows
  internally, but never expose `requestId` semantics to the caller.

Contract:
  * Requires authenticated user (`verify_user_token`).
  * Job must be assigned to the caller (`inspectorId` /
    `inspectorAccountId` ownership check on `inspection_jobs`).
  * 404 if job not found OR not assigned to this inspector (same
    opacity discipline as provider router — 404 not 403, to avoid
    leaking the existence of competitor jobs).

No write endpoints in this surface. Inspector mutates state via
existing business endpoints; this is read-only chronology.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket

from app.core.db import get_db
from app.core.security import verify_user_token

from .projections.inspector import project_timeline_for_inspector
from .timeline import read_timeline
from .realtime import inspector_ws_handler


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/inspector", tags=["inspector:booking-lifecycle"])


def _inspector_identity(payload: Dict[str, Any]) -> List[str]:
    """Collect every id under which the caller may be recorded as an
    inspector on `inspection_jobs` rows. Multi-keyed because legacy
    docs use a mix of user-id / account-id / explicit inspectorId."""
    ids: List[str] = []
    for key in (
        "sub", "userId", "accountId",
        "inspectorId", "inspectorAccountId",
    ):
        val = payload.get(key)
        if val:
            ids.append(str(val))
    seen: set[str] = set()
    return [x for x in ids if not (x in seen or seen.add(x))]


def _job_inspector_ids(job: Dict[str, Any]) -> List[str]:
    """Collect every inspector-shaped id stored on the job doc."""
    out: List[str] = []
    for key in ("inspectorId", "inspectorAccountId", "inspectorUserId"):
        val = job.get(key)
        if val:
            out.append(str(val))
    return out


async def _load_inspector_job(
    db,
    job_id: str,
    caller_ids: List[str],
) -> Dict[str, Any]:
    """Resolve a job by id and assert ownership.

    Returns the job doc on success. Raises 404 in two cases:
      * job doesn't exist
      * job exists but belongs to a different inspector (opacity)
    """
    # `inspection_jobs._id` is the canonical key. We probe both `_id`
    # (Mongo legacy) and `id` defensively because some seed paths
    # write `id` as well.
    job = await db.inspection_jobs.find_one({"_id": job_id})
    if not job:
        job = await db.inspection_jobs.find_one({"id": job_id})
    if not job:
        raise HTTPException(404, "Job not found")

    job_inspector_ids = _job_inspector_ids(job)
    if not job_inspector_ids:
        # Unassigned job — inspector cannot claim ownership.
        raise HTTPException(404, "Job not assigned to current inspector")

    if not set(caller_ids).intersection(job_inspector_ids):
        # Foreign-owned job — opaque 404.
        raise HTTPException(404, "Job not found")

    return job


@router.get("/jobs/{job_id}/timeline")
async def inspector_job_timeline(
    job_id: str,
    user: dict = Depends(verify_user_token),
) -> Dict[str, Any]:
    """Inspector-facing timeline projection (P0.b.C.c).

    Returns:
        {
            "jobId":   the requested job id (echoed),
            "events":  chronological list of projected events,
            "count":   len(events),
        }

    Note: `requestId` / `bookingId` deliberately NOT echoed in the
    response. Inspector should not think about the underlying booking
    aggregate — that's a broader commercial object.
    """
    db = get_db()
    caller_ids = _inspector_identity(user)
    if not caller_ids:
        raise HTTPException(401, "Unauthorized")

    job = await _load_inspector_job(db, job_id, caller_ids)

    # Translate job → underlying booking_timeline rows.
    request_id = job.get("requestId")
    if not request_id:
        # Job has no upstream request linkage — empty timeline is
        # the right semantic (nothing has been recorded on the
        # canonical chronology for this job's booking).
        return {"jobId": job_id, "events": [], "count": 0}

    raw_rows = await read_timeline(db, str(request_id), limit=200)
    chronological = list(reversed(raw_rows))
    events = project_timeline_for_inspector(
        chronological, inspector_ids=caller_ids,
    )
    return {
        "jobId": job_id,
        "events": events,
        "count": len(events),
    }


# ─────────────────────────────────────────────────────────────────────
# P0.b.C.d — Realtime stream. Keyed by jobId. Server resolves
# jobId→requestId AT subscribe time (not on every emit). Ownership
# also enforced at subscribe — non-owners are silently closed with
# WS code 4404 (no leak of competitor jobs).
# ─────────────────────────────────────────────────────────────────────


@router.websocket("/jobs/{job_id}/timeline/stream")
async def inspector_job_timeline_stream(
    websocket: WebSocket,
    job_id: str,
    token: str = Query(None),
):
    db = get_db()
    await inspector_ws_handler(websocket, job_id, token, db)


__all__ = ["router"]
