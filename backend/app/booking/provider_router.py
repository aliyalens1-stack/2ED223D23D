"""P0.b.C.b — Provider-facing booking timeline.

Endpoint:

    GET /api/provider/bookings/{booking_id}/timeline

INTENTIONALLY separate from `/api/customer/bookings/{id}/timeline`
and `/api/admin/booking-lifecycle/{id}`. Different auth, different
projection module, independent evolution path. Per the P0.b.C brief:
no scope-param dispatcher, no shared rendering.

Contract:
  * Requires authenticated user (`verify_user_token`).
  * Booking must be assigned to the caller (`providerId` /
    `providerAccountId` / `providerSlug` ownership check).
  * 404 if booking not found OR not assigned to this provider.
  * 200 with empty `events` is a valid response (just matched, no
    transitions yet).

No write endpoints in this surface. Provider mutates the timeline
via the existing business endpoints (accept / depart / arrive /
start / complete) which P0.b.B already wires into the timeline.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket

from app.core.db import get_db
from app.core.security import verify_user_token

from .projections.provider import project_timeline_for_provider
from .timeline import read_timeline
from .realtime import provider_ws_handler


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/provider", tags=["provider:booking-lifecycle"])


def _provider_identity(payload: Dict[str, Any]) -> List[str]:
    """Collect every id under which this caller may be recorded as
    a provider. Multi-keyed because legacy bookings stash provider
    ownership variously (account id, user id, org slug)."""
    ids: List[str] = []
    for key in ("sub", "userId", "accountId", "providerId", "providerSlug"):
        val = payload.get(key)
        if val:
            ids.append(str(val))
    # Dedupe preserving order
    seen: set[str] = set()
    return [x for x in ids if not (x in seen or seen.add(x))]


def _booking_provider_ids(doc: Dict[str, Any]) -> List[str]:
    """Collect every provider-shaped id stored on the booking doc."""
    out: List[str] = []
    for key in (
        "providerId",
        "providerAccountId",
        "providerSlug",
        "assignedProviderId",
        "assignedProviderAccountId",
        "providerUserId",
    ):
        val = doc.get(key)
        if val:
            out.append(str(val))
    return out


async def _load_provider_booking(
    db,
    booking_id: str,
    caller_ids: List[str],
) -> Dict[str, Any]:
    """Resolve a booking by id and assert it belongs to the caller.

    We probe the same three booking-scope collections as the customer
    router. Ownership matches if ANY booking-provider-id appears in
    the caller's identity set.

    If no provider id is stored on the booking (legacy / unassigned),
    we return 404 — provider cannot claim ownership of an unassigned
    booking. This is strictly safer than the customer router's
    "permissive when no owner" branch: customer leakage to anonymous
    bookings is benign; provider leakage is not.
    """
    caller_set = set(caller_ids)
    for coll_name in ("web_bookings", "service_requests", "car_requests"):
        doc = await db[coll_name].find_one({"id": booking_id}, {"_id": 0})
        if not doc:
            continue
        booking_provider_ids = _booking_provider_ids(doc)
        if not booking_provider_ids:
            # No provider ownership recorded → cannot prove caller is
            # the assignee. Treat as not-found-for-this-provider.
            raise HTTPException(404, "Booking not assigned to current provider")
        if not caller_set.intersection(booking_provider_ids):
            # Booking exists but belongs to a different provider →
            # surface as 404 so we don't leak the existence of
            # competitor bookings. This is a deliberate divergence
            # from the customer router (which returns 403); for
            # provider isolation, opacity is the safer default.
            raise HTTPException(404, "Booking not found")
        return doc
    raise HTTPException(404, "Booking not found")


@router.get("/bookings/{booking_id}/timeline")
async def provider_booking_timeline(
    booking_id: str,
    user: dict = Depends(verify_user_token),
) -> Dict[str, Any]:
    """Provider-facing timeline projection (P0.b.C.b)."""
    db = get_db()
    caller_ids = _provider_identity(user)
    if not caller_ids:
        # No identifying claims at all → cannot resolve ownership.
        raise HTTPException(401, "Unauthorized")

    await _load_provider_booking(db, booking_id, caller_ids)

    raw_rows = await read_timeline(db, booking_id, limit=200)
    # Stored newest-first; provider UI scans chronologically.
    chronological = list(reversed(raw_rows))
    events = project_timeline_for_provider(chronological, provider_ids=caller_ids)
    return {
        "bookingId": booking_id,
        "events": events,
        "count": len(events),
    }


# ─────────────────────────────────────────────────────────────────────
# P0.b.C.d — Realtime stream. Per-event payload is byte-equal to
# `events[i]` from REST GET above. Same opacity discipline applies:
# subscribers to bookings they don't own simply receive nothing
# (no error, no leak).
# ─────────────────────────────────────────────────────────────────────


@router.websocket("/bookings/{booking_id}/timeline/stream")
async def provider_booking_timeline_stream(
    websocket: WebSocket,
    booking_id: str,
    token: str = Query(None),
):
    await provider_ws_handler(websocket, booking_id, token)


__all__ = ["router"]
