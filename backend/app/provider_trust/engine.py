"""Sprint 5 Trust Engine — pure aggregate compute over provider_reviews.

Architecture contract:
    service_requests (status=released) + provider_reviews (visibility=revealed)
        →  provider_reputation aggregate

Triggers:
    1. Both sides submitted → reveal pair → recompute provider aggregate
    2. 72h timeout elapsed   → reveal whatever exists → recompute
    3. Manual admin recompute (e.g. after data backfill)

Storage:
    provider_reviews    — immutable per-review records (unique on (requestId, authorRole))
    provider_reputation — one snapshot per providerId

Invariants:
    - Same inputs → same aggregate (deterministic)
    - Self-review impossible (authorId ≠ targetId enforced at submit)
    - One review per (requestId, authorRole)
    - Reveal is monotonic: pending → revealed (never back)
    - Recompute is idempotent
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────
# Tuning constants (single source of truth — no magic numbers downstream)
# ─────────────────────────────────────────────────────────────────────

REVEAL_TIMEOUT_HOURS = 72  # both sides reviewed OR this elapsed → reveal

# Badge thresholds — kept simple, growth-friendly.
BADGE_RULES = {
    "top_rated":     {"min_avg_rating": 4.8, "min_reviews": 10},
    "fast_response": {"max_avg_response_minutes": 10, "min_reviews": 5},
    "reliable":      {"min_completion_rate": 0.95, "min_jobs": 20},
    "rising_star":   {"min_avg_rating": 4.5, "min_reviews": 3, "max_reviews": 9},
    "high_volume":   {"min_jobs": 100},
}

# Ranking multiplier curve — applied to existing rankScore in marketplace.
# Soft to preserve liquidity (per product spec).
def ranking_multiplier(avg_rating: Optional[float], total_reviews: int) -> float:
    """Return multiplier for marketplace rankScore based on rating."""
    if avg_rating is None or total_reviews < 3:
        return 1.0  # cold start — neutral
    if avg_rating >= 4.8:
        return 1.08
    if avg_rating >= 4.5:
        return 1.04
    if avg_rating < 3.5:
        return 0.92
    return 1.0


# Tag whitelist — server-side validation (anti-abuse, prevents free-form noise).
POSITIVE_TAGS = {"fast", "professional", "quality_work", "communicative", "punctual", "clean"}
NEGATIVE_TAGS = {"late", "expensive", "rude", "incomplete"}
ALL_TAGS = POSITIVE_TAGS | NEGATIVE_TAGS


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def now_iso() -> str:
    return now_utc().isoformat()


# ─────────────────────────────────────────────────────────────────────
# Reveal logic
# ─────────────────────────────────────────────────────────────────────

async def try_reveal_pair(db, request_id: str) -> bool:
    """Attempt to reveal both sides of a review pair.

    Conditions to reveal:
        - Both customer + provider reviews exist (visibility=pending), OR
        - Pair age >= REVEAL_TIMEOUT_HOURS (timeout fallback)

    Returns True if reveal happened (caller should recompute aggregates).
    """
    pair = await db.provider_reviews.find({"requestId": request_id}, {"_id": 0}).to_list(length=2)
    if not pair:
        return False

    # Already revealed? skip.
    if all(r.get("visibility") == "revealed" for r in pair):
        return False

    both_submitted = len(pair) == 2
    oldest = min(r.get("createdAt", now_iso()) for r in pair)
    age_hours = (now_utc() - datetime.fromisoformat(oldest)).total_seconds() / 3600
    timeout_elapsed = age_hours >= REVEAL_TIMEOUT_HOURS

    if not (both_submitted or timeout_elapsed):
        return False

    now = now_iso()
    await db.provider_reviews.update_many(
        {"requestId": request_id, "visibility": "pending"},
        {"$set": {"visibility": "revealed", "revealedAt": now}},
    )
    logger.info(
        f"[trust] revealed pair request={request_id} both={both_submitted} timeout={timeout_elapsed}"
    )
    return True


async def sweep_timeouts(db) -> int:
    """Find pending reviews older than timeout and force-reveal them.

    Returns number of pairs revealed. Safe to run on a schedule.
    """
    cutoff = (now_utc() - timedelta(hours=REVEAL_TIMEOUT_HOURS)).isoformat()
    pending = await db.provider_reviews.find(
        {"visibility": "pending", "createdAt": {"$lte": cutoff}},
        {"_id": 0, "requestId": 1},
    ).to_list(length=500)
    seen = set()
    revealed = 0
    for r in pending:
        rid = r["requestId"]
        if rid in seen:
            continue
        seen.add(rid)
        if await try_reveal_pair(db, rid):
            revealed += 1
            # Recompute provider aggregate after reveal.
            review = await db.provider_reviews.find_one(
                {"requestId": rid, "targetRole": "provider"}, {"_id": 0}
            )
            if review:
                await recompute_provider_reputation(db, review["providerId"])
    if revealed:
        logger.info(f"[trust] sweep revealed {revealed} pairs (timeout)")
    return revealed


# ─────────────────────────────────────────────────────────────────────
# Aggregate recompute
# ─────────────────────────────────────────────────────────────────────

async def recompute_provider_reputation(db, provider_id: str) -> Dict[str, Any]:
    """Deterministic recompute of provider_reputation document.

    Reads:
        - provider_reviews where targetRole=provider, visibility=revealed
        - service_requests where providerId=X (for completion/cancellation rate, response time)
        - users.{id=providerId}.subscriptionTier (for tier badge)

    Writes:
        - provider_reputation (upsert)

    Returns the stored snapshot.
    """
    # 1. Pull revealed reviews about this provider (customer→provider direction).
    reviews_cursor = db.provider_reviews.find(
        {"providerId": provider_id, "targetRole": "provider", "visibility": "revealed"},
        {"_id": 0, "rating": 1, "tags": 1, "customerId": 1, "createdAt": 1},
    )
    reviews = await reviews_cursor.to_list(length=10000)
    total_reviews = len(reviews)
    avg_rating: Optional[float] = (
        round(sum(r["rating"] for r in reviews) / total_reviews, 2) if total_reviews else None
    )

    # 2. Tag histogram (counts across all revealed reviews).
    tag_counts: Dict[str, int] = {}
    for r in reviews:
        for t in (r.get("tags") or []):
            if t in ALL_TAGS:
                tag_counts[t] = tag_counts.get(t, 0) + 1

    # 3. Repeat customers — distinct customerIds with >= 2 reviews of this provider.
    customer_freq: Dict[str, int] = {}
    for r in reviews:
        cid = r.get("customerId")
        if cid:
            customer_freq[cid] = customer_freq.get(cid, 0) + 1
    repeat_customers = sum(1 for c in customer_freq.values() if c >= 2)

    # 4. Job stats from service_requests.
    req_pipeline = [
        {"$match": {"providerId": provider_id}},
        {"$group": {
            "_id": "$status",
            "n": {"$sum": 1},
            "avg_response": {"$avg": "$responseSeconds"},
        }},
    ]
    status_counts: Dict[str, int] = {}
    response_seconds_sum = 0.0
    response_seconds_n = 0
    async for row in db.service_requests.aggregate(req_pipeline):
        status_counts[row["_id"]] = row["n"]
        if row.get("avg_response") and row["n"]:
            response_seconds_sum += row["avg_response"] * row["n"]
            response_seconds_n += row["n"]

    completed_jobs = (
        status_counts.get("completed", 0)
        + status_counts.get("released", 0)
        + status_counts.get("paid", 0)
        + status_counts.get("in_progress", 0)
    )
    cancelled_jobs = status_counts.get("cancelled", 0) + status_counts.get("expired", 0)
    total_jobs = completed_jobs + cancelled_jobs
    completion_rate = round(completed_jobs / total_jobs, 3) if total_jobs > 0 else None

    avg_response_minutes: Optional[int] = None
    if response_seconds_n:
        avg_response_minutes = int(round((response_seconds_sum / response_seconds_n) / 60))

    # 5. Subscription tier (read from user doc; default 'free').
    user_doc = await db.users.find_one({"id": provider_id}, {"_id": 0, "subscriptionTier": 1}) or {}
    subscription_tier = user_doc.get("subscriptionTier", "free")

    # 6. Derive badges deterministically.
    from app.provider_trust.badges import derive_badges
    badges = derive_badges(
        avg_rating=avg_rating,
        total_reviews=total_reviews,
        completed_jobs=completed_jobs,
        completion_rate=completion_rate,
        avg_response_minutes=avg_response_minutes,
    )

    # 7. Compute ranking multiplier (for marketplace consumers).
    rank_multiplier = ranking_multiplier(avg_rating, total_reviews)

    snapshot = {
        "providerId": provider_id,
        "avgRating": avg_rating,
        "totalReviews": total_reviews,
        "completedJobs": completed_jobs,
        "cancelledJobs": cancelled_jobs,
        "completionRate": completion_rate,
        "avgResponseMinutes": avg_response_minutes,
        "repeatCustomers": repeat_customers,
        "subscriptionTier": subscription_tier,
        "tagCounts": tag_counts,
        "badges": badges,
        "rankMultiplier": rank_multiplier,
        "updatedAt": now_iso(),
    }

    await db.provider_reputation.update_one(
        {"providerId": provider_id},
        {"$set": snapshot},
        upsert=True,
    )
    logger.info(
        f"[trust] reputation recomputed provider={provider_id} "
        f"avg={avg_rating} reviews={total_reviews} badges={badges}"
    )
    return snapshot


async def ensure_indexes(db) -> None:
    """Idempotent index setup."""
    await db.provider_reviews.create_index(
        [("requestId", 1), ("authorRole", 1)],
        unique=True,
        name="uniq_request_author",
    )
    await db.provider_reviews.create_index([("providerId", 1), ("visibility", 1)])
    await db.provider_reviews.create_index([("customerId", 1), ("visibility", 1)])
    await db.provider_reviews.create_index([("visibility", 1), ("createdAt", 1)])
    await db.provider_reputation.create_index([("providerId", 1)], unique=True)
    await db.provider_reputation.create_index([("avgRating", -1)])
    logger.info("[trust] indexes ensured")
