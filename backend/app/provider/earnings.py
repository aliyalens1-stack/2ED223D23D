"""app.provider.earnings — Provider Earnings Phase 3.1 projector.

Doctrine (see /app/memory/PRD.md):
    "What does provider believe about money?"
    work completed ≠ client paid ≠ provider earned ≠ provider paid out

This module is a READ-ONLY projector:
  - reads from db.bookings, db.inspection_jobs, db.inspection_reports,
    db.payments, db.auction_charges
  - produces ProviderEarningsItem dicts
    (shape: shared/domain/contracts/provider-earnings-item.ts)
  - does NOT define a state machine
  - does NOT write to any new collection
  - does NOT introduce payout / settlement logic

Phase 3.1 emits only:
  - state='pending'        : work closed, no linked paid payment
  - state='payable'        : payment paid, no dispute
  - state='disputed_hold'  : payment disputed/refunded/chargeback
  - state='deducted'       : every auction_charges row (final, negative net)

Phase 3.1 NEVER emits:
  - state='processing'     : reserved, Phase 3.3 (payout pipeline)
  - state='paid_out'       : reserved, Phase 3.3 (settled to provider)

Critical invariant:
  lead_fee items ALWAYS carry state='deducted' and amount.net < 0.
  paid_out is provider-facing money-IN lifecycle ONLY. Never a deduction.
"""
from __future__ import annotations
from datetime import datetime, timezone, timedelta
from typing import Optional, Iterable

from app.core.db import get_db


# ── State / kind constants (mirror shared/domain/contracts/provider-earnings-item.ts) ──

S_PENDING        = "pending"
S_PAYABLE        = "payable"
S_PROCESSING     = "processing"      # reserved — Phase 3.3
S_PAID_OUT       = "paid_out"        # reserved — Phase 3.3
S_DISPUTED_HOLD  = "disputed_hold"
S_DEDUCTED       = "deducted"

ALL_STATES: tuple[str, ...] = (
    S_PENDING, S_PAYABLE, S_PROCESSING, S_PAID_OUT, S_DISPUTED_HOLD, S_DEDUCTED,
)

K_JOB       = "job"
K_LEAD_FEE  = "lead_fee"

# Soft SLA — `expectedSettlementBy` for a payable item is recognizedAt + N days.
# Phase 3.1 picks 7d as a safe default; tweak when payout pipeline is real.
PAYABLE_SETTLEMENT_DAYS = 7

# Default platform fee. Phase 3.1 keeps it at 0 because the real fee logic
# does not exist yet — surfacing a fake 10% would be misinforming the
# provider. When fee logic lands, this becomes a per-org / per-cluster lookup.
DEFAULT_PLATFORM_FEE_PCT = 0.0


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _ensure_iso(value) -> str:
    return _iso(value) or _now().isoformat()


def _payment_to_state(payment: Optional[dict]) -> tuple[str, Optional[dict]]:
    """Map a linked payment doc to (earningsState, blockedReason or None).

    Closed set of payment statuses we recognise. Anything else → pending
    (conservative — we only escalate to payable when we are sure).
    """
    if not payment:
        return S_PENDING, None
    status = (payment.get("status") or "").strip().lower()
    if status == "paid":
        return S_PAYABLE, None
    if status == "disputed":
        return S_DISPUTED_HOLD, {
            "code":    "payment_disputed",
            "message": "Клиент открыл спор по платежу — удержано до решения",
            "contactWho": "support",
        }
    if status == "refunded":
        return S_DISPUTED_HOLD, {
            "code":    "payment_refunded",
            "message": "Платёж возвращён клиенту — обратитесь в поддержку, если это ошибка",
            "contactWho": "support",
        }
    if status == "chargeback":
        return S_DISPUTED_HOLD, {
            "code":    "payment_disputed",
            "message": "Чарджбэк по карте — удержано до решения банком",
            "contactWho": "support",
        }
    # 'pending', 'processing', 'requires_action', anything else → still pending
    return S_PENDING, None


def _service_label_for_booking(b: dict) -> str:
    return b.get("serviceName") or b.get("problemLabel") or "Service"


