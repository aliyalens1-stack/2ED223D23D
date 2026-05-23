"""
backend/app/notifications/suppression.py — Sprint Bounce-1 (2026-05-15).

Provider-truth namespace for "the recipient cannot receive this channel".
APPEND-ONLY event log. NEVER mutated, NEVER deleted.

Roman 2026-05-15 invariant:
    suppression namespace = append-only event log
    "is recipient blocked?" = computed query, not mutable state

Why append-only:
  - unsubscribe → hard bounce → complaint → reactivation drift
    must preserve full chronology for compliance + forensic
  - any "delete" or "update" silently loses provider-truth history
  - reactivation is just another row of kind="reactivated"

Cross-namespace boundary (locked):
  - suppression NEVER mutates `preferences` (recipient intent)
  - suppression NEVER mutates `lifecycle` (transport attempts)
  - suppression IS ONLY written by provider webhook handlers
  - readers: send-time gate in `delivery.py::deliver_audit_row`
            + admin observability endpoint

Collection: `notification_suppressions`
Row shape (immutable):
{
  id:              uuid hex (NOT providerMessageId)
  channel:         "email" | "sms" | "push"
  recipientAddress: "user@example.com" | "+49..." | "ExponentPushToken[...]"
                    lowercased for email; raw for other channels
  recipientUserId: <Mongo _id string> | None
                    optional back-link; provider knows address only
  kind:            "hard_bounce" | "soft_bounce" | "spam_complaint"
                   | "subscription_unsubscribe" | "subscription_reactivate"
                   | "manual_suppress" | "manual_reactivate"
  effect:          "block" | "reactivate"
                   `block` rows make the address blocked.
                   `reactivate` rows undo prior `block` rows for the
                   same (channel, address). Latest wins by createdAt.
  provider:        "postmark" | "expo" | future "twilio"
  providerEventId: provider's webhook event id (or MessageID for bounce)
                   used together with `kind` for idempotency
  providerMessageId: original send MessageID that caused this event
                     (correlation back to lifecycle row)
  reason:          short tag from provider (e.g. "HardBounce/1")
  detailRaw:       full provider description, capped at 2 KB
  metadata:        whatever provider sent back (capped at 2 KB serialized)
  createdAt:       ISO8601 UTC — wall time we INGESTED the event
  providerEventAt: ISO8601 UTC — wall time PROVIDER stamped the event
}

Idempotency key: (provider, providerEventId, kind)
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# Index hook
# ─────────────────────────────────────────────────────────────────────

async def ensure_suppression_indexes(db) -> None:
    """Idempotent. Indexes:
       1. read path: lookup "is (channel, address) blocked?" — fastest
          query is latest row by createdAt desc.
       2. idempotency: unique (provider, providerEventId, kind) so
          replay attempts from a webhook retry never write twice.
       3. correlation: providerMessageId → quick join to lifecycle.

    Each index is wrapped in its own try/except so a single failing
    creation (e.g. version-specific filter syntax rejection) does not
    stop later indexes from being created."""
    plans = [
        dict(keys=[("channel", 1), ("recipientAddress", 1), ("createdAt", -1)],
             name="sup_channel_address_createdAt"),
        # Idempotency: unique on the natural webhook key. We use
        # partialFilterExpression with `$exists: true` only — MongoDB
        # forbids `$ne: null` inside partial indexes.
        dict(keys=[("provider", 1), ("providerEventId", 1), ("kind", 1)],
             name="sup_idempotency", unique=True,
             partial={"providerEventId": {"$exists": True}}),
        dict(keys=[("providerMessageId", 1)],
             name="sup_providerMessageId",
             partial={"providerMessageId": {"$exists": True}}),
        dict(keys=[("createdAt", -1)], name="sup_createdAt_desc"),
    ]
    for p in plans:
        kwargs: Dict[str, Any] = {"background": True, "name": p["name"]}
        if p.get("unique"):
            kwargs["unique"] = True
        if p.get("partial"):
            kwargs["partialFilterExpression"] = p["partial"]
        try:
            await db.notification_suppressions.create_index(p["keys"], **kwargs)
        except Exception as e:  # pragma: no cover
            logger.warning(f"sup ensure_index({p['name']}) non-fatal: {e}")


# ─────────────────────────────────────────────────────────────────────
# WRITE — append only (called from webhook handlers)
# ─────────────────────────────────────────────────────────────────────

VALID_KINDS = frozenset({
    "hard_bounce", "soft_bounce", "spam_complaint",
    "subscription_unsubscribe", "subscription_reactivate",
    "manual_suppress", "manual_reactivate",
})

VALID_EFFECTS = frozenset({"block", "reactivate"})

VALID_CHANNELS = frozenset({"email", "sms", "push"})


def _normalize_address(channel: str, address: str) -> str:
    """Channel-specific normalization. Email is case-insensitive per
    RFC 5321 (the user@ part is technically case-sensitive but no one
    sends to case-sensitive mailboxes; we lower for safety)."""
    if not isinstance(address, str):
        return ""
    if channel == "email":
        return address.strip().lower()
    return address.strip()


async def append_suppression_event(
    db,
    *,
    channel: str,
    recipient_address: str,
    kind: str,
    effect: str,
    provider: str,
    provider_event_id: Optional[str],
    provider_message_id: Optional[str] = None,
    recipient_user_id: Optional[str] = None,
    reason: Optional[str] = None,
    detail_raw: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    provider_event_at: Optional[str] = None,
) -> Dict[str, Any]:
    """Append ONE row. Returns {ok, reason, rowId|None}.

    Idempotent on (provider, providerEventId, kind): a duplicate insert
    is reported as `{ok: True, reason: "duplicate"}` — webhook retries
    are silently accepted. Never raises (webhook handler always 200).
    """
    if channel not in VALID_CHANNELS:
        return {"ok": False, "reason": f"bad_channel:{channel}"}
    if kind not in VALID_KINDS:
        return {"ok": False, "reason": f"bad_kind:{kind}"}
    if effect not in VALID_EFFECTS:
        return {"ok": False, "reason": f"bad_effect:{effect}"}

    addr = _normalize_address(channel, recipient_address)
    if not addr:
        return {"ok": False, "reason": "empty_address"}

    now_iso = datetime.now(timezone.utc).isoformat()
    meta_blob = None
    if metadata is not None:
        try:
            blob = json.dumps(metadata, default=str)
            meta_blob = metadata if len(blob) <= 2048 else {"_truncated": True}
        except Exception:
            meta_blob = {"_unserializable": True}

    doc: Dict[str, Any] = {
        "id": uuid.uuid4().hex,
        "channel": channel,
        "recipientAddress": addr,
        "recipientUserId": str(recipient_user_id) if recipient_user_id else None,
        "kind": kind,
        "effect": effect,
        "provider": provider,
        "providerEventId": provider_event_id,
        "providerMessageId": provider_message_id,
        "reason": (reason or "")[:128] or None,
        "detailRaw": (detail_raw or "")[:2048] or None,
        "metadata": meta_blob,
        "providerEventAt": provider_event_at,
        "createdAt": now_iso,
    }
    try:
        await db.notification_suppressions.insert_one(doc)
        return {"ok": True, "reason": "appended", "rowId": doc["id"]}
    except Exception as e:
        # DuplicateKeyError on (provider, providerEventId, kind) — webhook retry.
        msg = str(e)
        if "duplicate key" in msg.lower() or "E11000" in msg:
            return {"ok": True, "reason": "duplicate"}
        logger.warning(f"sup append failed (non-fatal): {e}")
        return {"ok": False, "reason": f"insert_failed:{type(e).__name__}"}


# ─────────────────────────────────────────────────────────────────────
# READ — computed "is blocked?"
# ─────────────────────────────────────────────────────────────────────

async def is_blocked(db, *, channel: str, recipient_address: str) -> Tuple[bool, Optional[Dict[str, Any]]]:
    """Computed query. Returns (blocked, latestRow).

    Semantics:
      - Look up the LATEST suppression row for (channel, address) by
        createdAt desc.
      - If latest.effect == "block" → blocked=True
      - If latest.effect == "reactivate" or no row → blocked=False

    This honours the append-only invariant: reactivation is a new row,
    not a deletion of the bounce row. Forensic chronology is preserved.
    """
    if channel not in VALID_CHANNELS:
        return (False, None)
    addr = _normalize_address(channel, recipient_address)
    if not addr:
        return (False, None)
    try:
        row = await db.notification_suppressions.find_one(
            {"channel": channel, "recipientAddress": addr},
            {"_id": 0},
            sort=[("createdAt", -1)],
        )
    except Exception as e:
        # If suppression query fails, FAIL-OPEN (allow send). Roman
        # invariant: dry-run audit is forensic; transport-side failures
        # never escalate beyond logging.
        logger.warning(f"sup is_blocked query failed (fail-open): {e}")
        return (False, None)
    if not row:
        return (False, None)
    return (row.get("effect") == "block", row)


async def list_suppressions(
    db,
    *,
    channel: Optional[str] = None,
    recipient_address: Optional[str] = None,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    """Admin observability read. Sorted by createdAt desc."""
    q: Dict[str, Any] = {}
    if channel:
        q["channel"] = channel
    if recipient_address:
        q["recipientAddress"] = _normalize_address(channel or "email", recipient_address)
    try:
        cursor = db.notification_suppressions.find(q, {"_id": 0}).sort(
            "createdAt", -1
        ).limit(max(1, min(int(limit), 1000)))
        return await cursor.to_list(length=1000)
    except Exception as e:
        logger.warning(f"sup list failed: {e}")
        return []


__all__ = [
    "ensure_suppression_indexes",
    "append_suppression_event",
    "is_blocked",
    "list_suppressions",
    "VALID_KINDS", "VALID_EFFECTS", "VALID_CHANNELS",
]
