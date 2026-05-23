"""Sprint B4.3-A.1 — service_payments reconciliation audit (READ-ONLY).

Doctrine:
  This module reads. It does not write. It does not mutate. It does
  not create new collections. It does not maintain a balance ledger.
  It does not register hooks. It does not run on boot.

  It computes buckets and detects divergences over the existing
  `service_payments` collection, and surfaces a structured report
  that an operator can read and decide what (if anything) to do.

  The status taxonomy below is INVENTORIED from the existing code as
  of B4.3-A-recovery + B4.3-A.2, NOT invented here. New statuses
  appear in the `unknown` bucket — they are not silently absorbed.

What this module does NOT do (explicit anti-goals per sprint brief):

  * ❌ auto-fix (no `update_one` / `delete_one` / `insert_one`)
  * ❌ backfill (no derived field writes)
  * ❌ new balance rows / new collection
  * ❌ reserved ledger / ac_* namespace
  * ❌ boot-time replay (no startup registration)
  * ❌ mutation hooks (no side-effect coupling to writer paths)
  * ❌ chronology emission (no `payment_events` appends)
  * ❌ alerting framework (caller decides what to do with the report)

Public surface:

  STATUS_BUCKETS, KNOWN_STATUSES          — frozen literal sets
  classify_status(status)                 — pure function
  compute_buckets(rows)                   — pure function
  detect_divergences(rows)                — pure function
  collect_top_n(rows, key, n)             — pure function
  generate_report(db, *, limit=None)      — async, READ-ONLY DB caller
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple


# ────────────────────────────────────────────────────────────────────
# Status taxonomy — INVENTORIED from /app/backend post-B4.3-A.2.
# Adding a new value to this dict is a deliberate act; unknown statuses
# show up in the `unknown` bucket of the report so they are visible.
# ────────────────────────────────────────────────────────────────────


# Outstanding escrow: customer paid in, money has not left platform yet.
# Per sprint brief: paid/disputed/in_review counted as outstanding.
# `disputed_hold` is a request-level status; the underlying payment is
# `disputed` per disputes/router.py:251 — but legacy payments may carry
# `disputed_hold` directly, so we accept both here for safety.
STATUS_OUTSTANDING_ESCROW = frozenset({
    "paid",
    "disputed",
    "disputed_hold",
    "in_review",        # legacy/admin manual hold
})

# Settled to provider: money committed in provider direction.
STATUS_SETTLED_TO_PROVIDER = frozenset({
    "released",
    "resolved_partial",   # split: PART went to provider, PART refunded
})

# Refunded to customer: money returned (or scheduled to return) to customer.
STATUS_REFUNDED_TO_CUSTOMER = frozenset({
    "refunded",
})

# Terminal failure: money never landed in escrow OR was reversed by Stripe.
STATUS_TERMINAL_FAILURE = frozenset({
    "failed",
    "transfer_reversed",
})

# Pre-escrow: payment row exists but customer hasn't paid yet.
STATUS_PRE_ESCROW = frozenset({
    "pending",
    "requires_payment_method",
})


# Closed set known to this slice. Anything outside this is `unknown`.
KNOWN_STATUSES = (
    STATUS_OUTSTANDING_ESCROW
    | STATUS_SETTLED_TO_PROVIDER
    | STATUS_REFUNDED_TO_CUSTOMER
    | STATUS_TERMINAL_FAILURE
    | STATUS_PRE_ESCROW
)


STATUS_BUCKETS = {
    "outstanding_escrow": STATUS_OUTSTANDING_ESCROW,
    "settled_to_provider": STATUS_SETTLED_TO_PROVIDER,
    "refunded_to_customer": STATUS_REFUNDED_TO_CUSTOMER,
    "terminal_failure": STATUS_TERMINAL_FAILURE,
    "pre_escrow": STATUS_PRE_ESCROW,
}


def classify_status(status: Optional[str]) -> str:
    """Map a raw `service_payments.status` to one of the 5 bucket names
    or 'unknown'. Pure. No DB access."""
    if not status:
        return "unknown"
    for bucket_name, members in STATUS_BUCKETS.items():
        if status in members:
            return bucket_name
    return "unknown"


# ────────────────────────────────────────────────────────────────────
# Money amount fields and helpers.
# ────────────────────────────────────────────────────────────────────


def _amt(row: Dict[str, Any], field: str) -> float:
    """Coerce a numeric field to float, treating None / missing / non-
    numeric as 0.0. Never raises."""
    v = row.get(field)
    if v is None:
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _ccy(row: Dict[str, Any]) -> str:
    c = row.get("currency") or "EUR"
    return str(c).upper()


# ────────────────────────────────────────────────────────────────────
# Bucket computation
# ────────────────────────────────────────────────────────────────────


def compute_buckets(rows: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """Roll `rows` into bucket-level aggregates.

    Returns a dict of bucket_name → {
        statuses: [str],          # statuses observed in this bucket
        count:    int,
        gross_by_currency:    {ccy: float},    # sum of grossAmount
        payout_by_currency:   {ccy: float},    # sum of providerPayout
        refund_by_currency:   {ccy: float},    # sum of refundAmount
    }

    Pure. No DB access.
    """
    initial: Dict[str, Any] = {}
    for name in (*STATUS_BUCKETS.keys(), "unknown"):
        initial[name] = {
            "statuses": set(),
            "count": 0,
            "gross_by_currency": defaultdict(float),
            "payout_by_currency": defaultdict(float),
            "refund_by_currency": defaultdict(float),
        }

    for row in rows:
        bucket = classify_status(row.get("status"))
        b = initial[bucket]
        b["statuses"].add(row.get("status") or "<missing>")
        b["count"] += 1
        ccy = _ccy(row)
        b["gross_by_currency"][ccy] += _amt(row, "grossAmount")
        # providerPayout is the provider-direction net; for resolved_partial
        # the partial payout lives in `partialPayoutAmount`.
        if row.get("status") == "resolved_partial":
            b["payout_by_currency"][ccy] += _amt(row, "partialPayoutAmount")
        else:
            b["payout_by_currency"][ccy] += _amt(row, "providerPayout")
        # refundAmount applies to refunded + resolved_partial branches.
        b["refund_by_currency"][ccy] += _amt(row, "refundAmount")

    # Serialise sets/defaultdicts to lists/dicts for JSON cleanliness.
    out: Dict[str, Any] = {}
    for name, b in initial.items():
        out[name] = {
            "statuses": sorted(b["statuses"]),
            "count": b["count"],
            "gross_by_currency": {k: round(v, 2) for k, v in b["gross_by_currency"].items()},
            "payout_by_currency": {k: round(v, 2) for k, v in b["payout_by_currency"].items()},
            "refund_by_currency": {k: round(v, 2) for k, v in b["refund_by_currency"].items()},
        }
    return out


# ────────────────────────────────────────────────────────────────────
# Divergence detection — read-only red flags.
# Each detector is a pure function. They never raise.
# ────────────────────────────────────────────────────────────────────


def detect_divergences(rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Run each closed-set check against each row and return a flat list
    of divergence records. Each record is JSON-safe.

    Code (machine-readable) for each detector:

      UNKNOWN_STATUS              status not in KNOWN_STATUSES
      RELEASED_NO_TIMESTAMP       status=released but releasedAt missing
      REFUNDED_NO_TIMESTAMP       status=refunded but refundedAt missing
      DISPUTED_NO_TIMESTAMP       status=disputed/disputed_hold but disputedAt missing
      PAID_HAS_RELEASE_FIELDS     status=paid but releasedAt/releasedBy set (stale partial transition)
      PAID_HAS_REFUND_FIELDS      status=paid but refundedAt set (stale partial transition)
      DISPUTED_HAS_RELEASE        status=disputed but releasedAt set (resolution started but status didn't flip)
      RELEASED_NO_PAYOUT          status=released but providerPayout is 0
      PARTIAL_MISSING_FIELDS      status=resolved_partial but partialPayoutAmount/refundAmount missing
      PAID_AFTER_RELEASED         paidAt > releasedAt (impossible)
      MISSING_CUSTOMER            customerId missing/empty
      MISSING_PROVIDER            providerId missing/empty
      NEGATIVE_AMOUNT             grossAmount/providerPayout/refundAmount < 0
      GROSS_PAYOUT_REFUND_DRIFT   For released/refunded/resolved_partial:
                                  gross != payout + refund + commission (tolerance 0.01)
      CURRENCY_MISSING            currency field missing/empty
    """
    divs: List[Dict[str, Any]] = []

    for row in rows:
        pid = row.get("id") or "<no id>"
        status = row.get("status")
        ccy = _ccy(row)
        gross = _amt(row, "grossAmount")
        payout = (_amt(row, "partialPayoutAmount")
                  if status == "resolved_partial"
                  else _amt(row, "providerPayout"))
        refund = _amt(row, "refundAmount")
        commission = _amt(row, "commissionAmount")

        def flag(code: str, detail: str = "") -> None:
            divs.append({
                "code": code,
                "paymentId": pid,
                "status": status,
                "currency": ccy,
                "detail": detail,
            })

        # 1. unknown status
        if status not in KNOWN_STATUSES:
            flag("UNKNOWN_STATUS", f"status={status!r} not in known set")

        # 2. timestamp consistency
        if status == "released" and not row.get("releasedAt"):
            flag("RELEASED_NO_TIMESTAMP", "releasedAt missing on released doc")
        if status == "refunded" and not row.get("refundedAt"):
            flag("REFUNDED_NO_TIMESTAMP", "refundedAt missing on refunded doc")
        if status in ("disputed", "disputed_hold") and not row.get("disputedAt"):
            flag("DISPUTED_NO_TIMESTAMP", "disputedAt missing on disputed doc")

        # 3. stale partial transitions (releasedAt set but status reverted/stuck)
        if status == "paid":
            if row.get("releasedAt") or row.get("releasedBy"):
                flag("PAID_HAS_RELEASE_FIELDS",
                     f"releasedAt={row.get('releasedAt')!r} but status='paid'")
            if row.get("refundedAt"):
                flag("PAID_HAS_REFUND_FIELDS",
                     f"refundedAt={row.get('refundedAt')!r} but status='paid'")
        if status == "disputed" and row.get("releasedAt"):
            flag("DISPUTED_HAS_RELEASE",
                 "releasedAt set on disputed doc (resolution did not flip status)")

        # 4. payout integrity
        if status == "released" and payout <= 0:
            flag("RELEASED_NO_PAYOUT", f"providerPayout={payout}")
        if status == "resolved_partial":
            if not row.get("partialPayoutAmount") or row.get("refundAmount") is None:
                flag("PARTIAL_MISSING_FIELDS",
                     f"partialPayoutAmount={row.get('partialPayoutAmount')!r} "
                     f"refundAmount={row.get('refundAmount')!r}")

        # 5. chronological impossibility
        paid_at = row.get("paidAt")
        released_at = row.get("releasedAt")
        if paid_at and released_at and isinstance(paid_at, str) and isinstance(released_at, str):
            if paid_at > released_at:
                flag("PAID_AFTER_RELEASED",
                     f"paidAt={paid_at!r} > releasedAt={released_at!r}")

        # 6. missing relational fields
        if not row.get("customerId"):
            flag("MISSING_CUSTOMER")
        if not row.get("providerId"):
            flag("MISSING_PROVIDER")

        # 7. negative amounts
        if gross < 0 or payout < 0 or refund < 0:
            flag("NEGATIVE_AMOUNT",
                 f"gross={gross} payout={payout} refund={refund}")

        # 8. currency
        if not row.get("currency"):
            flag("CURRENCY_MISSING")

        # 9. money conservation for terminal rows.
        # released:           gross ≈ payout + commission
        # refunded:           gross ≈ refund + commission   (refund whole)
        # resolved_partial:   gross ≈ payout + refund + commission
        if status in ("released", "refunded", "resolved_partial"):
            if status == "released":
                expected = payout + commission
            elif status == "refunded":
                # refundAmount may be missing on legacy refund rows
                # where the gross was implicitly the refund; allow both.
                if refund == 0 and not row.get("refundAmount"):
                    expected = gross
                else:
                    expected = refund + commission
            else:  # resolved_partial
                expected = payout + refund + commission
            if abs(gross - expected) > 0.01 and gross > 0:
                flag("GROSS_PAYOUT_REFUND_DRIFT",
                     f"gross={gross} expected≈{round(expected, 2)} "
                     f"(payout={payout} refund={refund} commission={commission})")

    return divs