def _service_label_for_inspection(j: dict) -> str:
    brand = (j.get("brand") or "").strip()
    model = (j.get("model") or "").strip()
    suffix = f" · {brand} {model}".rstrip()
    return f"Inspection{suffix}" if suffix.strip(" ·") else "Inspection"


def _amount_for_job(gross: float, currency: str, fee_pct: float = DEFAULT_PLATFORM_FEE_PCT) -> dict:
    """Compute amount split for a job item. Returns gross/fee/net dict."""
    gross_n = float(gross or 0)
    fee_n = round(gross_n * fee_pct, 2)
    net_n = round(gross_n - fee_n, 2)
    return {
        "gross":    gross_n,
        "fee":      fee_n,
        "net":      net_n,
        "currency": currency or "EUR",
    }


def _expected_settlement_by(state: str, recognized_at_iso: str) -> Optional[str]:
    """Soft SLA — only meaningful for state='payable' in Phase 3.1.
    pending/disputed_hold/deducted have no SLA hint.
    """
    if state != S_PAYABLE:
        return None
    try:
        recognized = datetime.fromisoformat(recognized_at_iso)
    except Exception:
        recognized = _now()
    return (recognized + timedelta(days=PAYABLE_SETTLEMENT_DAYS)).isoformat()


# ── Per-source projectors ────────────────────────────────────────────

def project_completed_booking(
    booking: dict,
    payment: Optional[dict],
) -> Optional[dict]:
    """Completed booking → ProviderEarningsItem (kind='job').

    Only emits for booking.status='completed'. Anything else is operational,
    not financial — projection should not show it.
    """
    if (booking.get("status") or "").strip() != "completed":
        return None

    booking_id = booking.get("id") or str(booking.get("_id") or "")
    if not booking_id:
        return None

    state, blocked = _payment_to_state(payment)

    gross = float(
        booking.get("finalPrice")
        or booking.get("priceEstimate")
        or booking.get("basePrice")
        or 0
    )
    currency = booking.get("currency") or (payment or {}).get("currency") or "EUR"

    recognized_at = _ensure_iso(
        booking.get("completedAt") or booking.get("updatedAt") or booking.get("createdAt")
    )

    item = {
        "id":           f"er_{booking_id}",
        "kind":         K_JOB,
        "state":        state,
        "workItemId":   f"bk_{booking_id}",
        "amount":       _amount_for_job(gross, currency),
        "recognizedAt": recognized_at,
        "service": {
            "label":        _service_label_for_booking(booking),
            "customerName": (booking.get("customerName") or "")[:40] or None,
        },
    }
    settlement = _expected_settlement_by(state, recognized_at)
    if settlement:
        item["expectedSettlementBy"] = settlement
    if blocked:
        item["blockedReason"] = blocked
    return item


def project_completed_inspection(
    job: dict,
    report: Optional[dict],
    payment: Optional[dict],
) -> Optional[dict]:
    """Approved inspection → ProviderEarningsItem (kind='job').

    Only emits when there is an inspection_report with status='approved' —
    that is the moment money is recognised for the inspector. Without an
    approved report, the work is operationally `awaiting_review`, not earned.
    """
    if not report or (report.get("status") or "").strip() != "approved":
        return None

    job_id = job.get("_id") or job.get("id")
    if not job_id:
        return None
    job_id = str(job_id)

    state, blocked = _payment_to_state(payment)
    gross = float(job.get("budget") or 0)
    currency = job.get("currency") or (payment or {}).get("currency") or "EUR"

    recognized_at = _ensure_iso(
        report.get("approvedAt") or report.get("submittedAt")
        or job.get("completedAt") or job.get("createdAt")
    )

    item = {
        "id":           f"er_{job_id}",
        "kind":         K_JOB,
        "state":        state,
        "workItemId":   f"ij_{job_id}",
        "amount":       _amount_for_job(gross, currency),
        "recognizedAt": recognized_at,
        "service": {
            "label":        _service_label_for_inspection(job),
            "customerName": (job.get("customerName") or job.get("city") or "")[:40] or None,
        },
    }
    settlement = _expected_settlement_by(state, recognized_at)
    if settlement:
        item["expectedSettlementBy"] = settlement
    if blocked:
        item["blockedReason"] = blocked
    return item


