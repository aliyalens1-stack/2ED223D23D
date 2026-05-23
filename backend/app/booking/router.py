"""Booking lifecycle — admin router (read + manual transitions).

Endpoints:

    GET   /api/admin/booking-lifecycle/states            — frozen enum + transitions
    GET   /api/admin/booking-lifecycle/{booking_id}      — current state + projection
                                                            + timeline + legal actions
    POST  /api/admin/booking-lifecycle/{booking_id}/transition
                                                          — explicit admin transition
                                                            (FSM-validated, TOCTOU,
                                                             append-only audit)

`scope` query/body chooses which collection backs the booking:
  * 'web_booking'      → db.web_bookings        (status field)
  * 'service_request'  → db.service_requests    (status field)
  * 'car_request'      → db.car_requests        (status field, AUTO 2.0)

We do NOT touch existing flows; we only read+mutate the `status` and write
to `booking_timeline`. Existing routes keep working unchanged.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, WebSocket
from pydantic import BaseModel, Field

from app.core.db import get_db
from app.core.security import verify_admin_token

from .fsm import (
    BOOKING_STATES,
    BOOKING_TERMINAL,
    BOOKING_TRANSITIONS,
    BookingTransitionError,
    assert_transition,
    list_legal_actions,
)
from .realtime import admin_ws_handler
from .projections import project_for_actor
from .timeline import (
    read_timeline,
    record_transition,
    record_rejected_attempt,
)


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin/booking-lifecycle", tags=["admin:booking-lifecycle"])


_SCOPE_COLLECTIONS = {
    "web_booking":     "web_bookings",
    "service_request": "service_requests",
    "car_request":     "car_requests",
}


def _coll(db, scope: str):
    name = _SCOPE_COLLECTIONS.get(scope)
    if not name:
        raise HTTPException(400, f"Unknown booking scope: {scope}; allowed: {list(_SCOPE_COLLECTIONS)}")
    return db[name]


def _actor_id(payload: Dict[str, Any]) -> str:
    return payload.get("sub") or payload.get("userId") or "unknown-admin"


async def _load_booking(db, scope: str, booking_id: str) -> Dict[str, Any]:
    coll = _coll(db, scope)
    # Try `id` (uuid string), then `_id` (legacy).
    doc = await coll.find_one({"id": booking_id}, {"_id": 0})
    if not doc:
        doc = await coll.find_one({"_id": booking_id})
        if doc:
            doc["id"] = str(doc.pop("_id"))
    if not doc:
        raise HTTPException(404, f"{scope} {booking_id} not found")
    return doc


# ── Body models ──────────────────────────────────────────────────


class AdminTransitionBody(BaseModel):
    scope: str = Field(..., description="web_booking | service_request | car_request")
    action: str = Field(..., description="see /states for the legal set")
    reason: Optional[str] = Field(None, max_length=500)
    note: Optional[str] = Field(None, max_length=2000)


# ── Endpoints ────────────────────────────────────────────────────


@router.get("/states")
async def list_states(_: dict = Depends(verify_admin_token)) -> Dict[str, Any]:
    """Public-to-admin view of the frozen FSM."""
    return {
        "states": list(BOOKING_STATES),
        "terminal": sorted(BOOKING_TERMINAL),
        "transitions": {
            action: {"from": sorted(allowed_from), "to": target}
            for action, (allowed_from, target) in BOOKING_TRANSITIONS.items()
        },
        "scopes": list(_SCOPE_COLLECTIONS.keys()),
    }


@router.get("/{booking_id}")
async def get_lifecycle(
    booking_id: str,
    scope: str = Query("web_booking"),
    actor: str = Query("admin", description="customer | provider | inspector | admin"),
    _: dict = Depends(verify_admin_token),
) -> Dict[str, Any]:
    db = get_db()
    booking = await _load_booking(db, scope, booking_id)
    raw_status = booking.get("status") or "requested"
    canonical = raw_status if raw_status in BOOKING_STATES else _normalize_legacy(raw_status)
    timeline = await read_timeline(db, booking_id, limit=200)
    return {
        "bookingId": booking_id,
        "scope": scope,
        "rawStatus": raw_status,
        "canonicalState": canonical,
        "terminal": canonical in BOOKING_TERMINAL,
        "projection": project_for_actor(canonical, actor),  # type: ignore[arg-type]
        "legalActions": list_legal_actions(canonical),
        "timeline": timeline,
    }


@router.post("/{booking_id}/transition")
async def admin_transition(
    booking_id: str,
    body: AdminTransitionBody,
    admin: dict = Depends(verify_admin_token),
) -> Dict[str, Any]:
    db = get_db()
    coll = _coll(db, body.scope)
    booking = await _load_booking(db, body.scope, booking_id)
    raw_status = booking.get("status") or "requested"
    current = raw_status if raw_status in BOOKING_STATES else _normalize_legacy(raw_status)
    actor_id = _actor_id(admin)

    # Validate FSM.
    try:
        _, target = assert_transition(current, body.action)
    except BookingTransitionError as e:
        await record_rejected_attempt(
            db,
            booking_id=booking_id,
            booking_scope=body.scope,
            action=body.action,
            current_status=current,
            actor_id=actor_id,
            actor_role="admin",
            reason=str(e),
            meta={"reason": body.reason, "note": body.note},
        )
        raise HTTPException(e.status_code, str(e))

    # TOCTOU-guarded mutation. We bind to BOTH the raw and canonical status
    # so back-compat docs (e.g. status='pending' meaning 'requested') still
    # match exactly without surprising rewrites.
    now_iso = datetime.now(timezone.utc).isoformat()
    result = await coll.update_one(
        {"id": booking_id, "status": raw_status},
        {"$set": {
            "status": target,
            "lifecycleUpdatedAt": now_iso,
            "lifecycleUpdatedBy": actor_id,
        }},
    )
    if result.modified_count == 0:
        # Try legacy _id key on retry — some older docs only have _id.
        result = await coll.update_one(
            {"_id": booking_id, "status": raw_status},
            {"$set": {
                "status": target,
                "lifecycleUpdatedAt": now_iso,
                "lifecycleUpdatedBy": actor_id,
            }},
        )
    if result.modified_count == 0:
        await record_rejected_attempt(
            db,
            booking_id=booking_id,
            booking_scope=body.scope,
            action=body.action,
            current_status=current,
            actor_id=actor_id,
            actor_role="admin",
            reason="concurrent_state_change",
            meta={"reason": body.reason, "note": body.note},
        )
        raise HTTPException(409, "Booking status changed concurrently; refresh and retry.")

    audit = await record_transition(
        db,
        booking_id=booking_id,
        booking_scope=body.scope,
        action=body.action,
        from_status=current,
        to_status=target,
        actor_id=actor_id,
        actor_role="admin",
        meta={
            "reason": body.reason,
            "note": body.note,
            "rawStatusBefore": raw_status,
        },
    )

    updated = await _load_booking(db, body.scope, booking_id)
    return {
        "bookingId": booking_id,
        "scope": body.scope,
        "fromStatus": current,
        "toStatus": target,
        "booking": updated,
        "audit": audit,
    }


# ── Back-compat: map legacy 6-state names onto canonical FSM ────


_LEGACY_MAP = {
    "pending":     "requested",
    "accepted":    "confirmed",   # service_marketplace vocabulary
    "paid":        "confirmed",   # escrow vocabulary — paid means "ready for execution"
    "released":    "completed",   # escrow released ⇒ booking finished economically
    "refunded":    "cancelled",   # money refunded ⇒ booking effectively cancelled
}


def _normalize_legacy(raw: str) -> str:
    """Best-effort projection of legacy state labels onto canonical states.

    We never WRITE through this — only used for read-side `canonicalState`.
    Admin transitions always operate on the literal `status` field; the
    TOCTOU guard binds to raw_status so historical labels are honoured.
    """
    return _LEGACY_MAP.get(raw, raw if raw in BOOKING_STATES else "requested")


# ─────────────────────────────────────────────────────────────────────
# P0.b.C.d — Admin realtime stream. RAW timeline rows (forensic
# surface). Admin role required; non-admin tokens are closed with
# WS code 4403. Subscriber filters by bookingId.
# ─────────────────────────────────────────────────────────────────────


@router.websocket("/{booking_id}/stream")
async def admin_booking_lifecycle_stream(
    websocket: WebSocket,
    booking_id: str,
    token: str = Query(None),
):
    await admin_ws_handler(websocket, booking_id, token)


__all__ = ["router"]
