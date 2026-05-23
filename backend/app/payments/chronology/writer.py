"""Sprint P0.b.C.f — F.2: payment_events append-only writer.

CONTRACT (frozen, see /app/memory/P0bCf_F1_taxonomy_frozen_2026_02_22.md):

  I-1. APPEND-ONLY — only insert_one. No update/delete/find_and_modify.
  I-2. NO orthogonal rejected: bool — encode rejection in the kind suffix.
  I-3. NO projection over money_audit or stripe_webhook_events.
  I-4. CLOSED KIND SET — unknown kind raises ValueError.
  I-5. SPARSE — ≤ ~10 rows per payment lifecycle.

Public API:
  KINDS                                  — frozen literal set (19)
  ACTOR_ROLES                            — closed set
  append_payment_event(db, **kwargs)     — only mutation entry-point
  ensure_indexes(db)                     — idempotent startup hook

Forbidden (statically by code shape):
  No emit_event(any_string) generic
  No PaymentStateMachine, PaymentReducer, ChronologyEngine
  No reuse of booking_timeline writer
  No webhook payload echo (only fields we own)
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────
# Frozen taxonomy. 19 literals.
# ──────────────────────────────────────────────────────────────────────────

# Customer-visible kinds (also seen by admin; provider-visible subset listed
# separately below for projector reference).
KINDS_CUSTOMER_VISIBLE = frozenset({
    "payment.initiated",
    "payment.failed",
    "escrow.held",
    "escrow.release_requested",
    "escrow.release_rejected",
    "escrow.released",
    "refund.requested",
    "refund.succeeded",
    "refund.failed",
    "dispute.linked",
    "dispute.resolved",
})

# Provider-visible kinds. Note: some customer-visible kinds (escrow.held,
# escrow.released, refund.succeeded, dispute.linked, dispute.resolved) are
# ALSO surfaced to provider — that's a projector decision, not a writer one.
KINDS_PROVIDER_CORE = frozenset({
    "transfer.initiated",
    "transfer.succeeded",
    "transfer.failed",
})

# Admin-only forensic kinds (NEVER projected to customer/provider).
KINDS_ADMIN_ONLY = frozenset({
    "admin.freeze.applied",
    "admin.freeze.lifted",
    "admin.force_release",
    "refund.requested:rejected",
    "admin.force_release:rejected",
})

# Complete closed set. Writer rejects anything outside this set.
KINDS: frozenset = (
    KINDS_CUSTOMER_VISIBLE | KINDS_PROVIDER_CORE | KINDS_ADMIN_ONLY
)

# Sanity: exactly 19 kinds per frozen taxonomy doc.
assert len(KINDS) == 19, (
    f"Taxonomy drift: expected 19 frozen kinds, got {len(KINDS)}. "
    f"Update F.1 doc before changing this."
)

# Closed set of actor roles. 'platform' = the platform itself initiated the
# row (e.g. orchestrator). 'stripe' = translated from a Stripe webhook.
ACTOR_ROLES = frozenset({
    "customer",
    "provider",
    "admin",
    "platform",
    "stripe",
})

# Closed set of rejection reasons for escrow.release_rejected. The writer
# does NOT enforce this (meta is loose by design), but projectors and tests
# refer to this enum. Documented here to keep ontology in one place.
ESCROW_RELEASE_REJECTION_REASONS = frozenset({
    "dispute_open",
    "platform_frozen",
    "provider_frozen",
    "delay_gate",
    "validation_failed",
})


SCHEMA_VERSION = 1


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ──────────────────────────────────────────────────────────────────────────
# Append-only writer.
# ──────────────────────────────────────────────────────────────────────────


async def append_payment_event(
    db,
    *,
    payment_id: str,
    kind: str,
    actor_id: str,
    actor_role: str,
    meta: Optional[Dict[str, Any]] = None,
    source_webhook_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Append one row to `payment_events`. Returns the inserted doc.

    Args:
      db: Motor AsyncIOMotorDatabase.
      payment_id: service_payments id this row is about.
      kind: one of KINDS (closed set). ValueError on unknown.
      actor_id: user id, 'platform', or 'stripe'.
      actor_role: one of ACTOR_ROLES. ValueError on unknown.
      meta: kind-specific dict; loose by design. Pass through verbatim.
      source_webhook_id: stripe_webhook_events id when this row was
        translated from a webhook; None for platform-initiated rows.

    Raises:
      ValueError on unknown kind or unknown actor_role.

    Append-only: never updates, never deletes. Corrections come as new rows
    with a different kind (e.g. refund.requested:rejected after a prior
    refund.requested).
    """
    if kind not in KINDS:
        raise ValueError(
            f"Unknown payment_events kind: {kind!r}. "
            f"Closed set of {len(KINDS)} literals — see "
            f"/app/memory/P0bCf_F1_taxonomy_frozen_2026_02_22.md"
        )
    if actor_role not in ACTOR_ROLES:
        raise ValueError(
            f"Unknown actor_role: {actor_role!r}. "
            f"Closed set: {sorted(ACTOR_ROLES)}"
        )
    if not payment_id or not isinstance(payment_id, str):
        raise ValueError(f"payment_id must be non-empty str, got {payment_id!r}")
    if not actor_id or not isinstance(actor_id, str):
        raise ValueError(f"actor_id must be non-empty str, got {actor_id!r}")

    doc: Dict[str, Any] = {
        "id": uuid.uuid4().hex,
        "paymentId": payment_id,
        "kind": kind,
        "at": _now_iso(),
        "actor": {"id": actor_id, "role": actor_role},
        "meta": dict(meta) if meta else {},
        "sourceWebhookId": source_webhook_id,
        "schemaVersion": SCHEMA_VERSION,
    }
    # Insert. Motor mutates input dict to add _id; we strip it before returning.
    to_insert = dict(doc)
    await db.payment_events.insert_one(to_insert)

    # Sprint P0.b.C.h — realtime sidecar. Fire-and-forget; subscribers are
    # in-process so this is a cheap fanout. Wrapped so a misbehaving
    # subscriber NEVER sabotages the append that just succeeded. Same
    # best-effort discipline as booking-timeline realtime publisher.
    # REST remains source of truth; realtime is acceleration only.
    try:
        from app.payments.chronology.realtime import publish_payment_event
        await publish_payment_event(db, doc)
    except Exception as e:
        logger.warning(
            f"[payment_events] realtime publish failed "
            f"payment_id={payment_id} kind={kind} err={e}"
        )

    # Return the version without _id (response-safe).
    return doc


async def ensure_indexes(db) -> None:
    """Idempotent index ensure. Adds-only, never drops.

    Indexes mirror the three primary query patterns of the F.4 REST/WS layer:
      1. (paymentId, at DESC) — fetch chronology for one payment.
      2. (kind, at DESC)     — kind-wide queries (ops dashboards).
      3. (actor.id, at DESC) — per-user audit trail.
    """
    try:
        await db.payment_events.create_index(
            [("paymentId", 1), ("at", -1)],
            name="payment_chronology",
        )
        await db.payment_events.create_index(
            [("kind", 1), ("at", -1)],
            name="kind_history",
        )
        await db.payment_events.create_index(
            [("actor.id", 1), ("at", -1)],
            name="actor_history",
        )
        # Hard uniqueness on row id (so client-side dedup by id is safe).
        await db.payment_events.create_index(
            [("id", 1)],
            name="row_id_unique",
            unique=True,
        )
    except Exception as e:
        logger.warning(f"[payment_events] ensure_indexes failed: {e}")