def project_lead_fee(charge: dict) -> Optional[dict]:
    """auction_charges row → ProviderEarningsItem (kind='lead_fee', state='deducted').

    Final the moment the row exists. amount.net is always negative.
    """
    charge_id = charge.get("id")
    if not charge_id:
        return None

    fee = float(charge.get("amountCharged") or charge.get("bid") or 0)
    if fee <= 0:
        return None

    currency = charge.get("currency") or "EUR"
    booking_id = charge.get("bookingId")

    return {
        "id":           f"lf_{charge_id}",
        "kind":         K_LEAD_FEE,
        "state":        S_DEDUCTED,
        "workItemId":   f"bk_{booking_id}" if booking_id else None,
        "amount": {
            "gross":    0.0,
            "fee":      round(fee, 2),
            "net":      round(-fee, 2),
            "currency": currency,
        },
        "recognizedAt": _ensure_iso(charge.get("createdAt")),
        "service": {
            "label":        f"Lead fee · {charge.get('zone') or 'unknown zone'}",
            "customerName": None,
        },
    }


# ── Aggregation ──────────────────────────────────────────────────────

def aggregate_summary(items: Iterable[dict]) -> dict:
    """Produce ProviderEarningsSummary — per-currency, per-state buckets.

    NEVER mixes currencies. Each currency is an independent ledger.
    """
    by_currency: dict[str, dict] = {}
    for it in items:
        amt = it.get("amount") or {}
        currency = amt.get("currency") or "EUR"
        bucket = by_currency.get(currency)
        if bucket is None:
            bucket = {
                "currency":      currency,
                "pending":       {"count": 0, "net": 0.0},
                "payable":       {"count": 0, "net": 0.0},
                "processing":    {"count": 0, "net": 0.0},
                "paid_out":      {"count": 0, "net": 0.0},
                "disputed_hold": {"count": 0, "net": 0.0},
                "deducted":      {"count": 0, "net": 0.0},
            }
            by_currency[currency] = bucket
        state = it.get("state")
        if state in bucket:
            bucket[state]["count"] += 1
            bucket[state]["net"] = round(bucket[state]["net"] + float(amt.get("net") or 0), 2)
    return {"byCurrency": list(by_currency.values())}


# ── Top-level projection ─────────────────────────────────────────────

# Sort priority for the items list: states that need attention first, then
# settled/deducted at the bottom (history).
_STATE_ORDER = {
    S_DISPUTED_HOLD: 0,
    S_PAYABLE:       1,
    S_PENDING:       2,
    S_PROCESSING:    3,
    S_PAID_OUT:      4,
    S_DEDUCTED:      5,
}


