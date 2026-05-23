"""Sprint 5 — Trust HTTP surface.

Endpoints (all prefixed /api):

    Customer / Provider (auth required, mutual)
        POST /api/trust/reviews                   — submit review for a request
        GET  /api/trust/reviews/pending           — list my requests awaiting review
        GET  /api/trust/reviews/by-request/{rid}  — see what's submitted/revealed

    Public
        GET  /api/trust/providers/{provider_id}              — full trust card
        GET  /api/trust/providers/{provider_id}/reviews      — revealed reviews list

    Admin (viewer only — no moderation in P1)
        GET  /api/admin/trust/reviews             — all reviews (latest first)
        POST /api/admin/trust/recompute/{provider_id}  — manual recompute
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.core.db import get_db
from app.core.security import verify_admin_token, verify_user_token
# P6.B.3 — Attribution wiring.
from app.core.attribution import (
    AttributionContext,
    get_attribution_context,
    record_admin_mutation,
)
from app.provider_trust.engine import (
    ALL_TAGS,
    POSITIVE_TAGS,
    REVEAL_TIMEOUT_HOURS,
    now_iso,
    recompute_provider_reputation,
    try_reveal_pair,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ─────────────────────────────────────────────────────────────────────
# Pydantic models
# ─────────────────────────────────────────────────────────────────────

class ReviewSubmitBody(BaseModel):
    requestId: str = Field(..., min_length=1)
    rating: int = Field(..., ge=1, le=5)
    tags: List[str] = Field(default_factory=list, max_length=6)
    comment: Optional[str] = Field(None, max_length=1000)


class TrustCard(BaseModel):
    """Public-safe slice of provider_reputation."""
    providerId: str
    avgRating: Optional[float]
    totalReviews: int
    completedJobs: int
    completionRate: Optional[float]
    avgResponseMinutes: Optional[int]
    repeatCustomers: int
    subscriptionTier: str
    badges: List[str]
    tagCounts: Dict[str, int] = Field(default_factory=dict)


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

def _uid() -> str:
    return uuid.uuid4().hex


async def _load_request(db, request_id: str) -> dict:
    """Find the service_request by id. 404 if missing."""
    req = await db.service_requests.find_one({"id": request_id}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Service request not found")
    return req


def _validate_tags(tags: List[str]) -> List[str]:
    """Whitelist tags; drop unknowns silently to keep client UX forgiving."""
    return [t for t in (tags or []) if t in ALL_TAGS][:6]


def _empty_card(provider_id: str) -> Dict[str, Any]:
    """Neutral card for providers without aggregate yet (cold start)."""
    return {
        "providerId": provider_id,
        "avgRating": None,
        "totalReviews": 0,
        "completedJobs": 0,
        "cancelledJobs": 0,
        "completionRate": None,
        "avgResponseMinutes": None,
        "repeatCustomers": 0,
        "subscriptionTier": "free",
        "badges": [],
        "tagCounts": {},
        "rankMultiplier": 1.0,
        "updatedAt": None,
    }


# ─────────────────────────────────────────────────────────────────────
# POST /api/trust/reviews — submit
# ─────────────────────────────────────────────────────────────────────

@router.post("/api/trust/reviews")
async def submit_review(body: ReviewSubmitBody, request: Request):
    """Submit a review (customer→provider OR provider→customer).

    Preconditions:
        - Service request exists and status == 'released' (escrow released)
        - Caller is either customer or provider of that request
        - No prior review by caller for this request

    Behavior:
        - Insert immutable review record (visibility=pending)
        - Try to reveal pair (if counterparty already submitted)
        - On reveal: recompute provider_reputation aggregate
    """
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    if not user_id:
        raise HTTPException(401, "Unauthorized")

    db = get_db()
    req = await _load_request(db, body.requestId)

    if req.get("status") != "released":
        raise HTTPException(
            400,
            f"Cannot review yet: request status={req.get('status')}; need 'released'",
        )

    customer_id = req.get("customerId")
    provider_id = req.get("providerId")
    if not customer_id or not provider_id:
        raise HTTPException(400, "Request has no provider assigned")
    if customer_id == provider_id:
        raise HTTPException(400, "Self-review not allowed")

    if user_id == customer_id:
        author_role, target_role = "customer", "provider"
    elif user_id == provider_id:
        author_role, target_role = "provider", "customer"
    else:
        raise HTTPException(403, "Not a party of this request")

    # Idempotency: one review per (request, author_role).
    existing = await db.provider_reviews.find_one(
        {"requestId": body.requestId, "authorRole": author_role}, {"_id": 0}
    )
    if existing:
        raise HTTPException(409, "Review already submitted for this side")

    tags = _validate_tags(body.tags)
    now = now_iso()
    review = {
        "id": _uid(),
        "requestId": body.requestId,
        "providerId": provider_id,
        "customerId": customer_id,
        "authorRole": author_role,
        "authorId": user_id,
        "targetRole": target_role,
        "rating": body.rating,
        "tags": tags,
        "comment": (body.comment or "").strip()[:1000] or None,
        "visibility": "pending",
        "createdAt": now,
        "revealedAt": None,
    }

    try:
        await db.provider_reviews.insert_one(review)
    except Exception as e:
        # Race on unique index → 409
        if "duplicate" in str(e).lower() or "E11000" in str(e):
            raise HTTPException(409, "Review already submitted for this side")
        raise

    review.pop("_id", None)

    # Try to reveal both sides if counterparty already submitted.
    revealed = await try_reveal_pair(db, body.requestId)
    if revealed:
        await recompute_provider_reputation(db, provider_id)
        # Notify both parties that their reviews are visible.
        try:
            from app.notifications.emit import emit_notification
            await emit_notification(
                db=db, user_id=customer_id,
                kind="review_revealed",
                title="📣 Отзывы открыты",
                body="Вы и исполнитель оставили отзывы. Они теперь видны обоим.",
                severity="info",
                metadata={"requestId": body.requestId},
                action_url=f"/service-marketplace/{body.requestId}",
            )
            await emit_notification(
                db=db, user_id=provider_id,
                kind="review_revealed",
                title="📣 Отзывы открыты",
                body="Вы и клиент оставили отзывы. Они теперь видны обоим.",
                severity="info",
                metadata={"requestId": body.requestId},
                action_url=f"/service-marketplace/{body.requestId}",
            )
        except Exception as e:
            logger.warning(f"[trust] reveal notify failed: {e}")

    # Notify counterparty that they can now review (if not already done).
    try:
        from app.notifications.emit import emit_notification
        counter_id = provider_id if author_role == "customer" else customer_id
        counter_role_label = "клиент" if author_role == "provider" else "исполнитель"
        other_review = await db.provider_reviews.find_one(
            {"requestId": body.requestId, "authorRole": target_role}, {"_id": 0, "id": 1}
        )
        if not other_review:
            await emit_notification(
                db=db, user_id=counter_id,
                kind="review_invitation",
                title="⭐ Оцените сделку",
                body=f"Ваш {counter_role_label} уже оставил отзыв. Оставьте свой — оба будут видны после.",
                severity="info",
                metadata={"requestId": body.requestId},
                action_url=f"/review/post-escrow?requestId={body.requestId}",
            )
    except Exception as e:
        logger.warning(f"[trust] invite notify failed: {e}")

    return {
        "review": review,
        "revealed": revealed,
        "message": "Spasibo — отзыв принят" if not revealed else "Оба отзыва открыты",
    }


# ─────────────────────────────────────────────────────────────────────
# GET /api/trust/reviews/pending — my outstanding reviews
# ─────────────────────────────────────────────────────────────────────

@router.get("/api/trust/reviews/pending")
async def list_pending_reviews(request: Request):
    """Return list of released requests where current user hasn't reviewed yet.

    Used by mobile home / notifications panel to prompt "leave a review".
    """
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    if not user_id:
        raise HTTPException(401, "Unauthorized")

    db = get_db()
    # Find released requests where I'm a party.
    requests_cursor = db.service_requests.find(
        {
            "status": "released",
            "$or": [{"customerId": user_id}, {"providerId": user_id}],
        },
        {"_id": 0, "id": 1, "customerId": 1, "providerId": 1, "category": 1, "title": 1,
         "amount": 1, "completedAt": 1, "releasedAt": 1, "updatedAt": 1},
    ).sort("updatedAt", -1).limit(50)
    requests = await requests_cursor.to_list(length=50)
    if not requests:
        return {"items": []}

    request_ids = [r["id"] for r in requests]
    my_reviews_cursor = db.provider_reviews.find(
        {"requestId": {"$in": request_ids}, "authorId": user_id},
        {"_id": 0, "requestId": 1},
    )
    reviewed_ids = {r["requestId"] for r in await my_reviews_cursor.to_list(length=200)}

    pending = []
    for req in requests:
        if req["id"] in reviewed_ids:
            continue
        author_role = "customer" if user_id == req.get("customerId") else "provider"
        target_role = "provider" if author_role == "customer" else "customer"
        target_id = req.get("providerId") if author_role == "customer" else req.get("customerId")
        pending.append({
            "requestId": req["id"],
            "category": req.get("category"),
            "title": req.get("title"),
            "amount": req.get("amount"),
            "completedAt": req.get("completedAt") or req.get("releasedAt") or req.get("updatedAt"),
            "authorRole": author_role,
            "targetRole": target_role,
            "targetId": target_id,
        })

    return {"items": pending}


# ─────────────────────────────────────────────────────────────────────
# GET /api/trust/reviews/by-request/{rid}
# ─────────────────────────────────────────────────────────────────────

@router.get("/api/trust/reviews/by-request/{request_id}")
async def reviews_by_request(request_id: str, request: Request):
    """Return both sides' review state for a request.

    Pending side is masked unless the caller authored it.
    Visible to either party.
    """
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    db = get_db()
    req = await _load_request(db, request_id)

    if user_id not in (req.get("customerId"), req.get("providerId")):
        # Public access: only show revealed reviews, no pending content
        reviews = await db.provider_reviews.find(
            {"requestId": request_id, "visibility": "revealed"}, {"_id": 0}
        ).to_list(length=2)
        return {"requestId": request_id, "reviews": reviews, "isParty": False}

    raw = await db.provider_reviews.find(
        {"requestId": request_id}, {"_id": 0}
    ).to_list(length=2)
    out = []
    for r in raw:
        if r.get("visibility") == "pending" and r.get("authorId") != user_id:
            # Mask counterparty's pending review.
            out.append({
                "id": r["id"],
                "authorRole": r["authorRole"],
                "targetRole": r["targetRole"],
                "visibility": "pending",
                "createdAt": r.get("createdAt"),
            })
        else:
            out.append(r)
    return {"requestId": request_id, "reviews": out, "isParty": True}


# ─────────────────────────────────────────────────────────────────────
# GET /api/trust/providers/{provider_id} — public trust card
# ─────────────────────────────────────────────────────────────────────

@router.get("/api/trust/providers/{provider_id}")
async def get_trust_card(provider_id: str):
    """Return aggregate trust card for a provider (public, no auth)."""
    db = get_db()
    card = await db.provider_reputation.find_one({"providerId": provider_id}, {"_id": 0})
    if not card:
        return _empty_card(provider_id)
    return card


# ─────────────────────────────────────────────────────────────────────
# GET /api/trust/providers/{provider_id}/reviews — public list
# ─────────────────────────────────────────────────────────────────────

@router.get("/api/trust/providers/{provider_id}/reviews")
async def list_provider_reviews(
    provider_id: str,
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    """Public: list revealed customer→provider reviews about this provider."""
    db = get_db()
    cursor = db.provider_reviews.find(
        {
            "providerId": provider_id,
            "targetRole": "provider",
            "visibility": "revealed",
        },
        {"_id": 0, "authorId": 0, "customerId": 0},
    ).sort("revealedAt", -1).skip(offset).limit(limit)
    items = await cursor.to_list(length=limit)
    total = await db.provider_reviews.count_documents({
        "providerId": provider_id,
        "targetRole": "provider",
        "visibility": "revealed",
    })
    return {"items": items, "total": total, "limit": limit, "offset": offset}


# ─────────────────────────────────────────────────────────────────────
# Admin
# ─────────────────────────────────────────────────────────────────────

@router.get("/api/admin/trust/reviews")
async def admin_list_reviews(
    _: dict = Depends(verify_admin_token),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    provider_id: Optional[str] = Query(None),
):
    """Admin viewer — no moderation, just transparency."""
    db = get_db()
    q: Dict[str, Any] = {}
    if provider_id:
        q["providerId"] = provider_id
    cursor = db.provider_reviews.find(q, {"_id": 0}).sort("createdAt", -1).skip(offset).limit(limit)
    items = await cursor.to_list(length=limit)
    total = await db.provider_reviews.count_documents(q)
    return {"items": items, "total": total}


@router.post("/api/admin/trust/recompute/{provider_id}")
async def admin_recompute(provider_id: str, _: dict = Depends(verify_admin_token), ctx_attr: AttributionContext = Depends(get_attribution_context)):
    """Admin manual recompute (used after backfill)."""
    db = get_db()
    snap = await recompute_provider_reputation(db, provider_id)
    # P6.B.3 — Attribution.
    try:
        await record_admin_mutation(
            get_db(), ctx_attr,
            action="trust.recompute",
            domain="user",
            entity_id=str(provider_id),
        )
    except Exception as _attr_e:
        import logging as _lg
        _lg.getLogger(__name__).warning(f"[admin_recompute] attribution trust.recompute failed: {_attr_e}")
    return {"snapshot": snap}
