"""P0.b.A — Booking Lifecycle Freeze.

This module is the canonical truth definition for booking lifecycle state.
It is added as a SIDECAR — existing booking flows in marketplace, escrow,
auto_requests etc. continue to work unchanged. New discipline:

  * `BookingState` — frozen enum of canonical states
  * `assert_transition()` — explicit predicate, no graph engine
  * `record_transition()` — append-only timeline writer
  * `project_for_actor()` — actor-scoped semantic narrowing
  * Admin router — read timeline + manual transition with full audit

Anti-goals (deliberately rejected):
  ❌ BookingEngine / BookingManager / UnifiedLifecycleService
  ❌ Generic `transition(entity, action)` dispatcher
  ❌ Automation rules / SLA engines / escalation framework
  ❌ Workflow graphs / BPMN / DSL
  ❌ Configurable transitions
  ❌ Retry schedulers

Every transition is a literal in `fsm.py`. Period.
"""
from .fsm import (  # noqa: F401
    BOOKING_STATES,
    BOOKING_TERMINAL,
    BOOKING_TRANSITIONS,
    BookingTransitionError,
    assert_transition,
    list_legal_actions,
)
from .timeline import (  # noqa: F401
    record_transition,
    record_rejected_attempt,
    ensure_indexes,
    read_timeline,
)
from .projections import project_for_actor  # noqa: F401
from .attach import observe_transition  # noqa: F401
from .router import router  # noqa: F401
from .customer_router import router as customer_router  # noqa: F401
from .provider_router import router as provider_router  # noqa: F401
from .inspector_router import router as inspector_router  # noqa: F401

__all__ = [
    "BOOKING_STATES",
    "BOOKING_TERMINAL",
    "BOOKING_TRANSITIONS",
    "BookingTransitionError",
    "assert_transition",
    "list_legal_actions",
    "record_transition",
    "record_rejected_attempt",
    "ensure_indexes",
    "read_timeline",
    "observe_transition",
    "project_for_actor",
    "router",
    "customer_router",
    "provider_router",
    "inspector_router",
]
