"""app.system.compat — `/my` alias shim, NestJS-independent.

Phase 0 closure (2026-05-22) — original goal restored.

This module is what `api-contracts.ts` references in its header comment:

    > Client-facing canonical path is preferred (e.g. `/favorites/my`,
    > `/notifications/my`) even when backend accepts both — compat
    > aliases stay in FastAPI.

For a while the aliases proxied to NestJS (`proxy_to_nest(...)`). With
`NESTJS_ENABLED=0` (decided as final-state in B4.3-A closure), those
proxy calls returned 500. This file replaces them with **native handlers
that read from MongoDB directly** — same shape, same auth, zero NestJS.

Doctrine:
  * One purpose: serve canonical `/my`-family + a handful of legacy URL
    rewrites that the published `api-contracts.ts` promised.
  * Every endpoint is READ-ONLY.
  * Auth via `verify_user_token` — any authenticated principal can ask
    for *their own* records. The customer-shell already gates which
    pages call these.
  * Empty list is the canonical answer when the user has zero records.
    Pages already handle `r.data?.X || r.data || []`.
  * No new MongoDB collections, no new indexes, no new write paths.
  * `_id` is always stripped from responses.

Aliases shipped here:
  Existing → moved off NestJS:
    1. GET  /api/disputes                 → list current user's disputes
    2. GET  /api/notifications/my         → list current user's notifications
    3. GET  /api/favorites/my             → list current user's favourites
    4. GET  /api/organizations/search     → org search with `q` / `search` rewrite
    5. GET  /api/garage/{vehicle_id}      → vehicle by id (alias of /customer/vehicles/{id})
    6. GET  /api/payments/list            → list current user's payments

  New `/my` paths (Phase 0 P0.3 — was 404):
    7. GET  /api/vehicles/my              → list current user's vehicles
    8. GET  /api/bookings/my              → list current user's bookings
    9. GET  /api/quotes/my                → list current user's quotes
   10. GET  /api/reviews/my               → list current user's reviews

CRITICAL: router МОЖЕТ регистрироваться где угодно — все маршруты
expлicit prefix-free и не пересекаются с другими роутерами. Sprint-21
ordering требование (до catch-all NestJS-proxy) исторически было
обусловлено `proxy_to_nest` — теперь не актуально, но сохранено в
существующем include порядке для безопасности.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.security import verify_user_token
from app.core.db import db

logger = logging.getLogger("server")

router = APIRouter()


# ────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────


def _uid(payload: Dict[str, Any]) -> str:
    """Stable user id from a verified JWT payload.

    Matches the convention used across the customer & notifications
    handlers: prefer `sub`, fall back to `userId`/`accountId`. We do
    NOT raise on miss — `verify_user_token` already 401s on invalid
    tokens, so any payload here is already authenticated.
    """
    for k in ("sub", "userId", "accountId"):
        v = payload.get(k)
        if isinstance(v, str) and v:
            return v
    # Practically unreachable after verify_user_token; defensive only.
    return ""


async def _find_for_user(
    coll,
    user_id: str,
    *,
    keys: List[str],
    limit: int = 100,
    sort_by: Optional[str] = "createdAt",
) -> List[Dict[str, Any]]:
    """Find rows where ANY of `keys` == user_id.

    Several legacy collections recorded the owning principal under
    different field names (`customerId`, `userId`, `authorId`, ...);
    we tolerate that here instead of forcing a migration. `_id` is
    always projected away.
    """
    if not user_id:
        return []
    q = {"$or": [{k: user_id} for k in keys]} if len(keys) > 1 else {keys[0]: user_id}
    cursor = coll.find(q, {"_id": 0})
    if sort_by:
        cursor = cursor.sort(sort_by, -1)
    cursor = cursor.limit(limit)
    return await cursor.to_list(length=limit)


# ────────────────────────────────────────────────────────────────────
# 1. Disputes alias
# ────────────────────────────────────────────────────────────────────


@router.get("/api/disputes")
async def compat_disputes_list(
    payload: Dict[str, Any] = Depends(verify_user_token),
):
    """Mobile/web-app contract: `/api/disputes` lists the caller's disputes.
    Native `/api/disputes/my` already exists; this is an alias that
    delegates to the same query shape so both URLs return the same data.
    """
    uid = _uid(payload)
    items = await _find_for_user(
        db.disputes, uid, keys=["customerId", "userId", "openedBy"], limit=100,
    )
    return {"items": items, "total": len(items)}


# ────────────────────────────────────────────────────────────────────
# 2. Notifications alias
# ────────────────────────────────────────────────────────────────────


@router.get("/api/notifications/my")
async def compat_notifications_my(
    payload: Dict[str, Any] = Depends(verify_user_token),
):
    """Native `/api/notifications/since` is the canonical polling route.
    `/my` is the legacy URL clients hardcoded; same query, no `after`."""
    uid = _uid(payload)
    items = await _find_for_user(
        db.notifications, uid, keys=["userId"], limit=100,
    )
    unread = await db.notifications.count_documents(
        {"userId": uid, "isRead": False}
    ) if uid else 0
    return {"items": items, "unread": unread}


# ────────────────────────────────────────────────────────────────────
# 3. Favourites alias
# ────────────────────────────────────────────────────────────────────


@router.get("/api/favorites/my")
async def compat_favorites_my(
    payload: Dict[str, Any] = Depends(verify_user_token),
):
    """Canonical native is `/api/customer/favorites` (customer-only).
    This alias accepts any authenticated principal and matches by
    `customerId` / `userId`. Same response shape."""
    uid = _uid(payload)
    favs = await _find_for_user(
        db.customer_favorites, uid, keys=["customerId", "userId"], limit=50,
    )

    # Enrich with provider info — mirrors customer/router.py.get_customer_favorites.
    enriched: List[Dict[str, Any]] = []
    for f in favs:
        provider = await db.organizations.find_one(
            {"slug": f.get("providerId")},
            {
                "_id": 0, "name": 1, "slug": 1, "ratingAvg": 1,
                "reviewsCount": 1, "isOnline": 1, "address": 1,
                "priceFrom": 1, "badges": 1, "type": 1, "workHours": 1,
            },
        )
        enriched.append({**f, "provider": provider} if provider else f)
    return {"favorites": enriched, "total": len(enriched)}


# ────────────────────────────────────────────────────────────────────
# 4. Organizations search alias
# ────────────────────────────────────────────────────────────────────


@router.get("/api/organizations/search")
async def compat_orgs_search(
    q: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
):
    """Public org search. Accepts both `?q=` and `?search=` (one or the
    other; if both, `q` wins for back-compat with the old NestJS contract).
    Empty query returns the first `limit` orgs."""
    term = (q or search or "").strip()
    query: Dict[str, Any] = {}
    if term:
        query = {
            "$or": [
                {"name": {"$regex": term, "$options": "i"}},
                {"slug": {"$regex": term, "$options": "i"}},
                {"address": {"$regex": term, "$options": "i"}},
            ]
        }
    items = await db.organizations.find(query, {"_id": 0}).limit(limit).to_list(limit)
    return {"items": items, "total": len(items)}


# ────────────────────────────────────────────────────────────────────
# 5. Garage alias → /vehicles/{id}
# ────────────────────────────────────────────────────────────────────


@router.get("/api/garage/{vehicle_id}")
async def compat_garage_get(
    vehicle_id: str,
    payload: Dict[str, Any] = Depends(verify_user_token),
):
    """`/garage/{id}` was the original public-ish read endpoint; native
    is `/api/customer/vehicles/{id}`. Returns the doc if it belongs to
    the caller, else 404 (we don't 403-leak existence)."""
    uid = _uid(payload)
    veh = await db.vehicles.find_one(
        {"_id": vehicle_id, "userId": uid}, {"_id": 0}
    ) or await db.vehicles.find_one(
        {"id": vehicle_id, "userId": uid}, {"_id": 0}
    )
    if not veh:
        raise HTTPException(status_code=404, detail="vehicle_not_found")
    return veh


# ────────────────────────────────────────────────────────────────────
# 6. Payments list alias
# ────────────────────────────────────────────────────────────────────


@router.get("/api/payments/list")
async def compat_payments_list(
    payload: Dict[str, Any] = Depends(verify_user_token),
):
    """User-scoped payments. Reads `service_payments` (the canonical
    A.1-audited collection) filtered by caller principal."""
    uid = _uid(payload)
    items = await _find_for_user(
        db.service_payments, uid,
        keys=["customerId", "providerId"], limit=100,
    )
    return {"items": items, "total": len(items)}


# ────────────────────────────────────────────────────────────────────
# 7. Vehicles `/my`
# ────────────────────────────────────────────────────────────────────


@router.get("/api/vehicles/my")
async def compat_vehicles_my(
    payload: Dict[str, Any] = Depends(verify_user_token),
):
    """Canonical native is `/api/customer/vehicles` (customer-only kind).
    This alias accepts any authenticated principal. Same shape:
    `{ vehicles: [...] }` so the existing UI accessor
    `r.data?.vehicles || r.data || []` (HomePage / CustomerGarage) works."""
    uid = _uid(payload)
    items = await _find_for_user(
        db.vehicles, uid, keys=["userId", "ownerId"], limit=50,
    )
    return {"vehicles": items, "total": len(items)}


# ────────────────────────────────────────────────────────────────────
# 8. Bookings `/my`
# ────────────────────────────────────────────────────────────────────


@router.get("/api/bookings/my")
async def compat_bookings_my(
    payload: Dict[str, Any] = Depends(verify_user_token),
):
    """User-scoped bookings list. Both `db.bookings` (legacy) and
    `db.service_bookings` (newer) may carry rows; merge with newest-first."""
    uid = _uid(payload)
    a = await _find_for_user(
        db.bookings, uid,
        keys=["customerId", "userId", "providerId"], limit=100,
    )
    b = await _find_for_user(
        db.service_bookings, uid,
        keys=["customerId", "userId", "providerId"], limit=100,
    )
    # Deduplicate by id; if both collections held the same row, prefer
    # the service_bookings copy (newer schema).
    by_id: Dict[str, Dict[str, Any]] = {}
    for row in a + b:
        rid = row.get("id") or row.get("bookingId")
        if rid:
            by_id[rid] = row
        else:
            # Untyped row — keep it under a synthetic key.
            by_id[str(id(row))] = row
    items = sorted(
        by_id.values(),
        key=lambda r: r.get("createdAt") or r.get("updatedAt") or "",
        reverse=True,
    )[:100]
    return {"bookings": items, "total": len(items)}


# ────────────────────────────────────────────────────────────────────
# 9. Quotes `/my`
# ────────────────────────────────────────────────────────────────────


@router.get("/api/quotes/my")
async def compat_quotes_my(
    payload: Dict[str, Any] = Depends(verify_user_token),
):
    """User-scoped quotes. `db.quotes` is the canonical collection
    (see seed.py / control_tower.py). The original NestJS contract
    keyed by `customerId`; the same field is used here."""
    uid = _uid(payload)
    items = await _find_for_user(
        db.quotes, uid,
        keys=["customerId", "userId"], limit=100,
    )
    return {"quotes": items, "total": len(items)}


# ────────────────────────────────────────────────────────────────────
# 10. Reviews `/my`
# ────────────────────────────────────────────────────────────────────


@router.get("/api/reviews/my")
async def compat_reviews_my(
    payload: Dict[str, Any] = Depends(verify_user_token),
):
    """User-scoped reviews. `db.reviews` is the canonical collection
    (see marketplace/providers.py). Match by author/customer/owner of
    the review, never by `organizationId` (that would list reviews
    *about* the user, not *by* them)."""
    uid = _uid(payload)
    items = await _find_for_user(
        db.reviews, uid,
        keys=["customerId", "authorId", "userId"], limit=100,
    )
    return {"reviews": items, "total": len(items)}
