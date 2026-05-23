"""Phase 3 — Soft Marketplace: Inspector exposures + Ranking v2.

Flow:
  request → fan-out jobs (per city)
  for each job → select TOP-N inspectors (score-based) → create exposures
  inspector opens app → sees only their exposures (not all jobs)
  inspector accepts → claim the job + mark other exposures expired

Scoring v2 (per-request, per-inspector):
    score = 0.4·quality + 0.2·speed + 0.2·reliability + 0.1·activity + 0.1·fairness
    anti-monopoly: if active_jobs > 5 → score *= 0.7
    decay: older completions weigh less (stored completedBookingsCount is baseline)

Exposures are stored with `inspectorId = organization._id` (org is the inspector entity).
Customers never see inspector identity — only aggregate "matching" progress.
"""
from __future__ import annotations
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from app.core.db import get_db


# ────────────────────────────────────────────────────────────────────
# constants
# ────────────────────────────────────────────────────────────────────
POOL_SIZE = 5                        # top-N inspectors per job
EXPOSURE_TTL_MINUTES = 60            # auto-expire after 60 min
FAIRNESS_DAYS = 5                    # days since last job for full fairness
ANTI_MONOPOLY_THRESHOLD = 5          # active jobs
ANTI_MONOPOLY_PENALTY = 0.7          # multiplier if above threshold


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ────────────────────────────────────────────────────────────────────
# Scoring v2
# ────────────────────────────────────────────────────────────────────
def score_inspector(org: dict, active_jobs: int, days_since_last_job: Optional[float]) -> dict:
    """Return {score, parts} in [0,1] + breakdown."""
    # quality: rating / 5
    rating = float(org.get("ratingAvg") or 0)
    quality = max(0.0, min(1.0, rating / 5.0))

    # speed: inverse of avgResponseTimeMinutes (<5min → 1, 60min → 0)
    resp = float(org.get("avgResponseTimeMinutes") or 30)
    speed = max(0.0, min(1.0, 1.0 - (resp - 5) / 55.0))

    # reliability: completed / total (if total>0)
    total_b = int(org.get("bookingsCount") or 0)
    done_b = int(org.get("completedBookingsCount") or 0)
    reliability = (done_b / total_b) if total_b > 0 else 0.6  # neutral default

    # activity: log scale of total bookings (30 → ~1.0)
    import math
    activity = max(0.0, min(1.0, math.log1p(total_b) / math.log1p(30)))

    # fairness boost: min(1, days/5)
    if days_since_last_job is None:
        fairness = 0.5  # newcomer — moderate boost
    else:
        fairness = max(0.0, min(1.0, days_since_last_job / FAIRNESS_DAYS))

    score = (
        0.40 * quality
        + 0.20 * speed
        + 0.20 * reliability
        + 0.10 * activity
        + 0.10 * fairness
    )

    # anti-monopoly: penalize heavy inspectors
    if active_jobs > ANTI_MONOPOLY_THRESHOLD:
        score *= ANTI_MONOPOLY_PENALTY

    return {
        "score": round(score, 4),
        "parts": {
            "quality": round(quality, 3),
            "speed": round(speed, 3),
            "reliability": round(reliability, 3),
            "activity": round(activity, 3),
            "fairness": round(fairness, 3),
            "antiMonopoly": 1.0 if active_jobs <= ANTI_MONOPOLY_THRESHOLD else ANTI_MONOPOLY_PENALTY,
            "activeJobs": active_jobs,
        },
    }


