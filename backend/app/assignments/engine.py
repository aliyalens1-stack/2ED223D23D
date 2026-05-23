"""Sprint 3 Step 4 — Live Assignments engine.

Architectural contract:
    new request → eligible inspectors → ranked offer → countdown
    → accept/decline → lifecycle starts → timeline + notifications

Pure deterministic ranking V1 — no ML, no random factors.

State machine:
    offered ─accept→ accepted    (terminal: job claimed, exclusive)
    offered ─decline→ declined   (terminal)
    offered ─time→ expired       (terminal, lazy)
    offered ─admin→ cancelled    (terminal)

Invariants enforced here:
    - accept is idempotent (returns existing accepted state on retry)
    - decline is idempotent
    - expired cannot transition to accepted
    - accepted cannot transition to declined
    - one job has at most one accepted assignment (unique partial index)
    - hardFloor inspectors cannot receive auto assignment (filtered by
      `find_eligible_inspectors`); manual admin assignment may override
      with `manualOverride=true`
"""
from __future__ import annotations

import logging
import math
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from pymongo.errors import DuplicateKeyError

from app.core.db import get_db


logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# Tunables — named constants only. No magic numbers downstream.
# ─────────────────────────────────────────────────────────────────────

OFFER_TTL_SECONDS_DEFAULT = 120  # 2 min countdown
PRIORITY_TTL: Dict[str, int] = {
    "urgent":  60,
    "normal":  120,
    "premium": 180,
}
RANK_WEIGHTS = {
    "reputation":   0.45,
    "distance":     0.25,
    "availability": 0.20,
    "verification": 0.10,
}
MAX_JOBS_PER_DAY_DEFAULT = 3
DISTANCE_DECAY_KM = 25.0  # at 25 km, distanceScore = 0


# ─────────────────────────────────────────────────────────────────────
# Indexes
# ─────────────────────────────────────────────────────────────────────

async def ensure_indexes(db) -> None:
    """Idempotent."""
    try:
        await db.inspection_assignments.create_index(
            [("inspectorId", 1), ("status", 1), ("expiresAt", 1)],
            background=True,
        )
        await db.inspection_assignments.create_index(
            [("jobId", 1), ("status", 1)], background=True
        )
        # Exclusive lock: a single job may have at most ONE accepted row.
        await db.inspection_assignments.create_index(
            [("jobId", 1), ("status", 1)],
            unique=True,
            background=True,
            name="job_unique_when_accepted",
            partialFilterExpression={"status": "accepted"},
        )
        await db.inspection_assignments.create_index(
            [("status", 1), ("createdAt", -1)], background=True
        )
    except Exception as e:  # pragma: no cover
        logger.warning(f"Sprint 3 Step 4: ensure_indexes (non-fatal): {e}")


# ─────────────────────────────────────────────────────────────────────
# Pure helpers — testable without DB.
# ─────────────────────────────────────────────────────────────────────

def _haversine_km(p1: Optional[Tuple[float, float]], p2: Optional[Tuple[float, float]]) -> Optional[float]:
    if not p1 or not p2:
        return None
    lat1, lon1 = p1; lat2, lon2 = p2
    r = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return round(r * 2 * math.asin(math.sqrt(a)), 2)


def _distance_score(km: Optional[float]) -> int:
    if km is None:
        return 50  # unknown distance → neutral
    if km >= DISTANCE_DECAY_KM:
        return 0
    return max(0, min(100, round(100 * (1 - km / DISTANCE_DECAY_KM))))


def compute_rank(
    *,
    reputation_score: int,
    is_online: bool,
    verified: bool,
    distance_km: Optional[float],
) -> Tuple[int, Dict[str, int]]:
    """Pure: same inputs → same score. Returns (overall, breakdown)."""
    breakdown = {
        "reputationScore":   max(0, min(100, int(reputation_score))),
        "distanceScore":     _distance_score(distance_km),
        "availabilityScore": 100 if is_online else 0,
        "verificationScore": 100 if verified else 0,
    }
    overall = round(
        breakdown["reputationScore"]   * RANK_WEIGHTS["reputation"]   +
        breakdown["distanceScore"]     * RANK_WEIGHTS["distance"]     +
        breakdown["availabilityScore"] * RANK_WEIGHTS["availability"] +
        breakdown["verificationScore"] * RANK_WEIGHTS["verification"]
    )
    return max(0, min(100, overall)), breakdown


