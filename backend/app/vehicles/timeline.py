"""app.vehicles.timeline — Per-vehicle aggregator (P4.1).

Composes the typed projection input the Vehicle Memory shared module
expects, by joining 5 collections on `vehicleId`:

    car_requests          ↘
    inspection_jobs        ↘
    inspection_reports      ──→ /api/customer/vehicles/:id/timeline
    customer_requests      ↗
    request_quotes        ↗
    customer_bookings    ↗
    payment_transactions↗

Hard rules (P4.1):
- NO `vehicle_events` collection.
- NO event sourcing.
- NO graph DB.
- NO event framework.
- Just explicit `vehicleId` lookups with per-collection indexes.

The aggregator is read-only — it does not back-fill or mutate
documents. Legacy docs without `vehicleId` are simply absent from the
result; that is the explicit cost of P4.1's "no migration script"
posture and is acceptable because:
    1. Legacy docs predate the linkage contract.
    2. New writes from this point onward carry `vehicleId`.
    3. The shared projection is robust to empty arrays.
"""
from __future__ import annotations
import logging
from typing import Any

from app.core.db import db


logger = logging.getLogger("server")


# ─────────────────────────────────────────────────────────────────────
# Index management — idempotent. Called once at app startup.
# ─────────────────────────────────────────────────────────────────────

# Each collection that gained a `vehicleId` field. The index is compound
# (vehicleId asc, createdAt desc) so per-vehicle timeline queries are
# already sorted at the index level.
_INDEXED_COLLECTIONS: tuple[str, ...] = (
    "car_requests",
    "inspection_jobs",
    "inspection_reports",
    "customer_requests",
    "request_quotes",
    "customer_bookings",
    "payment_transactions",
)


async def ensure_indexes() -> None:
    """Create the per-vehicle indexes. `create_index` is idempotent on
    same key signature so calling this on every startup is safe.
    """
    for col_name in _INDEXED_COLLECTIONS:
        try:
            # createdAt may not exist on every doc; sparse index keeps
            # legacy docs from blocking the build. We only care about
            # docs that actually have vehicleId set.
            await db[col_name].create_index(
                [("vehicleId", 1), ("createdAt", -1)],
                name="vehicleId_1_createdAt_-1",
                background=True,
                sparse=True,
            )
        except Exception as exc:
            # Non-fatal — startup must not crash on index creation.
            # The collection might already have an index with a
            # different name covering the same keys, in which case
            # MongoDB raises IndexOptionsConflict; we log and move on.
            logger.warning(f"[p4.1] index ensure failed for {col_name}: {exc}")


# ─────────────────────────────────────────────────────────────────────
# Per-collection translators — emit the wire shape the surface's
# CustomerVehicleDetail.tsx already consumes (LinkedXxxRef[] from
# /shared/domain/contracts/vehicle.ts). The shared projection layer
# is NOT touched here — translation only.
# ─────────────────────────────────────────────────────────────────────

def _iso(v: Any) -> str:
    """Coerce datetime/Mongo-ish to ISO-8601 string."""
    if v is None:
        return ""
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return str(v)


def _to_report_ref(doc: dict) -> dict:
    """inspection_reports doc → LinkedInspectionReportRef."""
    return {
        "id": str(doc.get("_id") or doc.get("id") or ""),
        "submittedAt": _iso(doc.get("createdAt") or doc.get("submittedAt")),
        "verdict": doc.get("verdict") or "recommended",
        "score": doc.get("score"),
        "summary": (doc.get("summary") or None),
    }


def _to_quote_ref(doc: dict) -> dict:
    """request_quotes doc → LinkedQuoteRef.

    NOTE: the SHARED layer is the one that normalises raw status to
    `QuoteStatus`. We pass the raw status through verbatim AND a
    best-effort mapping for the surface's typed input.
    """
    raw = (doc.get("status") or "").strip().lower()
    # Map the marketplace-flow status set to the shared QuoteStatus union.
    # Anything else falls through to 'sent' (safe minimum).
    mapping = {
        "pending": "sent",
        "draft": "draft",
        "sent": "sent",
        "viewed": "viewed",
        "accepted": "accepted",
        "rejected": "declined",
        "declined": "declined",
        "expired": "expired",
        "withdrawn": "withdrawn",
    }
    status = mapping.get(raw, "sent")
    return {
        "id": doc.get("id") or str(doc.get("_id") or ""),
        "providerSlug": doc.get("providerSlug"),
        "status": status,
        "rawStatus": raw or None,
        "priceFrom": doc.get("priceFrom"),
        "currency": doc.get("currency"),
        "acceptedAt": _iso(doc.get("acceptedAt")) if doc.get("acceptedAt") else None,
        "createdAt": _iso(doc.get("createdAt")) or None,
    }