async def project_earnings_for_provider(
    *,
    viewer_user_id: str,
    viewer_provider_slug: Optional[str],
    from_iso: Optional[str] = None,
    to_iso: Optional[str] = None,
    states_filter: Optional[set[str]] = None,
) -> dict:
    """Build the full earnings projection for a provider.

    Reads (in parallel batches):
      - completed bookings owned by this provider's slug
      - their linked payments (db.payments by bookingId)
      - approved inspection reports authored by this user
      - their linked payments
      - auction_charges for this provider's slug

    Window:
      Default = last 90 days. Override via from_iso / to_iso.

    Filtering by `states_filter` happens after projection (so summary
    always reflects ALL items in the window, never a filtered slice).
    """
    db = get_db()
    items: list[dict] = []

    # Default window: last 90d
    if not from_iso:
        from_iso = (_now() - timedelta(days=90)).isoformat()

    # ── 1. Completed bookings (provider-side) ──
    if viewer_provider_slug:
        booking_q: dict = {
            "providerSlug": viewer_provider_slug,
            "status": "completed",
        }
        date_filter: dict = {}
        if from_iso:
            date_filter["$gte"] = from_iso
        if to_iso:
            date_filter["$lte"] = to_iso
        if date_filter:
            booking_q["completedAt"] = date_filter

        bookings = [
            b async for b in db.bookings.find(booking_q, {"_id": 0}).limit(500)
        ]
        booking_ids = [b.get("id") for b in bookings if b.get("id")]
        # Bulk-fetch payments for these bookings.
        payments_by_booking: dict[str, dict] = {}
        if booking_ids:
            async for p in db.payments.find(
                {"bookingId": {"$in": booking_ids}},
                {"_id": 0},
            ):
                bk_id = p.get("bookingId")
                # If multiple payments per booking, pick the latest by paidAt/createdAt.
                existing = payments_by_booking.get(bk_id)
                if existing is None:
                    payments_by_booking[bk_id] = p
                else:
                    p_ts = p.get("paidAt") or p.get("createdAt") or ""
                    e_ts = existing.get("paidAt") or existing.get("createdAt") or ""
                    if p_ts > e_ts:
                        payments_by_booking[bk_id] = p
        for b in bookings:
            wi = project_completed_booking(b, payments_by_booking.get(b.get("id")))
            if wi:
                items.append(wi)

    # ── 2. Approved inspection reports (inspector-side) ──
    # Find approved reports authored by this user. The current schema attaches
    # the report to the job via job.reportId; the inspector identity is on the
    # job itself. We query reports first (approved), then fetch jobs by reportId.
    reports = [
        r async for r in db.inspection_reports.find(
            {"status": "approved"},
        ).limit(500)
    ]
    if reports:
        report_ids = [r.get("_id") for r in reports if r.get("_id") is not None]
        jobs_by_report_id: dict = {}
        async for j in db.inspection_jobs.find(
            {
                "inspectorId": viewer_user_id,
                "reportId":    {"$in": report_ids},
            },
        ):
            jobs_by_report_id[j.get("reportId")] = j
        # We may also need payments for inspections — same lookup pattern.
        # Inspection jobs use _id (string) as the canonical id; payments may
        # reference them via bookingId field too (legacy) — try both.
        for r in reports:
            j = jobs_by_report_id.get(r.get("_id"))
            if not j:
                continue
            payment = await db.payments.find_one(
                {"bookingId": j.get("_id")},
                {"_id": 0},
            )
            wi = project_completed_inspection(j, r, payment)
            if wi:
                items.append(wi)

    # ── 3. Lead-fee deductions (auction_charges) ──
    if viewer_provider_slug:
        charge_q: dict = {"providerSlug": viewer_provider_slug}
        if from_iso or to_iso:
            df: dict = {}
            if from_iso:
                df["$gte"] = from_iso
            if to_iso:
                df["$lte"] = to_iso
            charge_q["createdAt"] = df
        async for charge in db.auction_charges.find(charge_q, {"_id": 0}).limit(500):
            wi = project_lead_fee(charge)
            if wi:
                items.append(wi)

    # Summary BEFORE filtering — provider always sees the whole picture.
    summary = aggregate_summary(items)

    # Apply state filter (if any) AFTER summary computation.
    if states_filter:
        items = [it for it in items if it.get("state") in states_filter]

    # Sort: state priority asc, then recognizedAt desc.
    items.sort(key=lambda it: (
        _STATE_ORDER.get(it.get("state"), 99),
        # Negate by string compare: bigger ISO string = newer; we want desc within a bucket.
        # Use a tuple where second element is the ISO string itself, then reverse=True is wrong
        # because we want the FIRST sort key ascending. Trick: lambda returning (priority, -ts_seconds)
        # would need a numeric ts. Cheap alt: use ISO as is and rely on Python's stable sort:
        # since recognizedAt is a string, reverse-newest within a state means we negate by sorting
        # bucket items separately. Simpler approach: do the sort in two passes.
        it.get("recognizedAt") or "",
    ))
    # Two-pass: now reverse within each state bucket so newest comes first.
    # Stable sort preserves the priority key while we re-sort by recognizedAt desc.
    items.sort(key=lambda it: it.get("recognizedAt") or "", reverse=True)
    items.sort(key=lambda it: _STATE_ORDER.get(it.get("state"), 99))

    return {"items": items, "summary": summary}