# ────────────────────────────────────────────────────────────────────
# Top-N aggregation by grouping key (provider / customer).
# ────────────────────────────────────────────────────────────────────


def collect_top_n(
    rows: Iterable[Dict[str, Any]],
    *,
    group_key: str,
    bucket_filter: Iterable[str],
    n: int = 10,
) -> List[Dict[str, Any]]:
    """Sum outstanding (or any bucket-set) per group_key.

    Returns [{key, count, totalByCurrency}, ...] sorted DESC by total
    (largest currency wins on ties — good enough for inspection).
    """
    bucket_set = set(bucket_filter)
    grouped: Dict[str, Any] = defaultdict(lambda: {
        "count": 0,
        "totalByCurrency": defaultdict(float),
    })
    for row in rows:
        if classify_status(row.get("status")) not in bucket_set:
            continue
        key = row.get(group_key)
        if not key:
            continue
        ccy = _ccy(row)
        grouped[str(key)]["count"] += 1
        # Use grossAmount as the canonical magnitude for ranking.
        grouped[str(key)]["totalByCurrency"][ccy] += _amt(row, "grossAmount")
    out = [
        {
            "key": k,
            "count": v["count"],
            "totalByCurrency": {ccy: round(amt, 2) for ccy, amt in v["totalByCurrency"].items()},
        }
        for k, v in grouped.items()
    ]
    # Sort by the maximum currency total (descending).
    out.sort(key=lambda r: max(r["totalByCurrency"].values(), default=0.0), reverse=True)
    return out[:n]


