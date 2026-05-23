"""Car-Selection-6 — Offer Packages.

An OfferPackage is an *immutable commercial deliverable* produced by a
provider for a customer inside a Car-Selection request.

This module is intentionally a **separate bounded context** from
`car_selection_thread`:

    thread        — conversation              (append-only messages)
    artifacts     — evidence                  (immutable blobs)
    offer_package — deliverable               (commercial commitment)

Why a separate context:

    * deliverables have their own lifecycle (`draft` → `delivered` →
      `accepted` | `declined` | `revoked`) which does NOT overlap with
      the request lifecycle. Mixing the two leaks state transitions.
    * deliverables freeze content at `deliver` time — title, summary,
      price and the artifact bundle become immutable. Messages never
      have content immutability semantics.
    * deliverables carry COMMERCIAL data (price, currency) and an
      acceptance event the customer is committing to. The thread is
      not a place to commit anything.

What this module deliberately AVOIDS:

    * no revisions in-place: a provider who needs to change a delivered
      package creates a new `version` (next sprint). v1 freezes at
      deliver-time and that's the truth that goes into reporting.
    * no fan-out notifications via this module (Phase 5 thread
      notifier remains the single inbox projector). Phase 6 adds
      lifecycle hooks that **call the existing thread notifier** so
      we keep ONE inbox surface.
    * no payment coupling. Money flow comes later; this module only
      records the agreed price as a frozen number on accept.
"""
from app.offer_packages.lifecycle import (
    STATUSES,
    TERMINAL_STATUSES,
    PROVIDER_EDITABLE_STATUSES,
    ALLOWED_TRANSITIONS,
    is_transition_allowed,
    OfferPackageStatus,
)

__all__ = [
    "STATUSES",
    "TERMINAL_STATUSES",
    "PROVIDER_EDITABLE_STATUSES",
    "ALLOWED_TRANSITIONS",
    "is_transition_allowed",
    "OfferPackageStatus",
]
