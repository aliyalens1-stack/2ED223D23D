"""Inspector operating profile — identity + trust + capability snapshot.

GET /api/inspector/profile

Это «operating identity», не settings page. Read-only. Все секции
толерантны к отсутствию данных (новый инспектор без репутации ≠ 500).

Контракт:
  {
    identity:    { id, displayName, email, phone, city, role, joinedAt, avatar, language },
    trust:       { completedTotal, completedMonth, ratingAvg, reviewsCount,
                   approvalRate, avgResponseMinutes, disputesReopened,
                   verified, status },
    capability:  { brands, languages, tools },               // placeholders, заполняются позже
    availability:{ available, workingRadiusKm, zones },     // placeholders
    documents:   { passport, insurance, taxId, business },  // status flags
    financial:   { earningsMonth, pendingPayout, currency }
  }
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict

from fastapi import APIRouter, Depends

from app.auto_requests.auth import get_user_id_required
from app.core.db import get_db


router = APIRouter(prefix="/api/inspector", tags=["inspector:profile"])


def _safe_iso(v: Any) -> str | None:
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


async def _count(coll, q):
    try:
        return await coll.count_documents(q)
    except Exception:
        return 0


@router.get("/profile")
async def my_profile(uid: str = Depends(get_user_id_required)) -> Dict[str, Any]:
    db = get_db()

    # ── User document
    try:
        from bson import ObjectId
        user_oid = ObjectId(uid) if len(uid) == 24 else uid
    except Exception:
        user_oid = uid
    user_doc: Dict[str, Any] = await db.users.find_one({"_id": user_oid}) or {}

    # ── Active account (preferred displayName / status / verified)
    acc: Dict[str, Any] = (
        await db.accounts.find_one({"userId": uid, "kind": "inspector"})
        or await db.accounts.find_one({"userId": uid})
        or {}
    )

    # ── Organization (legacy provider model — keeps ratingAvg / verified)
    org: Dict[str, Any] = await db.organizations.find_one({"_id": uid}) or {}

    # ── Identity ─────────────────────────────────────────────
    first = user_doc.get("firstName") or ""
    last = user_doc.get("lastName") or ""
    display = (
        acc.get("displayName")
        or (f"{first} {last}".strip())
        or user_doc.get("email")
        or "Inspector"
    )
    identity = {
        "id": str(user_oid),
        "displayName": display,
        "firstName": first or None,
        "lastName": last or None,
        "email": user_doc.get("email"),
        "phone": user_doc.get("phone") or org.get("phone"),
        "city": user_doc.get("city") or org.get("city"),
        "role": user_doc.get("role") or acc.get("kind") or "inspector",
        "joinedAt": _safe_iso(user_doc.get("createdAt") or acc.get("createdAt")),
        "avatar": user_doc.get("avatar") or acc.get("avatar"),
        "language": user_doc.get("language") or "ru",
    }

    # ── Trust ────────────────────────────────────────────────
    completed_total = await _count(
        db.inspection_jobs, {"inspectorId": uid, "status": "done"}
    )

    # Same-month completed (matches /stats)
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    completed_month = await _count(
        db.inspection_jobs,
        {"inspectorId": uid, "status": "done", "completedAt": {"$gte": month_start}},
    )

    # Rating: prefer organization stat, fall back to user-level cache, fall back to account.stats
    rating_avg = float(
        org.get("ratingAvg")
        or user_doc.get("ratingAvg")
        or (acc.get("stats") or {}).get("rating")
        or 0
    )
    reviews_count = int(
        org.get("reviewsCount")
        or user_doc.get("reviewsCount")
        or (acc.get("stats") or {}).get("reviewsCount")
        or 0
    )

    # Approval rate: reports approved / total submitted
    reports_total = await _count(db.inspection_reports, {"inspectorId": uid})
    reports_approved = await _count(
        db.inspection_reports, {"inspectorId": uid, "status": {"$in": ["approved", "accepted"]}}
    )
    approval_rate = (reports_approved / reports_total) if reports_total else 0.0

    # Avg response time — minutes between job createdAt and claimedAt for this inspector.
    avg_resp_min = 0.0
    try:
        pipe = [
            {"$match": {"inspectorId": uid, "claimedAt": {"$ne": None}}},
            {
                "$project": {
                    "claimedAt": 1,
                    "createdAt": 1,
                }
            },
            {"$limit": 200},  # last 200 jobs is plenty for avg
        ]
        diffs: list[float] = []
        async for d in db.inspection_jobs.aggregate(pipe):
            try:
                c = d.get("createdAt")
                a = d.get("claimedAt")
                if isinstance(c, str):
                    c = datetime.fromisoformat(c.replace("Z", "+00:00"))
                if isinstance(a, str):
                    a = datetime.fromisoformat(a.replace("Z", "+00:00"))
                if c and a:
                    diffs.append(max(0.0, (a - c).total_seconds() / 60))
            except Exception:
                continue
        if diffs:
            avg_resp_min = sum(diffs) / len(diffs)
    except Exception:
        pass

    disputes_reopened = await _count(
        db.disputes,
        {"inspectorId": uid, "status": {"$in": ["reopened", "in_review", "open"]}},
    )

    verified = bool(
        org.get("verifiedAt")
        or user_doc.get("verifiedAt")
        or (acc.get("status") == "active" and acc.get("kind") == "inspector")
    )
    trust = {
        "completedTotal": int(completed_total),
        "completedMonth": int(completed_month),
        "ratingAvg": round(rating_avg, 2),
        "reviewsCount": int(reviews_count),
        "approvalRate": round(approval_rate, 3),
        "avgResponseMinutes": round(avg_resp_min, 1),
        "disputesReopened": int(disputes_reopened),
        "verified": verified,
        "status": acc.get("status") or ("active" if verified else "pending"),
    }

    # ── Capability — placeholders for future matching engine ─
    capability = {
        "brands": user_doc.get("brands") or org.get("brands") or [],
        "languages": user_doc.get("languages") or [identity["language"]],
        "tools": user_doc.get("tools") or org.get("tools") or [],
    }

    # ── Availability — placeholder for calendar/zones layer ──
    availability = {
        "available": bool(user_doc.get("isOnline") or org.get("isOnline")),
        "workingRadiusKm": int(user_doc.get("workingRadiusKm") or org.get("workingRadiusKm") or 0),
        "zones": user_doc.get("zones") or org.get("zones") or [],
    }

    # ── Documents — verification flags ────────────────────────
    docs_raw = user_doc.get("documents") or org.get("documents") or {}
    documents = {
        "passport": bool(docs_raw.get("passport") or user_doc.get("passportVerified")),
        "insurance": bool(docs_raw.get("insurance")),
        "taxId": bool(docs_raw.get("taxId") or user_doc.get("taxId")),
        "business": bool(docs_raw.get("business") or org.get("verifiedAt")),
    }

    # ── Financial — month earnings + pending payouts ──────────
    earnings_month = 0
    try:
        rows = await db.inspection_jobs.aggregate(
            [
                {
                    "$match": {
                        "inspectorId": uid,
                        "status": "done",
                        "completedAt": {"$gte": month_start},
                    }
                },
                {
                    "$lookup": {
                        "from": "car_requests",
                        "localField": "requestId",
                        "foreignField": "_id",
                        "as": "req",
                    }
                },
                {"$unwind": {"path": "$req", "preserveNullAndEmptyArrays": True}},
                {"$group": {"_id": None, "earnings": {"$sum": {"$ifNull": ["$req.price", 0]}}}},
            ]
        ).to_list(1)
        if rows:
            earnings_month = int(rows[0].get("earnings") or 0)
    except Exception:
        pass

    pending_payout = 0
    try:
        rows = await db.payouts.aggregate(
            [
                {"$match": {"inspectorId": uid, "status": {"$in": ["pending", "scheduled"]}}},
                {"$group": {"_id": None, "amount": {"$sum": {"$ifNull": ["$amount", 0]}}}},
            ]
        ).to_list(1)
        if rows:
            pending_payout = int(rows[0].get("amount") or 0)
    except Exception:
        pass

    financial = {
        "earningsMonth": earnings_month,
        "pendingPayout": pending_payout,
        "currency": "EUR",
    }

    return {
        "identity": identity,
        "trust": trust,
        "capability": capability,
        "availability": availability,
        "documents": documents,
        "financial": financial,
        "generatedAt": now.isoformat(),
    }


__all__ = ["router"]
