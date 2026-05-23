"""Inspector API — Sprint 4 lifecycle + Sprint 1D.1 capability gate.

Sprint 1D.1 — Inspector Auto Requests Gate:
  - All endpoints now require `inspect` capability (not just any authenticated
    user). Customers, admins-without-inspect-cap, etc. → 403.
  - `IdentityContext` is the single source of truth for caller identity. The
    legacy `users.role` field is no longer consulted at this layer.
  - Each job doc gets `inspectorAccountId` written alongside `inspectorId`.
    Old code that reads `inspectorId` keeps working; new code can adopt
    `inspectorAccountId`. Service-layer ownership checks (still on
    `inspectorId == users._id`) are intentionally untouched.

Lifecycle: open → claimed → on_route → arrived → inspecting → done
Endpoint summary:
  GET    /api/inspector/jobs                       — list open jobs (filter by city)
  GET    /api/inspector/jobs/my                    — inspector's jobs (full lifecycle)
  GET    /api/inspector/jobs/{id}                  — single job (full)
  POST   /api/inspector/jobs/{id}/claim            — atomic claim
  POST   /api/inspector/jobs/{id}/on-route         — claimed → on_route
  POST   /api/inspector/jobs/{id}/arrived          — on_route → arrived
  POST   /api/inspector/jobs/{id}/start-inspection — arrived → inspecting
  POST   /api/inspector/jobs/{id}/cancel           — release back to open
  POST   /api/inspector/jobs/{id}/report           — inspecting → done + consume credit
  POST   /api/inspector/jobs/{id}/complete         — DEPRECATED (kept for back-compat)
  GET    /api/inspector/checklist                  — checklist v1 (12 items)
"""
from __future__ import annotations
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query

from app.auto_requests import service as svc
from app.auto_requests import reports as rsvc
from app.auto_requests.schemas import (
    SubmitReportRequest,
    CancelJobRequest,
)
from app.auto_requests.checklist import CHECKLIST, ITEM_STATUSES, VERDICTS
from app.core.db import get_db
from app.core.identity_runtime import (
    IdentityContext,
    require_capability_v2,
)

router = APIRouter(prefix="/api/inspector/jobs", tags=["auto_requests:inspector"])


# ── Capability gate ─────────────────────────────────────────────────
# Single dependency reused by every inspector endpoint. Resolves through
# identity_runtime — reads `account_capabilities` (with legacy fallback) so
# a customer cannot reach inspector endpoints even if they hand-craft a JWT
# with role='provider_owner' (which would have worked before 1D.1).
_inspect_required = require_capability_v2("inspect")


# ── Internal helpers ────────────────────────────────────────────────

async def _set_inspector_account_id(job_id: str, account_id: Optional[str]) -> None:
    """Dual-write the new `inspectorAccountId` field. None means "release"
    (used on cancel) so the field tracks `inspectorId` 1:1."""
    db = get_db()
    await db.inspection_jobs.update_one(
        {"_id": job_id},
        {"$set": {"inspectorAccountId": account_id}},
    )


def _to_dict(obj):
    """Coerce a Pydantic model OR plain dict into a plain dict so we can merge
    the new `inspectorAccountId` field into the response. Service layer returns
    `InspectionJobOut` (Pydantic), but a few code paths may return dicts —
    handle both transparently."""
    if obj is None:
        return None
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    if hasattr(obj, "dict"):
        return obj.dict()
    return dict(obj) if isinstance(obj, dict) else obj


# ── Reads ─────────────────────────────────────────────────────────────

@router.get("")
async def list_open_jobs_endpoint(
    city: Optional[str] = Query(default=None),
    ctx: IdentityContext = Depends(_inspect_required),  # noqa: B008
):
    """List open jobs available for an inspector to claim. Sprint 1D.1: this
    is now capability-gated. Pre-1D.1 the endpoint was public, which leaked
    request data to anyone with a JWT (or none)."""
    jobs = await svc.list_open_jobs(city=city)
    return {"jobs": jobs, "count": len(jobs)}


