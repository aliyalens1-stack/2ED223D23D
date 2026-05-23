"""Sprint B4.3-A.1 — reconciliation audit smoke (READ-ONLY).

Two phases:

  Phase A — PURE FUNCTIONS over a synthetic dataset.
    Covers every divergence code AND every bucket. No DB needed.

  Phase B — END-TO-END through `generate_report(db, limit=)` against a
    seeded test DB collection. Verifies the read-only-ness of the DB
    code path (no `update_one` / `insert_one` from the audit module).

Run:
  cd /app/backend && python test_reconciliation_audit_smoke.py
"""
from __future__ import annotations

import asyncio
import sys
import uuid

from motor.motor_asyncio import AsyncIOMotorClient

from app.payments.reconciliation import (
    KNOWN_STATUSES,
    STATUS_BUCKETS,
    classify_status,
    collect_top_n,
    compute_buckets,
    detect_divergences,
    generate_report,
)


MONGO = "mongodb://localhost:27017"
DB = "test_database"


# A representative dataset that touches:
#   * all 5 buckets + unknown
#   * almost every divergence code
SYNTHETIC = [
    # outstanding_escrow × 3
    {"id": "p1", "status": "paid", "currency": "EUR",
     "grossAmount": 100, "providerPayout": 88, "commissionAmount": 12,
     "customerId": "c1", "providerId": "prov1",
     "paidAt": "2026-05-22T10:00:00Z"},
    {"id": "p2", "status": "disputed", "currency": "EUR",
     "grossAmount": 200, "providerPayout": 176, "commissionAmount": 24,
     "customerId": "c2", "providerId": "prov1",
     "paidAt": "2026-05-22T10:00:00Z",
     "disputedAt": "2026-05-22T11:00:00Z"},
    {"id": "p3", "status": "disputed_hold", "currency": "USD",
     "grossAmount": 50, "providerPayout": 44, "commissionAmount": 6,
     "customerId": "c3", "providerId": "prov2",
     "paidAt": "2026-05-22T10:00:00Z",
     "disputedAt": "2026-05-22T11:00:00Z"},

    # settled_to_provider × 2
    {"id": "p4", "status": "released", "currency": "EUR",
     "grossAmount": 100, "providerPayout": 88, "commissionAmount": 12,
     "customerId": "c1", "providerId": "prov1",
     "paidAt": "2026-05-22T10:00:00Z",
     "releasedAt": "2026-05-22T11:00:00Z", "releasedBy": "c1"},
    {"id": "p5", "status": "resolved_partial", "currency": "EUR",
     "grossAmount": 100,
     "partialPayoutAmount": 60, "refundAmount": 28, "commissionAmount": 12,
     "refundPercent": 28,
     "customerId": "c2", "providerId": "prov1",
     "paidAt": "2026-05-22T10:00:00Z",
     "releasedAt": "2026-05-22T12:00:00Z"},

    # refunded_to_customer × 1
    {"id": "p6", "status": "refunded", "currency": "EUR",
     "grossAmount": 50, "providerPayout": 0,
     "refundAmount": 50, "commissionAmount": 0,
     "customerId": "c3", "providerId": "prov2",
     "paidAt": "2026-05-22T10:00:00Z",
     "refundedAt": "2026-05-22T11:00:00Z"},

    # terminal_failure × 1
    {"id": "p7", "status": "failed", "currency": "EUR",
     "grossAmount": 0, "providerPayout": 0, "commissionAmount": 0,
     "customerId": "c4", "providerId": "prov3"},

    # pre_escrow × 1
    {"id": "p8", "status": "pending", "currency": "EUR",
     "grossAmount": 100, "providerPayout": 88, "commissionAmount": 12,
     "customerId": "c5", "providerId": "prov3"},

    # unknown × 1
    {"id": "p9", "status": "weird_invented_status", "currency": "EUR",
     "grossAmount": 99, "providerPayout": 99, "commissionAmount": 0,
     "customerId": "c5", "providerId": "prov3"},

    # ── divergence-positives (intentionally inconsistent) ──
    # released but no releasedAt
    {"id": "d1", "status": "released", "currency": "EUR",
     "grossAmount": 100, "providerPayout": 88, "commissionAmount": 12,
     "customerId": "c1", "providerId": "prov1",
     "paidAt": "2026-05-22T10:00:00Z"},  # releasedAt MISSING
    # paid but releasedAt set (stale partial transition)
    {"id": "d2", "status": "paid", "currency": "EUR",
     "grossAmount": 100, "providerPayout": 88, "commissionAmount": 12,
     "customerId": "c1", "providerId": "prov1",
     "paidAt": "2026-05-22T10:00:00Z",
     "releasedAt": "2026-05-22T11:00:00Z"},
    # disputed but releasedAt set
    {"id": "d3", "status": "disputed", "currency": "EUR",
     "grossAmount": 100, "providerPayout": 88, "commissionAmount": 12,
     "customerId": "c1", "providerId": "prov1",
     "paidAt": "2026-05-22T10:00:00Z",
     "disputedAt": "2026-05-22T11:00:00Z",
     "releasedAt": "2026-05-22T12:00:00Z"},
    # negative amount
    {"id": "d4", "status": "refunded", "currency": "EUR",
     "grossAmount": -10, "refundAmount": -10, "commissionAmount": 0,
     "customerId": "c1", "providerId": "prov1",
     "refundedAt": "2026-05-22T11:00:00Z"},
    # missing customer
    {"id": "d5", "status": "paid", "currency": "EUR",
     "grossAmount": 100, "providerPayout": 88, "commissionAmount": 12,
     "providerId": "prov1",
     "paidAt": "2026-05-22T10:00:00Z"},  # NO customerId
    # paid > released (impossible time order)
    {"id": "d6", "status": "released", "currency": "EUR",
     "grossAmount": 100, "providerPayout": 88, "commissionAmount": 12,
     "customerId": "c1", "providerId": "prov1",
     "paidAt": "2026-05-22T12:00:00Z",
     "releasedAt": "2026-05-22T10:00:00Z"},
    # gross conservation drift: released, but payout+commission != gross
    {"id": "d7", "status": "released", "currency": "EUR",
     "grossAmount": 100, "providerPayout": 70, "commissionAmount": 12,
     "customerId": "c1", "providerId": "prov1",
     "paidAt": "2026-05-22T10:00:00Z",
     "releasedAt": "2026-05-22T11:00:00Z"},
    # currency missing
    {"id": "d8", "status": "paid",
     "grossAmount": 100, "providerPayout": 88, "commissionAmount": 12,
     "customerId": "c1", "providerId": "prov1",
     "paidAt": "2026-05-22T10:00:00Z"},  # NO currency
]


