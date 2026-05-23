"""P0.b.B — observability attachment to existing booking write paths.

Discipline (per sprint brief):

    attach, don't rewrite
    observe, don't orchestrate
    record, don't control

This module exposes ONE function: `observe_transition(...)`.

Contract:
  1. BEST-EFFORT — never raises. Existing flow continues even if Mongo
     fails. We log at WARN and move on.
  2. IDEMPOTENT — repeated calls with the same `(bookingId, source,
     sourceRequestId)` are a no-op. Implemented as a single atomic
     `update_one(..., upsert=True, $setOnInsert={...})`.
  3. LEGACY-AWARE — accepts raw legacy status strings ("pending",
     "accepted", "released", "refunded"). They are normalized to
     canonical FSM states ONLY in the recorded `fromStatus`/`toStatus`
     fields. The existing flow's own writes are not touched.
  4. ACCEPTED + REJECTED — callers can record either kind. Reject path
     uses `action` suffix ":rejected" so timeline forensics work the
     same way `money_audit` does.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


# Map legacy status names to canonical FSM names. These are USED ONLY for
# the timeline row — the existing flow's status field stays whatever it is.
_LEGACY_CANONICAL = {
    "pending":     "requested",
    "accepted":    "confirmed",   # service_marketplace vocabulary
    "paid":        "confirmed",   # escrow paid ⇒ ready for execution
    "released":    "completed",   # escrow released ⇒ booking economically finished
    "refunded":    "cancelled",   # money refunded ⇒ booking effectively cancelled
}


def _canonical(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    return _LEGACY_CANONICAL.get(raw, raw)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def observe_transition(
    db,
    *,
    booking_id: str,
    booking_scope: str,          # 'web_booking' | 'service_request' | 'car_request' | ...
    action: str,                  # 'mark_confirmed' | 'cancel' | 'mark_completed' | ...
    from_status: Optional[str],
    to_status: Optional[str],
    actor_id: str,
    actor_role: str = "system",
    source: str = "unknown",      # endpoint id, e.g. 'marketplace.provider.accept'
    source_request_id: Optional[str] = None,
    accepted: bool = True,
    meta: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Best-effort, idempotent observation of an existing business write.

    Returns the inserted row, or None if it was a duplicate / write failed.

    Callers MUST NOT depend on the return value being non-None for their
    flow correctness. The existing endpoint's success contract is unchanged.
    """
    canonical_from = _canonical(from_status)
    canonical_to = _canonical(to_status)
    recorded_action = action if accepted else f"{action}:rejected"

    # Idempotency key — content-based, atomic upsert.
    # When sourceRequestId is provided, dedup is exact (same logical request).
    # When not, we fall back to (bookingId, action, from, to, source) which
    # is conservative but prevents identical replays inside a single endpoint.
    dedup = {
        "bookingId": booking_id,
        "source": source,
        "sourceRequestId": source_request_id,
        "action": recorded_action,
    }
    if source_request_id is None:
        dedup.update({
            "fromStatus": canonical_from,
            "toStatus":   canonical_to,
        })

    payload = {
        "id": uuid.uuid4().hex,
        "bookingId": booking_id,
        "bookingScope": booking_scope,
        "action": recorded_action,
        "actorId": actor_id,
        "actorRole": actor_role,
        "fromStatus": canonical_from,
        "toStatus": canonical_to,
        "rawFromStatus": from_status,
        "rawToStatus": to_status,
        "source": source,
        "sourceRequestId": source_request_id,
        "meta": meta or {},
        "timestamp": _now_iso(),
    }

    try:
        result = await db.booking_timeline.update_one(
            dedup,
            {"$setOnInsert": payload},
            upsert=True,
        )
        if result.upserted_id is None:
            # Duplicate — already observed earlier. Idempotent no-op.
            return None
        payload.pop("_id", None)
    except Exception as e:
        # NEVER raise into the calling flow. Log at WARN — visibility is
        # secondary to operational continuity per sprint discipline.
        logger.warning(
            "[observe_transition] best-effort write failed "
            f"booking={booking_id} action={recorded_action} source={source} err={e}"
        )
        return None

    # P0.b.C.d — realtime sidecar. Fire-and-forget; subscribers are
    # in-process so this is a cheap fanout. Wrapped so a misbehaving
    # subscriber NEVER sabotages the business mutation that just
    # succeeded. Same best-effort discipline as the timeline write.
    try:
        from app.booking.realtime import publish_timeline_event
        await publish_timeline_event(db, payload)
    except Exception as e:
        logger.warning(
            f"[observe_transition] realtime publish failed "
            f"booking={booking_id} action={recorded_action} err={e}"
        )
    return payload
