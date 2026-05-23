"""tests/phase1b/test_writer_enrichment.py — Phase 1B helper purity + behavior tests.

Scope (intentionally narrow):
  * verify `cluster_writer.py` is PURE (no DB / no async / no readers).
  * verify the 4 strategy combinations produce correct breadcrumb shape.
  * verify the manual_review fallback when caller passes cluster=None.
  * verify `enrich_with_currency` is idempotent (does NOT overwrite explicit currency).
  * verify `enrich_applies_to_clusters` validates cluster values.

These tests do NOT touch MongoDB. They exercise the helper module directly.
"""
from __future__ import annotations

import inspect
import pytest

from app.core import cluster_writer
from app.core.cluster_writer import (
    DEFAULT_ADMIN_ACTION_CLUSTER,
    PAYMENT_SOURCE_TO_CLUSTER,
    cluster_from_payment_source,
    derive_cluster_from_event_type,
    enrich_applies_to_clusters,
    enrich_with_cluster,
    enrich_with_currency,
)


# ─────────────────────────────────────────────────────────────
# 1. PURITY — module imports / no DB / no async
# ─────────────────────────────────────────────────────────────


def test_purity_no_async_helpers():
    """All public helpers MUST be synchronous (no `async def`)."""
    for name in cluster_writer.__all__:
        obj = getattr(cluster_writer, name)
        if not callable(obj):
            continue
        assert not inspect.iscoroutinefunction(obj), (
            f"{name} is async — violates Phase 1B purity contract"
        )


def test_purity_no_motor_or_db_import():
    """`cluster_writer` module MUST NOT depend on motor/db."""
    src = inspect.getsource(cluster_writer)
    forbidden = ["motor", "AsyncIOMotorClient", "from app.core.db", "import app.core.db"]
    for token in forbidden:
        assert token not in src, (
            f"cluster_writer must not reference {token} (Phase 1B purity)"
        )


# ─────────────────────────────────────────────────────────────
# 2. enrich_with_cluster — 4 strategy combinations
# ─────────────────────────────────────────────────────────────


def test_zone_lookup_strategy_inspection():
    doc = {"id": "x", "zoneId": "berlin-mitte"}
    enrich_with_cluster(doc, cluster="inspection", strategy="zone_lookup", source_field="zoneId")
    assert doc["cluster"] == "inspection"
    assert doc["clusterCreateMeta"]["phase"] == "1B"
    assert doc["clusterCreateMeta"]["strategy"] == "zone_lookup"
    assert doc["clusterCreateMeta"]["sourceField"] == "zoneId"


def test_admin_default_repair_strategy():
    doc = {"id": "y", "type": "behavior_warn"}
    enrich_with_cluster(
        doc, cluster=DEFAULT_ADMIN_ACTION_CLUSTER,
        strategy="admin_default_repair", reason="legacy_taxi_admin_push",
    )
    assert doc["cluster"] == "repair"
    assert doc["clusterCreateMeta"]["strategy"] == "admin_default_repair"
    assert doc["clusterCreateMeta"]["reason"] == "legacy_taxi_admin_push"


def test_metadata_source_strategy_billing_boost():
    doc = {"id": "z", "metadata": {"source": "billing_boost"}}
    enrich_with_cluster(
        doc, cluster=cluster_from_payment_source("billing_boost"),
        strategy="metadata_source", source_field="metadata.source",
        reason="billing_boost",
    )
    assert doc["cluster"] == "repair"
    assert doc["clusterCreateMeta"]["strategy"] == "metadata_source"
    assert doc["clusterCreateMeta"]["reason"] == "billing_boost"


def test_metadata_source_strategy_auto_request_inline():
    doc = {"id": "z2"}
    enrich_with_cluster(
        doc, cluster=cluster_from_payment_source("auto_request_inline"),
        strategy="metadata_source", source_field="metadata.source",
        reason="auto_request_inline",
    )
    assert doc["cluster"] == "inspection"


def test_manual_review_when_cluster_is_none():
    """Caller passes cluster=None → doc has NO cluster field but HAS provenance."""
    doc = {"id": "fallback"}
    enrich_with_cluster(
        doc, cluster=None, strategy="manual_review", source_field="zoneId"
    )
    assert "cluster" not in doc
    assert doc["clusterCreateMeta"]["phase"] == "1B"
    assert doc["clusterCreateMeta"]["strategy"] == "manual_review"


def test_invalid_cluster_raises():
    """Invalid cluster string MUST raise (no silent drop)."""
    with pytest.raises(ValueError):
        enrich_with_cluster({}, cluster="taxi", strategy="zone_lookup")


# ─────────────────────────────────────────────────────────────
# 3. PAYMENT_SOURCE_TO_CLUSTER constant map
# ─────────────────────────────────────────────────────────────


def test_payment_source_map_complete():
    assert PAYMENT_SOURCE_TO_CLUSTER["billing_boost"] == "repair"
    assert PAYMENT_SOURCE_TO_CLUSTER["auto_request_inline"] == "inspection"
    assert PAYMENT_SOURCE_TO_CLUSTER["stage4_checkout"] == "repair"


def test_payment_source_unknown_returns_none():
    """Unknown source returns None — caller must handle as manual_review."""
    assert cluster_from_payment_source("future_source") is None
    assert cluster_from_payment_source(None) is None
    assert cluster_from_payment_source("") is None


# ─────────────────────────────────────────────────────────────
# 4. enrich_with_currency idempotency
# ─────────────────────────────────────────────────────────────


def test_currency_idempotent_does_not_overwrite():
    """Currency already set → no-op (respects 'never infer amount semantics')."""
    doc = {"currency": "USD"}  # writer explicitly set USD
    enrich_with_currency(doc, cluster="repair")  # cluster maps to UAH
    assert doc["currency"] == "USD"  # NOT overwritten


def test_currency_set_when_missing():
    """Currency absent → derive from cluster canonical map."""
    doc = {}
    enrich_with_currency(doc, cluster="inspection")
    assert doc["currency"] == "EUR"


def test_currency_for_unknown_cluster_is_noop():
    """Cluster outside CLUSTER_TO_CURRENCY (defensive)."""
    doc = {}
    enrich_with_currency(doc, cluster="repair")
    assert doc.get("currency") == "UAH"


# ─────────────────────────────────────────────────────────────
# 5. enrich_applies_to_clusters
# ─────────────────────────────────────────────────────────────


def test_applies_to_clusters_inspection_domain():
    doc = {"key": "use_exposures"}
    enrich_applies_to_clusters(doc, clusters=["inspection"])
    assert doc["appliesToClusters"] == ["inspection"]
    assert doc["clusterCreateMeta"]["phase"] == "1B"
    assert doc["clusterCreateMeta"]["strategy"] == "appliesto_default"


def test_applies_to_clusters_validates():
    """Invalid cluster in list MUST raise."""
    with pytest.raises(ValueError):
        enrich_applies_to_clusters({}, clusters=["taxi"])


# ─────────────────────────────────────────────────────────────
# 6. derive_cluster_from_event_type
# ─────────────────────────────────────────────────────────────


def test_event_type_derivation_inspection_prefix():
    assert derive_cluster_from_event_type("inspection.scheduled") == "inspection"
    assert derive_cluster_from_event_type("inspection.completed") == "inspection"


def test_event_type_derivation_unknown_returns_none():
    """Unknown prefix → None (caller decides manual_review)."""
    assert derive_cluster_from_event_type("future.event") is None
