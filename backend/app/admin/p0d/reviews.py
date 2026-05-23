"""P0.d — Reviews admin moderation.

Endpoints (all under /api/admin/reviews-mod, to avoid clashing with
existing /api/admin/trust/reviews list endpoint in app.provider_trust):

    GET   /                            — list with filter (flagged|all|excluded)
    GET   /{review_id}                  — detail + audit history
    POST  /{review_id}/flag             — mark moderation:flagged
    POST  /{review_id}/restore          — flagged → moderation:visible (back live)
    POST  /{review_id}/exclude-rating   — keep visible but excludeFromRating=true
                                          (provider rating recomputed)

Storage:
    Reviews live in `provider_reviews` collection (see app.provider_trust).
    P0.d adds three immutable flags on each doc:
      - moderation:    'visible'|'flagged'        (default 'visible')
      - excludeFromRating: bool                   (default False)
      - moderationActorId / moderationAt          (last action stamp)

    Full timeline of moderation actions lives in `money_audit` (entity='review').

After /exclude-rating or /restore (which can toggle off the exclude flag),
provider's aggregated rating is recomputed via existing engine helper.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.core.db import get_db
from app.core.security import verify_admin_token
from app.core.attribution import (
    AttributionContext,
    get_attribution_context,
    record_admin_mutation,
)

from .audit import write_money_audit

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin/reviews-mod", tags=["admin:p0d:reviews"])


class AdminReviewFlag(BaseModel):
    reason: str = Field(..., min_length=1, max_length=500)
    note: Optional[str] = Field(None, max_length=2000)


class AdminReviewSimple(BaseModel):
    reason: Optional[str] = Field(None, max_length=500)
    note: Optional[str] = Field(None, max_length=2000)


class AdminReviewExclude(BaseModel):
    exclude: bool = Field(True, description="True to exclude from rating; False to re-include")
    reason: str = Field(..., min_length=1, max_length=500)
    note: Optional[str] = Field(None, max_length=2000)


def _actor_id(payload: Dict[str, Any]) -> str:
    return payload.get("sub") or payload.get("userId") or "unknown-admin"


async def _load_review(db, review_id: str) -> Dict[str, Any]:
    doc = await db.provider_reviews.find_one({"id": review_id}, {"_id": 0})
    if not doc:
        # Some legacy reviews may use other id fields.
        doc = await db.provider_reviews.find_one(
            {"$or": [{"reviewId": review_id}, {"_id": review_id}]},
            {"_id": 0},
        )
    if not doc:
        raise HTTPException(404, "Review not found")
    return doc


async def _recompute_provider_rating(db, provider_id: Optional[str]) -> None:
    """Best-effort: call the existing engine recompute helper if present."""
    if not provider_id:
        return
    try:
        from app.provider_trust.engine import recompute_reputation
        await recompute_reputation(db, provider_id)
    except Exception as e:
        logger.warning(f"[reviews-mod] recompute failed for {provider_id}: {e}")


# ──────────────────────────────────────────────────────────────────


@router.get("")
async def list_reviews_mod(
    filter: str = Query("all", description="all|flagged|excluded|visible"),
    provider_id: Optional[str] = Query(None, alias="providerId"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _: dict = Depends(verify_admin_token),
) -> Dict[str, Any]:
    db = get_db()
    q: Dict[str, Any] = {}
    if filter == "flagged":
        q["moderation"] = "flagged"
    elif filter == "excluded":
        q["excludeFromRating"] = True
    elif filter == "visible":
        q["$or"] = [{"moderation": "visible"}, {"moderation": {"$exists": False}}]
    if provider_id:
        q["providerId"] = provider_id

    total = await db.provider_reviews.count_documents(q)
    cursor = db.provider_reviews.find(q, {"_id": 0}).sort("createdAt", -1).skip(offset).limit(limit)
    items: List[Dict[str, Any]] = await cursor.to_list(limit)
    return {
        "items": items,
        "total": total,
        "limit": limit,
        "offset": offset,
        "filter": {"kind": filter, "providerId": provider_id},
    }


@router.get("/{review_id}")
async def get_review(
    review_id: str,
    _: dict = Depends(verify_admin_token),
) -> Dict[str, Any]:
    db = get_db()
    review = await _load_review(db, review_id)
    history_cursor = db.money_audit.find(
        {"entity": "review", "entityId": review_id},
        {"_id": 0},
    ).sort("timestamp", -1).limit(100)
    history = await history_cursor.to_list(100)
    return {"review": review, "history": history}


@router.post("/{review_id}/flag")
async def flag_review(
    review_id: str,
    body: AdminReviewFlag,
    admin: dict = Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
) -> Dict[str, Any]:
    db = get_db()
    review = await _load_review(db, review_id)
    actor_id = _actor_id(admin)
    prev_mod = review.get("moderation") or "visible"
    if prev_mod == "flagged":
        raise HTTPException(409, "Review already flagged.")

    now_iso = datetime.now(timezone.utc).isoformat()
    await db.provider_reviews.update_one(
        {"id": review_id},
        {"$set": {
            "moderation": "flagged",
            "moderationActorId": actor_id,
            "moderationAt": now_iso,
            "moderationReason": body.reason,
            "moderationNote": body.note,
            "updatedAt": now_iso,
        }},
    )
    audit = await write_money_audit(
        db,
        entity="review",
        entity_id=review_id,
        action="flag",
        actor_id=actor_id,
        from_status=prev_mod,
        to_status="flagged",
        meta={
            "reason": body.reason,
            "note": body.note,
            "providerId": review.get("providerId"),
            "customerId": review.get("customerId"),
            "rating": review.get("rating"),
        },
    )
    # P6.B.2 — Attribution: governance trail for review moderation.
    try:
        await record_admin_mutation(
            db, ctx,
            action="review.flag",
            domain="review",
            entity_id=review_id,
            extra={"reason": body.reason, "providerId": review.get("providerId"),
                   "fromStatus": prev_mod, "toStatus": "flagged"},
        )
    except Exception as _attr_e:
        logger.warning(f"[p0d.reviews] attribution flag failed: {_attr_e}")
    updated = await _load_review(db, review_id)
    return {"review": updated, "audit": audit}


@router.post("/{review_id}/restore")
async def restore_review(
    review_id: str,
    body: AdminReviewSimple = Body(default_factory=AdminReviewSimple),
    admin: dict = Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
) -> Dict[str, Any]:
    db = get_db()
    review = await _load_review(db, review_id)
    actor_id = _actor_id(admin)
    prev_mod = review.get("moderation") or "visible"
    if prev_mod == "visible":
        raise HTTPException(409, "Review is not flagged.")

    now_iso = datetime.now(timezone.utc).isoformat()
    await db.provider_reviews.update_one(
        {"id": review_id},
        {"$set": {
            "moderation": "visible",
            "moderationActorId": actor_id,
            "moderationAt": now_iso,
            "moderationReason": body.reason,
            "moderationNote": body.note,
            "updatedAt": now_iso,
        }},
    )
    audit = await write_money_audit(
        db,
        entity="review",
        entity_id=review_id,
        action="restore",
        actor_id=actor_id,
        from_status=prev_mod,
        to_status="visible",
        meta={
            "reason": body.reason,
            "note": body.note,
            "providerId": review.get("providerId"),
        },
    )
    try:
        await record_admin_mutation(
            db, ctx,
            action="review.restore",
            domain="review",
            entity_id=review_id,
            extra={"reason": body.reason, "providerId": review.get("providerId"),
                   "fromStatus": prev_mod, "toStatus": "visible"},
        )
    except Exception as _attr_e:
        logger.warning(f"[p0d.reviews] attribution restore failed: {_attr_e}")
    updated = await _load_review(db, review_id)
    return {"review": updated, "audit": audit}


@router.post("/{review_id}/exclude-rating")
async def exclude_rating(
    review_id: str,
    body: AdminReviewExclude,
    admin: dict = Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
) -> Dict[str, Any]:
    db = get_db()
    review = await _load_review(db, review_id)
    actor_id = _actor_id(admin)
    prev_excluded = bool(review.get("excludeFromRating"))
    target = bool(body.exclude)
    if prev_excluded == target:
        raise HTTPException(
            409,
            f"Review excludeFromRating already {target}.",
        )

    now_iso = datetime.now(timezone.utc).isoformat()
    await db.provider_reviews.update_one(
        {"id": review_id},
        {"$set": {
            "excludeFromRating": target,
            "moderationActorId": actor_id,
            "moderationAt": now_iso,
            "ratingExclusionReason": body.reason,
            "ratingExclusionNote": body.note,
            "updatedAt": now_iso,
        }},
    )
    # Trigger rating recompute on the provider whose review changed.
    await _recompute_provider_rating(db, review.get("providerId"))

    audit = await write_money_audit(
        db,
        entity="review",
        entity_id=review_id,
        action="exclude-rating",
        actor_id=actor_id,
        from_status=f"excluded={prev_excluded}",
        to_status=f"excluded={target}",
        meta={
            "reason": body.reason,
            "note": body.note,
            "providerId": review.get("providerId"),
            "rating": review.get("rating"),
        },
    )
    try:
        await record_admin_mutation(
            db, ctx,
            action="review.exclude_rating",
            domain="review",
            entity_id=review_id,
            extra={"reason": body.reason, "providerId": review.get("providerId"),
                   "excluded": target, "rating": review.get("rating")},
        )
    except Exception as _attr_e:
        logger.warning(f"[p0d.reviews] attribution exclude-rating failed: {_attr_e}")
    updated = await _load_review(db, review_id)
    return {"review": updated, "audit": audit}


__all__ = ["router"]