# ────────────────────────────────────────────────────────────────────
# Pool selection
# ────────────────────────────────────────────────────────────────────
async def select_pool_for_city(
    city_name: str,
    top_n: int = POOL_SIZE,
    exclude_inspector_ids: Optional[set] = None,
) -> List[dict]:
    """Pick top-N inspectors for a city, ordered by score desc.

    city_name can be "Berlin" (human) or "berlin" (code). We normalize by case-insensitive match.
    `exclude_inspector_ids` — inspectors to skip (e.g. already exposed in prior waves
    for the same job). Used by batching_loop.

    Scoring data source: cached fields on organizations (statsUpdatedAt / activeJobsCount /
    lastJobAt) — recomputed by exposures_cron.stats_recompute_loop every 5 min.
    Falls back to on-the-fly aggregation when cache is missing (first boot / new org).
    """
    db = get_db()
    city_norm = city_name.strip().lower()
    excluded = exclude_inspector_ids or set()

    # Candidates — active + verified organizations in that city.
    # Verified filter: if ANY org in the system is flagged `isVerified`, enforce the filter;
    # otherwise we accept all (demo seed has no verification flag yet).
    verified_count = await db.organizations.count_documents({"isVerified": True})
    base_filter: dict = {"status": "active"}
    if verified_count > 0:
        base_filter["isVerified"] = True

    candidates = await db.organizations.find(
        {
            **base_filter,
            "$or": [
                {"city": city_norm},
                {"cityCode": city_norm},
                {"cities": {"$elemMatch": {"$regex": f"^{city_norm}$", "$options": "i"}}},
            ],
        },
        {
            "_id": 1, "name": 1, "slug": 1, "city": 1, "cityCode": 1, "country": 1,
            "ratingAvg": 1, "reviewsCount": 1, "bookingsCount": 1,
            "completedBookingsCount": 1, "avgResponseTimeMinutes": 1,
            "activeJobsCount": 1, "lastJobAt": 1, "statsUpdatedAt": 1,
            "completionRate": 1, "jobsLast7d": 1,
        },
    ).to_list(200)

    if not candidates:
        # Fallback: any active organization (demo data — relax city match)
        candidates = await db.organizations.find(
            base_filter,
            {
                "_id": 1, "name": 1, "slug": 1, "city": 1, "country": 1,
                "ratingAvg": 1, "reviewsCount": 1, "bookingsCount": 1,
                "completedBookingsCount": 1, "avgResponseTimeMinutes": 1,
                "activeJobsCount": 1, "lastJobAt": 1, "statsUpdatedAt": 1,
                "completionRate": 1, "jobsLast7d": 1,
            },
        ).to_list(50)

    if not candidates:
        return []

    # Filter excluded inspector_ids (e.g. already exposed in prior waves)
    if excluded:
        candidates = [c for c in candidates if str(c["_id"]) not in excluded]
        if not candidates:
            return []

    # Prefer cached stats; fall back to one aggregation if ANY candidate lacks cache.
    missing_cache = [c for c in candidates if not c.get("statsUpdatedAt")]
    active_map: dict = {}
    last_map: dict = {}
    if missing_cache:
        ids = [c["_id"] for c in missing_cache]
        active_agg = await db.inspection_jobs.aggregate([
            {"$match": {"inspectorId": {"$in": ids}, "status": {"$in": ["claimed", "on_route", "arrived", "inspecting"]}}},
            {"$group": {"_id": "$inspectorId", "n": {"$sum": 1}}},
        ]).to_list(500)
        active_map = {row["_id"]: row["n"] for row in active_agg}
        last_agg = await db.inspection_jobs.aggregate([
            {"$match": {"inspectorId": {"$in": ids}, "status": "done"}},
            {"$group": {"_id": "$inspectorId", "last": {"$max": "$completedAt"}}},
        ]).to_list(500)
        last_map = {row["_id"]: row["last"] for row in last_agg}

    now = _now()
    scored: list[dict] = []
    for c in candidates:
        # Hybrid: cached → fallback to aggregation → 0
        if c.get("statsUpdatedAt"):
            active = int(c.get("activeJobsCount") or 0)
            last = c.get("lastJobAt")
        else:
            active = int(active_map.get(c["_id"], 0))
            last = last_map.get(c["_id"])
        days = None
        if last:
            delta = now - (last if last.tzinfo else last.replace(tzinfo=timezone.utc))
            days = delta.total_seconds() / 86400.0
        s = score_inspector(c, active, days)
        scored.append({
            "inspectorId": str(c["_id"]),
            "name": c.get("name", ""),
            "slug": c.get("slug"),
            "city": c.get("city") or c.get("cityCode") or "",
            "country": c.get("country"),
            "rating": round(float(c.get("ratingAvg") or 0), 2),
            "score": s["score"],
            "parts": s["parts"],
        })

    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:top_n]


