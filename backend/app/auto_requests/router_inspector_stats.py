"""Inspector personal stats — earnings, completed, rating, active jobs.

Reads the cached fields written by:
  • inspector_stats.recompute_inspector_stats (every 5 min)
  • reports.submit_report (live recompute of ratingAvg + completedJobs)
"""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends

from app.auto_requests.auth import get_user_id_required
from app.core.db import get_db


router = APIRouter(prefix="/api/inspector", tags=["inspector:stats"])


@router.get("/stats")
async def my_stats(uid: str = Depends(get_user_id_required)):
    """Personal dashboard stats for the inspector home screen."""
    db = get_db()
    # inspector_id is stored as the user's hex string in inspection_jobs.
    # Rating may be cached in either organizations (org-owners) OR users (individual providers).
    org = await db.organizations.find_one({"_id": uid}) or {}
    user_doc = {}
    if not org.get("ratingAvg"):
        try:
            from bson import ObjectId
            user_oid = ObjectId(uid) if len(uid) == 24 else uid
        except Exception:
            user_oid = uid
        user_doc = await db.users.find_one({"_id": user_oid}) or {}

    # Earnings this month — sum of report fees from inspector_jobs.completedAt
    # in current month. We approximate fee per job via request-level price.
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    rows = await db.inspection_jobs.aggregate([
        {"$match": {
            "inspectorId": uid,
            "status": "done",
            "completedAt": {"$gte": month_start},
        }},
        {"$lookup": {
            "from": "car_requests",
            "localField": "requestId",
            "foreignField": "_id",
            "as": "req",
        }},
        {"$unwind": {"path": "$req", "preserveNullAndEmptyArrays": True}},
        {"$group": {
            "_id": None,
            "earnings": {"$sum": {"$ifNull": ["$req.price", 0]}},
            "n": {"$sum": 1},
        }},
    ]).to_list(1)
    earnings_month = int(rows[0]["earnings"]) if rows else 0
    completed_month = int(rows[0]["n"]) if rows else 0

    # Active jobs (claimed/on_route/arrived/inspecting)
    active = await db.inspection_jobs.count_documents({
        "inspectorId": uid,
        "status": {"$in": ["claimed", "on_route", "arrived", "inspecting"]},
    })

    # Available jobs near inspector — open in their city
    available = await db.inspection_jobs.count_documents({
        "inspectorId": None,
        "status": "open",
        "city": org.get("city"),
    }) if org.get("city") else 0

    # Pick whichever doc has the rating data (org takes priority)
    src = org if org.get("ratingAvg") is not None or org.get("reviewsCount") else user_doc

    return {
        "earningsMonth": earnings_month,
        "earningsMonthCurrency": "EUR",
        "completedMonth": completed_month,
        "completed": int(src.get("completedJobs") or src.get("reviewsCount") or 0),
        "rating": float(src.get("ratingAvg") or 0),
        "reviewsCount": int(src.get("reviewsCount") or 0),
        "activeJobs": int(active),
        "availableJobs": int(available),
        "city": org.get("city") or user_doc.get("city"),
    }


__all__ = ["router"]
