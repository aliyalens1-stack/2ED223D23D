"""car_selection lifecycle — locked enums and allowed transitions.

These are LOCKED. Any change requires a new namespace version (car_selection_v2)
and a migration plan, not an edit.

Why locked:
  • Admin queue UI, notification triggers, customer-facing copy all
    pivot on these literals. Edits propagate silently into UX.
  • Reporting/audit aggregates by these values. New values break
    historical aggregation invariants.
"""
from __future__ import annotations
from typing import Literal, Final, FrozenSet, Mapping


CarSelectionServiceType = Literal[
    "budget_search",      # find a car within budget — managed scout work
    "market_search",      # scan the market for a specific pattern
    "negotiation_help",   # human help negotiating with a seller
    "listing_review",     # human review of a specific mobile.de listing
]

SERVICE_TYPES: Final[FrozenSet[str]] = frozenset({
    "budget_search",
    "market_search",
    "negotiation_help",
    "listing_review",
})


CarSelectionStatus = Literal[
    "submitted",          # customer created
    "reviewing",          # admin opened
    "assigned",           # provider/expert assigned
    "in_progress",        # active work
    "waiting_customer",   # paused on info request
    "completed",          # done
    "cancelled",          # cancelled (by customer or admin)
]

STATUSES: Final[FrozenSet[str]] = frozenset({
    "submitted",
    "reviewing",
    "assigned",
    "in_progress",
    "waiting_customer",
    "completed",
    "cancelled",
})

# Terminal states. Once a request reaches one of these, no further
# transitions are accepted (idempotency at the lifecycle layer).
TERMINAL_STATUSES: Final[FrozenSet[str]] = frozenset({
    "completed",
    "cancelled",
})


# Adjacency table — what each status can move to NEXT.
#
# Design notes:
#   • `submitted` → `reviewing` only via admin pickup. (No customer
#     edits — the request as posted IS the brief.)
#   • `reviewing` → `assigned` once admin assigns a worker.
#   • `assigned` → `in_progress` when the worker actually starts.
#   • Cancellation is reachable from every non-terminal status.
#   • `completed` is only reachable from `in_progress` or
#     `waiting_customer` — never directly from `submitted`/`reviewing`,
#     so no admin can accidentally close a request that no one worked.
ALLOWED_TRANSITIONS: Final[Mapping[str, FrozenSet[str]]] = {
    "submitted":         frozenset({"reviewing", "cancelled"}),
    "reviewing":         frozenset({"assigned", "cancelled"}),
    "assigned":          frozenset({"in_progress", "waiting_customer", "cancelled"}),
    "in_progress":       frozenset({"waiting_customer", "completed", "cancelled"}),
    "waiting_customer":  frozenset({"in_progress", "completed", "cancelled"}),
    "completed":         frozenset(),  # terminal
    "cancelled":         frozenset(),  # terminal
}


def is_transition_allowed(current: str, target: str) -> bool:
    """Strict lifecycle check. Returns False on:
      • unknown current/target status
      • same-status transitions (no-ops are not allowed transitions)
      • terminal current status
    """
    if current not in ALLOWED_TRANSITIONS or target not in STATUSES:
        return False
    return target in ALLOWED_TRANSITIONS[current]
