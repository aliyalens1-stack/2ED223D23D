"""Business logic for Auto Requests:
1 car_request  →  N inspection_jobs (по городам).
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from app.core.db import get_db
from app.auto_requests.schemas import (
    CreateCarRequest,
    CarRequestOut,
    InspectionJobOut,
)


# ──────────────────────────────────────────────────────────────────────
# helpers
# ──────────────────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(v) -> str:
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v) if v is not None else ""


def _to_request_out(doc: dict) -> CarRequestOut:
    return CarRequestOut(
        id=str(doc["_id"]),
        userId=doc.get("userId"),
        vehicleId=doc.get("vehicleId"),  # P4.1 — explicit linkage; None for legacy docs.
        type=doc.get("type", "selection"),
        brand=doc.get("brand", "") or "",
        model=doc.get("model", "") or "",
        budget=int(doc.get("budget", 0) or 0),
        links=list(doc.get("links", []) or []),
        cities=list(doc.get("cities", []) or []),
        country=doc.get("country"),
        urgency=doc.get("urgency"),
        yearFrom=doc.get("yearFrom"),
        yearTo=doc.get("yearTo"),
        fuel=doc.get("fuel"),
        transmission=doc.get("transmission"),
        mileageMax=doc.get("mileageMax"),
        comment=doc.get("comment"),
        uncertainty=doc.get("uncertainty"),
        schedulingWindow=doc.get("schedulingWindow"),
        status=doc.get("status", "open"),
        jobsTotal=int(doc.get("jobsTotal", 0)),
        jobsClaimed=int(doc.get("jobsClaimed", 0)),
        jobsDone=int(doc.get("jobsDone", 0)),
        createdAt=_iso(doc.get("createdAt")),
        updatedAt=_iso(doc.get("updatedAt")),
    )


def _to_job_out(doc: dict) -> InspectionJobOut:
    return InspectionJobOut(
        id=str(doc["_id"]),
        requestId=str(doc.get("requestId", "")),
        city=doc.get("city", ""),
        inspectorId=doc.get("inspectorId"),
        status=doc.get("status", "open"),
        brand=doc.get("brand", ""),
        model=doc.get("model", ""),
        budget=int(doc.get("budget", 0)),
        createdAt=_iso(doc.get("createdAt")),
    )


# ──────────────────────────────────────────────────────────────────────
# create_request → fan-out jobs
# ──────────────────────────────────────────────────────────────────────

async def create_request(
    data: CreateCarRequest,
    user_id: Optional[str] = None,
    pre_paid_session_id: Optional[str] = None,
) -> CarRequestOut:
    """Create a car request and fan-out into N jobs (one per city).

    Phase 3.0b P0-1: when `pre_paid_session_id` is set, the request is treated
    as already paid — credits/packages flow is bypassed. The session_id is stored
    on the request document for audit/refund lookups.
    """
    db = get_db()
    now = _now()
    req_id = str(uuid.uuid4())
    jobs_total = len(data.cities)

    # V1 intake: scheduling window is the calm continuity vocabulary.
    # When provided, deterministically maps to legacy `urgency` for downstream
    # systems (inspector job sorting, marketplace ranking). When both are
    # provided, explicit `urgency` wins (back-compat).
    SCHEDULING_TO_URGENCY = {
        "soon": "asap",
        "this_week": "24h",
        "flexible": "week",
    }
    effective_urgency = data.urgency or SCHEDULING_TO_URGENCY.get(
        data.schedulingWindow or "", None
    )

    request_doc = {
        "_id": req_id,
        "userId": user_id,
        # P4.1 — Vehicle linkage. Stored as `vehicleId` on the wire +
        # in Mongo. Indexed (see app.vehicles.timeline.ensure_indexes).
        # Optional — anonymous flow may have no saved vehicle yet, and
        # legacy requests created before P4.1 will carry None.
        "vehicleId": data.vehicleId,
        "type": data.type,
        "brand": data.brand or "",
        "model": data.model or "",
        "budget": int(data.budget or 0),
        "links": list(data.links),
        "cities": list(data.cities),
        "country": data.country,
        "urgency": effective_urgency,
        # V1 intake substrate — persisted as-is. NOT proxied into any
        # customer-facing mapper (continuity / cognition read structural
        # signals only).
        "uncertainty": data.uncertainty,
        "schedulingWindow": data.schedulingWindow,
        "yearFrom": data.yearFrom,
        "yearTo": data.yearTo,
        "fuel": data.fuel,
        "transmission": data.transmission,
        "mileageMax": data.mileageMax,
        "comment": data.comment,
        # Phase 3 — per-request override for soft-marketplace flag
        "useExposures": data.useExposures,
        # Phase 3.0b — paid via Stripe session (one-shot inline payment)
        "paymentSessionId": pre_paid_session_id,
        "paid": pre_paid_session_id is not None,
        "status": "open",
        "jobsTotal": jobs_total,
        "jobsClaimed": 0,
        "jobsDone": 0,
        "createdAt": now,
        "updatedAt": now,
    }
    await db.car_requests.insert_one(request_doc)

    # fan-out: 1 job per city (denormalized brand/model/budget for inspector list)
    # P4.1 — denormalize vehicleId onto each job too. Reports built from
    # the job will inherit it without re-fetching the request.
    job_docs = []
    for city in data.cities:
        job_docs.append({
            "_id": str(uuid.uuid4()),
            "requestId": req_id,
            "vehicleId": data.vehicleId,  # P4.1
            "city": city,
            "country": data.country,
            "type": data.type,
            "inspectorId": None,
            "status": "open",
            "brand": data.brand or "",
            "model": data.model or "",
            "budget": int(data.budget or 0),
            "links": list(data.links),
            "urgency": effective_urgency,
            "createdAt": now,
        })
    if job_docs:
        await db.inspection_jobs.insert_many(job_docs)

    # Phase 3 — Soft Marketplace: for each job, expose to top-N inspectors.
    # Respects feature flag `use_exposures` (global Mongo flag + per-request override).
    from app.auto_requests.feature_flags_helper import is_enabled, get_config_int
    use_exposures = await is_enabled("use_exposures", default=True, request_doc=request_doc)
    if use_exposures:
        try:
            from app.auto_requests import marketplace as mkt
            pool_size = await get_config_int("exposures_per_request", default=5)
            for jd in job_docs:
                await mkt.create_exposures_for_job(
                    request_id=req_id,
                    job_id=jd["_id"],
                    city=jd["city"],
                    pool_size=pool_size,
                    wave_reason="initial",
                )
        except Exception as exc:
            # Non-blocking: if marketplace fails, jobs are still createable via legacy claim
            import logging
            logging.getLogger(__name__).warning(f"exposure creation failed: {exc}")

    # Phase D Pass 1 — emit continuity-topology event.
    # Append-only, low-cardinality (one per request, ever). The emit
    # is BEST-EFFORT: a ledger insert failure must NOT roll back the
    # request creation — the operational substrate (car_requests +
    # inspection_jobs) is the source of record. The ledger is a
    # continuity trace on top.
    try:
        from app.runtime_ledger import emit, EventType
        await emit(
            EventType.INSPECTION_CONTEXT_ESTABLISHED,
            subject_id=req_id,
            payload={"requestType": data.type},
            emitted_by=user_id,
        )
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning(
            f"runtime_ledger emit failed for request {req_id}: {exc}"
        )

    return _to_request_out(request_doc)


# ──────────────────────────────────────────────────────────────────────
# customer queries
# ──────────────────────────────────────────────────────────────────────

async def list_my_requests(user_id: str) -> List[CarRequestOut]:
    db = get_db()
    cursor = db.car_requests.find({"userId": user_id}).sort("createdAt", -1)
    docs = await cursor.to_list(200)
    return [_to_request_out(d) for d in docs]


async def get_request(request_id: str) -> Optional[CarRequestOut]:
    db = get_db()
    doc = await db.car_requests.find_one({"_id": request_id})
    return _to_request_out(doc) if doc else None


async def get_jobs_for_request(request_id: str) -> List[InspectionJobOut]:
    db = get_db()
    cursor = db.inspection_jobs.find({"requestId": request_id}).sort("createdAt", 1)
    docs = await cursor.to_list(100)
    return [_to_job_out(d) for d in docs]


# ──────────────────────────────────────────────────────────────────────
# inspector queries
# ──────────────────────────────────────────────────────────────────────

async def list_open_jobs(city: Optional[str] = None) -> List[InspectionJobOut]:
    db = get_db()
    q: dict = {"status": "open"}
    if city:
        q["city"] = city
    cursor = db.inspection_jobs.find(q).sort("createdAt", -1)
    docs = await cursor.to_list(100)
    return [_to_job_out(d) for d in docs]


async def list_my_jobs(inspector_id: str) -> List[InspectionJobOut]:
    db = get_db()
    cursor = db.inspection_jobs.find({"inspectorId": inspector_id}).sort("createdAt", -1)
    docs = await cursor.to_list(100)
    return [_to_job_out(d) for d in docs]


async def claim_job(job_id: str, inspector_id: str) -> Optional[InspectionJobOut]:
    """Atomic claim: only open jobs can be taken; update parent request counters."""
    db = get_db()
    res = await db.inspection_jobs.find_one_and_update(
        {"_id": job_id, "status": "open"},
        {"$set": {"status": "claimed", "inspectorId": inspector_id, "claimedAt": _now()}},
        return_document=True,  # ReturnDocument.AFTER equivalent in pymongo 4+: True works for motor
    )
    if not res:
        return None
    # bump parent counters
    parent = await db.car_requests.find_one_and_update(
        {"_id": res["requestId"]},
        {
            "$inc": {"jobsClaimed": 1},
            "$set": {"status": "in_progress", "updatedAt": _now()},
        },
        return_document=True,
    )

    # Sprint 2 Step 1 — durable timeline event
    try:
        from app.inspector.timeline import append_event
        await append_event(
            kind="assignment_claimed",
            job_id=job_id,
            report_id=None,
            vehicle_id=res.get("vehicleId"),
            inspector_id=inspector_id,
            customer_id=(parent or {}).get("userId"),
            actor_type="inspector",
            actor_id=inspector_id,
            title="Задание принято",
            text=f"{res.get('brand', '')} {res.get('model', '')} · {res.get('city', '')}".strip(" ·"),
            metadata={
                "city": res.get("city"),
                "brand": res.get("brand"),
                "model": res.get("model"),
                "requestId": res.get("requestId"),
            },
        )
    except Exception:
        pass

    # Phase D Pass 1B — assignment continuity wiring (Step 8A).
    # Append-only, low-cardinality: one event per job, ever. Coalesced
    # at storage layer via the unique dedupKey index, which makes
    # repeated claim attempts (legacy → marketplace → admin) idempotent
    # without coordination. Best-effort: a ledger insert failure must
    # NOT roll back the claim — operational substrate is the source of
    # record.
    try:
        from app.runtime_ledger import emit, EventType
        await emit(
            EventType.ASSIGNMENT_CONTINUITY_CLAIMED,
            subject_id=job_id,
            payload={"inspectorId": inspector_id},
            emitted_by=inspector_id,
        )
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning(
            f"runtime_ledger emit (assignment_claimed) failed for job {job_id}: {exc}"
        )

    return _to_job_out(res)


# ──────────────────────────────────────────────────────────────────────
# admin
# ──────────────────────────────────────────────────────────────────────

async def list_all_requests(status: Optional[str] = None, city: Optional[str] = None) -> List[CarRequestOut]:
    db = get_db()
    q: dict = {}
    if status:
        q["status"] = status
    if city:
        q["cities"] = city
    cursor = db.car_requests.find(q).sort("createdAt", -1)
    docs = await cursor.to_list(500)
    return [_to_request_out(d) for d in docs]


async def admin_assign_job(job_id: str, inspector_id: str) -> Optional[InspectionJobOut]:
    db = get_db()
    res = await db.inspection_jobs.find_one_and_update(
        {"_id": job_id, "status": {"$in": ["open", "claimed"]}},
        {"$set": {"status": "claimed", "inspectorId": inspector_id, "assignedByAdmin": True}},
        return_document=True,
    )
    if not res:
        return None
    await db.car_requests.update_one(
        {"_id": res["requestId"]},
        {"$set": {"status": "in_progress", "updatedAt": _now()}},
    )

    # Phase D Pass 1B — assignment continuity wiring (Step 8A).
    # Same continuity transition as inspector-initiated claim — admin
    # override path. Dedup on (job_id) makes second-claim attempts via
    # any path silent no-ops at the ledger layer.
    try:
        from app.runtime_ledger import emit, EventType
        await emit(
            EventType.ASSIGNMENT_CONTINUITY_CLAIMED,
            subject_id=job_id,
            payload={"inspectorId": inspector_id},
            emitted_by=inspector_id,
        )
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning(
            f"runtime_ledger emit (admin_assign) failed for job {job_id}: {exc}"
        )

    return _to_job_out(res)


# ──────────────────────────────────────────────────────────────────────
# stats (simple counters for admin dashboard)
# ──────────────────────────────────────────────────────────────────────

async def stats() -> dict:
    db = get_db()
    total = await db.car_requests.count_documents({})
    open_cnt = await db.car_requests.count_documents({"status": "open"})
    in_progress = await db.car_requests.count_documents({"status": "in_progress"})
    jobs_open = await db.inspection_jobs.count_documents({"status": "open"})
    jobs_claimed = await db.inspection_jobs.count_documents({"status": "claimed"})
    return {
        "requests": {"total": total, "open": open_cnt, "in_progress": in_progress},
        "jobs": {"open": jobs_open, "claimed": jobs_claimed},
    }
