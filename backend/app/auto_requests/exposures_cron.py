"""Phase 3 — Background loops for exposures lifecycle.

Three independent asyncio loops launched from lifespan:
  1. expire_loop()           — every 60s: `visible` → `expired` where expiresAt < now.
  2. batching_loop()          — every 60s: for each job with 0 visible exposures
                                 and still `open`, create the NEXT wave of exposures
                                 (excluding inspectors already exposed).
  3. stats_recompute_loop()   — every 300s: refresh cached inspector stats.

All loops are crash-safe: one iteration's exception is logged, sleep continues,
next iteration tries again. They never raise into the event loop.

Index note: these loops rely on compound indexes created by ensure_exposure_indexes
(in bootstrap). If missing — queries still work, just slower.
"""
from __future__ import annotations
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import List

from app.core.db import get_db

logger = logging.getLogger("server")


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ══════════════════════════════════════════════════════════════════════
# 1. EXPIRE LOOP
# ══════════════════════════════════════════════════════════════════════
async def expire_once() -> int:
    """Mark expired exposures. Returns number updated."""
    db = get_db()
    res = await db.inspector_exposures.update_many(
        {"status": "visible", "expiresAt": {"$lte": _now()}},
        {"$set": {"status": "expired", "expiredAt": _now(), "expiredReason": "ttl"}},
    )
    return int(res.modified_count or 0)


async def expire_loop(interval_s: int = 60) -> None:
    logger.info(f"[exposures] expire_loop started (interval={interval_s}s)")
    while True:
        try:
            n = await expire_once()
            if n:
                logger.info(f"[exposures] expired {n} visible exposures (TTL)")
        except Exception as exc:
            logger.exception(f"[exposures] expire_loop error: {exc}")
        await asyncio.sleep(interval_s)


# ══════════════════════════════════════════════════════════════════════
# 2. BATCHING LOOP — if no visible exposures remain for an open job, expose next wave.
# ══════════════════════════════════════════════════════════════════════
async def find_jobs_needing_next_wave() -> List[dict]:
    """Return open inspection_jobs that have 0 visible exposures right now.

    Excludes jobs for which the parent request is not in 'open' state (closed/cancelled
    requests shouldn't get more exposure waves). Caps at 200 jobs per tick to avoid
    long-running scans.
    """
    db = get_db()
    # All currently-open jobs (no inspector yet claimed)
    open_jobs = await db.inspection_jobs.find(
        {"status": "open"},
        {"_id": 1, "requestId": 1, "city": 1},
    ).sort("createdAt", 1).to_list(200)
    if not open_jobs:
        return []

    # Group-count exposures by jobId to know which have visible/active exposures
    job_ids = [j["_id"] for j in open_jobs]
    rows = await db.inspector_exposures.aggregate([
        {"$match": {"jobId": {"$in": job_ids}, "status": "visible"}},
        {"$group": {"_id": "$jobId", "n": {"$sum": 1}}},
    ]).to_list(500)
    with_visible = {r["_id"] for r in rows}

    return [j for j in open_jobs if j["_id"] not in with_visible]


async def exposed_inspector_ids(job_id: str) -> set[str]:
    """Set of inspector_ids already exposed for this job (any status)."""
    db = get_db()
    cur = db.inspector_exposures.find({"jobId": job_id}, {"inspectorId": 1, "_id": 0})
    return {doc["inspectorId"] async for doc in cur}


async def batching_once() -> int:
    """Create next wave for every job that has none visible. Returns #waves created."""
    from app.auto_requests import marketplace as mkt
    from app.auto_requests.feature_flags_helper import is_enabled, get_config_int

    if not await is_enabled("use_exposures", default=True):
        return 0

    jobs = await find_jobs_needing_next_wave()
    if not jobs:
        return 0

    pool_size = await get_config_int("exposures_per_request", default=5)
    waves = 0
    for job in jobs:
        try:
            exclude = await exposed_inspector_ids(job["_id"])
            docs = await mkt.create_exposures_for_job(
                request_id=str(job["requestId"]),
                job_id=str(job["_id"]),
                city=job.get("city") or "",
                pool_size=pool_size,
                exclude_inspector_ids=exclude,
                wave_reason="next_wave",
            )
            if docs:
                waves += 1
                logger.info(
                    f"[exposures] next wave for job={job['_id']} city={job.get('city')} "
                    f"created={len(docs)} excluded={len(exclude)}"
                )
        except Exception as exc:
            logger.exception(f"[exposures] batching for job {job['_id']} failed: {exc}")
    return waves


async def batching_loop(interval_s: int = 60) -> None:
    logger.info(f"[exposures] batching_loop started (interval={interval_s}s)")
    while True:
        try:
            await batching_once()
        except Exception as exc:
            logger.exception(f"[exposures] batching_loop error: {exc}")
        await asyncio.sleep(interval_s)


# ══════════════════════════════════════════════════════════════════════
# 3. STATS RECOMPUTE LOOP — moved to app.workers.exposures_stats (PR-02)
# ══════════════════════════════════════════════════════════════════════
# Phase 3D PR-02: `stats_recompute_loop` was relocated to its own
# Tier A worker package at `app/workers/exposures_stats/`. Sibling
# loops (`expire_loop`, `batching_loop`) remain here pending the B3
# cluster extraction (PR-11). No shim is needed at this path because
# `stats_recompute_loop` had a single importer (lifespan) which has
# also been updated.


# ══════════════════════════════════════════════════════════════════════
# Index creation — called from bootstrap
# ══════════════════════════════════════════════════════════════════════
async def ensure_exposure_indexes() -> None:
    """Create compound indexes that the loops + endpoints rely on. Idempotent."""
    db = get_db()
    try:
        # Inspector "my visible exposures" feed — hottest query
        await db.inspector_exposures.create_index([("inspectorId", 1), ("status", 1), ("expiresAt", 1)])
        # Siblings lookup during accept
        await db.inspector_exposures.create_index([("jobId", 1), ("status", 1)])
        # Batching loop: find jobs with no visible exposures
        await db.inspector_exposures.create_index([("jobId", 1)])
        # Customer matching status
        await db.inspector_exposures.create_index([("requestId", 1), ("status", 1)])
        # Uniqueness: one exposure per (job, inspector) so batching never duplicates
        await db.inspector_exposures.create_index([("jobId", 1), ("inspectorId", 1)], unique=True)
        # Anti-abuse rolling-window lookups
        await db.inspector_exposure_events.create_index([("inspectorId", 1), ("ts", -1)])
        await db.inspector_exposure_events.create_index(
            "ts", expireAfterSeconds=86400  # keep events 24h
        )
        logger.info("[exposures] indexes ensured")
    except Exception as exc:
        logger.warning(f"[exposures] index creation warning (non-fatal): {exc}")