# ────────────────────────────────────────────────────────────────────
# DB caller — READ-ONLY. Uses `find` with projection; never writes.
# ────────────────────────────────────────────────────────────────────


_PROJECTION = {
    "_id": 0,
    "id": 1, "status": 1, "currency": 1,
    "grossAmount": 1, "providerPayout": 1, "commissionAmount": 1,
    "refundAmount": 1, "refundPercent": 1, "partialPayoutAmount": 1,
    "customerId": 1, "providerId": 1, "requestId": 1,
    "paidAt": 1, "releasedAt": 1, "releasedBy": 1,
    "refundedAt": 1, "disputedAt": 1,
    "createdAt": 1, "updatedAt": 1,
    "stripePaymentIntentId": 1, "stripeTransferId": 1,
}


async def generate_report(db, *, limit: Optional[int] = None) -> Dict[str, Any]:
    """Read all `service_payments` rows and produce a structured report.

    Args:
        db: Motor database handle.
        limit: optional cap on rows scanned (for quick sampling on huge
            collections). None = scan all.

    Returns a JSON-safe dict. NEVER mutates the DB.
    """
    now_iso = datetime.now(timezone.utc).isoformat()

    cursor = db.service_payments.find({}, _PROJECTION)
    if limit is not None:
        cursor = cursor.limit(int(limit))
    rows: List[Dict[str, Any]] = [row async for row in cursor]

    buckets = compute_buckets(rows)
    divs = detect_divergences(rows)
    top_providers_outstanding = collect_top_n(
        rows, group_key="providerId",
        bucket_filter=["outstanding_escrow"], n=10,
    )
    top_customers_outstanding = collect_top_n(
        rows, group_key="customerId",
        bucket_filter=["outstanding_escrow"], n=10,
    )

    # Divergence counts grouped by code
    div_counts: Dict[str, int] = defaultdict(int)
    for d in divs:
        div_counts[d["code"]] += 1

    return {
        "generatedAt": now_iso,
        "scope": "service_payments (READ-ONLY snapshot)",
        "totalDocs": len(rows),
        "limit": limit,
        "buckets": buckets,
        "divergenceCountsByCode": dict(div_counts),
        "divergences": divs,
        "topProvidersOutstanding": top_providers_outstanding,
        "topCustomersOutstanding": top_customers_outstanding,
    }


__all__ = [
    "STATUS_OUTSTANDING_ESCROW",
    "STATUS_SETTLED_TO_PROVIDER",
    "STATUS_REFUNDED_TO_CUSTOMER",
    "STATUS_TERMINAL_FAILURE",
    "STATUS_PRE_ESCROW",
    "STATUS_BUCKETS",
    "KNOWN_STATUSES",
    "classify_status",
    "compute_buckets",
    "detect_divergences",
    "collect_top_n",
    "generate_report",
]
