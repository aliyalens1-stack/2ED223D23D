"""app.core.clusters_phase1 — Phase 1A: Cluster inference helpers (READ-ONLY).

Purpose
-------
Pure functions that compute the canonical `cluster` value for a given record.
NO writes. NO side effects. NO DB access. NO global state.

Consumers
---------
- scripts/phase1a_backfill.py (read-only inference; write only inside backfill script)
- New writers in Phase 1 (auto-set cluster on insert)
- Tests in tests/phase1a/

Non-consumers (Phase 1A invariant)
-----------------------------------
- NO existing reader is allowed to call these helpers.
- NO existing endpoint may change response shape using these values.
- Readers must ignore `cluster` field until Phase 2.

Cluster vocabulary (frozen — see decision plan §9 RULE 1)
---------------------------------------------------------
Source of truth: app/marketplace/clusters.py:CLUSTERS

    repair      — UAH, UA, legacy taxi-marketplace
    inspection  — EUR, DE, pre-purchase TÜV
    selection   — EUR, DE, car picker service
    delivery    — EUR, DE, transport/import service
"""
from __future__ import annotations

from typing import Optional

# Frozen cluster vocabulary (Phase 1A — do not extend without decision document)
CLUSTER_REPAIR = "repair"
CLUSTER_INSPECTION = "inspection"
CLUSTER_SELECTION = "selection"
CLUSTER_DELIVERY = "delivery"

VALID_CLUSTERS = frozenset({
    CLUSTER_REPAIR,
    CLUSTER_INSPECTION,
    CLUSTER_SELECTION,
    CLUSTER_DELIVERY,
})

# Cluster → currency lookup (mirrors app/marketplace/clusters.py:CLUSTERS)
CLUSTER_TO_CURRENCY = {
    CLUSTER_REPAIR: "UAH",
    CLUSTER_INSPECTION: "EUR",
    CLUSTER_SELECTION: "EUR",
    CLUSTER_DELIVERY: "EUR",
}


def is_valid_cluster(value: Optional[str]) -> bool:
    """True if value is a recognized cluster identifier."""
    return value in VALID_CLUSTERS


def cluster_for_currency(currency: Optional[str]) -> Optional[str]:
    """Reverse lookup: currency → most-likely cluster. EUR is ambiguous (returns None)."""
    if not currency:
        return None
    cur = currency.upper()
    if cur == "UAH":
        return CLUSTER_REPAIR
    # EUR maps to 3 clusters → caller must disambiguate via other signals
    return None


# ─────────────────────────────────────────────────────────────────────
# Zone → cluster
# ─────────────────────────────────────────────────────────────────────


def zone_to_cluster(zone_doc: dict) -> Optional[str]:
    """Infer cluster from a zones document.

    Strategy (high confidence per Phase 0 backfill_dryrun):
        country == 'UA'                       → repair
        country in ('DE', 'AT') + currency=EUR → inspection (primary live cluster)

    Returns None when the input is ambiguous (caller routes to manual_review bucket).
    """
    if not zone_doc:
        return None
    country = zone_doc.get("country") or ""
    currency = (zone_doc.get("currency") or "").upper()
    if country == "UA" and currency == "UAH":
        return CLUSTER_REPAIR
    if country in ("DE", "AT") and currency == "EUR":
        return CLUSTER_INSPECTION
    return None


# ─────────────────────────────────────────────────────────────────────
# Account.kind → cluster (for user-derived inference)
# ─────────────────────────────────────────────────────────────────────


def account_kind_to_cluster(kind: Optional[str]) -> Optional[str]:
    """Map account kind → cluster.

    Strategy (Phase 0 finding §A.3):
        inspector             → inspection
        service_provider      → repair   (legacy mechanic/СТО)
        dealer                → selection (planned future-kind)
        transport_provider    → delivery  (planned future-kind)
        customer / admin      → None     (cluster-orthogonal, kind not informative)

    Returns None for cluster-orthogonal kinds; caller must use a different signal.
    """
    if not kind:
        return None
    k = kind.lower()
    if k == "inspector":
        return CLUSTER_INSPECTION
    if k == "service_provider":
        return CLUSTER_REPAIR
    if k == "dealer":
        return CLUSTER_SELECTION
    if k == "transport_provider":
        return CLUSTER_DELIVERY
    # customer / admin → kind alone is not informative
    return None


# ─────────────────────────────────────────────────────────────────────
# Event-type → cluster (runtime_ledger_events)
# ─────────────────────────────────────────────────────────────────────


def event_type_to_cluster(event_type: Optional[str]) -> Optional[str]:
    """Infer cluster from runtime_ledger_events.eventType prefix.

    Strategy (Phase 0):
        INSPECTION_*  / ASSIGNMENT_* / VEHICLE_* / CONTACT_* → inspection
        QUOTE_*       / BOOKING_*                            → repair (legacy)
        otherwise → None (manual_review)
    """
    if not event_type:
        return None
    et = event_type.upper()
    if any(p in et for p in ("INSPECTION", "ASSIGNMENT", "VEHICLE", "CONTACT")):
        return CLUSTER_INSPECTION
    if "QUOTE" in et or "BOOKING" in et:
        return CLUSTER_REPAIR
    return None


# ─────────────────────────────────────────────────────────────────────
# Taxi-primitive action-type → cluster (action_feedback fallback)
# ─────────────────────────────────────────────────────────────────────


TAXI_PRIMITIVE_ACTIONS = frozenset({
    "set_surge",
    "push_providers",
    "fanout",
    "priority_bias",
    "zone_boost",
    "expand_radius",
})


def action_type_to_cluster_hint(action_type: Optional[str]) -> Optional[str]:
    """Hint cluster from action_type. Returns repair for known taxi-primitives.

    This is a hint only — use with zone_to_cluster as primary signal.
    """
    if not action_type:
        return None
    if action_type in TAXI_PRIMITIVE_ACTIONS:
        return CLUSTER_REPAIR
    return None


__all__ = [
    "CLUSTER_REPAIR",
    "CLUSTER_INSPECTION",
    "CLUSTER_SELECTION",
    "CLUSTER_DELIVERY",
    "VALID_CLUSTERS",
    "CLUSTER_TO_CURRENCY",
    "is_valid_cluster",
    "cluster_for_currency",
    "zone_to_cluster",
    "account_kind_to_cluster",
    "event_type_to_cluster",
    "action_type_to_cluster_hint",
    "TAXI_PRIMITIVE_ACTIONS",
]
