"""Job lifecycle + inspection report service (Sprint 4)."""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from app.core.db import get_db
from app.reports.schemas import SubmitReport, ReportOut, ChecklistItem, Issue
from app.packages import service as credits_svc


# ──────────────────────────────────────────────────────────────────────
# helpers
# ──────────────────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(v) -> str:
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v) if v is not None else ""


# Valid job status transitions (inspector-driven unless noted)
ALLOWED_TRANSITIONS = {
    "claimed": {"on_route", "canceled"},
    "on_route": {"arrived", "canceled"},
    "arrived": {"inspecting", "canceled"},
    "inspecting": {"report_upload", "canceled"},
    "report_upload": {"done"},  # done is set by report submit
}


async def _assert_job_owned(job_id: str, inspector_id: str):
    db = get_db()
    job = await db.inspection_jobs.find_one({"_id": job_id})
    if not job:
        return None, "job not found"
    if job.get("inspectorId") != inspector_id:
        return None, "not your job"
    return job, None


async def _transition(job_id: str, inspector_id: str, to_status: str, timestamp_field: str = None):
    """Move job to new status if current status allows it. Returns updated job or error."""
    db = get_db()
    job, err = await _assert_job_owned(job_id, inspector_id)
    if err:
        return None, err
    current = job.get("status", "open")
    allowed = ALLOWED_TRANSITIONS.get(current, set())
    if to_status not in allowed:
        return None, f"cannot move {current} → {to_status}"
    now = _now()
    update = {"status": to_status, "updatedAt": now}
    if timestamp_field:
        update[timestamp_field] = now
    await db.inspection_jobs.update_one({"_id": job_id}, {"$set": update})
    job.update(update)
    return job, None


# ──────────────────────────────────────────────────────────────────────
# lifecycle transitions
# ──────────────────────────────────────────────────────────────────────

async def on_route(job_id: str, inspector_id: str):
    return await _transition(job_id, inspector_id, "on_route", "onRouteAt")


async def arrived(job_id: str, inspector_id: str):
    return await _transition(job_id, inspector_id, "arrived", "arrivedAt")


async def start_inspection(job_id: str, inspector_id: str):
    return await _transition(job_id, inspector_id, "inspecting", "startedAt")


async def cancel_job(job_id: str, inspector_id: str):
    """Inspector cancels before inspecting → release job back to open (no credit change)."""
    db = get_db()
    job, err = await _assert_job_owned(job_id, inspector_id)
    if err:
        return None, err
    current = job.get("status", "open")
    if current not in {"claimed", "on_route", "arrived", "inspecting"}:
        return None, f"cannot cancel from status {current}"
    now = _now()
    # Re-open the job
    await db.inspection_jobs.update_one(
        {"_id": job_id},
        {
            "$set": {"status": "open", "updatedAt": now, "canceledAt": now},
            "$unset": {"inspectorId": "", "onRouteAt": "", "arrivedAt": "", "startedAt": ""},
        },
    )
    # Decrement parent request counter
    await db.car_requests.update_one(
        {"_id": job["requestId"]},
        {"$inc": {"jobsClaimed": -1}, "$set": {"updatedAt": now}},
    )
    job["status"] = "open"
    return job, None


# ──────────────────────────────────────────────────────────────────────
# report submit
# ──────────────────────────────────────────────────────────────────────