@router.get("/my")
async def my_jobs(ctx: IdentityContext = Depends(_inspect_required)):  # noqa: B008
    """Inspector's jobs — full lifecycle data."""
    jobs = await rsvc.list_my_jobs_full(ctx.user_id)
    return {"jobs": jobs, "count": len(jobs)}


@router.get("/{job_id}")
async def get_job_detail(
    job_id: str,
    ctx: IdentityContext = Depends(_inspect_required),  # noqa: B008
):
    job, err = await rsvc.get_job_full(job_id, ctx.user_id)
    if err == "job_not_found":
        raise HTTPException(404, "job not found")
    if err == "not_your_job":
        raise HTTPException(403, "not your job")
    return {"job": job}


# ── Claim ─────────────────────────────────────────────────────────────

@router.post("/{job_id}/claim")
async def claim_job_endpoint(
    job_id: str,
    ctx: IdentityContext = Depends(_inspect_required),  # noqa: B008
):
    res = await svc.claim_job(job_id, inspector_id=ctx.user_id)
    if not res:
        raise HTTPException(409, "job already claimed or not found")
    # Sprint 1D.1: backfill the new field. Legacy `inspectorId` is already
    # set by the service inside the same atomic update — we add the account
    # id as a parallel reference.
    await _set_inspector_account_id(job_id, ctx.account.id)
    job_d = _to_dict(res) or {}
    job_d["inspectorAccountId"] = ctx.account.id
    return {"status": "ok", "job": job_d}


# ── Lifecycle transitions ────────────────────────────────────────────

@router.post("/{job_id}/on-route")
async def on_route(
    job_id: str,
    ctx: IdentityContext = Depends(_inspect_required),  # noqa: B008
):
    job, err = await rsvc.transition_status(job_id, ctx.user_id, "on_route")
    if err:
        _raise_lifecycle_error(err)
    await _set_inspector_account_id(job_id, ctx.account.id)
    job_d = _to_dict(job) or {}
    job_d["inspectorAccountId"] = ctx.account.id
    return {"status": "ok", "job": job_d}


@router.post("/{job_id}/arrived")
async def arrived(
    job_id: str,
    ctx: IdentityContext = Depends(_inspect_required),  # noqa: B008
):
    job, err = await rsvc.transition_status(job_id, ctx.user_id, "arrived")
    if err:
        _raise_lifecycle_error(err)
    await _set_inspector_account_id(job_id, ctx.account.id)
    job_d = _to_dict(job) or {}
    job_d["inspectorAccountId"] = ctx.account.id
    return {"status": "ok", "job": job_d}


@router.post("/{job_id}/start-inspection")
async def start_inspection(
    job_id: str,
    ctx: IdentityContext = Depends(_inspect_required),  # noqa: B008
):
    job, err = await rsvc.transition_status(job_id, ctx.user_id, "inspecting")
    if err:
        _raise_lifecycle_error(err)
    await _set_inspector_account_id(job_id, ctx.account.id)
    job_d = _to_dict(job) or {}
    job_d["inspectorAccountId"] = ctx.account.id
    return {"status": "ok", "job": job_d}


@router.post("/{job_id}/cancel")
async def cancel_job(
    job_id: str,
    body: Optional[CancelJobRequest] = None,
    ctx: IdentityContext = Depends(_inspect_required),  # noqa: B008
):
    reason = (body.reason if body else None)
    job, err = await rsvc.cancel_by_inspector(job_id, ctx.user_id, reason=reason)
    if err == "job_not_found_or_not_yours":
        raise HTTPException(404, "job not found or not yours")
    if err and err.startswith("not_cancellable"):
        raise HTTPException(409, f"cannot cancel from status {err.split(':',1)[1]}")
    # Cancel releases the job — clear the account id 1:1 with how service
    # clears legacy inspectorId.
    await _set_inspector_account_id(job_id, None)
    job_d = _to_dict(job) or {}
    job_d["inspectorAccountId"] = None
    return {"status": "ok", "job": job_d}


