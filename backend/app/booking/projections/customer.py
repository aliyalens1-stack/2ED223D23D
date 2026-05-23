"""Customer-facing timeline projection.

The customer's view of a booking lifecycle is the most trust-sensitive
projection — accidentally leaking internal truth here destroys faith in
the platform. We err HARD on the side of hiding.

Visibility contract (whitelist, not blacklist):

  Customer ONLY sees:
    1. Their own actions (cancel)
    2. Provider operational milestones (confirmed, on_route, arrived,
       in_progress, completed)
    3. Closure outcomes (cancelled, resolved)

  Customer NEVER sees:
    * `*:rejected` rows — entirely hidden (no "your refund was rejected"
      banner; no admin attempt traces)
    * platformCut / commission fields
    * internalNotes / internal admin comments
    * otherPartyId (provider ids stay opaque under "Provider")
    * refundReason / refundNote (handled separately in payments flow)
    * moderation metadata (flag / restore / exclude-rating)
    * admin actor ids ("admin took action X" → just hidden)
    * TOCTOU error strings
    * dispute internals (only the fact a dispute exists)

This module is INTENTIONALLY duplicated from any provider/inspector/admin
projection (P0.b.C.b/c/d). Sharing here would make divergence dangerous.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional


# Whitelist of timeline actions the customer is allowed to see.
# Adding an action here is a deliberate UX decision; do not generalize.
_CUSTOMER_VISIBLE_ACTIONS: Dict[str, Dict[str, str]] = {
    # Customer's own actions
    "cancel": {
        "key": "cancelled",
        "label": "Вы отменили заказ",
        "description": "Заказ отменён по вашей просьбе.",
        "tone": "neutral",
    },
    # Provider operational milestones
    "mark_confirmed": {
        "key": "confirmed",
        "label": "Исполнитель подтвердил",
        "description": "Готовится к выезду.",
        "tone": "positive",
    },
    "mark_on_route": {
        "key": "on_route",
        "label": "Исполнитель выехал",
        "description": "В пути к вам.",
        "tone": "positive",
    },
    "mark_arrived": {
        "key": "arrived",
        "label": "Прибыл на место",
        "description": "Исполнитель на месте.",
        "tone": "positive",
    },
    "mark_in_progress": {
        "key": "in_progress",
        "label": "Работа началась",
        "description": "Дождитесь завершения.",
        "tone": "positive",
    },
    "mark_completed": {
        "key": "completed",
        "label": "Работа завершена",
        "description": "Можно оставить отзыв.",
        "tone": "celebratory",
    },
    # Dispute existence — but NOT internals
    "open_dispute": {
        "key": "disputed",
        "label": "Открыт спор",
        "description": "Команда поддержки разбирается.",
        "tone": "alert",
    },
    "resolve_dispute": {
        "key": "resolved",
        "label": "Спор закрыт",
        "description": "Решение администрации.",
        "tone": "neutral",
    },
}

# Everything else is hidden by default. We expose the exhaustive hidden
# list for tests + documentation — keep it manually in sync with the FSM.
HIDDEN_FROM_CUSTOMER: List[str] = [
    # System-internal lifecycle that customer doesn't need to track
    "mark_matched",
    # Every rejected attempt — never show "we tried to cancel and failed"
    "cancel:rejected",
    "mark_matched:rejected",
    "mark_confirmed:rejected",
    "mark_on_route:rejected",
    "mark_arrived:rejected",
    "mark_in_progress:rejected",
    "mark_completed:rejected",
    "open_dispute:rejected",
    "resolve_dispute:rejected",
]


# Keys from row.meta that are SAFE to surface to customer.
# Whitelist, not blacklist — anything not listed is dropped.
_SAFE_META_KEYS = {
    "reason",   # cancel reason from customer themselves
    "eta",      # provider on_route ETA
}


def _sanitize_meta(meta: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not meta:
        return {}
    return {k: v for k, v in meta.items() if k in _SAFE_META_KEYS and v not in (None, "")}


def _row_belongs_to_customer(row: Dict[str, Any], customer_id: str) -> bool:
    """Customer's own actions are theirs to see in full. Other actors'
    actions are surfaced only via the action whitelist."""
    return row.get("actorRole") == "customer" and row.get("actorId") == customer_id


def project_timeline_for_customer(
    rows: List[Dict[str, Any]],
    *,
    customer_id: str,
) -> List[Dict[str, Any]]:
    """Project raw `booking_timeline` rows into the customer-facing view.

    Args:
        rows: ordered list of timeline rows from `booking_timeline`.
        customer_id: the authenticated customer's user id. Used ONLY to
            decide whether a cancel row was the customer's own (vs. an
            admin cancel from the moderation surface).

    Returns:
        Filtered + relabelled list. Hidden rows are dropped entirely
        (no placeholders, no "system action took place" lines).
        Sort order matches input.
    """
    out: List[Dict[str, Any]] = []
    for row in rows:
        action = row.get("action") or ""
        # Hide every `:rejected` attempt — non-negotiable for trust.
        if action.endswith(":rejected"):
            continue
        spec = _CUSTOMER_VISIBLE_ACTIONS.get(action)
        if spec is None:
            # Anything not in the whitelist is hidden. No fallthrough.
            continue
        # Admin-initiated cancels show up to the customer as a generic
        # "cancelled" — but we do not leak the admin actor id.
        is_self = _row_belongs_to_customer(row, customer_id) if action == "cancel" else False
        out.append({
            "key": spec["key"],
            "label": spec["label"],
            "description": spec["description"],
            "tone": spec["tone"],
            "at": row.get("timestamp"),
            "isSelfAction": is_self,
            "meta": _sanitize_meta(row.get("meta")),
        })
    return out
