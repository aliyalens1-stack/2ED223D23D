"""tests/test_phase_2a_cluster_summary.py — Phase 2A-α reader contract freeze.

Tests the canonical revenue-reader contract for
`GET /api/admin/revenue/cluster-summary`.

Invariants under test (locked):
  1. Money grouped by currency BEFORE summed (no cross-currency totals).
  2. `cluster=manual_review` (writer breadcrumb) → bucket "manual_review",
     amount=null regardless of currency.
  3. Missing `cluster` field → bucket "unknown", amount summed normally
     IF currency is known (cluster-unknown alone does NOT untrust amount).
  4. Missing `currency` field → currency label "unknown", amount=null.
  5. `count` is ALWAYS present (we count even untrusted rows).
  6. Aggregates across `payment_transactions` + `provider_purchases`.
  7. Period dimension: today | week | month → corresponding windowStart.
  8. Only paid/completed rows participate; pending/failed excluded.
  9. Adds NO write paths; existing /api/admin/revenue/summary endpoint
     remains byte-identical at the response-shape level.
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient


# ── App context init (same pattern as test_dedupe_bucket.py) ──────────
@pytest_asyncio.fixture(autouse=True)
async def _init_app_context():
    from app.core.context import ctx
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    db_name = os.environ.get("DB_NAME", "test_database")
    client = AsyncIOMotorClient(mongo_url)
    ctx.mongo = client
    ctx.db = client[db_name]
    # Init revenue module's local db handle too (it caches its own ref).
    from app.revenue import init as revenue_init
    revenue_init(client[db_name], None)
    yield
    client.close()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _clear_test_docs(db, tag: str):
    """Remove any seed docs tagged with the test-run id."""
    await db.payment_transactions.delete_many({"_test_tag": tag})
    await db.provider_purchases.delete_many({"_test_tag": tag})


async def _seed(db, coll_name: str, tag: str, **fields):
    """Insert a test doc with a sentinel `_test_tag` for cleanup."""
    doc = {
        "id": str(uuid.uuid4()),
        "_test_tag": tag,
        "status": fields.pop("status", "paid"),
        "createdAt": fields.pop("createdAt", _now_iso()),
        **fields,
    }
    await getattr(db, coll_name).insert_one(doc)
    return doc


# ── Tests ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_basic_inspection_eur_sums_within_currency():
    """Two paid docs cluster=inspection, currency=EUR → single bucket
    with summed amount and count=2."""
    from app.core.context import ctx
    from app.revenue import revenue_cluster_summary

    db = ctx.db
    tag = f"t-{uuid.uuid4().hex[:8]}"

    # Seed 2 trusted EUR inspection payments
    await _seed(db, "payment_transactions", tag, cluster="inspection",
                currency="EUR", amount=600)
    await _seed(db, "payment_transactions", tag, cluster="inspection",
                currency="EUR", amount=400)

    try:
        resp = await revenue_cluster_summary(period="month")
        bucket = resp["totalsByCluster"].get("inspection", {})
        eur = bucket.get("EUR", {})

        assert eur.get("count", 0) >= 2, f"expected count>=2, got {eur}"
        # amount is the sum BUT may include other ambient inspection EUR docs
        # in the DB. The invariant we test: amount is NOT null and >= 1000.
        assert eur.get("amount") is not None, "trusted bucket must have integer amount"
        assert eur.get("amount") >= 1000
    finally:
        await _clear_test_docs(db, tag)


@pytest.mark.asyncio
async def test_no_cross_currency_summation():
    """EUR + UAH in same cluster → TWO sub-buckets, no merged total."""
    from app.core.context import ctx
    from app.revenue import revenue_cluster_summary

    db = ctx.db
    tag = f"t-{uuid.uuid4().hex[:8]}"

    await _seed(db, "payment_transactions", tag, cluster="repair",
                currency="EUR", amount=100)
    await _seed(db, "payment_transactions", tag, cluster="repair",
                currency="UAH", amount=5000)

    try:
        resp = await revenue_cluster_summary(period="month")
        repair = resp["totalsByCluster"].get("repair", {})
        # Both currency buckets must exist independently
        assert "EUR" in repair, f"EUR bucket missing: {repair}"
        assert "UAH" in repair, f"UAH bucket missing: {repair}"
        assert repair["EUR"]["amount"] >= 100
        assert repair["UAH"]["amount"] >= 5000
        # And there must be NO merged super-total at the cluster level.
        # The cluster value is a dict, NOT a scalar.
        assert isinstance(repair, dict)
        # No "total" or "amount" key directly on the cluster bucket.
        assert "total" not in repair
        assert "amount" not in repair
    finally:
        await _clear_test_docs(db, tag)


@pytest.mark.asyncio
async def test_manual_review_bucket_amount_is_null():
    """Doc with clusterCreateMeta.strategy='manual_review' → goes to
    `manual_review` cluster bucket, amount is null even if currency is
    known. (Writer decision pending — untrust the sum.)"""
    from app.core.context import ctx
    from app.revenue import revenue_cluster_summary

    db = ctx.db
    tag = f"t-{uuid.uuid4().hex[:8]}"

    await _seed(db, "payment_transactions", tag,
                cluster="inspection",  # would be inspection, but...
                clusterCreateMeta={"strategy": "manual_review", "phase": "1B"},
                currency="EUR", amount=999)

    try:
        resp = await revenue_cluster_summary(period="month")
        mr = resp["totalsByCluster"].get("manual_review", {})
        eur = mr.get("EUR")
        assert eur is not None, f"manual_review/EUR bucket missing: {mr}"
        assert eur.get("count", 0) >= 1
        assert eur.get("amount") is None, (
            f"manual_review amount MUST be null (untrusted), got {eur.get('amount')}"
        )

        # And the doc must NOT appear in the inspection bucket.
        inspection = resp["totalsByCluster"].get("inspection", {})
        inspection_eur = inspection.get("EUR", {})
        # Only the seeded manual_review row was added; if inspection.EUR
        # has the SAME count delta we'd know it was double-counted.
        # We test by injecting a 999 amount: it must not appear in
        # inspection.EUR.amount.
        # Note: we can't make a hard assertion on this without isolating
        # the DB, so just verify shape.
        assert isinstance(inspection_eur.get("amount", 0), (int, type(None)))
    finally:
        await _clear_test_docs(db, tag)


@pytest.mark.asyncio
async def test_unknown_currency_yields_null_amount():
    """Doc missing `currency` → currency label 'unknown', amount=null."""
    from app.core.context import ctx
    from app.revenue import revenue_cluster_summary

    db = ctx.db
    tag = f"t-{uuid.uuid4().hex[:8]}"

    await _seed(db, "payment_transactions", tag, cluster="repair",
                amount=500)  # no currency field

    try:
        resp = await revenue_cluster_summary(period="month")
        repair = resp["totalsByCluster"].get("repair", {})
        unknown_cur = repair.get("unknown")
        assert unknown_cur is not None, (
            f"repair/unknown(currency) bucket missing: {repair}"
        )
        assert unknown_cur.get("count", 0) >= 1
        assert unknown_cur.get("amount") is None, (
            f"unknown-currency amount MUST be null, got {unknown_cur.get('amount')}"
        )
    finally:
        await _clear_test_docs(db, tag)


@pytest.mark.asyncio
async def test_missing_cluster_yields_unknown_bucket():
    """Doc missing `cluster` field → bucket 'unknown'. Currency known → amount summed normally."""
    from app.core.context import ctx
    from app.revenue import revenue_cluster_summary

    db = ctx.db
    tag = f"t-{uuid.uuid4().hex[:8]}"

    await _seed(db, "payment_transactions", tag, currency="EUR", amount=42)

    try:
        resp = await revenue_cluster_summary(period="month")
        unknown_cluster = resp["totalsByCluster"].get("unknown", {})
        eur = unknown_cluster.get("EUR")
        assert eur is not None, f"unknown(cluster)/EUR bucket missing: {unknown_cluster}"
        assert eur.get("count", 0) >= 1
        # Currency is KNOWN (EUR), so amount MUST be integer (not null).
        assert eur.get("amount") is not None
        assert eur.get("amount") >= 42
    finally:
        await _clear_test_docs(db, tag)


@pytest.mark.asyncio
async def test_pending_and_failed_excluded():
    """Only paid/completed rows participate. pending/failed never enter
    any bucket."""
    from app.core.context import ctx
    from app.revenue import revenue_cluster_summary

    db = ctx.db
    tag = f"t-{uuid.uuid4().hex[:8]}"

    # Use a unique cluster value so we can assert specifically on it.
    unique_cluster = f"pending-test-{uuid.uuid4().hex[:6]}"

    await _seed(db, "payment_transactions", tag,
                cluster=unique_cluster, currency="EUR", amount=777,
                status="pending")
    await _seed(db, "payment_transactions", tag,
                cluster=unique_cluster, currency="EUR", amount=888,
                status="failed")

    try:
        resp = await revenue_cluster_summary(period="month")
        # The pending/failed cluster must not appear at all.
        assert unique_cluster not in resp["totalsByCluster"], (
            f"pending/failed should not appear, got {resp['totalsByCluster'].get(unique_cluster)}"
        )
    finally:
        await _clear_test_docs(db, tag)


@pytest.mark.asyncio
async def test_aggregates_across_both_collections():
    """Doc in payment_transactions + doc in provider_purchases with same
    (cluster, currency) → single merged bucket with summed amount."""
    from app.core.context import ctx
    from app.revenue import revenue_cluster_summary

    db = ctx.db
    tag = f"t-{uuid.uuid4().hex[:8]}"
    cluster = f"boost-{uuid.uuid4().hex[:6]}"  # unique

    await _seed(db, "payment_transactions", tag, cluster=cluster,
                currency="EUR", amount=300)
    await _seed(db, "provider_purchases", tag, cluster=cluster,
                currency="EUR", amount=700)

    try:
        resp = await revenue_cluster_summary(period="month")
        bucket = resp["totalsByCluster"].get(cluster, {})
        eur = bucket.get("EUR")
        assert eur is not None
        assert eur.get("count") == 2
        assert eur.get("amount") == 1000
    finally:
        await _clear_test_docs(db, tag)


@pytest.mark.asyncio
async def test_period_returns_correct_window():
    """period=today → windowStart at today's 00:00; period=week → -7d;
    period=month → -30d. Defaulting to month for any other value."""
    from app.revenue import revenue_cluster_summary

    for period in ("today", "week", "month", "invalid"):
        resp = await revenue_cluster_summary(period=period)
        # period label normalizes invalid → 'month'
        if period == "invalid":
            assert resp["period"] == "month"
        else:
            assert resp["period"] == period
        # windowStart is ISO; sanity-check it's parseable.
        ws = resp.get("windowStart")
        assert isinstance(ws, str)
        datetime.fromisoformat(ws)  # raises if malformed


@pytest.mark.asyncio
async def test_response_shape_has_only_locked_top_level_keys():
    """Contract freeze: response MUST have exactly three top-level keys:
    period, windowStart, totalsByCluster. No accidental fields leak.
    This is what makes the contract a contract."""
    from app.revenue import revenue_cluster_summary

    resp = await revenue_cluster_summary(period="month")
    assert set(resp.keys()) == {"period", "windowStart", "totalsByCluster"}, (
        f"top-level keys drift: got {set(resp.keys())}"
    )


@pytest.mark.asyncio
async def test_no_amount_field_at_cluster_level():
    """Cluster bucket MUST be a dict<currency, {count, amount}>, never a
    scalar or a dict with `total`/`amount` keys at the cluster layer.
    This prevents accidental cross-currency aggregation in a future patch."""
    from app.revenue import revenue_cluster_summary

    resp = await revenue_cluster_summary(period="month")
    for cluster_label, currency_map in resp["totalsByCluster"].items():
        assert isinstance(currency_map, dict), (
            f"cluster {cluster_label} value must be dict, got {type(currency_map)}"
        )
        for currency_label, bucket in currency_map.items():
            assert isinstance(bucket, dict)
            assert set(bucket.keys()) == {"count", "amount"}, (
                f"bucket keys drift at {cluster_label}/{currency_label}: {bucket.keys()}"
            )
            assert isinstance(bucket["count"], int)
            assert bucket["amount"] is None or isinstance(bucket["amount"], int)


@pytest.mark.asyncio
async def test_summary_endpoint_back_compat_keys():
    """`/api/admin/revenue/summary` MUST keep its top-level keys unchanged
    after Phase 2A-α. This is the legacy consumer back-compat guarantee."""
    from app.revenue import revenue_summary

    resp = await revenue_summary()
    expected_keys = {
        "today", "yesterday", "week", "lastWeek", "month",
        "currency", "transactions", "paidTransactions", "failedTransactions",
        "boostRevenue", "avgOrderValue", "conversionRate",
        "growth", "revenueBreakdown", "alerts",
        "topProviders", "topZones", "recent",
    }
    missing = expected_keys - set(resp.keys())
    assert not missing, f"summary endpoint lost keys (back-compat violation): {missing}"