def _to_payment_ref(doc: dict) -> dict:
    """payment_transactions doc → LinkedPaymentRef.

    Maps Stripe-tracked lifecycle to the shared PaymentStatus union
    (`created`/`checkout_pending`/`processing`/`paid`/`refunded`/
    `failed`/`cancelled`).
    """
    raw = (doc.get("status") or "").strip().lower()
    payment_status = (doc.get("paymentStatus") or doc.get("payment_status") or "").strip().lower()
    if raw == "paid" or payment_status == "paid":
        s = "paid"
    elif raw == "refunded":
        s = "refunded"
    elif raw == "failed":
        s = "failed"
    elif raw in ("cancelled", "canceled", "expired"):
        s = "cancelled"
    elif raw in ("processing", "settling"):
        s = "processing"
    elif raw in ("initiated", "open", "checkout_pending"):
        s = "checkout_pending"
    else:
        s = "created"
    return {
        "id": doc.get("id") or str(doc.get("_id") or ""),
        "status": s,
        "amount": doc.get("amount"),
        "currency": (doc.get("currency") or "").upper() or None,
        "paidAt": _iso(doc.get("paidAt")) if doc.get("paidAt") else None,
        "createdAt": _iso(doc.get("createdAt")) or None,
    }


def _to_booking_ref(doc: dict) -> dict:
    """customer_bookings doc → LinkedBookingRef.

    The customer_bookings status set already matches the shared
    BookingStatus union exactly (pending/confirmed/on_route/arrived/
    in_progress/completed/cancelled).
    """
    raw = (doc.get("status") or "pending").strip().lower()
    if raw not in {"pending", "confirmed", "on_route", "arrived", "in_progress", "completed", "cancelled"}:
        raw = "pending"
    return {
        "id": doc.get("id") or str(doc.get("_id") or ""),
        "status": raw,
        "scheduledAt": _iso(doc.get("scheduledAt")) if doc.get("scheduledAt") else None,
        "createdAt": _iso(doc.get("createdAt")),
    }


# ─────────────────────────────────────────────────────────────────────
# Aggregator entry point — used by the router endpoint.
# ─────────────────────────────────────────────────────────────────────

async def build_timeline_payload(vehicle_id: str) -> dict:
    """Gather the per-vehicle linked artefacts.

    Returns the shape:
        {
            "reports":  [LinkedInspectionReportRef, ...],
            "quotes":   [LinkedQuoteRef, ...],
            "payments": [LinkedPaymentRef, ...],
            "bookings": [LinkedBookingRef, ...],
        }

    All lists are unsorted on the wire (the shared projection sorts the
    timeline). Empty arrays are valid and mean "no linked records of
    that kind", NOT "data not loaded yet".
    """
    # Reports come from BOTH `inspection_reports` (auto-search inspection
    # flow) — they were the only collection that ever wrote `vehicleId`
    # on reports. Pull both legacy field names (vehicleId is the new
    # canonical; falling back to None means we don't return reports
    # for legacy docs predating P4.1, by design).
    reports_cur = db.inspection_reports.find(
        {"vehicleId": vehicle_id},
        {"_id": 1, "id": 1, "createdAt": 1, "verdict": 1, "score": 1, "summary": 1},
    ).sort("createdAt", -1).limit(50)
    reports = [_to_report_ref(d) for d in await reports_cur.to_list(50)]

    # Quotes — marketplace flow `request_quotes` collection.
    quotes_cur = db.request_quotes.find(
        {"vehicleId": vehicle_id},
        {"_id": 0},
    ).sort("createdAt", -1).limit(50)
    quotes = [_to_quote_ref(d) for d in await quotes_cur.to_list(50)]

    # Payments — Stripe-tracked transactions.
    payments_cur = db.payment_transactions.find(
        {"vehicleId": vehicle_id},
        {"_id": 0},
    ).sort("createdAt", -1).limit(50)
    payments = [_to_payment_ref(d) for d in await payments_cur.to_list(50)]

    # Bookings — service-marketplace customer bookings.
    bookings_cur = db.customer_bookings.find(
        {"vehicleId": vehicle_id},
        {"_id": 0},
    ).sort("createdAt", -1).limit(50)
    bookings = [_to_booking_ref(d) for d in await bookings_cur.to_list(50)]

    return {
        "reports": reports,
        "quotes": quotes,
        "payments": payments,
        "bookings": bookings,
    }
