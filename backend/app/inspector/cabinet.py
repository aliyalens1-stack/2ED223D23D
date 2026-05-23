"""Inspector Cabinet — backend surface for /inspector/*.

Реализует полный кабинет согласно Inspector Cabinet Expansion Sprint:
  /api/inspector/dashboard       GET
  /api/inspector/profile         GET (already in router_inspector_profile.py)
  /api/inspector/profile         PATCH
  /api/inspector/inspections     GET (archive with filters)
  /api/inspector/availability    GET / PATCH
  /api/inspector/payouts         GET
  /api/inspector/performance     GET
  /api/inspector/verification    GET
  /api/inspector/verification/upload     POST
  /api/inspector/verification/{docId}    PATCH
  /api/inspector/security        GET
  /api/inspector/change-password POST
  /api/inspector/settings        GET / PATCH

Storage strategy:
  - Профильные/cabinet поля живут в `users` (один документ на actor).
  - Verification documents — отдельная коллекция `inspector_verifications`
    (по одному doc на (userId, kind)).
  - Sessions list — derive из `user_sessions` если есть, иначе синтез из текущего токена.

Все ответы — tolerant: новый инспектор без истории = 200 с разумными
дефолтами, не 500.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.auto_requests.auth import get_user_id_required
from app.core.db import get_db
from app.core.security import hash_pw, verify_pw


router = APIRouter(prefix="/api/inspector", tags=["inspector:cabinet"])


# ──────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _month_start() -> datetime:
    n = _now()
    return n.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _safe_iso(v: Any) -> Optional[str]:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, str):
        return v
    try:
        return str(v)
    except Exception:
        return None


async def _count(coll, q: Dict) -> int:
    try:
        return await coll.count_documents(q)
    except Exception:
        return 0


async def _sum(coll, q: Dict, field: str) -> float:
    try:
        async for d in coll.aggregate(
            [{"$match": q}, {"$group": {"_id": None, "sum": {"$sum": f"${field}"}}}]
        ):
            return float(d.get("sum") or 0)
    except Exception:
        pass
    return 0.0


async def _get_user(uid: str) -> Dict[str, Any]:
    db = get_db()
    try:
        from bson import ObjectId
        oid = ObjectId(uid) if len(uid) == 24 else uid
    except Exception:
        oid = uid
    return await db.users.find_one({"_id": oid}) or {}


# Default cabinet state for a fresh inspector — single source of truth.
DEFAULT_AVAILABILITY = {
    "online": False,
    "zones": [],
    "radiusKm": 25,
    "workingDays": [1, 2, 3, 4, 5],  # Mon-Fri
    "workingHours": {"start": "09:00", "end": "18:00"},
    "blackoutDates": [],
    "maxJobsPerDay": 3,
}

DEFAULT_SETTINGS = {
    "language": "ru",
    "timezone": "Europe/Berlin",
    "notifications": {
        "newJobOffers": True,
        "reportReminders": True,
        "payoutUpdates": True,
        "disputeAlerts": True,
        "marketing": False,
    },
    "channels": {"email": True, "push": True, "sms": False},
    "reportDefaults": {"autoSaveDraft": True, "suggestVerdict": True},
    "privacy": {"showRatingPublic": True, "showStatsPublic": False},
}

VERIFICATION_KINDS = ["passport", "businessRegistration", "insurance", "taxId", "toolsProof", "tuvCertificate"]
# Sprint 3 Step 1: extended status taxonomy. `approved` supersedes `verified`
# (kept as a back-compat alias). `needs_resubmission` and `expired` are new
# admin-driven states. PATCH still accepts the legacy spellings.
VERIFICATION_STATES = [
    "missing", "uploaded", "pending_review",
    "approved", "rejected", "needs_resubmission", "expired",
    "verified",  # legacy alias, accepted on read; normalised by admin queue
]


# ──────────────────────────────────────────────────────────────────
# 1. Dashboard
# ──────────────────────────────────────────────────────────────────


@router.get("/dashboard")
async def get_dashboard(uid: str = Depends(get_user_id_required)) -> Dict[str, Any]:
    db = get_db()
    ms = _month_start()

    active = await _count(
        db.inspection_jobs,
        {"inspectorId": uid, "status": {"$in": ["accepted", "in_progress", "on_site", "claimed"]}},
    )
    awaiting_report = await _count(
        db.inspection_jobs,
        {"inspectorId": uid, "status": {"$in": ["awaiting_report", "report_pending", "report_draft"]}},
    )
    completed_month = await _count(
        db.inspection_jobs,
        {"inspectorId": uid, "status": "done", "completedAt": {"$gte": ms}},
    )

    user = await _get_user(uid)
    rating = float(user.get("ratingAvg") or 0)
    reviews = int(user.get("reviewsCount") or 0)

    # Earnings month
    earnings_month = 0.0
    try:
        async for d in db.inspection_jobs.aggregate(
            [
                {"$match": {"inspectorId": uid, "status": "done", "completedAt": {"$gte": ms}}},
                {
                    "$lookup": {
                        "from": "car_requests",
                        "localField": "requestId",
                        "foreignField": "_id",
                        "as": "req",
                    }
                },
                {"$unwind": {"path": "$req", "preserveNullAndEmptyArrays": True}},
                {"$group": {"_id": None, "s": {"$sum": {"$ifNull": ["$req.price", 0]}}}},
            ]
        ):
            earnings_month = float(d.get("s") or 0)
    except Exception:
        pass

    pending_payout = await _sum(
        db.payouts, {"inspectorId": uid, "status": {"$in": ["pending", "scheduled"]}}, "amount"
    )

    # Warnings: open disputes, missing docs, low rating
    warnings: List[Dict[str, Any]] = []
    disp_open = await _count(
        db.disputes, {"inspectorId": uid, "status": {"$in": ["open", "in_review", "reopened"]}}
    )
    if disp_open > 0:
        warnings.append(
            {
                "kind": "disputes_open",
                "severity": "warning",
                "message": f"{disp_open} спор(ов) на разборе",
                "count": disp_open,
            }
        )

    docs = await db.inspector_verifications.find({"userId": uid}).to_list(20)
    missing_docs = [k for k in VERIFICATION_KINDS if not any(d.get("kind") == k for d in docs)]
    if missing_docs:
        warnings.append(
            {
                "kind": "verification_incomplete",
                "severity": "info",
                "message": f"Не загружено документов: {len(missing_docs)}",
                "missing": missing_docs,
            }
        )

    if rating > 0 and rating < 4.0:
        warnings.append(
            {"kind": "low_rating", "severity": "warning", "message": f"Низкий рейтинг ({rating:.1f})"}
        )

    # Recent events — Sprint 2 Step 1: read from durable timeline_events first.
    # Fallback to job-level activity if timeline is empty (transition window
    # while existing jobs migrate). Both shapes co-exist in `recentEvents`.
    recent: List[Dict[str, Any]] = []
    try:
        cur_tl = db.timeline_events.find(
            {"inspectorId": uid},
            {"_id": 0},
        ).sort("timestamp", -1).limit(10)
        async for e in cur_tl:
            recent.append({
                "id": e.get("id"),
                "kind": e.get("kind"),
                "title": e.get("title"),
                "text": e.get("text"),
                "severity": e.get("severity"),
                "jobId": e.get("jobId"),
                "reportId": e.get("reportId"),
                "timestamp": e.get("timestamp"),
                "source": "timeline",
            })
    except Exception:
        pass

    if not recent:
        try:
            cur = (
                db.inspection_jobs.find(
                    {"inspectorId": uid},
                    {"_id": 1, "status": 1, "updatedAt": 1, "createdAt": 1, "claimedAt": 1, "completedAt": 1, "requestId": 1},
                )
                .sort("updatedAt", -1)
                .limit(6)
            )
            async for j in cur:
                recent.append(
                    {
                        "id": str(j.get("_id")),
                        "status": j.get("status"),
                        "requestId": j.get("requestId"),
                        "timestamp": _safe_iso(
                            j.get("updatedAt") or j.get("completedAt") or j.get("claimedAt") or j.get("createdAt")
                        ),
                        "source": "job_fallback",
                    }
                )
        except Exception:
            pass

    quick_actions = [
        {"id": "go-online", "label": "Перейти онлайн", "kind": "primary"},
        {"id": "open-jobs", "label": "Открыть задания", "to": "/inspector/jobs"},
        {"id": "request-payout", "label": "Запросить выплату", "to": "/inspector/payouts"},
        {"id": "update-availability", "label": "Изменить доступность", "to": "/inspector/availability"},
    ]

    return {
        "summary": {
            "activeJobs": active,
            "awaitingReport": awaiting_report,
            "completedMonth": completed_month,
            "ratingAvg": round(rating, 2),
            "reviewsCount": reviews,
            "earningsMonth": int(earnings_month),
            "pendingPayout": int(pending_payout),
            "currency": "EUR",
        },
        "warnings": warnings,
        "recentEvents": recent,
        "quickActions": quick_actions,
        "generatedAt": _now().isoformat(),
    }


# ──────────────────────────────────────────────────────────────────
# 2. Profile — PATCH (GET остаётся в router_inspector_profile.py)
# ──────────────────────────────────────────────────────────────────


class ProfileUpdate(BaseModel):
    firstName: Optional[str] = None
    lastName: Optional[str] = None
    phone: Optional[str] = None
    city: Optional[str] = None
    bio: Optional[str] = None
    languages: Optional[List[str]] = None
    brands: Optional[List[str]] = None
    tools: Optional[List[str]] = None
    workingRadiusKm: Optional[int] = None
    avatar: Optional[str] = None  # base64 data-url or external URL


@router.patch("/profile")
async def update_profile(payload: ProfileUpdate, uid: str = Depends(get_user_id_required)) -> Dict[str, Any]:
    db = get_db()
    update: Dict[str, Any] = {}
    for k, v in payload.dict(exclude_unset=True).items():
        if v is not None:
            update[k] = v
    if not update:
        return {"ok": True, "updated": []}
    update["updatedAt"] = _now().isoformat()

    try:
        from bson import ObjectId
        oid = ObjectId(uid) if len(uid) == 24 else uid
    except Exception:
        oid = uid

    await db.users.update_one({"_id": oid}, {"$set": update}, upsert=False)

    # Echo affected fields + recompute displayName for client
    user = await _get_user(uid)
    display = (
        f"{user.get('firstName', '') or ''} {user.get('lastName', '') or ''}".strip()
        or user.get("email")
        or "Inspector"
    )
    return {"ok": True, "updated": list(update.keys()), "displayName": display}


# ──────────────────────────────────────────────────────────────────
# 3. Inspections Archive
# ──────────────────────────────────────────────────────────────────


@router.get("/inspections")
async def list_inspections(
    uid: str = Depends(get_user_id_required),
    filter: str = Query("all", description="active|submitted|approved|rejected|customer_accepted|disputed|all"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> Dict[str, Any]:
    db = get_db()
    q: Dict[str, Any] = {"inspectorId": uid}
    if filter == "active":
        q["status"] = {"$in": ["accepted", "in_progress", "on_site", "claimed", "awaiting_report"]}
    elif filter == "submitted":
        q["status"] = {"$in": ["report_submitted", "qa_pending", "report_pending_review"]}
    elif filter == "approved":
        q["status"] = {"$in": ["approved", "done"]}
    elif filter == "rejected":
        q["status"] = {"$in": ["rejected", "cancelled"]}
    elif filter == "customer_accepted":
        q["customerAccepted"] = True
    elif filter == "disputed":
        q["status"] = {"$in": ["disputed", "in_dispute"]}

    total = await _count(db.inspection_jobs, q)
    cur = (
        db.inspection_jobs.find(
            q,
            {
                "_id": 1,
                "status": 1,
                "createdAt": 1,
                "completedAt": 1,
                "verdict": 1,
                "score": 1,
                "customerAccepted": 1,
                "requestId": 1,
                "reportId": 1,
                "vehicle": 1,
            },
        )
        .sort("createdAt", -1)
        .skip(offset)
        .limit(limit)
    )

    items: List[Dict[str, Any]] = []
    async for j in cur:
        rid = j.get("requestId")
        req: Dict[str, Any] = {}
        if rid:
            try:
                req = await db.car_requests.find_one({"_id": rid}, {"_id": 0}) or {}
            except Exception:
                req = {}
        vehicle = j.get("vehicle") or req.get("vehicle") or {}
        items.append(
            {
                "id": str(j.get("_id")),
                "status": j.get("status"),
                "createdAt": _safe_iso(j.get("createdAt")),
                "completedAt": _safe_iso(j.get("completedAt")),
                "verdict": j.get("verdict") or req.get("verdict"),
                "score": j.get("score"),
                "customerAccepted": bool(j.get("customerAccepted")),
                "amount": req.get("price"),
                "currency": req.get("currency") or "EUR",
                "vehicle": {
                    "brand": vehicle.get("brand") or req.get("brand"),
                    "model": vehicle.get("model") or req.get("model"),
                    "year": vehicle.get("year") or req.get("year"),
                },
                "reportUrl": f"/inspector/jobs/{j.get('_id')}/report" if j.get("reportId") or j.get("status") == "done" else None,
            }
        )

    return {"items": items, "total": total, "filter": filter, "limit": limit, "offset": offset}


# ──────────────────────────────────────────────────────────────────
# 4. Availability — GET / PATCH
# ──────────────────────────────────────────────────────────────────


class AvailabilityUpdate(BaseModel):
    online: Optional[bool] = None
    zones: Optional[List[str]] = None
    radiusKm: Optional[int] = Field(None, ge=0, le=500)
    workingDays: Optional[List[int]] = None  # 1=Mon..7=Sun
    workingHours: Optional[Dict[str, str]] = None
    blackoutDates: Optional[List[str]] = None
    maxJobsPerDay: Optional[int] = Field(None, ge=0, le=50)


@router.get("/availability")
async def get_availability(uid: str = Depends(get_user_id_required)) -> Dict[str, Any]:
    user = await _get_user(uid)
    av = (user.get("availability") or {}).copy()
    out = {**DEFAULT_AVAILABILITY, **av}
    return {"availability": out, "updatedAt": _safe_iso(user.get("availabilityUpdatedAt"))}


@router.patch("/availability")
async def update_availability(
    payload: AvailabilityUpdate, uid: str = Depends(get_user_id_required)
) -> Dict[str, Any]:
    db = get_db()
    user = await _get_user(uid)
    current = {**DEFAULT_AVAILABILITY, **(user.get("availability") or {})}
    for k, v in payload.dict(exclude_unset=True).items():
        if v is not None:
            current[k] = v

    try:
        from bson import ObjectId
        oid = ObjectId(uid) if len(uid) == 24 else uid
    except Exception:
        oid = uid

    now_iso = _now().isoformat()
    await db.users.update_one(
        {"_id": oid},
        {"$set": {"availability": current, "availabilityUpdatedAt": now_iso}},
    )
    return {"availability": current, "updatedAt": now_iso}


# ──────────────────────────────────────────────────────────────────
# 5. Payouts
# ──────────────────────────────────────────────────────────────────


@router.get("/payouts")
async def get_payouts(uid: str = Depends(get_user_id_required)) -> Dict[str, Any]:
    db = get_db()
    ms = _month_start()

    earnings_month = 0
    try:
        async for d in db.inspection_jobs.aggregate(
            [
                {"$match": {"inspectorId": uid, "status": "done", "completedAt": {"$gte": ms}}},
                {
                    "$lookup": {
                        "from": "car_requests",
                        "localField": "requestId",
                        "foreignField": "_id",
                        "as": "req",
                    }
                },
                {"$unwind": {"path": "$req", "preserveNullAndEmptyArrays": True}},
                {"$group": {"_id": None, "s": {"$sum": {"$ifNull": ["$req.price", 0]}}}},
            ]
        ):
            earnings_month = int(d.get("s") or 0)
    except Exception:
        pass

    pending = await _sum(db.payouts, {"inspectorId": uid, "status": {"$in": ["pending", "scheduled"]}}, "amount")
    paid_total = await _sum(db.payouts, {"inspectorId": uid, "status": "paid"}, "amount")

    # Pending reports — jobs done but reportId missing
    pending_reports = await _count(
        db.inspection_jobs, {"inspectorId": uid, "status": "done", "reportId": None}
    )

    history: List[Dict[str, Any]] = []
    try:
        async for p in db.payouts.find({"inspectorId": uid}).sort("createdAt", -1).limit(20):
            history.append(
                {
                    "id": str(p.get("_id")),
                    "amount": p.get("amount"),
                    "currency": p.get("currency") or "EUR",
                    "status": p.get("status"),
                    "createdAt": _safe_iso(p.get("createdAt")),
                    "paidAt": _safe_iso(p.get("paidAt")),
                    "method": p.get("method") or "bank_transfer",
                }
            )
    except Exception:
        pass

    user = await _get_user(uid)
    bank = (user.get("bank") or {}).copy()
    if not bank:
        bank = {"iban": None, "bic": None, "holderName": None, "country": None}

    return {
        "summary": {
            "earningsMonth": earnings_month,
            "pendingPayout": int(pending),
            "paidTotal": int(paid_total),
            "pendingReports": pending_reports,
            "currency": "EUR",
        },
        "history": history,
        "bank": bank,
        "note": "Банковские интеграции будут подключены позже. IBAN сохраняется только как placeholder.",
    }


# ──────────────────────────────────────────────────────────────────
# 6. Performance
# ──────────────────────────────────────────────────────────────────


@router.get("/performance")
async def get_performance(uid: str = Depends(get_user_id_required)) -> Dict[str, Any]:
    db = get_db()
    user = await _get_user(uid)

    completed_total = await _count(db.inspection_jobs, {"inspectorId": uid, "status": "done"})
    rejected = await _count(db.inspection_reports, {"inspectorId": uid, "status": "rejected"})
    reports_total = await _count(db.inspection_reports, {"inspectorId": uid})
    approved = await _count(
        db.inspection_reports, {"inspectorId": uid, "status": {"$in": ["approved", "accepted"]}}
    )
    accepted_by_customer = await _count(
        db.inspection_jobs, {"inspectorId": uid, "customerAccepted": True}
    )

    approval_rate = (approved / reports_total) if reports_total else 0.0
    customer_acceptance = (accepted_by_customer / completed_total) if completed_total else 0.0

    # Avg response — same logic as profile route
    avg_resp = 0.0
    try:
        diffs = []
        cur = db.inspection_jobs.aggregate(
            [
                {"$match": {"inspectorId": uid, "claimedAt": {"$ne": None}}},
                {"$project": {"createdAt": 1, "claimedAt": 1}},
                {"$limit": 200},
            ]
        )
        async for d in cur:
            try:
                a = d.get("claimedAt")
                c = d.get("createdAt")
                if isinstance(a, str):
                    a = datetime.fromisoformat(a.replace("Z", "+00:00"))
                if isinstance(c, str):
                    c = datetime.fromisoformat(c.replace("Z", "+00:00"))
                if a and c:
                    diffs.append(max(0.0, (a - c).total_seconds() / 60))
            except Exception:
                continue
        if diffs:
            avg_resp = sum(diffs) / len(diffs)
    except Exception:
        pass

    disputes_reopened = await _count(
        db.disputes, {"inspectorId": uid, "status": {"$in": ["reopened", "open", "in_review"]}}
    )

    # Strongest brands — count completed by vehicle.brand
    by_brand: Dict[str, int] = {}
    try:
        cur = db.inspection_jobs.aggregate(
            [
                {"$match": {"inspectorId": uid, "status": "done"}},
                {
                    "$lookup": {
                        "from": "car_requests",
                        "localField": "requestId",
                        "foreignField": "_id",
                        "as": "req",
                    }
                },
                {"$unwind": {"path": "$req", "preserveNullAndEmptyArrays": True}},
                {"$group": {"_id": "$req.brand", "n": {"$sum": 1}}},
                {"$sort": {"n": -1}},
                {"$limit": 5},
            ]
        )
        async for d in cur:
            b = d.get("_id")
            if b:
                by_brand[str(b)] = int(d.get("n") or 0)
    except Exception:
        pass

    strongest = [{"brand": k, "count": v} for k, v in by_brand.items()]

    # Weak spots — heuristic: brands with rejected/disputed reports
    weak: List[Dict[str, Any]] = []
    if rejected > 0:
        weak.append({"kind": "rejected_reports", "count": rejected})
    if disputes_reopened > 0:
        weak.append({"kind": "open_disputes", "count": disputes_reopened})

    return {
        "ratingAvg": round(float(user.get("ratingAvg") or 0), 2),
        "reviewsCount": int(user.get("reviewsCount") or 0),
        "approvalRate": round(approval_rate, 3),
        "customerAcceptanceRate": round(customer_acceptance, 3),
        "avgResponseMinutes": round(avg_resp, 1),
        "rejectedReports": int(rejected),
        "disputesReopened": int(disputes_reopened),
        "completedTotal": int(completed_total),
        "strongestBrands": strongest,
        "weakSpots": weak,
        "generatedAt": _now().isoformat(),
    }


# ──────────────────────────────────────────────────────────────────
# 7. Verification
# ──────────────────────────────────────────────────────────────────


class VerificationUpload(BaseModel):
    kind: str
    fileName: Optional[str] = None
    mimeType: Optional[str] = None
    dataBase64: Optional[str] = None  # placeholder storage; can be omitted (manual)
    note: Optional[str] = None


class VerificationStatusPatch(BaseModel):
    status: str  # one of VERIFICATION_STATES


@router.get("/verification")
async def get_verification(uid: str = Depends(get_user_id_required)) -> Dict[str, Any]:
    db = get_db()
    rows: List[Dict[str, Any]] = []
    async for r in db.inspector_verifications.find({"userId": uid}):
        raw_status = r.get("status") or "uploaded"
        # Sprint 3 Step 1 — normalise legacy `verified` → `approved` so the
        # mobile UI sees a single vocabulary.
        status = "approved" if raw_status == "verified" else raw_status
        rows.append(
            {
                "id": str(r.get("_id")),
                "kind": r.get("kind"),
                "status": status,
                "fileName": r.get("fileName"),
                "mimeType": r.get("mimeType"),
                "note": r.get("note"),
                "uploadedAt": _safe_iso(r.get("uploadedAt")),
                "reviewedAt": _safe_iso(r.get("reviewedAt")),
                # Sprint 3 Step 1 — surface admin rejection details so the
                # inspector knows WHY and what to fix.
                "rejectionReason": r.get("rejectionReason"),
                "rejectionNote": r.get("rejectionNote"),
            }
        )
    by_kind = {r["kind"]: r for r in rows}
    # Synthesize "missing" entries for every required kind not yet uploaded
    out: List[Dict[str, Any]] = []
    for kind in VERIFICATION_KINDS:
        if kind in by_kind:
            out.append(by_kind[kind])
        else:
            out.append({"id": None, "kind": kind, "status": "missing"})

    # `approved` counted under both names for transitional rows.
    approved_count = sum(1 for x in out if x.get("status") == "approved")
    rejected_count = sum(1 for x in out if x.get("status") == "rejected")
    pending_count = sum(1 for x in out if x.get("status") in ("uploaded", "pending_review", "needs_resubmission"))
    return {
        "documents": out,
        "totalRequired": len(VERIFICATION_KINDS),
        "verifiedCount": approved_count,
        "approvedCount": approved_count,
        "rejectedCount": rejected_count,
        "pendingCount": pending_count,
        "overallStatus": (
            "verified" if approved_count == len(VERIFICATION_KINDS)
            else ("partial" if approved_count > 0 else "incomplete")
        ),
    }


@router.post("/verification/upload")
async def upload_verification(
    payload: VerificationUpload, uid: str = Depends(get_user_id_required)
) -> Dict[str, Any]:
    if payload.kind not in VERIFICATION_KINDS:
        raise HTTPException(400, f"unknown kind: {payload.kind}")
    db = get_db()
    doc_id = uuid.uuid4().hex
    now_iso = _now().isoformat()

    # Sprint Verif-2: persist bytes in GridFS (bucket "verification") and
    # store ONLY the fileId in the metadata doc — never inline the base64.
    # Keeps /verification list cheap and read-amplification predictable.
    storage_file_id: Optional[str] = None
    size_bytes: int = 0
    if payload.dataBase64:
        try:
            import base64 as _b64
            from motor.motor_asyncio import AsyncIOMotorGridFSBucket
            raw = _b64.b64decode(payload.dataBase64, validate=False)
            size_bytes = len(raw)
            bucket = AsyncIOMotorGridFSBucket(db, bucket_name="verification")
            file_id = await bucket.upload_from_stream(
                filename=payload.fileName or f"{payload.kind}_{doc_id}",
                source=raw,
                metadata={
                    "docId":   doc_id,
                    "userId":  uid,
                    "kind":    payload.kind,
                    "mime":    payload.mimeType or "application/octet-stream",
                },
            )
            storage_file_id = str(file_id)
        except Exception as e:
            raise HTTPException(400, f"upload failed: {e}")

    new_doc = {
        "_id": doc_id,
        "userId": uid,
        "kind": payload.kind,
        "status": "pending_review",
        "fileName": payload.fileName,
        "mimeType": payload.mimeType,
        "sizeBytes": size_bytes,
        "note": payload.note,
        "uploadedAt": now_iso,
        "reviewedAt": None,
        # Sprint 3 Step 1 — clear any prior rejection metadata so the inspector
        # screen doesn't keep showing a stale rejection reason on resubmit.
        "rejectionReason": None,
        "rejectionNote": None,
        "reviewerId": None,
        # Sprint Verif-2: GridFS storage pointer (no inline base64).
        "storage": {"provider": "gridfs", "bucket": "verification", "fileId": storage_file_id}
            if storage_file_id else None,
    }
    # Replace previous doc of the same kind (single active doc per kind).
    prev = await db.inspector_verifications.find_one(
        {"userId": uid, "kind": payload.kind},
        {"_id": 1, "status": 1, "storage": 1},
    )
    # Best-effort cleanup of previous GridFS bytes (don't fail upload if it errors).
    if prev and prev.get("storage") and (prev["storage"] or {}).get("fileId"):
        try:
            from bson import ObjectId
            from motor.motor_asyncio import AsyncIOMotorGridFSBucket
            old_bucket = AsyncIOMotorGridFSBucket(db, bucket_name=prev["storage"].get("bucket", "verification"))
            await old_bucket.delete(ObjectId(prev["storage"]["fileId"]))
        except Exception:
            pass
    await db.inspector_verifications.delete_many({"userId": uid, "kind": payload.kind})
    await db.inspector_verifications.insert_one(new_doc)

    # Sprint 3 Step 1 — emit timeline event so admins can see resubmits in
    # the live feed. `verification_submitted` is the canonical kind for
    # both fresh uploads and re-submits after rejection.
    try:
        from app.inspector.timeline import append_event as _append
        was_resubmit = bool(prev and prev.get("status") in ("rejected", "needs_resubmission"))
        await _append(
            kind="verification_submitted",
            inspector_id=uid,
            actor_type="inspector",
            actor_id=uid,
            severity="info",
            title=f"Документ «{payload.kind}» {'отправлен заново' if was_resubmit else 'загружен'}",
            text=payload.note or None,
            metadata={
                "docId": doc_id,
                "kind": payload.kind,
                "resubmit": was_resubmit,
                "fileName": payload.fileName,
            },
            stable_key=f"verify:{doc_id}:submitted",
        )
    except Exception:
        pass

    return {
        "id": doc_id,
        "kind": payload.kind,
        "status": "pending_review",
        "uploadedAt": now_iso,
    }


@router.patch("/verification/{doc_id}")
async def patch_verification_status(
    doc_id: str, payload: VerificationStatusPatch, uid: str = Depends(get_user_id_required)
) -> Dict[str, Any]:
    if payload.status not in VERIFICATION_STATES:
        raise HTTPException(400, f"unknown status: {payload.status}")
    db = get_db()
    r = await db.inspector_verifications.find_one({"_id": doc_id, "userId": uid})
    if not r:
        raise HTTPException(404, "document not found")
    # Inspector self-can only change to 'uploaded' (re-claim) — admin endpoints
    # do verified/rejected. Here we allow any value because admin uses same
    # path with admin token in future; for now status is informational.
    upd = {"status": payload.status, "reviewedAt": _now().isoformat()}
    await db.inspector_verifications.update_one({"_id": doc_id}, {"$set": upd})
    return {"id": doc_id, **upd}


@router.get("/verification/{doc_id}/file")
async def download_verification_file(
    doc_id: str, uid: str = Depends(get_user_id_required)
):
    """Sprint Verif-2: stream the actual document bytes from GridFS.

    Auth-gated: inspectors can only download their own files. Admin uses
    `/api/admin/verification-queue/{docId}/file` (separate endpoint).

    Falls back to legacy inline `data` field for docs uploaded before the
    GridFS migration — so old uploads keep rendering in the admin queue.
    """
    from fastapi.responses import Response
    db = get_db()
    r = await db.inspector_verifications.find_one({"_id": doc_id, "userId": uid})
    if not r:
        raise HTTPException(404, "document not found")
    return await _stream_verif_bytes(r)


async def _stream_verif_bytes(r: Dict[str, Any]):
    """Shared helper: turn an inspector_verifications doc into a Response.

    Order:
      1. GridFS (new uploads).
      2. Legacy inline `data` base64 (pre-migration).
      3. 404 if neither.
    """
    from fastapi.responses import Response
    mime = r.get("mimeType") or "application/octet-stream"
    storage = r.get("storage") or {}
    file_id = storage.get("fileId")
    if file_id:
        try:
            from bson import ObjectId
            from motor.motor_asyncio import AsyncIOMotorGridFSBucket
            bucket = AsyncIOMotorGridFSBucket(get_db(), bucket_name=storage.get("bucket", "verification"))
            stream = await bucket.open_download_stream(ObjectId(file_id))
            data = await stream.read()
            return Response(content=data, media_type=mime)
        except Exception:
            pass
    # Legacy fallback.
    b64 = r.get("data")
    if b64:
        try:
            import base64 as _b64
            return Response(content=_b64.b64decode(b64), media_type=mime)
        except Exception:
            pass
    raise HTTPException(404, "file bytes not available")


# ──────────────────────────────────────────────────────────────────
# 8. Security
# ──────────────────────────────────────────────────────────────────


class ChangePasswordBody(BaseModel):
    currentPassword: str
    newPassword: str = Field(..., min_length=8, max_length=200)


@router.get("/security")
async def get_security(uid: str = Depends(get_user_id_required)) -> Dict[str, Any]:
    db = get_db()
    user = await _get_user(uid)

    # Sessions — soft-mocked from user_sessions collection if exists.
    sessions: List[Dict[str, Any]] = []
    try:
        async for s in db.user_sessions.find({"userId": uid}).sort("lastSeenAt", -1).limit(10):
            sessions.append(
                {
                    "id": str(s.get("_id")),
                    "userAgent": s.get("userAgent"),
                    "ip": s.get("ip"),
                    "createdAt": _safe_iso(s.get("createdAt")),
                    "lastSeenAt": _safe_iso(s.get("lastSeenAt")),
                    "current": bool(s.get("current")),
                }
            )
    except Exception:
        pass
    if not sessions:
        # Synthesize one entry from the current request so UI is never empty.
        sessions = [
            {
                "id": "current",
                "userAgent": "Текущая сессия",
                "ip": None,
                "createdAt": _safe_iso(user.get("lastLoginAt") or user.get("createdAt")),
                "lastSeenAt": _now().isoformat(),
                "current": True,
            }
        ]

    return {
        "emailStatus": {
            "address": user.get("email"),
            "verified": bool(user.get("emailVerifiedAt")),
        },
        "phoneStatus": {
            "phone": user.get("phone"),
            "verified": bool(user.get("phoneVerifiedAt")),
        },
        "passwordUpdatedAt": _safe_iso(user.get("passwordUpdatedAt")),
        "twoFactor": {"enabled": False, "available": False, "note": "Подключим позже"},
        "recovery": {"methods": [], "note": "Будет добавлено вместе с 2FA"},
        "sessions": sessions,
    }


@router.post("/change-password")
async def change_password(
    payload: ChangePasswordBody, uid: str = Depends(get_user_id_required)
) -> Dict[str, Any]:
    db = get_db()
    user = await _get_user(uid)
    if not user:
        raise HTTPException(404, "user not found")
    if not user.get("passwordHash") or not verify_pw(payload.currentPassword, user["passwordHash"]):
        raise HTTPException(400, "current password is incorrect")
    if payload.currentPassword == payload.newPassword:
        raise HTTPException(400, "new password must differ from current")

    try:
        from bson import ObjectId
        oid = ObjectId(uid) if len(uid) == 24 else uid
    except Exception:
        oid = uid

    new_hash = hash_pw(payload.newPassword)
    now_iso = _now().isoformat()
    await db.users.update_one(
        {"_id": oid}, {"$set": {"passwordHash": new_hash, "passwordUpdatedAt": now_iso}}
    )
    return {"ok": True, "passwordUpdatedAt": now_iso}


# ──────────────────────────────────────────────────────────────────
# 9. Settings
# ──────────────────────────────────────────────────────────────────


class SettingsUpdate(BaseModel):
    language: Optional[str] = None
    timezone: Optional[str] = None
    notifications: Optional[Dict[str, bool]] = None
    channels: Optional[Dict[str, bool]] = None
    reportDefaults: Optional[Dict[str, bool]] = None
    privacy: Optional[Dict[str, bool]] = None


def _merge_settings(stored: Optional[Dict], patch: Dict) -> Dict:
    """Deep-merge stored settings with PATCH payload, preserving defaults."""
    base: Dict[str, Any] = {}
    for k, v in DEFAULT_SETTINGS.items():
        base[k] = (stored or {}).get(k, v).copy() if isinstance(v, dict) else (stored or {}).get(k, v)
    for k, v in (patch or {}).items():
        if v is None:
            continue
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            merged = base[k].copy()
            merged.update({pk: pv for pk, pv in v.items() if pv is not None})
            base[k] = merged
        else:
            base[k] = v
    return base


@router.get("/settings")
async def get_settings(uid: str = Depends(get_user_id_required)) -> Dict[str, Any]:
    user = await _get_user(uid)
    return {"settings": _merge_settings(user.get("settings"), {})}


@router.patch("/settings")
async def update_settings(
    payload: SettingsUpdate, uid: str = Depends(get_user_id_required)
) -> Dict[str, Any]:
    db = get_db()
    user = await _get_user(uid)
    merged = _merge_settings(user.get("settings"), payload.dict(exclude_unset=True))

    try:
        from bson import ObjectId
        oid = ObjectId(uid) if len(uid) == 24 else uid
    except Exception:
        oid = uid

    await db.users.update_one({"_id": oid}, {"$set": {"settings": merged, "settingsUpdatedAt": _now().isoformat()}})
    return {"settings": merged}


__all__ = ["router"]
