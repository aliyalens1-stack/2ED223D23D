"""
backend/app/notifications/lifecycle_email.py — Sprint Email-Receipt-1
(2026-05-15).

In-place enrichment of email lifecycle rows from Postmark webhook
events. NEVER inserts. NEVER deletes. Only `update_one` keyed on
`providerMessageId` + `channel="email"`.

Hard invariant (Roman 2026-05-15):
    one lifecycle row = one delivery attempt

A Delivery webhook does NOT create a new lifecycle row. It enriches
the existing row written at send time with `deliveredAt`. Same for
Bounce-after-send and SpamComplaint-after-send: they enrich the same
row that already exists for the send attempt.

Why this module is separate from `delivery.py`:
    - `delivery.py` is the SEND path (inserts lifecycle rows)
    - `lifecycle_email.py` is the RECEIPT path (updates rows in place)
    Keeping them separate prevents accidental insertion-on-receipt
    drift. Each function here is `update_one` only.

Why this module is separate from `receipts.py`:
    - `receipts.py` is the PUSH receipt poller (poll-based, push only)
    - `lifecycle_email.py` is the EMAIL receipt enricher (webhook-driven,
       email only)
    Different transports, different reconciliation mechanisms.

Cross-namespace invariants (locked):
    - This module NEVER writes to `notification_suppressions` (that is
      the webhook handler's separate concern; the webhook calls BOTH
      `suppression.append_suppression_event` AND a function from this
      module, but the writes go to different collections).
    - This module NEVER writes to `notification_projection_audit`.
    - This module NEVER writes to `notification_preferences`.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

CHANNEL = "email"


async def _enrich(db, *, provider_message_id: str,
                  set_doc: Dict[str, Any]) -> Dict[str, Any]:
    """Single `update_one` keyed on (channel=email, providerMessageId).
    NEVER inserts. Returns a verdict dict.

    Adds `webhookReceivedAt` automatically (server-side timestamp of
    when the enrichment landed, distinct from provider-stamped times)."""
    if not provider_message_id:
        return {"ok": False, "reason": "no_provider_message_id"}
    set_doc = dict(set_doc)  # defensive copy
    set_doc.setdefault("webhookReceivedAt",
                       datetime.now(timezone.utc).isoformat())
    try:
        res = await db.notification_delivery_lifecycle.update_one(
            {"channel": CHANNEL, "providerMessageId": provider_message_id},
            {"$set": set_doc},
        )
    except Exception as e:
        logger.warning(f"lifecycle_email enrich update failed: {e}")
        return {"ok": False, "reason": f"update_failed:{type(e).__name__}"}

    if res.matched_count == 0:
        # Webhook arrived for a MessageID we never wrote a lifecycle
        # row for — e.g. test-send (which deliberately skips lifecycle),
        # or a race where Postmark is faster than our DB. Not an error.
        return {"ok": True, "reason": "no_lifecycle_row",
                "matched": 0, "modified": 0}
    return {"ok": True, "reason": "enriched",
            "matched": res.matched_count, "modified": res.modified_count}


async def enrich_delivery(
    db, *,
    provider_message_id: str,
    delivered_at: Optional[str] = None,
    detail_raw: Optional[str] = None,
) -> Dict[str, Any]:
    """Postmark Delivery webhook → mark email as delivered.

    Sets:
      deliveredAt              = provider's `DeliveredAt` (or now)
      providerReceiptStatus    = "delivered"
      providerReceiptDetail    = provider's `Details` (capped)
    """
    return await _enrich(db,
        provider_message_id=provider_message_id,
        set_doc={
            "deliveredAt": delivered_at or datetime.now(timezone.utc).isoformat(),
            "providerReceiptStatus": "delivered",
            "providerReceiptDetail": (detail_raw or "")[:512] or None,
        },
    )


async def enrich_bounce(
    db, *,
    provider_message_id: str,
    bounce_kind: str,            # "hard_bounce" | "soft_bounce"
    bounced_at: Optional[str] = None,
    reason: Optional[str] = None,
    detail_raw: Optional[str] = None,
) -> Dict[str, Any]:
    """Postmark Bounce webhook → mark previously-sent email as bounced.

    Sets:
      bouncedAt                = provider's `BouncedAt`
      providerReceiptStatus    = "bounced" (kind preserved separately)
      providerReceiptKind      = bounce_kind  (`hard_bounce|soft_bounce`)
      providerReceiptError     = reason / detail
      providerReceiptDetail    = full description (capped)

    NOTE: `failedAt` is NOT mutated. `failedAt` is send-attempt truth
    (the /email API call itself failed). A bounce is delivery-time
    truth that arrives AFTER a successful send. Keeping them separate
    is what makes "we sent, then it bounced" expressible as ONE row.
    """
    return await _enrich(db,
        provider_message_id=provider_message_id,
        set_doc={
            "bouncedAt": bounced_at or datetime.now(timezone.utc).isoformat(),
            "providerReceiptStatus": "bounced",
            "providerReceiptKind": bounce_kind,
            "providerReceiptError": (reason or "")[:256] or None,
            "providerReceiptDetail": (detail_raw or "")[:512] or None,
        },
    )


async def enrich_complaint(
    db, *,
    provider_message_id: str,
    complained_at: Optional[str] = None,
    detail_raw: Optional[str] = None,
) -> Dict[str, Any]:
    """Postmark SpamComplaint webhook → mark email as complained.

    Sets:
      complainedAt             = provider's `BouncedAt` (yes, Postmark
                                  reuses this field for complaints)
      providerReceiptStatus    = "complained"
      providerReceiptDetail    = full description (capped)
    """
    return await _enrich(db,
        provider_message_id=provider_message_id,
        set_doc={
            "complainedAt": complained_at or datetime.now(timezone.utc).isoformat(),
            "providerReceiptStatus": "complained",
            "providerReceiptDetail": (detail_raw or "")[:512] or None,
        },
    )


__all__ = ["enrich_delivery", "enrich_bounce", "enrich_complaint"]