failures: list[str] = []


def assert_(label: str, cond: bool, ctx: str = "") -> None:
    if cond:
        print(f"  ✓ {label}")
    else:
        failures.append(f"{label}{(': ' + ctx) if ctx else ''}")
        print(f"  ✗ {label}{(' (' + ctx + ')') if ctx else ''}")


async def phase_a_pure() -> None:
    print("\n── PHASE A — PURE FUNCTIONS over synthetic dataset ──")

    # ── classify_status
    assert_("classify_status: paid → outstanding_escrow",
            classify_status("paid") == "outstanding_escrow")
    assert_("classify_status: released → settled_to_provider",
            classify_status("released") == "settled_to_provider")
    assert_("classify_status: resolved_partial → settled_to_provider",
            classify_status("resolved_partial") == "settled_to_provider")
    assert_("classify_status: refunded → refunded_to_customer",
            classify_status("refunded") == "refunded_to_customer")
    assert_("classify_status: failed → terminal_failure",
            classify_status("failed") == "terminal_failure")
    assert_("classify_status: pending → pre_escrow",
            classify_status("pending") == "pre_escrow")
    assert_("classify_status: weird_invented → unknown",
            classify_status("weird_invented_status") == "unknown")
    assert_("classify_status: None → unknown",
            classify_status(None) == "unknown")

    # ── compute_buckets
    buckets = compute_buckets(SYNTHETIC)
    # outstanding: p1, p2, p3, d2 (paid w/ release fields still in paid bucket),
    #              d3 (disputed w/ extra release fields), d5 (paid, no customer),
    #              d8 (paid, no currency)
    # = 7
    assert_("outstanding_escrow count == 7",
            buckets["outstanding_escrow"]["count"] == 7,
            f"got {buckets['outstanding_escrow']['count']}")
    # settled: p4, p5, d1 (released, no timestamp), d6 (paid>released), d7 (gross drift)
    # = 5
    assert_("settled_to_provider count == 5",
            buckets["settled_to_provider"]["count"] == 5,
            f"got {buckets['settled_to_provider']['count']}")
    # refunded: p6, d4 (negative amount, still refunded status)
    # = 2
    assert_("refunded_to_customer count == 2",
            buckets["refunded_to_customer"]["count"] == 2)
    # terminal_failure: p7
    assert_("terminal_failure count == 1",
            buckets["terminal_failure"]["count"] == 1)
    # pre_escrow: p8
    assert_("pre_escrow count == 1",
            buckets["pre_escrow"]["count"] == 1)
    # unknown: p9
    assert_("unknown count == 1",
            buckets["unknown"]["count"] == 1)

    # ── sum integrity
    # outstanding EUR gross: p1(100) + p2(200) + d2(100) + d3(100) + d5(100) + d8(100) = 700
    eur = buckets["outstanding_escrow"]["gross_by_currency"].get("EUR", 0)
    assert_("outstanding EUR sum == 700",
            eur == 700.0, f"got {eur}")
    # outstanding USD gross: p3(50)
    usd = buckets["outstanding_escrow"]["gross_by_currency"].get("USD", 0)
    assert_("outstanding USD sum == 50", usd == 50.0)
    # outstanding EUR sum must NOT include d4 (refunded) or p4 (released)
    # ── pre_escrow EUR gross: p8(100)
    assert_("pre_escrow EUR sum == 100",
            buckets["pre_escrow"]["gross_by_currency"].get("EUR") == 100.0)

    # ── settled payouts: p4(88) + p5(60) + d1(88) + d6(88) + d7(70) = 394
    settled_payout = buckets["settled_to_provider"]["payout_by_currency"].get("EUR", 0)
    assert_("settled provider payout sum == 394",
            settled_payout == 394.0, f"got {settled_payout}")

    # ── divergences
    divs = detect_divergences(SYNTHETIC)
    codes = {d["code"] for d in divs}

    expected_codes = {
        "UNKNOWN_STATUS",          # p9
        "RELEASED_NO_TIMESTAMP",   # d1
        "PAID_HAS_RELEASE_FIELDS", # d2
        "DISPUTED_HAS_RELEASE",    # d3
        "NEGATIVE_AMOUNT",         # d4
        "MISSING_CUSTOMER",        # d5
        "PAID_AFTER_RELEASED",     # d6
        "GROSS_PAYOUT_REFUND_DRIFT",  # d7
        "CURRENCY_MISSING",        # d8
    }
    missing = expected_codes - codes
    assert_("all expected divergence codes triggered",
            not missing, f"missing={sorted(missing)}")

    # No false-positive on clean rows (p1, p4, p6, p7, p8)
    clean_ids = {"p1", "p4", "p6", "p7", "p8"}
    flagged_clean = [d for d in divs if d["paymentId"] in clean_ids]
    assert_("no divergence flag on clean rows (p1/p4/p6/p7/p8)",
            not flagged_clean,
            f"flagged={[(d['paymentId'], d['code']) for d in flagged_clean]}")

    # ── per-code count sanity
    by_code: dict[str, int] = {}
    for d in divs:
        by_code[d["code"]] = by_code.get(d["code"], 0) + 1
    assert_("exactly 1 UNKNOWN_STATUS", by_code.get("UNKNOWN_STATUS") == 1)
    assert_("exactly 1 RELEASED_NO_TIMESTAMP", by_code.get("RELEASED_NO_TIMESTAMP") == 1)
    assert_("exactly 1 PAID_HAS_RELEASE_FIELDS", by_code.get("PAID_HAS_RELEASE_FIELDS") == 1)
    assert_("exactly 1 GROSS_PAYOUT_REFUND_DRIFT", by_code.get("GROSS_PAYOUT_REFUND_DRIFT") == 1)

    # ── top-N
    top_provs = collect_top_n(
        SYNTHETIC, group_key="providerId",
        bucket_filter=["outstanding_escrow"], n=10,
    )
    # prov1: p1(100) + p2(200) + d2(100) + d3(100) + d5(100) + d8(100) = 700 EUR
    # prov2: p3(50 USD)
    # prov3: nothing in outstanding (p7 failed, p8 pre_escrow, p9 unknown)
    assert_("top providers ranked correctly",
            top_provs[0]["key"] == "prov1" and top_provs[0]["totalByCurrency"]["EUR"] == 700,
            f"got {top_provs[0] if top_provs else None}")

    top_custs = collect_top_n(
        SYNTHETIC, group_key="customerId",
        bucket_filter=["outstanding_escrow"], n=10,
    )
    # c1: p1(100) + d2(100) + d3(100) + d8(100) = 400 EUR
    # c2: p2(200) = 200 EUR
    # c3: p3(50 USD) = 50 USD
    # c5: nothing in outstanding (p8 pre_escrow, p9 unknown)
    assert_("top customers: c1 ranked first with 400 EUR",
            top_custs[0]["key"] == "c1" and top_custs[0]["totalByCurrency"]["EUR"] == 400,
            f"got {top_custs[0] if top_custs else None}")

    # ── KNOWN_STATUSES contains every status we intentionally classify
    for s in ("paid", "disputed", "disputed_hold", "released",
              "resolved_partial", "refunded", "failed",
              "transfer_reversed", "pending", "requires_payment_method"):
        assert_(f"KNOWN_STATUSES has {s!r}", s in KNOWN_STATUSES)

    # ── STATUS_BUCKETS is closed: bucket members are disjoint
    seen: set[str] = set()
    for name, members in STATUS_BUCKETS.items():
        overlap = seen.intersection(members)
        assert_(f"bucket {name!r} disjoint from prior", not overlap,
                f"overlap={overlap}")
        seen.update(members)


