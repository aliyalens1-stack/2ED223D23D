"""Booking lifecycle timeline — append-only evidence layer.

Single collection `booking_timeline`. Same discipline as `money_audit`:

  * Every transition (accepted OR rejected) writes exactly one row.
  * Append-only: no update/delete code path in this module.
  * Indexed by (bookingId, timestamp DESC) — that's the operational chronology.
  * Indexed by (actorId, timestamp DESC) and (action, timestamp DESC) — auditor views.

Document shape:
    {
        id: uuid hex,
        bookingId: str,
        bookingScope: str        # 'web_booking' | 'service_request' | 'car_request' | ...
        action: str               # 'mark_matched' | 'cancel' | 'open_dispute' | ...
                                  # rejected attempts: '<action>:rejected'
        actorId: str,
        actorRole: str            # 'customer' | 'provider' | 'inspector' | 'admin' | 'system'
        fromStatus: str | None
        toStatus:   str | None
        meta: dict
        timestamp: ISO8601 UTC
    }
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _write_row(
    db,
    *,
    booking_id: str,
    booking_scope: str,
    action: str,
    actor_id: str,
    actor_role: str,
    from_status: Optional[str],
    to_status: Optional[str],
    meta: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    row = {
        "id": uuid.uuid4().hex,
        "bookingId": booking_id,
        "bookingScope": booking_scope,
        "action": action,
        "actorId": actor_id,
        "actorRole": actor_role,
        "fromStatus": from_status,
        "toStatus": to_status,
        "meta": meta or {},
        "timestamp": _now_iso(),
    }
    try:
        await db.booking_timeline.insert_one(dict(row))
        row.pop("_id", None)
    except Exception as e:
        logger.exception(
            f"[booking_timeline] write failed booking={booking_id} action={action} err={e}"
        )
    return row


async def record_transition(
    db,
    *,
    booking_id: str,
    booking_scope: str,
    action: str,
    from_status: Optional[str],
    to_status: str,
    actor_id: str,
    actor_role: str = "system",
    meta: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Record an ACCEPTED transition. Caller has already mutated the entity."""
    return await _write_row(
        db,
        booking_id=booking_id,
        booking_scope=booking_scope,
        action=action,
        actor_id=actor_id,
        actor_role=actor_role,
        from_status=from_status,
        to_status=to_status,
        meta=meta,
    )


async def record_rejected_attempt(
    db,
    *,
    booking_id: str,
    booking_scope: str,
    action: str,
    current_status: Optional[str],
    actor_id: str,
    actor_role: str = "admin",
    reason: Optional[str] = None,
    meta: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Record a REJECTED transition attempt. Same shape, suffixed action."""
    merged = dict(meta or {})
    if reason is not None:
        merged["error"] = reason
    return await _write_row(
        db,
        booking_id=booking_id,
        booking_scope=booking_scope,
        action=f"{action}:rejected",
        actor_id=actor_id,
        actor_role=actor_role,
        from_status=current_status,
        to_status=None,
        meta=merged,
    )


async def read_timeline(
    db,
    booking_id: str,
    *,
    limit: int = 200,
) -> List[Dict[str, Any]]:
    cursor = db.booking_timeline.find(
        {"bookingId": booking_id},
        {"_id": 0},
    ).sort("timestamp", -1).limit(limit)
    return await cursor.to_list(limit)


async def ensure_indexes(db) -> None:
    """Idempotent. Adds-only."""
    try:
        await db.booking_timeline.create_index(
            [("bookingId", 1), ("timestamp", -1)],
            name="booking_chronology",
        )
        await db.booking_timeline.create_index(
            [("actorId", 1), ("timestamp", -1)],
            name="actor_history",
        )
        await db.booking_timeline.create_index(
            [("action", 1), ("timestamp", -1)],
            name="action_history",
        )
        await db.booking_timeline.create_index(
            [("bookingScope", 1), ("timestamp", -1)],
            name="scope_history",
        )
    except Exception as e:
        logger.warning(f"[booking_timeline] ensure_indexes failed: {e}")
