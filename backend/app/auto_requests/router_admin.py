"""Admin API: list all requests, view jobs, manual assign."""
from __future__ import annotations
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query

from app.auto_requests import service as svc
from app.auto_requests.schemas import AssignJob, RejectReportRequest
from app.core.security import verify_admin_token

router = APIRouter(prefix="/api/admin", tags=["auto_requests:admin"])


@router.get("/requests")
async def list_requests(
    status: Optional[str] = Query(default=None),
    city: Optional[str] = Query(default=None),
    _=Depends(verify_admin_token),
):
    items = await svc.list_all_requests(status=status, city=city)
    return {"items": items, "count": len(items)}


@router.get("/requests/stats")
async def requests_stats(_=Depends(verify_admin_token)):
    return await svc.stats()


@router.get("/requests/{request_id}")
async def get_request_detail(request_id: str, _=Depends(verify_admin_token)):
    doc = await svc.get_request(request_id)
    if not doc:
        raise HTTPException(404, "not found")
    jobs = await svc.get_jobs_for_request(request_id)
    return {"request": doc, "jobs": jobs}


@router.post("/requests/assign")
async def assign_job(data: AssignJob, _=Depends(verify_admin_token)):
    res = await svc.admin_assign_job(data.jobId, data.inspectorId)
    if not res:
        raise HTTPException(409, "job not found or already completed")
    return {"status": "ok", "job": res}


# ─────────────────────────────────────────────────────────────────────
# Sprint 4 — Admin moderation of inspection reports
# ─────────────────────────────────────────────────────────────────────

@router.get("/reports")
async def admin_list_reports(
    status: Optional[str] = Query(default=None, description="submitted|approved|rejected"),
    city: Optional[str] = Query(default=None),
    inspectorId: Optional[str] = Query(default=None),
    limit: int = Query(default=200, ge=1, le=500),
    _=Depends(verify_admin_token),
):
    from app.auto_requests import reports as rsvc
    items = await rsvc.list_all_reports(
        status=status, city=city, inspector_id=inspectorId, limit=limit
    )
    return {"items": items, "count": len(items)}


@router.get("/reports/{report_id}")
async def admin_report_detail(report_id: str, _=Depends(verify_admin_token)):
    from app.auto_requests import reports as rsvc
    rep = await rsvc.get_report(report_id)
    if not rep:
        raise HTTPException(404, "report not found")
    return {"report": rep}


@router.post("/reports/{report_id}/approve")
async def admin_approve_report(report_id: str, _=Depends(verify_admin_token)):
    from app.auto_requests import reports as rsvc
    rep = await rsvc.admin_set_report_status(report_id, "approved")
    if not rep:
        raise HTTPException(404, "report not found")
    return {"status": "ok", "report": rep}


@router.post("/reports/{report_id}/reject")
async def admin_reject_report(
    report_id: str,
    body: "RejectReportRequest",
    _=Depends(verify_admin_token),
):
    from app.auto_requests import reports as rsvc
    rep = await rsvc.admin_set_report_status(report_id, "rejected", reason=body.reason)
    if not rep:
        raise HTTPException(404, "report not found")
    return {"status": "ok", "report": rep}
