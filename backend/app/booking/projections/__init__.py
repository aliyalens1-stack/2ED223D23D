"""Booking projections — surface-specific semantic narrowing.

Discipline (per P0.b.C brief):

  surface-specific projection — NOT generic visibility engine
  explicit duplication — NOT shared rendering layer
  separate files per actor — customer / provider / inspector / admin

Each actor's projection module owns its OWN labels, OWN visibility rules,
OWN narrative tone. If customer and provider use the same word for the
same state today, that's a coincidence — they will diverge.

Anti-goals deliberately rejected:
  ❌ project_timeline(scope=...) dispatcher
  ❌ TIMELINE_VISIBILITY_MATRIX
  ❌ ROLE_RULES registry
  ❌ shared row renderer
  ❌ activity-feed events (no "viewed", no "hovered")
"""
# Back-compat: existing callers import `project_for_actor` from
# `app.booking.projections`. Re-export the state-level labels module.
from ..projections_labels import project_for_actor  # noqa: F401

# Per-actor timeline projectors (P0.b.C.a — customer first).
from .customer import (  # noqa: F401
    project_timeline_for_customer,
    HIDDEN_FROM_CUSTOMER,
)
# P0.b.C.b — provider projection (execution-oriented, separate file).
from .provider import (  # noqa: F401
    project_timeline_for_provider,
    HIDDEN_FROM_PROVIDER,
)
# P0.b.C.c — inspector projection (inspection-centric, separate file).
from .inspector import (  # noqa: F401
    project_timeline_for_inspector,
    HIDDEN_FROM_INSPECTOR,
)

__all__ = [
    "project_for_actor",
    "project_timeline_for_customer",
    "HIDDEN_FROM_CUSTOMER",
    "project_timeline_for_provider",
    "HIDDEN_FROM_PROVIDER",
    "project_timeline_for_inspector",
    "HIDDEN_FROM_INSPECTOR",
]
