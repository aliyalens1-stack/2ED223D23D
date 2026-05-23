"""Booking lifecycle FSM — explicit, frozen, non-generic.

Canonical states (frozen, never reshape):

      requested
         │ (matcher)
         ▼
       matched
         │ (provider/admin accepts)
         ▼
      confirmed ──────┐
         │            │
         │ (provider  │
         │  start)    │
         ▼            │
      on_route        │
         │            │ (off-ramp)
         ▼            │ cancel allowed
       arrived        │ from requested,
         │            │ matched, confirmed
         ▼            │
    in_progress ──────┤
         │   │        │
         │   └── dispute open
         ▼            │
     completed ──────►│ (also: completed→disputed)
         │            │
         ▼            ▼
    (terminal)    cancelled (terminal)

      disputed
         │ (admin resolve)
         ▼
      resolved (terminal)

Terminal states: completed, cancelled, resolved.

Every transition below is a literal. No graph. No DSL. No registry.
Adding a state means editing this file. That is the point.
"""
from __future__ import annotations
from typing import Set, Tuple


# ── State enum — frozen ───────────────────────────────────────────
BOOKING_STATES: Tuple[str, ...] = (
    "requested",
    "matched",
    "confirmed",
    "on_route",
    "arrived",
    "in_progress",
    "completed",
    "cancelled",
    "disputed",
    "resolved",
)

BOOKING_TERMINAL: Set[str] = {"completed", "cancelled", "resolved"}


# ── Action → (allowed_from set, target state) ─────────────────────
# Each action is its own function name in the spirit of money domain
# discipline. Code uses these explicitly:
#     assert_transition(current, "mark_matched") → ("requested", "matched")
BOOKING_TRANSITIONS: dict[str, Tuple[Set[str], str]] = {
    # Forward happy path
    "mark_matched":      ({"requested"},                       "matched"),
    "mark_confirmed":    ({"matched"},                         "confirmed"),
    "mark_on_route":     ({"confirmed"},                       "on_route"),
    "mark_arrived":      ({"on_route"},                        "arrived"),
    "mark_in_progress":  ({"arrived"},                         "in_progress"),
    "mark_completed":    ({"in_progress"},                     "completed"),

    # Off-ramps — explicit, only from non-engagement states
    "cancel":            ({"requested", "matched", "confirmed"}, "cancelled"),

    # Dispute branch
    "open_dispute":      ({"in_progress", "completed"},         "disputed"),
    "resolve_dispute":   ({"disputed"},                         "resolved"),
}


class BookingTransitionError(Exception):
    """Raised when an action is illegal from the current state."""

    def __init__(self, msg: str, *, status_code: int = 409):
        super().__init__(msg)
        self.status_code = status_code


def assert_transition(current: str, action: str) -> Tuple[str, str]:
    """Validate `action` is legal from `current`.

    Returns `(current, target)` on success.
    Raises `BookingTransitionError` with status_code=400 (unknown action)
    or 409 (illegal transition / terminal state).
    """
    if current in BOOKING_TERMINAL:
        raise BookingTransitionError(
            f"Booking is terminal ({current}); no further transitions allowed.",
            status_code=409,
        )
    spec = BOOKING_TRANSITIONS.get(action)
    if spec is None:
        raise BookingTransitionError(
            f"Unknown booking action: {action}",
            status_code=400,
        )
    allowed_from, target = spec
    if current not in allowed_from:
        raise BookingTransitionError(
            f"Cannot {action} from status={current}; "
            f"allowed only from {sorted(allowed_from)}.",
            status_code=409,
        )
    return current, target


def list_legal_actions(current: str) -> list[str]:
    """Return the list of action names legal from `current` (helper for UIs)."""
    if current in BOOKING_TERMINAL:
        return []
    return sorted(
        action for action, (allowed_from, _) in BOOKING_TRANSITIONS.items()
        if current in allowed_from
    )
