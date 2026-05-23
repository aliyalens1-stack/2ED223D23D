"""Intelligence router — POST /api/inspector/jobs/{id}/draft (Sprint 2 Step 4)."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException

from app.auto_requests.auth import get_user_id_required
from app.core.db import get_db
from app.intelligence.draft import synthesize_report

router = APIRouter(prefix="/api/inspector/jobs", tags=["intelligence:draft"])


def _is_owner(job: Dict[str, Any], uid: str) -> bool:
    if not job:
        return False
    if str(job.get("inspectorAccountId") or "") == str(uid):
        return True
    if str(job.get("inspectorId") or "") == str(uid):
        return True
    return False


@router.post("/{job_id}/draft")
async def generate_draft(
    job_id: str,
    body: Dict[str, Any] = Body(default_factory=dict),
    uid: str = Depends(get_user_id_required),
) -> Dict[str, Any]:
    """Generate an AI-assisted inspection draft for the inspector.

    Body:
      {
        "runtimeState": {...},     # checklist items, summary hint, etc.
        "media":        [...],     # optional override; otherwise we pull
                                   #   inspection_media+inspection_job_media
        "vehicle":      {...}      # optional override
      }
    """
    db = get_db()
    job = await db.inspection_jobs.find_one({"_id": job_id})
    if not job:
        raise HTTPException(404, "job not found")
    if not _is_owner(job, uid):
        raise HTTPException(403, "not your job")

    runtime_state = body.get("runtimeState") or {}
    media: List[Dict[str, Any]] = body.get("media") or []
    vehicle: Dict[str, Any] = body.get("vehicle") or {}

    # Auto-fetch media if not provided
    if not media:
        try:
            cur = db.inspection_media.find(
                {"jobId": job_id, "status": "uploaded"},
                {"_id": 0, "dataBase64": 0},
            )
            async for m in cur:
                media.append(m)
            cur2 = db.inspection_job_media.find(
                {"jobId": job_id}, {"dataBase64": 0}
            )
            async for m in cur2:
                m.pop("_id", None)
                media.append(m)
        except Exception:
            pass

    if not vehicle:
        vehicle = {
            "brand": job.get("brand"),
            "model": job.get("model"),
            "year": job.get("year"),
            "vin": job.get("vin"),
        }

    draft = await synthesize_report(
        job=job,
        runtime_state=runtime_state,
        media=media,
        vehicle=vehicle,
        inspector_id=uid,
    )
    return {"status": "ok", "draft": draft}


@router.get("/{job_id}/drafts")
async def list_drafts(
    job_id: str,
    uid: str = Depends(get_user_id_required),
    limit: int = 5,
) -> Dict[str, Any]:
    db = get_db()
    job = await db.inspection_jobs.find_one({"_id": job_id})
    if not job:
        raise HTTPException(404, "job not found")
    if not _is_owner(job, uid):
        raise HTTPException(403, "not your job")
    out: List[Dict[str, Any]] = []
    cursor = (
        db.inspection_drafts
        .find({"jobId": job_id, "inspectorId": uid}, {"_id": 0})
        .sort("generatedAt", -1)
        .limit(max(1, min(20, int(limit))))
    )
    async for d in cursor:
        out.append(d)
    return {"drafts": out, "count": len(out)}


__all__ = ["router"]
