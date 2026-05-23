"""Service Marketplace — PUBLIC open marketplace endpoints.

This module ships the publicly-browsable side of the marketplace. No
authentication is required to read open requests, just like an open job
board. Anyone — guests, customers, executors — can browse open work and
filter by city / category / urgency / budget.

Endpoints (all PUBLIC — no auth required for reads):

    GET  /api/marketplace/feed                — open marketplace feed (paginated, filtered)
    GET  /api/marketplace/feed/{id}           — public request detail (no contact data)
    GET  /api/marketplace/stats               — aggregate counters (homepage hero)
    GET  /api/marketplace/categories          — public catalogue (mirror of /service-requests/categories)
    POST /api/marketplace/feed/{id}/bid       — submit a bid (provider auth required)

Why a NEW module instead of extending router_customer.py?

1. **Hierarchy clarity** — customer/provider/admin/public split mirrors
   the access-control layers. Mixing public reads into router_customer
   forced callers to read auth context they don't have.
2. **Hidden contacts contract** — the public feed MUST strip every
   contact-like field (customerId, customerName, contactPhone, bid
   providerPhone, bid providerEmail). Centralising that in one router
   makes the guarantee one-line auditable.
3. **Marketplace ranking** — public feed sorting (urgency × freshness ×
   budget) is independent of the provider-specific geo-radius ranking.
4. **Caching surface** — public feed is cacheable (no auth, no PII).
   Future Redis/CDN caching can wrap exactly this router.

The bid endpoint is here too so the marketplace surface has its full
verb set (read + write) in one file. It still calls verify_user_token
and reuses the existing bid-creation logic (see
`router_provider.create_bid`) — we only re-expose it under the public
`/api/marketplace/feed/{id}/bid` URL.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from app.core.db import get_db
from app.core.utils import now_utc
from app.core.security import verify_user_token

from .models import (
    CATEGORY_LIST,
    CATEGORY_META,
    BID_PUBLIC_FIELDS,
    PUBLIC_REQUEST_FIELDS,
    CreateBidBody,
)

router = APIRouter(prefix="/api/marketplace", tags=["service_marketplace:public"])
logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────

# Fields shown on a public marketplace card. Tighter than
# PUBLIC_REQUEST_FIELDS because the feed list needs only a card preview,
# not the full description. We still include description for now since
# clients may show 2 lines preview — but you can drop it here later if
# bandwidth matters.
FEED_CARD_FIELDS: dict[str, int] = {
    "_id": 0,
    "id": 1,
    "category": 1,
    "title": 1,
    "description": 1,
    "city": 1,
    "location": 1,  # lat/lng only — no street address
    "urgency": 1,
    "budget": 1,
    "photos": 1,
    "status": 1,
    "bidsCount": 1,
    "createdAt": 1,
    "updatedAt": 1,
    "expiresAt": 1,
}

# Status whitelist visible on the public feed. Once a bid is accepted
# (awaiting_payment / paid / in_progress / completed / cancelled) the
# request leaves the public marketplace — only the involved parties
# (owner + assigned provider + admin) keep visibility.
PUBLIC_STATUSES = ["open", "bidding"]

# Urgency → numeric weight used by the marketplace ranking.
URGENCY_WEIGHT: dict[str, int] = {
    "emergency": 3,
    "urgent": 2,
    "normal": 1,
}


# ── Ranking ───────────────────────────────────────────────────────────────


def _rank_score(doc: dict[str, Any], now_ts: float) -> float:
    """Composite score for marketplace ordering.

    Components (each normalised 0..1, then weighted):
      - urgency      ×0.45  (emergency > urgent > normal)
      - freshness    ×0.40  (decays linearly across 72h TTL)
      - budget hint  ×0.15  (higher budget ceiling → small boost)

    The weights are deliberately tuned so that an `emergency` request a
    few hours old outranks a `normal` request just posted. Customers who
    pick `normal` shouldn't be pushed to the top by sheer recency.
    """
    urgency = URGENCY_WEIGHT.get(doc.get("urgency") or "normal", 1) / 3.0  # 1/3..1

    # Freshness — minutes since createdAt, clamped to TTL=72h=4320min
    created = doc.get("createdAt")
    age_min = 0.0
    if isinstance(created, str):
        try:
            dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
            age_min = max(0.0, (now_ts - dt.timestamp()) / 60.0)
        except Exception:
            age_min = 0.0
    freshness = max(0.0, 1.0 - min(age_min, 4320.0) / 4320.0)

    # Budget ceiling — log-ish bump, capped so a €1M bid doesn't dominate.
    budget = doc.get("budget") or {}
    ceiling = budget.get("max") or budget.get("min") or 0
    budget_score = min(1.0, (ceiling / 2000.0)) if ceiling else 0.0

    return urgency * 0.45 + freshness * 0.40 + budget_score * 0.15


# ── GET /api/marketplace/categories ───────────────────────────────────────


@router.get("/categories")
async def public_categories() -> dict[str, Any]:
    """Mirror of `/api/service-requests/categories` — same 9 categories.

    Duplicated here so callers can hit a single `/api/marketplace/*` URL
    namespace without reaching across to `/service-requests`.
    """
    items = []
    for key in CATEGORY_LIST:
        meta = CATEGORY_META[key]
        items.append({
            "key": key,
            "titleRu": meta["title_ru"],
            "titleEn": meta["title_en"],
            "titleDe": meta.get("title_de", meta["title_en"]),
            "emoji": meta["emoji"],
            "minBudget": meta["min_budget"],
            "currency": "EUR",
        })
    return {"categories": items, "total": len(items)}


# ── GET /api/marketplace/stats ────────────────────────────────────────────


@router.get("/feed/stats")
async def public_stats() -> dict[str, Any]:
    """Lightweight aggregate counters for hero / landing / SEO.

    Path is `/feed/stats` (not `/stats`) because `/api/marketplace/stats`
    is already claimed by the provider-stats endpoint (online providers,
    avg ETA, demand level). This one is about REQUESTS, not providers.

    Always public. Counts only requests in the publicly-visible
    statuses so the headline number matches what users actually see
    when they open the feed.
    """
    db = get_db()
    pipeline = [
        {"$match": {"status": {"$in": PUBLIC_STATUSES}}},
        {"$group": {
            "_id": None,
            "total": {"$sum": 1},
            "totalBids": {"$sum": "$bidsCount"},
            "cities": {"$addToSet": "$city"},
            "byCategory": {"$push": "$category"},
        }},
    ]
    agg = await db.service_requests.aggregate(pipeline).to_list(1)
    if not agg:
        return {"openRequests": 0, "totalBids": 0, "cities": 0, "byCategory": {}}
    row = agg[0]
    by_cat: dict[str, int] = {}
    for cat in row.get("byCategory") or []:
        by_cat[cat] = by_cat.get(cat, 0) + 1
    return {
        "openRequests": row.get("total", 0),
        "totalBids": row.get("totalBids", 0),
        "cities": len(row.get("cities") or []),
        "byCategory": by_cat,
    }


# ── GET /api/marketplace/feed ─────────────────────────────────────────────


@router.get("/feed")
async def public_feed(
    request: Request,
    city: str | None = Query(None, description="Filter by city code (lowercase)"),
    category: str | None = Query(None, description="Filter by category key"),
    urgency: str | None = Query(None, description="normal | urgent | emergency"),
    budget_min: int | None = Query(None, ge=0, description="Min budget ceiling (€)"),
    budget_max: int | None = Query(None, ge=0, description="Max budget ceiling (€)"),
    q: str | None = Query(None, description="Free-text search in title/description"),
    sort: str = Query("smart", description="smart | newest | budget"),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
) -> dict[str, Any]:
    """Public marketplace feed — NO authentication required.

    Returns open requests with **all contact information stripped**.
    Anyone (guest, customer browsing other people's tasks, executor
    scanning for work) sees the same shape.

    `sort=smart` (default) uses the composite ranking score; `newest`
    falls back to createdAt desc; `budget` sorts by max budget desc.

    Pagination is cursor-less (offset) — sufficient for a feed of ≤1k
    open requests at any one time. If we grow past that, switch to a
    keyset cursor on (rankScore, id).
    """
    db = get_db()
    mongo_q: dict[str, Any] = {"status": {"$in": PUBLIC_STATUSES}}
    if city:
        mongo_q["city"] = city.lower()
    if category:
        if category not in CATEGORY_META:
            raise HTTPException(400, f"Unknown category: {category}")
        mongo_q["category"] = category
    if urgency:
        if urgency not in URGENCY_WEIGHT:
            raise HTTPException(400, f"Unknown urgency: {urgency}")
        mongo_q["urgency"] = urgency
    if budget_min is not None:
        mongo_q["budget.max"] = {"$gte": budget_min}
    if budget_max is not None:
        existing = mongo_q.get("budget.max", {})
        if isinstance(existing, dict):
            existing["$lte"] = budget_max
            mongo_q["budget.max"] = existing
        else:
            mongo_q["budget.max"] = {"$lte": budget_max}
    if q:
        # Case-insensitive substring search across title + description.
        # No text index required — the open-feed cardinality (≤1k docs)
        # makes regex acceptable. Replace with $text once volume warrants.
        import re
        rx = re.compile(re.escape(q.strip()), re.IGNORECASE)
        mongo_q["$or"] = [
            {"title": {"$regex": rx}},
            {"description": {"$regex": rx}},
        ]

    # Step 1 — total count (cheap because of the status index).
    total = await db.service_requests.count_documents(mongo_q)

    # Step 2 — fetch a window. For `smart` sort we rank in app and
    # therefore over-fetch to keep the ordering stable across pages.
    fetch_limit = limit * 5 if sort == "smart" and page == 1 else limit
    skip = (page - 1) * limit

    if sort == "newest":
        cursor = db.service_requests.find(mongo_q, FEED_CARD_FIELDS).sort("createdAt", -1)
    elif sort == "budget":
        cursor = db.service_requests.find(mongo_q, FEED_CARD_FIELDS).sort("budget.max", -1)
    else:
        # smart — sort by createdAt desc as base, then re-rank in Python.
        cursor = db.service_requests.find(mongo_q, FEED_CARD_FIELDS).sort("createdAt", -1)

    items = await cursor.skip(skip).limit(fetch_limit).to_list(fetch_limit)

    if sort == "smart":
        now_ts = now_utc().timestamp()
        items.sort(key=lambda d: _rank_score(d, now_ts), reverse=True)
        items = items[:limit]

    # Pre-resolve category metadata so clients don't need a second call.
    for it in items:
        meta = CATEGORY_META.get(it.get("category") or "", {})
        it["categoryMeta"] = {
            "titleRu": meta.get("title_ru"),
            "titleEn": meta.get("title_en"),
            "titleDe": meta.get("title_de") or meta.get("title_en"),
            "emoji": meta.get("emoji"),
            "minBudget": meta.get("min_budget"),
        }

    return {
        "items": items,
        "total": total,
        "page": page,
        "limit": limit,
        "hasMore": (skip + len(items)) < total,
        "filters": {
            "city": city, "category": category, "urgency": urgency,
            "budgetMin": budget_min, "budgetMax": budget_max, "q": q, "sort": sort,
        },
    }


# ── GET /api/marketplace/feed/{id} ────────────────────────────────────────


@router.get("/feed/{request_id}")
async def public_feed_detail(request_id: str, request: Request) -> dict[str, Any]:
    """Public read of one request + its bids.

    Mirrors `/api/service-requests/{id}` but is intentionally
    duplicated in the public router so:

    1. Callers can keep a single `/api/marketplace/*` namespace.
    2. We guarantee the contact-stripping contract regardless of any
       future changes to the customer router.
    3. If the request has left the public statuses (e.g. accepted,
       awaiting_payment), we 404 it instead of returning a partial
       half-stripped detail.
    """
    db = get_db()
    doc = await db.service_requests.find_one({"id": request_id}, {"_id": 0})
    if not doc or doc.get("status") not in PUBLIC_STATUSES:
        raise HTTPException(404, "Request not visible on public marketplace")

    # Strip every contact-like field, no matter who is asking. Even an
    # owner hitting this URL gets the redacted view — they should use
    # `/api/service-requests/{id}` for the owner-aware detail.
    for k in ("customerId", "customerName", "contactPhone"):
        doc.pop(k, None)

    meta = CATEGORY_META.get(doc.get("category") or "", {})
    doc["categoryMeta"] = {
        "titleRu": meta.get("title_ru"),
        "titleEn": meta.get("title_en"),
        "titleDe": meta.get("title_de") or meta.get("title_en"),
        "emoji": meta.get("emoji"),
        "minBudget": meta.get("min_budget"),
    }

    # Public bids — provider contact strictly hidden until accept-bid.
    raw_bids = await db.service_bids.find(
        {"requestId": request_id, "status": {"$in": ["submitted", "accepted"]}},
        BID_PUBLIC_FIELDS,
    ).sort("createdAt", 1).to_list(50)
    bids: list[dict[str, Any]] = []
    for b in raw_bids:
        b.pop("providerPhone", None)
        b.pop("providerEmail", None)
        bids.append(b)

    return {"request": doc, "bids": bids, "isPublic": True}


# ── POST /api/marketplace/feed/{id}/bid ───────────────────────────────────


@router.post("/feed/{request_id}/bid")
async def public_submit_bid(
    request_id: str,
    body: CreateBidBody,
    request: Request,
) -> dict[str, Any]:
    """Provider-only — submit a bid on a public marketplace request.

    Reuses the same validation pipeline as
    `/api/provider/service-requests/{id}/bids`. Kept here under the
    `/api/marketplace/*` namespace so a frontend marketplace feature
    talks to a single base URL. Requires Bearer auth — guests cannot bid.

    Idempotency: a provider may submit at most ONE active bid per
    request. Re-submitting updates price/message instead of duplicating.
    """
    payload = await verify_user_token(request)
    role = payload.get("role") or payload.get("kind")
    if role not in ("provider_owner", "inspector", "provider"):
        raise HTTPException(403, "Provider role required to bid")
    provider_id = payload.get("sub") or payload.get("userId")
    provider_email = payload.get("email")

    db = get_db()
    req = await db.service_requests.find_one({"id": request_id}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Request not found")
    if req.get("status") not in PUBLIC_STATUSES:
        raise HTTPException(400, f"Request is not open for bidding (status={req.get('status')})")

    # Sanity: bid currency must match the request currency.
    if body.currency != (req.get("budget") or {}).get("currency", "EUR"):
        raise HTTPException(400, "Bid currency must match request currency")

    now = now_utc().isoformat()

    # Idempotent upsert — one active bid per (provider, request).
    existing = await db.service_bids.find_one(
        {"requestId": request_id, "providerId": provider_id, "status": "submitted"},
        {"_id": 0},
    )
    if existing:
        await db.service_bids.update_one(
            {"id": existing["id"]},
            {"$set": {
                "price": body.price,
                "currency": body.currency,
                "message": (body.message or "").strip()[:500],
                "etaMinutes": body.etaMinutes,
                "updatedAt": now,
            }},
        )
        bid_doc = {**existing, "price": body.price, "currency": body.currency,
                   "message": (body.message or "").strip()[:500], "etaMinutes": body.etaMinutes,
                   "updatedAt": now}
        action = "updated"
    else:
        from app.core.utils import uid
        bid_id = uid()
        # Provider display name comes from the user record (kept light here
        # so we don't slow down the bid endpoint with a join). Frontend
        # surfaces will hydrate via /providers/{id} when needed.
        bid_doc = {
            "id": bid_id,
            "requestId": request_id,
            "providerId": provider_id,
            "providerName": provider_email,  # placeholder — replaced by org name in detail
            "providerRating": None,
            "providerPhone": None,           # stripped on read until accept-bid
            "providerEmail": provider_email,
            "price": body.price,
            "currency": body.currency,
            "message": (body.message or "").strip()[:500],
            "etaMinutes": body.etaMinutes,
            "status": "submitted",
            "createdAt": now,
            "updatedAt": now,
        }
        await db.service_bids.insert_one(dict(bid_doc))
        bid_doc.pop("_id", None)
        # Bump bidsCount on the parent request and promote `open` →
        # `bidding`. The latter is intentional: it tells the customer
        # they actually have offers to look at.
        await db.service_requests.update_one(
            {"id": request_id},
            {
                "$inc": {"bidsCount": 1},
                "$set": {"status": "bidding", "updatedAt": now},
            },
        )
        action = "created"

    # Timeline event — best-effort, never blocks the response.
    try:
        from app.service_chat.timeline import append_event
        await append_event(
            request_id=request_id,
            kind="bid_submitted" if action == "created" else "bid_updated",
            actor_role="provider",
            actor_id=provider_id,
            meta={"bidId": bid_doc["id"], "price": body.price, "etaMinutes": body.etaMinutes},
            db=db,
        )
    except Exception as e:
        logger.warning(f"[marketplace_public] timeline emit failed for bid {bid_doc['id']}: {e}")

    # Public projection — strip provider contact fields from the response.
    public_bid = {k: v for k, v in bid_doc.items() if k not in ("providerPhone", "providerEmail")}
    return {"ok": True, "action": action, "bid": public_bid}
