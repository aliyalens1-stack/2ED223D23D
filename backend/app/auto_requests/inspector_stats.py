"""Phase 3 — Hybrid scoring data: cached inspector stats.

Instead of aggregating `inspection_jobs` on every exposure selection
(select_pool_for_city), we persist the inputs on `organizations` docs:

  qualityScore          ← ratingAvg / 5
  avgResponseTimeMinutes (already exists)
  completionRate        ← completed_bookings / total_bookings
  jobsLast7d            ← count(status=done, completedAt within 7d)
  activeJobsCount       ← count(status in claimed/on_route/arrived/inspecting)
  lastJobAt             ← max(completedAt)
  statsUpdatedAt        ← when we last recomputed

Recompute runs every 5 minutes via exposures_cron.stats_recompute_loop.
marketplace.select_pool_for_city prefers these cached fields, falling back to
real-time aggregates if they're missing (first boot / new org).
"""
from __future__ import annotations
import logging
from datetime import datetime, timedelta, timezone

from app.core.db import get_db

logger = logging.getLogger("server")


def _now() -> datetime:
    return datetime.now(timezone.utc)


ACTIVE_JOB_STATUSES = ["claimed", "on_route", "arrived", "inspecting"]


async def recompute_inspector_stats() -> int:
    """Recompute cached stats for every active inspector organization.

    Returns the number of organizations updated.
    """
    db = get_db()
    now = _now()
    seven_days_ago = now - timedelta(days=7)

    orgs = await db.organizations.find(
        {"status": "active"},
        {"_id": 1},
    ).to_list(2000)
    if not orgs:
        return 0

    ids = [o["_id"] for o in orgs]

    # Bulk: active jobs per inspector
    active_rows = await db.inspection_jobs.aggregate([
        {"$match": {"inspectorId": {"$in": ids}, "status": {"$in": ACTIVE_JOB_STATUSES}}},
        {"$group": {"_id": "$inspectorId", "n": {"$sum": 1}}},
    ]).to_list(5000)
    active_map = {r["_id"]: r["n"] for r in active_rows}

    # Bulk: last completed job + last 7 days done count
    done_rows = await db.inspection_jobs.aggregate([
        {"$match": {"inspectorId": {"$in": ids}, "status": "done"}},
        {"$group": {
            "_id": "$inspectorId",
            "last": {"$max": "$completedAt"},
            "total_done": {"$sum": 1},
            "last7d": {"$sum": {"$cond": [{"$gte": ["$completedAt", seven_days_ago]}, 1, 0]}},
        }},
    ]).to_list(5000)
    done_map = {r["_id"]: r for r in done_rows}

    # Bulk: total claimed (ever) per inspector — for completion-rate calc
    claimed_rows = await db.inspection_jobs.aggregate([
        {"$match": {"inspectorId": {"$in": ids}, "status": {"$ne": "open"}}},
        {"$group": {"_id": "$inspectorId", "total": {"$sum": 1}}},
    ]).to_list(5000)
    claimed_map = {r["_id"]: r["total"] for r in claimed_rows}

    updated = 0
    for oid in ids:
        done = done_map.get(oid, {})
        total = claimed_map.get(oid, 0)
        done_total = int(done.get("total_done", 0))
        last_at = done.get("last")
        completion_rate = (done_total / total) if total > 0 else None

        patch = {
            "activeJobsCount": int(active_map.get(oid, 0)),
            "jobsLast7d": int(done.get("last7d", 0)),
            "lastJobAt": last_at,
            "statsUpdatedAt": now,
        }
        if completion_rate is not None:
            patch["completionRate"] = round(completion_rate, 3)
        await db.organizations.update_one({"_id": oid}, {"$set": patch})
        updated += 1

    logger.info(f"[exposures] stats recomputed for {updated} inspectors")
    return updated


async def ensure_stats_for_inspector(inspector_id: str) -> None:
    """Lightweight on-demand recompute for a single inspector — used by scoring
    fallback when cached fields are missing."""
    db = get_db()
    now = _now()
    seven_days_ago = now - timedelta(days=7)

    active = await db.inspection_jobs.count_documents(
        {"inspectorId": inspector_id, "status": {"$in": ACTIVE_JOB_STATUSES}}
    )
    done_last = await db.inspection_jobs.aggregate([
        {"$match": {"inspectorId": inspector_id, "status": "done"}},
        {"$group": {
            "_id": None,
            "last": {"$max": "$completedAt"},
            "last7d": {"$sum": {"$cond": [{"$gte": ["$completedAt", seven_days_ago]}, 1, 0]}},
            "total_done": {"$sum": 1},
        }},
    ]).to_list(1)
    row = done_last[0] if done_last else {}
    total_claimed = await db.inspection_jobs.count_documents(
        {"inspectorId": inspector_id, "status": {"$ne": "open"}}
    )
    patch = {
        "activeJobsCount": int(active),
        "jobsLast7d": int(row.get("last7d", 0)),
        "lastJobAt": row.get("last"),
        "statsUpdatedAt": now,
    }
    if total_claimed > 0:
        patch["completionRate"] = round(int(row.get("total_done", 0)) / total_claimed, 3)
    await db.organizations.update_one({"_id": inspector_id}, {"$set": patch})
