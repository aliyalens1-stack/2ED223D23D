"""P0.d — money_audit (append-only).

Single collection `money_audit` shared by payouts / payments / reviews
to keep terminal-money-history immutable + queryable in one place.

Document shape:
    {
        id: str            # uuid
        entity: 'payout'|'payment'|'review'
        entityId: str
        action: str        # approve|hold|process|refund|retry|flag|restore|exclude-rating
        actorId: str       # admin user id
        actorRole: str     # 'admin'
        fromStatus: str|None
        toStatus: str|None
        meta: dict         # action-specific (reason, amount, note, stripeRefundId, ...)
        timestamp: ISO8601 UTC
    }

Indexes (idempotent in `ensure_indexes`):
    (entity, entityId, timestamp DESC)   — entity history feed
    (actorId, timestamp DESC)            — auditor view
    (action, timestamp DESC)             — global action log

Append-only discipline: NO update/delete code paths exist in this module.
The collection is never read with $unset/$pull; admin endpoints insert only.
"""
from __future__ import annotations

import uuid
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def write_money_audit(
    db,
    *,
    entity: str,
    entity_id: str,
    action: str,
    actor_id: str,
    from_status: Optional[str] = None,
    to_status: Optional[str] = None,
    meta: Optional[Dict[str, Any]] = None,
    actor_role: str = "admin",
) -> Dict[str, Any]:
    """Append one row to `money_audit`. Returns the inserted doc.

    Never raises on log failure — money mutations must remain visible
    even if telemetry side-channel hiccups (we log the error and return
    a synthetic doc so callers can include `auditId` in their response).
    """
    doc = {
        "id": uuid.uuid4().hex,
        "entity": entity,
        "entityId": entity_id,
        "action": action,
        "actorId": actor_id,
        "actorRole": actor_role,
        "fromStatus": from_status,
        "toStatus": to_status,
        "meta": meta or {},
        "timestamp": _now_iso(),
    }
    try:
        await db.money_audit.insert_one(dict(doc))
        doc.pop("_id", None)
    except Exception as e:
        logger.exception(
            f"[money_audit] write failed entity={entity} id={entity_id} "
            f"action={action} err={e}"
        )
    return doc


async def ensure_indexes(db) -> None:
    """Idempotent index ensure. Adds-only, never drops."""
    try:
        await db.money_audit.create_index(
            [("entity", 1), ("entityId", 1), ("timestamp", -1)],
            name="entity_history",
        )
        await db.money_audit.create_index(
            [("actorId", 1), ("timestamp", -1)],
            name="actor_history",
        )
        await db.money_audit.create_index(
            [("action", 1), ("timestamp", -1)],
            name="action_history",
        )
    except Exception as e:
        logger.warning(f"[money_audit] ensure_indexes failed: {e}")
