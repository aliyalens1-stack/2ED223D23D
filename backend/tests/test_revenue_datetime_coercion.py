"""tests/test_revenue_datetime_coercion.py — Phase 2A-β follow-up safety net.

Locks the reader-side tolerant datetime coercion contract for
`/api/admin/revenue/summary` so that the recent-transactions sort
NEVER 500s on mixed `createdAt` types again.

Invariants under test:
  1. `_coerce_created_at` accepts datetime, ISO string, None.
  2. `_coerce_created_at` returns "" for anything else (sortable bottom),
     never raises.
  3. After coercion, sorted-mixed-types is safe: no TypeError.
  4. The /summary endpoint returns 200 when DB has mixed createdAt types
     (datetime + ISO string + missing).
  5. `recent[].createdAt` in the response is always None or string —
     never a datetime object (otherwise FE / JSON consumers break).
  6. Phase 2A-α back-compat: the summary response key set is unchanged.
  7. Malformed counter (`_malformed_created_at_counter`) increments only
     for genuinely unsupported types; valid inputs do not bump it.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient


@pytest_asyncio.fixture(autouse=True)
async def _init_app_context():
    from app.core.context import ctx
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    db_name = os.environ.get("DB_NAME", "test_database")
    client = AsyncIOMotorClient(mongo_url)
    ctx.mongo = client
    ctx.db = client[db_name]
    from app.revenue import init as revenue_init
    revenue_init(client[db_name], None)
    yield
    client.close()


# ── Unit-level: coercion helper ──────────────────────────────────

def test_coerce_datetime_returns_iso_string():
    from app.revenue import _coerce_created_at
    dt = datetime(2026, 5, 13, 10, 30, 0, tzinfo=timezone.utc)
    out = _coerce_created_at(dt)
    assert isinstance(out, str)
    assert out.startswith("2026-05-13T10:30:00")


def test_coerce_iso_string_returns_verbatim():
    from app.revenue import _coerce_created_at
    s = "2026-05-13T10:30:00+00:00"
    assert _coerce_created_at(s) == s


def test_coerce_none_returns_empty_string():
    """None → "" so the sort key is a sortable bottom, never raises."""
    from app.revenue import _coerce_created_at
    assert _coerce_created_at(None) == ""


def test_coerce_unknown_type_returns_empty_string_and_does_not_raise():
    """Unsupported types (int, list, dict, etc.) → "" without raising."""
    from app.revenue import _coerce_created_at
    for bad in (12345, [1, 2], {"x": 1}, 3.14, object()):
        assert _coerce_created_at(bad) == ""


def test_coerce_increments_malformed_counter_on_unknown_type():
    import app.revenue as r_mod
    before = r_mod._malformed_created_at_counter
    r_mod._coerce_created_at(12345)  # int — unsupported
    after = r_mod._malformed_created_at_counter
    assert after == before + 1


def test_coerce_does_not_increment_counter_on_valid_inputs():
    import app.revenue as r_mod
    before = r_mod._malformed_created_at_counter
    r_mod._coerce_created_at(None)
    r_mod._coerce_created_at(datetime.now(timezone.utc))
    r_mod._coerce_created_at("2026-01-01T00:00:00Z")
    after = r_mod._malformed_created_at_counter
    assert after == before


def test_mixed_inputs_can_be_sorted_after_coercion():
    """The whole point: a mixed list of coerced keys sorts cleanly."""
    from app.revenue import _coerce_created_at
    raw = [
        datetime(2026, 5, 1, tzinfo=timezone.utc),
        "2026-05-13T10:00:00+00:00",
        None,
        12345,  # unsupported
    ]
    keys = [_coerce_created_at(v) for v in raw]
    # Should not raise
    keys.sort()
    # Empty strings sort first; ISO strings sort chronologically
    assert keys[0] == "" and keys[1] == ""
    assert keys[2].startswith("2026-05-01")
    assert keys[3].startswith("2026-05-13")


# ── Integration: /summary endpoint survives mixed createdAt ──────

@pytest.mark.asyncio
async def test_summary_endpoint_200_with_mixed_created_at_types():
    """The reproduction scenario that previously 500'd the endpoint:
    one BSON Date doc + one ISO string doc in payment_transactions.
    Endpoint MUST return 200 and include both in `recent`."""
    from app.core.context import ctx
    from app.revenue import revenue_summary

    db = ctx.db
    tag = f"t-{uuid.uuid4().hex[:8]}"

    # Seed: 1 BSON Date, 1 ISO string, 1 missing createdAt
    await db.payment_transactions.insert_many([
        {
            "_test_tag": tag, "id": f"{tag}-bson",
            "status": "paid", "amount": 100, "currency": "EUR",
            "createdAt": datetime.now(timezone.utc),  # BSON Date
        },
        {
            "_test_tag": tag, "id": f"{tag}-iso",
            "status": "paid", "amount": 200, "currency": "EUR",
            "createdAt": datetime.now(timezone.utc).isoformat(),  # ISO str
        },
        {
            "_test_tag": tag, "id": f"{tag}-none",
            "status": "paid", "amount": 300, "currency": "EUR",
            # no createdAt at all
        },
    ])
    try:
        # Must NOT raise. Previously raised TypeError → 500.
        resp = await revenue_summary()
        assert isinstance(resp, dict)
        # `recent` must include our seeded rows (if not pushed out by older docs).
        # We can't assert on exact membership because DB has unrelated rows,
        # but we can assert the list exists and is well-typed.
        assert isinstance(resp.get("recent"), list)
        for r in resp["recent"]:
            # Reader-side normalization: createdAt is either str or None,
            # never a datetime that would break JSON consumers downstream.
            ca = r.get("createdAt")
            assert ca is None or isinstance(ca, str), (
                f"createdAt must be str/None in response, got {type(ca).__name__}"
            )
    finally:
        await db.payment_transactions.delete_many({"_test_tag": tag})


@pytest.mark.asyncio
async def test_summary_response_keys_unchanged_after_coercion_fix():
    """Phase 2A-α back-compat freeze still holds: top-level response
    keys unchanged after the coercion patch."""
    from app.revenue import revenue_summary

    resp = await revenue_summary()
    expected = {
        "today", "yesterday", "week", "lastWeek", "month",
        "currency", "transactions", "paidTransactions", "failedTransactions",
        "boostRevenue", "avgOrderValue", "conversionRate",
        "growth", "revenueBreakdown", "alerts",
        "topProviders", "topZones", "recent",
    }
    missing = expected - set(resp.keys())
    assert not missing, f"summary lost keys: {missing}"


@pytest.mark.asyncio
async def test_summary_recent_items_have_string_or_none_createdAt():
    """In `recent[]`, every `createdAt` MUST be string-or-None after
    reader-side coercion. Datetime leakage would break downstream
    JSON consumers and re-introduce the original bug class."""
    from app.core.context import ctx
    from app.revenue import revenue_summary

    db = ctx.db
    tag = f"t-{uuid.uuid4().hex[:8]}"
    # Force at least one BSON Date row to be eligible for recent[].
    await db.payment_transactions.insert_one({
        "_test_tag": tag, "id": f"{tag}-x",
        "status": "paid", "amount": 1, "currency": "EUR",
        "createdAt": datetime.now(timezone.utc),
    })
    try:
        resp = await revenue_summary()
        for r in resp.get("recent", []):
            ca = r.get("createdAt")
            assert ca is None or isinstance(ca, str)
    finally:
        await db.payment_transactions.delete_many({"_test_tag": tag})
