"""car_selection — advisory workflow for human-mediated car selection.

Lives ALONGSIDE the inspection/auto-request namespaces. It is NOT:
  • app/auto_requests (inspection execution domain)
  • app/marketplace      (provider bidding)
  • app/matching_v2      (inspection dispatch)
  • app/pricing          (inspection economics)

Separation rationale:

  car selection = advisory workflow  (human scout, admin-mediated)
  inspection    = execution workflow (geo-bound, density-priced, frozen)

These are different operational domains. Mixing them would:
  • pollute inspection lifecycle with advisory statuses
  • blur SLA — inspections are seconds-to-minutes, selection is days
  • break density/pricing invariants (selection has no geo dispatch)
  • make admin queue triage harder

Sprint 1 (current): models, repository, lifecycle, customer + admin
routers. Real Mongo persistence. NO mocks, NO scraping, NO AI, NO
enrichment. Admin-mediated only.
"""
from app.car_selection.lifecycle import (
    SERVICE_TYPES,
    STATUSES,
    TERMINAL_STATUSES,
    ALLOWED_TRANSITIONS,
    CarSelectionServiceType,
    CarSelectionStatus,
    is_transition_allowed,
)
from app.car_selection.repository import (
    CarSelectionRepository,
    InvalidTransitionError,
    RequestNotFoundError,
)

__all__ = [
    "SERVICE_TYPES",
    "STATUSES",
    "TERMINAL_STATUSES",
    "ALLOWED_TRANSITIONS",
    "CarSelectionServiceType",
    "CarSelectionStatus",
    "is_transition_allowed",
    "CarSelectionRepository",
    "InvalidTransitionError",
    "RequestNotFoundError",
]
