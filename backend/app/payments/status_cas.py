"""Sprint B4.3-A.2 — Service-payment status CAS helper.

Doctrine:
  This is NOT a reservation ledger. NOT a new accounting layer.
  It is one small piece of TOCTOU-safe write discipline for the
  EXISTING mutable `service_payments.status` field.

What it does:
  Wraps `service_payments.update_one` with a `{status: expected_from}`
  CAS filter so concurrent / redelivered / out-of-order callers can
  never silently overwrite a terminal state.

What it does NOT do:
  * No `ac_reserved` / `ac_hold` / `ac_pending` namespaces.
  * No new collection.
  * No balance tracking.
  * No boot-time replay.
  * No new chronology kinds (chronology side-effects remain best-effort
    and reuse the EXISTING taxonomy from F.1: `escrow.release_rejected`
    is the only `:rejected` literal the customer ever sees, and it is
    written ONLY at sites where that pattern already exists).
  * No projector changes.

The helper signature is deliberately minimal: one function, no class,
no global state.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Literal, Optional, Tuple

logger = logging.getLogger(__name__)


# Outcome literals — explicit enum so callers can branch deterministically.
OutcomeLiteral = Literal["modified", "idempotent", "forbidden", "missing"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def cas_set_payment_status(
    db,
    *,
    payment_id: str,
    expected_from: Iterable[str],
    next_status: str,
    extra_fields: Optional[Dict[str, Any]] = None,
) -> Tuple[OutcomeLiteral, Optional[str]]:
    """Compare-and-set `service_payments.status`.

    Args:
        db: Motor database handle.
        payment_id: `service_payments.id` to mutate.
        expected_from: closed set of statuses from which `next_status`
            is permitted. The CAS query is
            `{"id": payment_id, "status": {"$in": list(expected_from)}}`.
        next_status: the post-mutation status.
        extra_fields: additional `$set` payload (paidAt, releasedAt,
            failureReason, etc.). `updatedAt` is set automatically.

    Returns:
        `("modified", <prev_status>)`   — write succeeded; row's status
            BEFORE the write was one of `expected_from`. Caller may
            proceed with side-effects (notifications, chronology, ...).
        `("idempotent", <current_status>)` — row exists and already has
            `status == next_status`. Caller should suppress side-effects.
        `("forbidden", <current_status>)` — row exists, status is neither
            in `expected_from` nor equal to `next_status`. Caller MUST
            NOT proceed; status drift detected (e.g. webhook arrived
            after a refund). Caller may log + write a `:rejected` row.
        `("missing", None)` — no row with that `id` exists.

    Discipline:
        * The function only mutates the document if the CAS filter
          matches. It NEVER overwrites a status that wasn't in the
          whitelist.
        * The function NEVER raises on DB errors; it logs and returns
          ("missing", None) on exception, so callers don't have to
          wrap. Side-effect failures must not corrupt money state.
    """
    expected_list = list(expected_from)
    set_payload: Dict[str, Any] = {
        "status": next_status,
        "updatedAt": _now_iso(),
    }
    if extra_fields:
        # Defensive copy — never let caller mutate the dict we operate on.
        # Status, if leaked into extra_fields, MUST NOT override next_status.
        for k, v in extra_fields.items():
            if k in ("status", "updatedAt"):
                continue
            set_payload[k] = v

    try:
        # Try the CAS write first. modified_count == 1 means the row was
        # in one of the expected `from` states AND we just flipped it.
        result = await db.service_payments.update_one(
            {"id": payment_id, "status": {"$in": expected_list}},
            {"$set": set_payload},
        )
    except Exception as exc:
        logger.exception(
            f"[status_cas] write error payment_id={payment_id} "
            f"expected_from={expected_list} next={next_status} err={exc}"
        )
        return "missing", None

    if result.modified_count == 1:
        # We won the race. Caller may proceed with side-effects.
        # We don't know the exact prev_status from update_one — but
        # `expected_from` is closed; caller already knew the legal set.
        # Returning the first expected literal as a coarse hint is
        # better than None for telemetry; callers shouldn't rely on it
        # for branching.
        return "modified", expected_list[0] if len(expected_list) == 1 else None

    # CAS missed. Figure out whether the row is missing, already at
    # `next_status` (idempotent), or in a foreign status (forbidden).
    try:
        doc = await db.service_payments.find_one(
            {"id": payment_id},
            {"_id": 0, "status": 1},
        )
    except Exception as exc:
        logger.exception(f"[status_cas] read error payment_id={payment_id} err={exc}")
        return "missing", None

    if not doc:
        return "missing", None

    current = doc.get("status")
    if current == next_status:
        return "idempotent", current
    return "forbidden", current


__all__ = ["cas_set_payment_status", "OutcomeLiteral"]