# ────────────────────────────────────────────────────────────────────
# Exposure creation
# ────────────────────────────────────────────────────────────────────
async def create_exposures_for_job(
    request_id: str,
    job_id: str,
    city: str,
    pool_size: int = POOL_SIZE,
    exclude_inspector_ids: Optional[set] = None,
    wave_reason: str = "initial",
) -> List[dict]:
    """Build top-N pool + persist exposures. Returns exposure docs.

    `exclude_inspector_ids` — inspectors to skip (e.g. prior waves for this job).
    `wave_reason` — "initial" | "next_wave" | "manual_admin". Stored on exposure.

    Uniqueness is enforced at the DB layer by a compound index on (jobId, inspectorId).
    If insert_many hits a duplicate, we retry per-doc to salvage the rest.
    """
    db = get_db()
    pool = await select_pool_for_city(
        city, top_n=pool_size, exclude_inspector_ids=exclude_inspector_ids,
    )
    if not pool:
        return []

    now = _now()
    expires_at = now + timedelta(minutes=EXPOSURE_TTL_MINUTES)
    docs: list[dict] = []
    for rank, entry in enumerate(pool, start=1):
        docs.append({
            "_id": str(uuid.uuid4()),
            "requestId": request_id,
            "jobId": job_id,
            "city": city,
            "inspectorId": entry["inspectorId"],
            "inspectorName": entry["name"],
            "inspectorSlug": entry.get("slug"),
            "rank": rank,
            "score": entry["score"],
            "scoreParts": entry["parts"],
            "status": "visible",   # visible | accepted | rejected | expired
            "waveReason": wave_reason,
            "exposedAt": now,
            "expiresAt": expires_at,
        })
    try:
        await db.inspector_exposures.insert_many(docs, ordered=False)
    except Exception:
        # Duplicate from unique index — retry individually, skip duplicates.
        inserted: list[dict] = []
        for d in docs:
            try:
                await db.inspector_exposures.insert_one(d)
                inserted.append(d)
            except Exception:
                pass
        return inserted
    return docs


# ────────────────────────────────────────────────────────────────────
# Inspector queries
# ────────────────────────────────────────────────────────────────────
async def list_visible_exposures_for_inspector(inspector_id: str) -> List[dict]:
    """Return enriched exposures (visible only) for this inspector."""
    db = get_db()
    now = _now()
    cursor = db.inspector_exposures.find({
        "inspectorId": inspector_id,
        "status": "visible",
        "expiresAt": {"$gt": now},
    }).sort("exposedAt", -1)
    exposures = await cursor.to_list(100)

    # Enrich with request data
    req_ids = list({e["requestId"] for e in exposures})
    if not req_ids:
        return []
    reqs = await db.car_requests.find({"_id": {"$in": req_ids}}).to_list(200)
    req_map = {r["_id"]: r for r in reqs}

    out = []
    for e in exposures:
        req = req_map.get(e["requestId"], {})
        brand = req.get("brand") or ""
        model = req.get("model") or ""
        year = req.get("yearFrom") or req.get("yearTo")
        vehicle_summary = " ".join(p for p in [str(year) if year else None, brand, model] if p).strip() or None
        # Web inspector workspace contract (`InspectorExposure`) expects
        # `status` + `preview` + `createdAt` on each row. Mobile clients
        # still read the legacy flat `request`+`exposedAt` fields below.
        out.append({
            "id": e["_id"],
            "requestId": e["requestId"],
            "jobId": e["jobId"],
            "city": e["city"],
            "rank": e.get("rank"),
            "score": e.get("score"),
            "status": "open",  # backend filters to status=visible already; web treats as open offer
            "createdAt": e["exposedAt"].isoformat() if hasattr(e["exposedAt"], "isoformat") else str(e["exposedAt"]),
            "expiresAt": e["expiresAt"].isoformat() if hasattr(e["expiresAt"], "isoformat") else str(e["expiresAt"]),
            "exposedAt": e["exposedAt"].isoformat() if hasattr(e["exposedAt"], "isoformat") else str(e["exposedAt"]),
            "preview": {
                "serviceLabel": "Pre-purchase inspection",
                "cityLabel": e.get("city") or req.get("country"),
                "budgetEur": req.get("budget"),
                "vehicleSummary": vehicle_summary,
            },
            "request": {
                "type": req.get("type", "selection"),
                "brand": req.get("brand"),
                "model": req.get("model"),
                "budget": req.get("budget"),
                "country": req.get("country"),
                "urgency": req.get("urgency"),
                "links": list(req.get("links") or []),
                "comment": req.get("comment"),
                "yearFrom": req.get("yearFrom"),
                "yearTo": req.get("yearTo"),
                "fuel": req.get("fuel"),
                "transmission": req.get("transmission"),
                "mileageMax": req.get("mileageMax"),
            },
            "priceEstimate": 149 if req.get("type") == "inspection" else 149,
        })
    return out