# ─────────────────────────────────────────────────────────────────────
# Eligibility — readers + filters.
# ─────────────────────────────────────────────────────────────────────

async def find_eligible_inspectors(
    db,
    *,
    city: Optional[str] = None,
    job_location: Optional[Tuple[float, float]] = None,
    priority: str = "normal",
    exclude_hard_floor: bool = True,
) -> List[Dict[str, Any]]:
    """Return ranked candidate inspectors for a new job.

    Filters:
      - role=inspector
      - hardFloor=true excluded (unless `exclude_hard_floor` is False)
      - active job count >= maxJobsPerDay → excluded
      - premium priority requires verified=true
    """
    q: Dict[str, Any] = {
        "$or": [
            {"role": "inspector"},
            {"accountKind": "inspector"},
        ],
    }
    if exclude_hard_floor:
        q["reputation.hardFloor"] = {"$ne": True}

    candidates: List[Dict[str, Any]] = []
    async for u in db.users.find(q, {
        "_id": 1, "name": 1, "email": 1,
        "reputation": 1, "verified": 1, "isOnline": 1,
        "location": 1, "city": 1, "maxJobsPerDay": 1,
    }):
        uid = u["_id"]
        # Active job throttle.
        active = await db.inspection_jobs.count_documents({
            "inspectorId": uid,
            "status": {"$in": ["claimed", "on_route", "arrived", "inspecting", "accepted"]},
        })
        max_jobs = int(u.get("maxJobsPerDay") or MAX_JOBS_PER_DAY_DEFAULT)
        if active >= max_jobs:
            continue
        verified = bool(u.get("verified") or u.get("reputation", {}).get("verificationScore", 0) >= 80)
        if priority == "premium" and not verified:
            continue
        rep_score = int(u.get("reputation", {}).get("score") or 0)
        is_online = bool(u.get("isOnline"))
        loc = u.get("location") or {}
        inspector_pt = None
        if isinstance(loc, dict) and loc.get("lat") is not None and loc.get("lng") is not None:
            inspector_pt = (float(loc["lat"]), float(loc["lng"]))
        distance_km = _haversine_km(inspector_pt, job_location) if job_location else None
        score, breakdown = compute_rank(
            reputation_score=rep_score,
            is_online=is_online,
            verified=verified,
            distance_km=distance_km,
        )
        candidates.append({
            "userId": uid, "score": score, "ranking": breakdown,
            "distanceKm": distance_km, "verified": verified,
            "isOnline": is_online,
        })

    candidates.sort(key=lambda c: (-c["score"], c["userId"]))  # tie-break by id for stable order
    return candidates


# ─────────────────────────────────────────────────────────────────────
# Lazy expiration
# ─────────────────────────────────────────────────────────────────────

async def expire_stale(db, *, inspector_id: Optional[str] = None) -> int:
    """Move offered rows whose expiresAt < now into 'expired'. Lazy.

    Returns the count of expired rows (per call). Also emits a timeline
    'assignment_expired' event for each one, best-effort.
    """
    now_iso = datetime.now(timezone.utc).isoformat()
    q: Dict[str, Any] = {"status": "offered", "expiresAt": {"$lt": now_iso}}
    if inspector_id:
        q["inspectorId"] = inspector_id
    expired_rows: List[Dict[str, Any]] = []
    async for row in db.inspection_assignments.find(q, {"_id": 0}):
        expired_rows.append(row)
    if not expired_rows:
        return 0
    ids = [r["id"] for r in expired_rows]
    await db.inspection_assignments.update_many(
        {"id": {"$in": ids}, "status": "offered"},
        {"$set": {"status": "expired", "expiredAt": now_iso}},
    )
    # Emit timeline events for observability.
    try:
        from app.inspector.timeline import append_event
        for r in expired_rows:
            await append_event(
                kind="assignment_expired",
                job_id=r.get("jobId"),
                inspector_id=r.get("inspectorId"),
                actor_type="system",
                actor_label="assignments engine",
                severity="info",
                title="Предложение истекло",
                text="Заявка вышла из окна принятия.",
                metadata={"assignmentId": r["id"], "priority": r.get("priority")},
                stable_key=r["id"],
            )
    except Exception:
        logger.exception("expire_stale: timeline emit failed")
    return len(expired_rows)


