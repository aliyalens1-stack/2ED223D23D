"""app.core.cluster_writer — Phase 1B write-side cluster enrichment helpers.

Purity contract (Phase 1B doctrine — 2026-05-12)
------------------------------------------------
This module is **pure enrichment**:
  * NO database access.
  * NO reader imports.
  * NO fallback queries.
  * NO hidden inference side effects.

All `enrich_*` functions are SYNCHRONOUS and accept the cluster value as a
direct argument from the caller. The caller is responsible for sourcing
that value from its own scope (typically a zone/org dict it already holds
to perform the write). This keeps `cluster_writer` infrastructural, not
business-logic.

Provenance convention
---------------------
Phase 1A backfill set `clusterBackfillMeta.phase='1A'` on legacy docs.
Phase 1B write-side sets `clusterCreateMeta.phase='1B'` on new docs.

Roll-back of 1B
---------------
Rollback of 1B writer-side edits = git revert.
Rollback of 1B-marked docs in DB = `clusterCreateMeta.phase: '1B'` filter
(see scripts/phase1b_rollback.py — symmetric with Phase 1A rollback).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from app.core.clusters_phase1 import (
    CLUSTER_REPAIR,
    CLUSTER_INSPECTION,
    CLUSTER_TO_CURRENCY,
    VALID_CLUSTERS,
    event_type_to_cluster,
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def enrich_with_cluster(
    doc: dict,
    *,
    cluster: Optional[str],
    strategy: str,
    reason: Optional[str] = None,
    source_field: Optional[str] = None,
) -> dict:
    """Mutate `doc` to add cluster + clusterCreateMeta provenance.

    Args:
        doc: insert document (mutated in-place AND returned for convenience).
        cluster: target cluster value (must be valid OR None for manual_review).
        strategy: one of 'zone_lookup' | 'org_lookup' | 'event_type' |
                  'admin_default_repair' | 'metadata_source' | 'manual_review'.
        reason: optional human-readable note.
        source_field: optional field name that drove the decision.

    Returns:
        The same `doc` dict, mutated.

    Notes:
        - If `cluster` is None, the helper writes ONLY clusterCreateMeta
          (NO cluster field), marking the doc for manual_review.
        - If `cluster` is invalid (not in VALID_CLUSTERS), raises ValueError —
          we never silently drop bad cluster values.
    """
    if cluster is not None and cluster not in VALID_CLUSTERS:
        raise ValueError(
            f"enrich_with_cluster: invalid cluster {cluster!r}; "
            f"must be one of {sorted(VALID_CLUSTERS)} or None"
        )

    meta: dict[str, Any] = {
        "phase": "1B",
        "strategy": strategy,
        "createdAt": _now_iso(),
    }
    if reason:
        meta["reason"] = reason
    if source_field:
        meta["sourceField"] = source_field

    if cluster:
        doc["cluster"] = cluster
    doc["clusterCreateMeta"] = meta
    return doc


def enrich_with_currency(doc: dict, *, cluster: str) -> dict:
    """Add `currency` field derived from cluster (if cluster has a canonical currency).

    Idempotent: if `currency` already present, does not overwrite.
    """
    if cluster not in CLUSTER_TO_CURRENCY:
        return doc
    if not doc.get("currency"):
        doc["currency"] = CLUSTER_TO_CURRENCY[cluster]
    return doc


def enrich_applies_to_clusters(doc: dict, *, clusters: list[str]) -> dict:
    """Add `appliesToClusters` field for config-like documents
    (feature_flags, automation_rules, etc.).

    Validates each value is a known cluster.
    """
    for c in clusters:
        if c not in VALID_CLUSTERS:
            raise ValueError(f"appliesToClusters: invalid cluster {c!r}")
    doc["appliesToClusters"] = list(clusters)
    doc["clusterCreateMeta"] = {
        "phase": "1B",
        "strategy": "appliesto_default",
        "createdAt": _now_iso(),
    }
    return doc


def derive_cluster_from_event_type(event_type: str) -> Optional[str]:
    """Pure wrapper for clusters_phase1.event_type_to_cluster (sync, no DB)."""
    return event_type_to_cluster(event_type)


# ─────────────────────────────────────────────────────────────────────
# Constants — used by writers without zone/org context
# ─────────────────────────────────────────────────────────────────────


# Used by admin-controlled writers (governance, manual surge, manual zone_boost)
# when target zone is implicit/all and the admin action is presumed legacy taxi.
DEFAULT_ADMIN_ACTION_CLUSTER = CLUSTER_REPAIR

# Used by metadata.source → cluster mapping for payment_transactions
PAYMENT_SOURCE_TO_CLUSTER = {
    "stage4_checkout":     CLUSTER_REPAIR,
    "auto_request_inline": CLUSTER_INSPECTION,
    "billing_boost":       CLUSTER_REPAIR,
}


def cluster_from_payment_source(source: Optional[str]) -> Optional[str]:
    """Map metadata.source → cluster for payment_transactions write-side."""
    if not source:
        return None
    return PAYMENT_SOURCE_TO_CLUSTER.get(source)


__all__ = [
    "enrich_with_cluster",
    "enrich_with_currency",
    "enrich_applies_to_clusters",
    "derive_cluster_from_event_type",
    "cluster_from_payment_source",
    "DEFAULT_ADMIN_ACTION_CLUSTER",
    "PAYMENT_SOURCE_TO_CLUSTER",
]