async def submit_report(job_id: str, inspector_id: str, data: SubmitReport):
    """Transition job to report_upload → done and persist the report.
    Credit is consumed only here (not earlier).
    """
    db = get_db()
    job, err = await _assert_job_owned(job_id, inspector_id)
    if err:
        return None, err
    current = job.get("status", "open")
    # Allow submit from inspecting (typical) or direct from arrived (if inspector skips start)
    if current not in {"inspecting", "arrived"}:
        return None, f"cannot submit report from status {current}"
    # Validate estimate range
    if data.repairEstimateMin is not None and data.repairEstimateMax is not None:
        if data.repairEstimateMin > data.repairEstimateMax:
            return None, "repairEstimateMin > repairEstimateMax"

    now = _now()
    report_id = str(uuid.uuid4())
    report_doc = {
        "_id": report_id,
        "jobId": job_id,
        "requestId": job["requestId"],
        "inspectorId": inspector_id,
        "city": job.get("city", ""),
        "score": float(data.score),
        "verdict": data.verdict,
        "riskLevel": data.riskLevel,
        "checklist": [item.model_dump() for item in data.checklist],
        "issues": [iss.model_dump() for iss in data.issues],
        "photos": data.photos,
        "videos": data.videos,
        "summary": data.summary,
        "repairEstimateMin": data.repairEstimateMin,
        "repairEstimateMax": data.repairEstimateMax,
        "status": "submitted",
        "createdAt": now,
        "approvedAt": None,
        "rejectedAt": None,
        "rejectReason": None,
    }
    await db.inspection_reports.insert_one(report_doc)

    # Transition job to done & attach reportId
    await db.inspection_jobs.update_one(
        {"_id": job_id},
        {"$set": {
            "status": "done",
            "reportId": report_id,
            "completedAt": now,
            "updatedAt": now,
        }},
    )
    # Bump parent request counters
    await db.car_requests.update_one(
        {"_id": job["requestId"]},
        {"$inc": {"jobsClaimed": -1, "jobsDone": +1}, "$set": {"updatedAt": now}},
    )
    # Consume credit now (and only now)
    req = await db.car_requests.find_one({"_id": job["requestId"]})
    if req and req.get("userId"):
        await credits_svc.consume_credit(req["userId"], job_id=job_id, request_id=req["_id"])
    # If last job — mark request completed
    fresh = await db.car_requests.find_one({"_id": job["requestId"]})
    if fresh and fresh.get("jobsDone", 0) >= fresh.get("jobsTotal", 0):
        await db.car_requests.update_one({"_id": fresh["_id"]}, {"$set": {"status": "completed", "updatedAt": now}})

    return report_doc, None


# ──────────────────────────────────────────────────────────────────────
# read / admin
# ──────────────────────────────────────────────────────────────────────

def _to_out(doc: dict) -> ReportOut:
    return ReportOut(
        id=str(doc["_id"]),
        jobId=str(doc.get("jobId", "")),
        requestId=str(doc.get("requestId", "")),
        inspectorId=str(doc.get("inspectorId", "")),
        city=doc.get("city", ""),
        score=float(doc.get("score", 0)),
        verdict=doc.get("verdict", ""),
        riskLevel=doc.get("riskLevel", "low"),
        checklist=[ChecklistItem(**c) for c in doc.get("checklist", [])],
        issues=[Issue(**i) for i in doc.get("issues", [])],
        photos=doc.get("photos", []) or [],
        videos=doc.get("videos", []) or [],
        summary=doc.get("summary", ""),
        repairEstimateMin=doc.get("repairEstimateMin"),
        repairEstimateMax=doc.get("repairEstimateMax"),
        status=doc.get("status", "submitted"),
        createdAt=_iso(doc.get("createdAt")),
        approvedAt=_iso(doc.get("approvedAt")) if doc.get("approvedAt") else None,
        rejectedAt=_iso(doc.get("rejectedAt")) if doc.get("rejectedAt") else None,
        rejectReason=doc.get("rejectReason"),
    )


async def get_report(report_id: str) -> Optional[ReportOut]:
    db = get_db()
    doc = await db.inspection_reports.find_one({"_id": report_id})
    return _to_out(doc) if doc else None


async def list_reports_for_request(request_id: str) -> List[ReportOut]:
    db = get_db()
    cursor = db.inspection_reports.find({"requestId": request_id}).sort("createdAt", 1)
    return [_to_out(d) for d in await cursor.to_list(50)]


async def list_reports_for_user(user_id: str) -> List[ReportOut]:
    db = get_db()
    reqs = await db.car_requests.find({"userId": user_id}, {"_id": 1}).to_list(500)
    req_ids = [r["_id"] for r in reqs]
    if not req_ids:
        return []
    cursor = db.inspection_reports.find({"requestId": {"$in": req_ids}}).sort("createdAt", -1)
    return [_to_out(d) for d in await cursor.to_list(500)]


async def list_all_reports(status: Optional[str] = None) -> List[ReportOut]:
    db = get_db()
    q: dict = {}
    if status:
        q["status"] = status
    cursor = db.inspection_reports.find(q).sort("createdAt", -1)
    return [_to_out(d) for d in await cursor.to_list(500)]


async def approve_report(report_id: str):
    db = get_db()
    res = await db.inspection_reports.find_one_and_update(
        {"_id": report_id, "status": "submitted"},
        {"$set": {"status": "approved", "approvedAt": _now()}},
        return_document=True,
    )
    return _to_out(res) if res else None


async def reject_report(report_id: str, reason: str):
    db = get_db()
    res = await db.inspection_reports.find_one_and_update(
        {"_id": report_id, "status": "submitted"},
        {"$set": {"status": "rejected", "rejectedAt": _now(), "rejectReason": reason}},
        return_document=True,
    )
    return _to_out(res) if res else None