# ── Report submission (CRITICAL — credit consumed here only) ─────────

@router.post("/{job_id}/report")
async def submit_report_endpoint(
    job_id: str,
    payload: SubmitReportRequest,
    ctx: IdentityContext = Depends(_inspect_required),  # noqa: B008
):
    """Submit inspection report. Credit is consumed ONLY on successful submission."""
    report, err = await rsvc.submit_report(job_id, ctx.user_id, payload)
    if err == "job_not_found":
        raise HTTPException(404, "job not found")
    if err == "not_your_job":
        raise HTTPException(403, "not your job")
    if err and err.startswith("job_not_in_inspecting"):
        raise HTTPException(
            409,
            f"job must be in 'inspecting' status to submit report (current: {err.split(':',1)[1]})",
        )
    if err == "report_already_submitted":
        raise HTTPException(409, "report already submitted for this job")
    if err == "race_condition_retry":
        raise HTTPException(409, "race condition — retry")
    # Backfill the new field on both job and report. Both updates are
    # idempotent and safe to rerun.
    await _set_inspector_account_id(job_id, ctx.account.id)
    db = get_db()
    report_d = _to_dict(report) or {}
    if report_d.get("id"):
        await db.inspection_reports.update_one(
            {"_id": report_d["id"]},
            {"$set": {"inspectorAccountId": ctx.account.id}},
        )
        report_d["inspectorAccountId"] = ctx.account.id
    return {"status": "ok", "report": report_d}


# ── Checklist exposure (separate router to avoid /{job_id} collision) ──
# Sprint 1D.1: checklist remains capability-gated — frontend that doesn't
# have inspect cap shouldn't even fetch checklist contents (they could leak
# scoring criteria to providers we haven't certified yet).
checklist_router = APIRouter(prefix="/api/inspector", tags=["auto_requests:inspector"])


@checklist_router.get("/checklist")
async def get_checklist(ctx: IdentityContext = Depends(_inspect_required)):  # noqa: B008
    """Single source of truth for the inspection checklist (mobile uses this)."""
    return {
        "items": CHECKLIST,
        "statuses": list(ITEM_STATUSES),
        "verdicts": list(VERDICTS),
    }


# ── Legacy: /complete (kept for backwards-compat — does NOT consume credit) ──

@router.post("/{job_id}/complete", deprecated=True)
async def complete_job_endpoint(
    job_id: str,
    ctx: IdentityContext = Depends(_inspect_required),  # noqa: B008
):
    """DEPRECATED: Sprint 4 moves credit consumption to /report.
    Marks job as done WITHOUT consuming credit.
    Use POST /api/inspector/jobs/{id}/report instead.
    """
    db = get_db()
    job = await db.inspection_jobs.find_one(
        {"_id": job_id, "inspectorId": ctx.user_id, "status": "claimed"}
    )
    if not job:
        raise HTTPException(409, "job not found, not yours, or not claimed (use lifecycle endpoints + /report)")
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    await db.inspection_jobs.update_one(
        {"_id": job_id},
        {"$set": {
            "status": "done",
            "completedAt": now,
            "inspectorAccountId": ctx.account.id,
        }},
    )
    await db.car_requests.update_one(
        {"_id": job["requestId"]},
        {"$inc": {"jobsClaimed": -1, "jobsDone": +1}, "$set": {"updatedAt": now}},
    )
    return {"status": "ok", "deprecated": True, "hint": "Use /report to consume credit"}


# ── helpers ──────────────────────────────────────────────────────────

def _raise_lifecycle_error(err: str) -> None:
    if err == "job_not_found":
        raise HTTPException(404, "job not found")
    if err == "not_your_job":
        raise HTTPException(403, "not your job")
    if err.startswith("invalid_status"):
        cur = err.split(":", 1)[1]
        raise HTTPException(409, f"invalid lifecycle transition from status '{cur}'")
    if err == "unknown_target_status":
        raise HTTPException(400, "unknown target status")
    raise HTTPException(409, err)
