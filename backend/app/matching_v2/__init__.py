"""Matching-v2 — density-aware dispatch.

Sprint 1 (projection): `policy` — pure dispatch policy table.
Sprint 2 (frozen):     `snapshot` — immutable matching_dispatch_snapshot.
Sprint 3 (executor):   TBD — provider selection, batching, escalation.

The router exposes:
  POST /api/matching/v2/project           (Sprint 1, stateless)
  POST /api/matching/v2/freeze/{jobId}    (Sprint 2, idempotent)
  GET  /api/matching/v2/snapshot/{jobId}  (Sprint 2, read-only)
"""
from app.matching_v2.policy import (
    DISPATCH_POLICY,
    DispatchPolicy,
    project_dispatch_policy,
    policy_to_dict,
)
from app.matching_v2.snapshot import (
    PricingNotConfirmedError,
    MATCHING_VERSION_V2,
    DISPATCH_SNAPSHOT_STATUS_PROJECTED,
    freeze_dispatch_snapshot,
    get_dispatch_snapshot,
    ensure_dispatch_indexes,
)

__all__ = [
    "DISPATCH_POLICY",
    "DispatchPolicy",
    "project_dispatch_policy",
    "policy_to_dict",
    "PricingNotConfirmedError",
    "MATCHING_VERSION_V2",
    "DISPATCH_SNAPSHOT_STATUS_PROJECTED",
    "freeze_dispatch_snapshot",
    "get_dispatch_snapshot",
    "ensure_dispatch_indexes",
]