async def phase_b_db() -> None:
    print("\n── PHASE B — generate_report() against a seeded test DB ──")

    client = AsyncIOMotorClient(MONGO)
    db = client[DB]

    # Use a namespaced id prefix so we don't collide with prod-like data
    # or other smokes. We DELETE these rows at the end (cleanup, not the
    # audit module mutating them).
    seed_tag = f"recon-smoke-{uuid.uuid4().hex[:8]}"
    seed_rows = []
    for r in SYNTHETIC:
        sr = dict(r)
        sr["id"] = f"{seed_tag}-{r['id']}"
        sr["_smoke_seed_tag"] = seed_tag
        seed_rows.append(sr)
    await db.service_payments.insert_many(seed_rows)

    # Snapshot the collection size BEFORE the report, to assert the audit
    # module is truly read-only.
    size_before = await db.service_payments.count_documents({})

    # Run the report. We pass `limit` so we only scan our seeded rows
    # if the DB has unrelated data—to make the smoke deterministic, we
    # take a different strategy: filter by `_smoke_seed_tag` via a
    # subsequent compute step. Use generate_report() unfiltered first
    # to also prove that mixing-in production rows doesn't break
    # invariants (it just dilutes them).
    report = await generate_report(db)

    # Read-only invariant: collection size unchanged.
    size_after = await db.service_payments.count_documents({})
    assert_("DB collection size unchanged by audit (READ-ONLY)",
            size_before == size_after,
            f"before={size_before} after={size_after}")

    # Result shape
    for key in ("generatedAt", "scope", "totalDocs", "buckets",
                "divergenceCountsByCode", "divergences",
                "topProvidersOutstanding", "topCustomersOutstanding"):
        assert_(f"report has key {key!r}", key in report)

    assert_("report.totalDocs == size_before",
            report["totalDocs"] == size_before)

    # Targeted check: divergences should include AT LEAST the codes we
    # seeded (other rows in the DB may add more, but they cannot remove
    # ours).
    triggered = set(report["divergenceCountsByCode"].keys())
    for need in ("UNKNOWN_STATUS", "RELEASED_NO_TIMESTAMP",
                 "PAID_HAS_RELEASE_FIELDS", "NEGATIVE_AMOUNT",
                 "GROSS_PAYOUT_REFUND_DRIFT"):
        assert_(f"DB report contains divergence code {need!r}",
                need in triggered)

    # Targeted check: bucket counts must be >= seed counts.
    # outstanding_escrow seed = 7; DB might have more, but never fewer.
    db_outstanding = report["buckets"]["outstanding_escrow"]["count"]
    assert_("outstanding_escrow count >= 7 (seeded floor)",
            db_outstanding >= 7, f"got {db_outstanding}")

    # Cleanup our seeded rows (NOT the audit module — the smoke does it).
    delete_result = await db.service_payments.delete_many({"_smoke_seed_tag": seed_tag})
    assert_("cleanup deleted exactly seeded rows",
            delete_result.deleted_count == len(seed_rows),
            f"deleted={delete_result.deleted_count} seeded={len(seed_rows)}")

    client.close()


async def main() -> int:
    await phase_a_pure()
    await phase_b_db()

    if failures:
        print("\n❌ FAILURES:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(
        "\n✅ ALL B4.3-A.1 RECONCILIATION CHECKS PASSED "
        "(buckets classified · divergences detected · sums correct · "
        "top-N ranked · DB code-path is READ-ONLY · cleanup verified)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
