"""P0.d — payout state machine.

The final FSM (after adding `failed` per the 2026-02-20 brief):

                ┌──────────┐
                │ pending  │
                └────┬─────┘
                     │ approve
                     ▼
                ┌──────────┐                ┌──────┐
                │ approved │ ───hold───▶    │ hold │
                └────┬─────┘                └──┬───┘
                     │ process                 │ approve
                     ▼                         ▼
                ┌─────────────┐           (back to approved)
                │ processing  │ ───hold──▶  hold
                └─────┬───┬───┘
                      │   └── failed ────▶  ┌────────┐  (TERMINAL)
                      │ paid                │ failed │
                      ▼                     └────────┘
                ┌──────┐
                │ paid │ (TERMINAL)
                └──────┘

Rules (exact wording from sprint brief):
  * paid    — terminal
  * failed  — terminal (retry will be a future, separate sprint)
  * hold    — only from non-terminal states
  * process — only from approved
  * approve — only from pending or hold
"""
from __future__ import annotations
from typing import Tuple

# Status enum used by `payouts` documents.
PayoutStatus = str  # one of:
PAYOUT_STATES = ("pending", "approved", "hold", "processing", "paid", "failed")

# Terminal — no transitions allowed out.
PAYOUT_TERMINAL = {"paid", "failed"}

# Action → (allowed_from, target_state)
PAYOUT_TRANSITIONS = {
    "approve": ({"pending", "hold"},          "approved"),
    "hold":    ({"pending", "approved", "processing"}, "hold"),
    "process": ({"approved"},                 "processing"),
    # Engine-only transitions (not exposed as admin endpoints in P0.d):
    "_mark_paid":   ({"processing"}, "paid"),
    "_mark_failed": ({"processing"}, "failed"),
}


class PayoutTransitionError(Exception):
    """Raised when a payout transition violates the FSM."""

    def __init__(self, msg: str, *, status_code: int = 409):
        super().__init__(msg)
        self.status_code = status_code


def assert_transition(current: str, action: str) -> Tuple[str, str]:
    """Validate `action` is legal from `current` status.

    Returns `(current, target)` on success. Raises `PayoutTransitionError`
    on violation (admin caller maps to 409).
    """
    if current in PAYOUT_TERMINAL:
        raise PayoutTransitionError(
            f"Payout is terminal ({current}); no further transitions allowed.",
            status_code=409,
        )
    spec = PAYOUT_TRANSITIONS.get(action)
    if spec is None:
        raise PayoutTransitionError(
            f"Unknown payout action: {action}",
            status_code=400,
        )
    allowed_from, target = spec
    if current not in allowed_from:
        raise PayoutTransitionError(
            f"Cannot {action} from status={current}; "
            f"allowed only from {sorted(allowed_from)}.",
            status_code=409,
        )
    return current, target