async def accept_exposure(exposure_id: str, inspector_id: str) -> Optional[dict]:
    """Inspector accepts exposure → claim the job atomically + expire siblings.

    Returns enriched exposure dict (with jobId) on success, None otherwise.
    """
    db = get_db()
    now = _now()
    # 1. Atomic update: visible → accepted (only the caller's exposure)
    exp = await db.inspector_exposures.find_one_and_update(
        {"_id": exposure_id, "inspectorId": inspector_id, "status": "visible", "expiresAt": {"$gt": now}},
        {"$set": {"status": "accepted", "acceptedAt": now}},
        return_document=True,
    )
    if not exp:
        return None

    # 2. Claim the job atomically (only if still open)
    job = await db.inspection_jobs.find_one_and_update(
        {"_id": exp["jobId"], "status": "open"},
        {"$set": {"status": "claimed", "inspectorId": inspector_id, "claimedAt": now}},
        return_document=True,
    )
    if not job:
        # Someone else claimed the job via another exposure — rollback our acceptance
        await db.inspector_exposures.update_one(
            {"_id": exposure_id},
            {"$set": {"status": "visible"}, "$unset": {"acceptedAt": ""}},
        )
        return None

    # 3. Expire all sibling exposures for this job (other inspectors)
    await db.inspector_exposures.update_many(
        {"jobId": exp["jobId"], "_id": {"$ne": exposure_id}, "status": "visible"},
        {"$set": {"status": "expired", "expiredAt": now, "expiredReason": "job_claimed_by_other"}},
    )

    # 4. Bump parent request counters (mirror svc.claim_job behavior)
    await db.car_requests.update_one(
        {"_id": exp["requestId"]},
        {
            "$inc": {"jobsClaimed": 1},
            "$set": {"status": "in_progress", "updatedAt": now},
        },
    )

    # Phase D Pass 1B — assignment continuity wiring (Step 8A).
    # Marketplace-driven claim path. Same continuity transition as
    # the legacy claim_job/admin_assign_job paths; dedup on (job_id)
    # ensures one ledger event per job across all three.
    try:
        from app.runtime_ledger import emit, EventType
        await emit(
            EventType.ASSIGNMENT_CONTINUITY_CLAIMED,
            subject_id=exp["jobId"],
            payload={"inspectorId": inspector_id},
            emitted_by=inspector_id,
        )
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning(
            f"runtime_ledger emit (accept_exposure) failed for job {exp['jobId']}: {exc}"
        )

    return {
        "id": exp["_id"],
        "jobId": exp["jobId"],
        "requestId": exp["requestId"],
        "status": "accepted",
        "city": exp["city"],
    }


async def reject_exposure(exposure_id: str, inspector_id: str) -> bool:
    db = get_db()
    res = await db.inspector_exposures.update_one(
        {"_id": exposure_id, "inspectorId": inspector_id, "status": "visible"},
        {"$set": {"status": "rejected", "rejectedAt": _now()}},
    )
    return res.modified_count > 0


# ────────────────────────────────────────────────────────────────────
# Customer-facing matching stats
# ────────────────────────────────────────────────────────────────────
async def matching_status_for_request(request_id: str) -> dict:
    """Aggregate exposure + job state for customer-visible progress."""
    db = get_db()
    agg = await db.inspector_exposures.aggregate([
        {"$match": {"requestId": request_id}},
        {"$group": {"_id": "$status", "n": {"$sum": 1}}},
    ]).to_list(10)
    counts = {row["_id"]: row["n"] for row in agg}

    jobs_agg = await db.inspection_jobs.aggregate([
        {"$match": {"requestId": request_id}},
        {"$group": {"_id": "$status", "n": {"$sum": 1}}},
    ]).to_list(20)
    job_counts = {row["_id"]: row["n"] for row in jobs_agg}

    exposed = counts.get("visible", 0) + counts.get("accepted", 0) + counts.get("rejected", 0) + counts.get("expired", 0)
    accepted = counts.get("accepted", 0)
    rejected = counts.get("rejected", 0)
    expired = counts.get("expired", 0)
    visible = counts.get("visible", 0)

    total_jobs = sum(job_counts.values())
    in_progress = job_counts.get("claimed", 0) + job_counts.get("on_route", 0) + job_counts.get("arrived", 0) + job_counts.get("inspecting", 0)
    done = job_counts.get("done", 0)

    # Build customer-friendly label
    if done > 0:
        label = "Отчёт готов" if done >= total_jobs else "В работе"
    elif in_progress > 0:
        label = "Инспектор в работе"
    elif visible > 0:
        label = f"Ищем инспекторов · {visible} получили задание"
    elif rejected + expired > 0 and accepted == 0:
        label = "Расширяем поиск"
    else:
        label = "Распределяем"

    return {
        "requestId": request_id,
        "label": label,
        "exposures": {
            "total": exposed,
            "visible": visible,
            "accepted": accepted,
            "rejected": rejected,
            "expired": expired,
        },
        "jobs": {
            "total": total_jobs,
            "inProgress": in_progress,
            "done": done,
        },
    }
