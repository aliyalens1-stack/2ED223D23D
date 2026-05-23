"""offer_packages — locked lifecycle.

Statuses:

    draft       — provider is composing; customer cannot see
    delivered   — frozen and visible to customer; awaiting decision
    accepted    — customer accepted the offer  (terminal)
    declined    — customer declined the offer  (terminal)
    revoked     — admin pulled the package     (terminal)

Adjacency:

    draft       → delivered, revoked            (provider deliver / admin pull)
    delivered   → accepted, declined, revoked   (customer decide / admin pull)
    accepted    → ∅
    declined    → ∅
    revoked     → ∅

Why locked:
    These literals back the customer commercial flow, the admin
    governance UI, and any future revenue / acceptance funnel. Adding
    a new status mid-flight breaks audit aggregation and silently
    re-classifies historical deliveries.

Important boundaries:
    * `draft` is the ONLY status during which package content is
      mutable. The freeze is enforced in repository.update_draft().
    * Reaching `delivered` triggers a notification projection
      (customer + admin). Acceptance / decline projects to provider
      + admin. Revocation projects to provider + customer.
    * Cancellation of the parent Car-Selection request does NOT
      automatically revoke open offer packages — admins decide
      explicitly. We surface stale packages instead of cascading.
"""
from __future__ import annotations
from typing import Final, FrozenSet, Literal, Mapping


OfferPackageStatus = Literal[
    "draft",
    "delivered",
    "accepted",
    "declined",
    "revoked",
]

STATUSES: Final[FrozenSet[str]] = frozenset({
    "draft", "delivered", "accepted", "declined", "revoked",
})

TERMINAL_STATUSES: Final[FrozenSet[str]] = frozenset({
    "accepted", "declined", "revoked",
})

# Content is editable only while the package is in this set. Anywhere
# else the package is frozen — see repository.update_draft().
PROVIDER_EDITABLE_STATUSES: Final[FrozenSet[str]] = frozenset({"draft"})


# Adjacency. `revoked` is reachable from any non-terminal state — admin
# can recall a package even after the customer has seen it, but cannot
# undo an accept/decline. The transition table itself does NOT encode
# *who* is allowed to perform the transition — that is enforced at the
# router layer (provider can only `deliver`, customer can only
# `accept`/`decline`, admin can `revoke`).
ALLOWED_TRANSITIONS: Final[Mapping[str, FrozenSet[str]]] = {
    "draft":     frozenset({"delivered", "revoked"}),
    "delivered": frozenset({"accepted", "declined", "revoked"}),
    "accepted":  frozenset(),
    "declined":  frozenset(),
    "revoked":   frozenset(),
}


def is_transition_allowed(current: str, target: str) -> bool:
    """Strict lifecycle check. Returns False for unknown statuses or
    no-op transitions; mirrors car_selection.lifecycle for consistency.
    """
    if current not in ALLOWED_TRANSITIONS or target not in STATUSES:
        return False
    if current == target:
        return False
    return target in ALLOWED_TRANSITIONS[current]


__all__ = [
    "OfferPackageStatus",
    "STATUSES",
    "TERMINAL_STATUSES",
    "PROVIDER_EDITABLE_STATUSES",
    "ALLOWED_TRANSITIONS",
    "is_transition_allowed",
]
