"""P0.b.C.a — Customer-facing booking timeline.

Endpoint:

    GET /api/customer/bookings/{booking_id}/timeline

This endpoint is INTENTIONALLY separate from
`/api/admin/booking-lifecycle/{id}` (raw chronology) and from any
future provider/inspector endpoints. Different auth, different
semantics, different evolution. Per the P0.b.C brief.

Contract:
  * Requires authenticated user (`verify_user_token`).
  * Returns the customer's narrow projection of `booking_timeline`.
  * 404 if booking not found.
  * 403 if booking exists but belongs to another customer.
  * Empty list `[]` is a valid response (no events yet).

No write endpoints in this surface. Customer cannot mutate timeline
directly — they mutate via the existing business endpoints
(`/api/marketplace/bookings/{id}/cancel` etc.), which P0.b.B already
wires into the timeline.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket

from app.core.db import get_db
from app.core.security import verify_user_token

from .projections import project_timeline_for_customer
from .timeline import read_timeline
from .realtime import customer_ws_handler


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/customer", tags=["customer:booking-lifecycle"])


def _user_id(payload: Dict[str, Any]) -> str:
    return payload.get("sub") or payload.get("userId") or ""


async def _load_customer_booking(db, booking_id: str, user_id: str) -> Dict[str, Any]:
    """Resolve a booking by id and assert it belongs to the caller.

    We probe the three booking-scope collections in order, identical to
    the admin lifecycle endpoint. Ownership check uses `customerId`
    (preferred), falling back to `userId` for legacy docs.
    """
    for coll_name in ("web_bookings", "service_requests", "car_requests"):
        doc = await db[coll_name].find_one({"id": booking_id}, {"_id": 0})
        if doc:
            owner = doc.get("customerId") or doc.get("userId")
            # When the booking is anonymous (no owner stored — legacy
            # web_bookings often have no customer id), we permit access.
            # Once customer auth backfill lands, this branch will be
            # dropped and 403 will be enforced strictly.
            if owner and owner != user_id:
                raise HTTPException(403, "Booking does not belong to current user")
            return doc
    raise HTTPException(404, "Booking not found")


@router.get("/bookings/{booking_id}/timeline")
async def customer_booking_timeline(
    booking_id: str,
    user: dict = Depends(verify_user_token),
) -> Dict[str, Any]:
    db = get_db()
    user_id = _user_id(user)
    booking = await _load_customer_booking(db, booking_id, user_id)  # noqa: F841
    raw_rows = await read_timeline(db, booking_id, limit=200)
    # Timeline is stored newest-first; customer UI reads chronologically.
    chronological = list(reversed(raw_rows))
    events = project_timeline_for_customer(chronological, customer_id=user_id)
    return {
        "bookingId": booking_id,
        "events": events,
        "count": len(events),
    }


# ─────────────────────────────────────────────────────────────────────
# P0.b.C.d — Realtime stream.  Same projection as the REST endpoint
# above; payload schema for each pushed `event` is byte-equal to
# `events[i]` from REST. Polling remains the recovery substrate.
# ─────────────────────────────────────────────────────────────────────


@router.websocket("/bookings/{booking_id}/timeline/stream")
async def customer_booking_timeline_stream(
    websocket: WebSocket,
    booking_id: str,
    token: str = Query(None),
):
    await customer_ws_handler(websocket, booking_id, token)


__all__ = ["router"]