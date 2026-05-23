"""Sprint P0.b.C.f — F.3: payment_events projector.

Pure functions. List-in, list-out. NO db calls. NO state. NO reducer.

Three projections (3 actors — inspector deliberately absent):
  - project_customer(rows) → customer-safe payment-activity rows
  - project_provider(rows) → provider-safe payout-activity rows
  - project_admin(rows)    → raw forensic passthrough

OPACITY INVARIANTS (cross-actor):
  Customer NEVER sees: transfer.*, admin.*, *:rejected
  Provider NEVER sees: payment.initiated, payment.failed,
                       escrow.release_requested, escrow.release_rejected,
                       refund.requested, admin.*, *:rejected
  Customer/Provider NEVER see meta keys:
    platformCut, internalNotes, webhookId, providerId, customerId,
    customerNote, adminNote
  Customer/Provider see actor.role ONLY (actor.id redacted)
  Admin sees everything verbatim.
"""
from __future__ import annotations

from typing import Any, Dict, List


# ── Customer visible kinds (closed set) ────────────────────────────────────
CUSTOMER_VISIBLE_KINDS = frozenset({
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

# ── Provider visible kinds (closed set) ────────────────────────────────────
# Note: provider sees escrow.held + escrow.released as informational context
# ("funds being held for your job"), plus their own transfer.* lifecycle,
# plus dispute and refund.succeeded that impact payout.
PROVIDER_VISIBLE_KINDS = frozenset({
    "escrow.held",
    "escrow.released",
    "transfer.initiated",
    "transfer.succeeded",
    "transfer.failed",
    "refund.succeeded",
    "dispute.linked",
    "dispute.resolved",
})

# ── Meta whitelists per actor (closed sets) ────────────────────────────────
CUSTOMER_META_WHITELIST = frozenset({
    "amount", "currency", "releaseEta", "disputeId", "resolution", "reason",
})
PROVIDER_META_WHITELIST = frozenset({
    "amount", "currency", "payoutAmount", "transferRef",
    "arrivalEta", "resolution", "disputeId",
})

# Meta keys FORBIDDEN in customer/provider output (defence-in-depth — the
# whitelist already excludes them, but this set is what tests assert against).
FORBIDDEN_META_KEYS_OUTSIDE_ADMIN = frozenset({
    "platformCut", "internalNotes", "webhookId", "providerId",
    "customerId", "customerNote", "adminNote", "stripeSecret",
})


def _redact_actor(actor: Dict[str, Any]) -> Dict[str, Any]:
    """Customer/Provider: drop actor.id, keep role only."""
    return {"role": actor.get("role", "platform") if actor else "platform"}


def _filter_meta(meta: Dict[str, Any], whitelist: frozenset) -> Dict[str, Any]:
    """Pass through ONLY whitelisted keys. Defensive: also strip forbidden
    keys even if they accidentally show up in whitelist (belt + suspenders)."""
    if not isinstance(meta, dict):
        return {}
    out: Dict[str, Any] = {}
    for k, v in meta.items():
        if k in FORBIDDEN_META_KEYS_OUTSIDE_ADMIN:
            continue
        if k in whitelist:
            out[k] = v
    return out


def _project_row(
    row: Dict[str, Any],
    *,
    kind_whitelist: frozenset,
    meta_whitelist: frozenset,
) -> Dict[str, Any] | None:
    """Returns projected row or None if filtered out by kind whitelist.
    Also filters out any `:rejected` suffix kind by hard rule (only admin
    surface includes rejected variants)."""
    kind = row.get("kind", "")
    if ":rejected" in kind:
        return None
    if kind not in kind_whitelist:
        return None
    return {
        "id": row.get("id"),
        "paymentId": row.get("paymentId"),
        "kind": kind,
        "at": row.get("at"),
        "actor": _redact_actor(row.get("actor", {})),
        "meta": _filter_meta(row.get("meta", {}), meta_whitelist),
    }


def project_customer(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """payment-activity.customer projection."""
    out: List[Dict[str, Any]] = []
    for r in rows:
        p = _project_row(
            r,
            kind_whitelist=CUSTOMER_VISIBLE_KINDS,
            meta_whitelist=CUSTOMER_META_WHITELIST,
        )
        if p is not None:
            out.append(p)
    return out


def project_provider(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """payout-activity.provider projection."""
    out: List[Dict[str, Any]] = []
    for r in rows:
        p = _project_row(
            r,
            kind_whitelist=PROVIDER_VISIBLE_KINDS,
            meta_whitelist=PROVIDER_META_WHITELIST,
        )
        if p is not None:
            out.append(p)
    return out


def project_admin(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """payment-forensic.admin — raw passthrough. NO filtering.

    Strips Mongo _id only (response-safe). All other fields verbatim,
    including :rejected rows, full actor.id, raw meta with internal keys.
    Each row keeps unique `id` for client-side dedup.
    """
    out: List[Dict[str, Any]] = []
    for r in rows:
        copy = {k: v for k, v in r.items() if k != "_id"}
        out.append(copy)
    return out