# ─────────────────────────────────────────────────────────────────────
# Create assignment — used by admin manual create and (future) auto-dispatch.
# ─────────────────────────────────────────────────────────────────────

async def create_assignment(
    *,
    job_id: str,
    inspector_id: str,
    customer_id: Optional[str] = None,
    vehicle_id: Optional[str] = None,
    priority: str = "normal",
    estimated_earnings: Optional[float] = None,
    currency: str = "EUR",
    ttl_seconds: Optional[int] = None,
    job_location: Optional[Tuple[float, float]] = None,
    manual_override: bool = False,
    metadata: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Persist offered assignment row + emit assignment_offered timeline.

    Returns the assignment dict, or None on failure. Rejects if the
    inspector has hardFloor=true unless manual_override=true.
    """
    db = get_db()
    priority = priority if priority in PRIORITY_TTL else "normal"
    ttl = int(ttl_seconds or PRIORITY_TTL[priority])
    now = datetime.now(timezone.utc)
    expires_iso = (now + timedelta(seconds=ttl)).isoformat()

    # Load inspector for ranking + floor check.
    u = await db.users.find_one(
        {"_id": inspector_id},
        {"reputation": 1, "verified": 1, "isOnline": 1, "location": 1, "_id": 0},
    )
    if not u:
        return None
    if not manual_override and u.get("reputation", {}).get("hardFloor"):
        return None  # hard-floor inspector excluded from auto assignment

    rep_score = int(u.get("reputation", {}).get("score") or 0)
    is_online = bool(u.get("isOnline"))
    verified = bool(u.get("verified") or u.get("reputation", {}).get("verificationScore", 0) >= 80)
    loc = u.get("location") or {}
    inspector_pt = None
    if isinstance(loc, dict) and loc.get("lat") is not None and loc.get("lng") is not None:
        inspector_pt = (float(loc["lat"]), float(loc["lng"]))
    distance_km = _haversine_km(inspector_pt, job_location) if job_location else None
    score, breakdown = compute_rank(
        reputation_score=rep_score,
        is_online=is_online,
        verified=verified,
        distance_km=distance_km,
    )

    asg = {
        "id": f"asg_{uuid.uuid4().hex[:18]}",
        "jobId": job_id,
        "inspectorId": inspector_id,
        "customerId": customer_id,
        "vehicleId": vehicle_id,
        "status": "offered",
        "priority": priority,
        "expiresAt": expires_iso,
        "ttlSeconds": ttl,
        "distanceKm": distance_km,
        "estimatedEarnings": estimated_earnings,
        "currency": currency,
        "score": score,
        "ranking": breakdown,
        "createdAt": now.isoformat(),
        "acceptedAt": None,
        "declinedAt": None,
        "manualOverride": bool(manual_override),
        "metadata": metadata or {},
    }
    await db.inspection_assignments.insert_one(asg)
    # insert_one mutates `asg` by injecting ObjectId `_id`; strip it so the
    # dict is JSON-serialisable when returned by the router.
    asg.pop("_id", None)

    # Timeline + notifications via append_event hook.
    try:
        from app.inspector.timeline import append_event
        await append_event(
            kind="assignment_offered",
            job_id=job_id,
            inspector_id=inspector_id,
            customer_id=customer_id,
            actor_type="admin" if manual_override else "system",
            actor_label="assignments engine",
            severity="info",
            title="Новое предложение",
            text=f"{priority.upper()} · {estimated_earnings or '—'} {currency}",
            metadata={
                "assignmentId": asg["id"], "priority": priority,
                "score": score, "ranking": breakdown,
                "estimatedEarnings": estimated_earnings,
                "currency": currency, "distanceKm": distance_km,
                "manualOverride": manual_override,
            },
            stable_key=asg["id"],
        )
    except Exception:
        logger.exception("create_assignment: timeline emit failed")

    return asg


# ─────────────────────────────────────────────────────────────────────
# State transitions
# ─────────────────────────────────────────────────────────────────────

async def accept_assignment(assignment_id: str, inspector_id: str) -> Tuple[str, Optional[Dict[str, Any]]]:
    """Atomic accept. Returns (status_code, row).

    status_code:
        "accepted"   — newly accepted
        "idempotent" — already accepted by this inspector
        "expired"    — past expiresAt OR row.status='expired'
        "forbidden"  — assignment belongs to a different inspector
        "conflict"   — another inspector already accepted this job
        "notfound"   — row missing
        "cancelled"  — row was cancelled by admin
        "declined"   — row was previously declined
    """
    db = get_db()
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    row = await db.inspection_assignments.find_one({"id": assignment_id}, {"_id": 0})
    if not row:
        return "notfound", None
    if row.get("inspectorId") != inspector_id:
        return "forbidden", row
    if row["status"] == "accepted":
        return "idempotent", row
    if row["status"] in ("declined", "expired", "cancelled"):
        return row["status"], row
    # Lazy expiration check: even if status=='offered', expiresAt may be past.
    if row.get("expiresAt") and row["expiresAt"] < now_iso:
        await db.inspection_assignments.update_one(
            {"id": assignment_id, "status": "offered"},
            {"$set": {"status": "expired", "expiredAt": now_iso}},
        )
        return "expired", {**row, "status": "expired"}

    # Try to claim. Use unique partial index to enforce one-accepted-per-job.
    try:
        res = await db.inspection_assignments.update_one(
            {"id": assignment_id, "status": "offered"},
            {"$set": {"status": "accepted", "acceptedAt": now_iso}},
        )
        if res.modified_count != 1:
            # Race: another transition happened. Re-read.
            fresh = await db.inspection_assignments.find_one({"id": assignment_id}, {"_id": 0})
            return fresh["status"] if fresh else "notfound", fresh
        # Check unique index by attempting to mark — if another row is already
        # accepted for the same jobId, the partial unique index would have
        # raised DuplicateKeyError. We use a defensive count fallback.
        accepted_count = await db.inspection_assignments.count_documents(
            {"jobId": row["jobId"], "status": "accepted"}
        )
        if accepted_count > 1:
            # Roll back this row to declined (cannot keep two accepted).
            await db.inspection_assignments.update_one(
                {"id": assignment_id},
                {"$set": {"status": "declined", "declinedAt": now_iso,
                          "metadata.conflictRollback": True}},
            )
            return "conflict", {**row, "status": "declined"}
    except DuplicateKeyError:
        return "conflict", row

    # Claim the inspection_job (best-effort; never fatal).
    try:
        await db.inspection_jobs.update_one(
            {"_id": row["jobId"]},
            {"$set": {
                "status": "claimed",
                "inspectorId": inspector_id,
                "claimedAt": now_iso,
            }},
        )
    except Exception:
        logger.exception("accept_assignment: job claim failed")

    # Cancel sibling offered rows for the same job (only one inspector wins).
    try:
        await db.inspection_assignments.update_many(
            {"jobId": row["jobId"], "id": {"$ne": assignment_id}, "status": "offered"},
            {"$set": {"status": "cancelled", "cancelledAt": now_iso,
                      "metadata.cancelReason": "another_inspector_accepted"}},
        )
    except Exception:
        pass

    # Timeline event.
    try:
        from app.inspector.timeline import append_event
        await append_event(
            kind="assignment_accepted",
            job_id=row["jobId"],
            inspector_id=inspector_id,
            customer_id=row.get("customerId"),
            actor_type="inspector",
            actor_id=inspector_id,
            severity="success",
            title="Задание принято",
            metadata={"assignmentId": assignment_id, "score": row.get("score")},
            stable_key=assignment_id,
        )
        # Customer-facing event so the customer's inbox can light up.
        if row.get("customerId"):
            await append_event(
                kind="inspector_assigned",
                job_id=row["jobId"],
                inspector_id=inspector_id,
                customer_id=row.get("customerId"),
                actor_type="system",
                actor_label="assignments engine",
                severity="success",
                title="Инспектор назначен",
                text="Инспектор принял вашу проверку.",
                metadata={"assignmentId": assignment_id},
                stable_key=f"{assignment_id}_customer",
            )
    except Exception:
        logger.exception("accept_assignment: timeline emit failed")

    fresh = await db.inspection_assignments.find_one({"id": assignment_id}, {"_id": 0})
    return "accepted", fresh


async def decline_assignment(assignment_id: str, inspector_id: str, reason: Optional[str] = None) -> Tuple[str, Optional[Dict[str, Any]]]:
    """Atomic decline. Returns (status_code, row)."""
    db = get_db()
    now_iso = datetime.now(timezone.utc).isoformat()
    row = await db.inspection_assignments.find_one({"id": assignment_id}, {"_id": 0})
    if not row:
        return "notfound", None
    if row.get("inspectorId") != inspector_id:
        return "forbidden", row
    if row["status"] == "declined":
        return "idempotent", row
    if row["status"] == "accepted":
        return "already_accepted", row  # cannot decline an accepted job
    if row["status"] in ("expired", "cancelled"):
        return row["status"], row
    await db.inspection_assignments.update_one(
        {"id": assignment_id, "status": "offered"},
        {"$set": {"status": "declined", "declinedAt": now_iso,
                  "declineReason": reason or None}},
    )
    try:
        from app.inspector.timeline import append_event
        await append_event(
            kind="assignment_declined",
            job_id=row["jobId"],
            inspector_id=inspector_id,
            customer_id=row.get("customerId"),
            actor_type="inspector",
            actor_id=inspector_id,
            severity="warning",
            title="Задание отклонено",
            text=reason or "",
            metadata={"assignmentId": assignment_id, "reason": reason},
            stable_key=assignment_id,
        )
    except Exception:
        logger.exception("decline_assignment: timeline emit failed")
    fresh = await db.inspection_assignments.find_one({"id": assignment_id}, {"_id": 0})
    return "declined", fresh


async def cancel_assignment(assignment_id: str, admin_actor: Optional[str] = None) -> Tuple[str, Optional[Dict[str, Any]]]:
    db = get_db()
    now_iso = datetime.now(timezone.utc).isoformat()
    row = await db.inspection_assignments.find_one({"id": assignment_id}, {"_id": 0})
    if not row:
        return "notfound", None
    if row["status"] in ("accepted",):
        return "already_accepted", row
    if row["status"] in ("cancelled", "declined", "expired"):
        return row["status"], row
    await db.inspection_assignments.update_one(
        {"id": assignment_id, "status": "offered"},
        {"$set": {"status": "cancelled", "cancelledAt": now_iso,
                  "cancelledBy": admin_actor}},
    )
    fresh = await db.inspection_assignments.find_one({"id": assignment_id}, {"_id": 0})
    return "cancelled", fresh


__all__ = [
    "ensure_indexes",
    "compute_rank",
    "find_eligible_inspectors",
    "expire_stale",
    "create_assignment",
    "accept_assignment",
    "decline_assignment",
    "cancel_assignment",
    "PRIORITY_TTL",
    "RANK_WEIGHTS",
    "OFFER_TTL_SECONDS_DEFAULT",
    "DISTANCE_DECAY_KM",
]
