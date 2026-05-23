"""P3.4 — Forensic navigation graph (READ-ONLY).

Doctrine:
  After P2 the contract is machine-verifiable. After Sprint B4.3 the
  money mutations are CAS-safe and the chronology is append-only.
  These two facts together mean it is now SAFE to expose a navigation
  graph that links operational entities — booking → payment chronology
  → dispute → money audit → provider payout → stripe evidence — without
  the risk of materializing a "distributed illusion".

  Per P3 brief:
    "booking → payment chronology → dispute → money audit
     → provider payout → stripe evidence"
    "это уже governance observability graph"

  This router gives that graph in one read.

What this router IS:
  * READ-ONLY: it never writes, mutates, or queues anything.
  * Composition over invention: it does NOT compute new business
    facts — it surfaces the relationships that already exist in the
    underlying collections.
  * Admin-only.

What it is NOT:
  * Not a SAGA / orchestrator.
  * Not a unified ledger.
  * Not an event-sourcing projection.
  * Not the source of truth for any field — every value it returns is
    a verbatim reference to a primary collection's data.
  * Not a chronology — chronology lives in
    /api/admin/payments/{id}/chronology and /timeline endpoints. This
    router only provides the GRAPH of related entities; chronology
    deep-links are returned as URLs the caller can follow.

Auth: admin-only.
Path: /api/admin/forensic-graph/{entity_type}/{entity_id} (canonical).
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Path

from app.core.db import get_db
from app.core.security import verify_admin_token


router = APIRouter(
    prefix="/api/admin/forensic-graph",
    tags=["admin.forensic-graph"],
    dependencies=[Depends(verify_admin_token)],
)


# ─── helpers ──────────────────────────────────────────────────────────────

def _strip_id(doc: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """ObjectId is not JSON-serializable. Mongo populates `_id` on read —
    remove it before returning to the network."""
    if doc is None:
        return None
    doc.pop("_id", None)
    return doc


def _node(kind: str, entity_id: str | None, data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {"kind": kind, "id": entity_id, "data": _strip_id(data)}


def _link(rel: str, kind: str, target_id: str, deeplink: str) -> Dict[str, Any]:
    return {"rel": rel, "kind": kind, "id": target_id, "deeplink": deeplink}


# ─── core graph builders ──────────────────────────────────────────────────

async def _graph_for_booking(db, booking_id: str) -> Dict[str, Any]:
    booking = await db.bookings.find_one({"id": booking_id})
    if booking is None:
        # legacy bookings may have used `_id` string
        booking = await db.bookings.find_one({"_id": booking_id})
    if booking is None:
        raise HTTPException(status_code=404, detail="booking not found")

    nodes: List[Dict[str, Any]] = [_node("booking", booking_id, booking)]
    edges: List[Dict[str, Any]] = []

    # ─── Payment(s) linked to the booking via service_payments ────────
    async for payment in db.service_payments.find({"bookingId": booking_id}, {"_id": 0}):
        pid = payment.get("id") or payment.get("paymentId")
        nodes.append(_node("payment", pid, payment))
        edges.append(_link("payment_for", "booking", booking_id,
                           f"/api/admin/payments/{pid}"))
        edges.append(_link("chronology_of", "payment", pid,
                           f"/api/admin/payments/{pid}/chronology"))

    # ─── Dispute(s) linked to booking ─────────────────────────────────
    async for dispute in db.disputes.find({"bookingId": booking_id}, {"_id": 0}):
        did = dispute.get("id") or dispute.get("disputeId")
        nodes.append(_node("dispute", did, dispute))
        edges.append(_link("dispute_of", "booking", booking_id,
                           f"/api/admin/disputes/{did}"))

    # ─── Review(s) for booking ────────────────────────────────────────
    async for review in db.provider_reviews.find({"bookingId": booking_id}, {"_id": 0}):
        rid = review.get("id") or review.get("reviewId")
        nodes.append(_node("review", rid, review))
        edges.append(_link("review_of", "booking", booking_id,
                           f"/api/admin/reviews/{rid}"))

    # ─── Customer / Provider primary references ───────────────────────
    if booking.get("customerId"):
        edges.append(_link("customer_of", "user", booking["customerId"],
                           f"/api/admin/users/{booking['customerId']}"))
    if booking.get("providerId"):
        edges.append(_link("provider_of", "organization", booking["providerId"],
                           f"/api/admin/organizations/{booking['providerId']}"))

    return {"root": "booking", "rootId": booking_id, "nodes": nodes, "edges": edges}


async def _graph_for_payment(db, payment_id: str) -> Dict[str, Any]:
    payment = await db.service_payments.find_one({"id": payment_id}, {"_id": 0})
    if payment is None:
        payment = await db.service_payments.find_one({"paymentId": payment_id}, {"_id": 0})
    if payment is None:
        raise HTTPException(status_code=404, detail="payment not found")

    nodes: List[Dict[str, Any]] = [_node("payment", payment_id, payment)]
    edges: List[Dict[str, Any]] = [
        _link("chronology_of", "payment", payment_id,
              f"/api/admin/payments/{payment_id}/chronology"),
    ]

    booking_id = payment.get("bookingId")
    if booking_id:
        booking = await db.bookings.find_one({"id": booking_id}, {"_id": 0})
        if booking:
            nodes.append(_node("booking", booking_id, booking))
            edges.append(_link("booking_for", "payment", payment_id,
                               f"/api/admin/bookings/{booking_id}"))

    # Disputes referencing this payment via the underlying booking
    if booking_id:
        async for dispute in db.disputes.find({"bookingId": booking_id}, {"_id": 0}):
            did = dispute.get("id") or dispute.get("disputeId")
            nodes.append(_node("dispute", did, dispute))
            edges.append(_link("dispute_of", "booking", booking_id,
                               f"/api/admin/disputes/{did}"))

    # Stripe references (read-only — these are external opaque IDs)
    if payment.get("stripePaymentIntentId"):
        edges.append(_link("stripe_payment_intent", "stripe",
                           payment["stripePaymentIntentId"],
                           f"https://dashboard.stripe.com/payments/{payment['stripePaymentIntentId']}"))
    if payment.get("stripeTransferId"):
        edges.append(_link("stripe_transfer", "stripe",
                           payment["stripeTransferId"],
                           f"https://dashboard.stripe.com/connect/transfers/{payment['stripeTransferId']}"))

    # Customer / provider refs
    if payment.get("customerId"):
        edges.append(_link("customer_of", "user", payment["customerId"],
                           f"/api/admin/users/{payment['customerId']}"))
    if payment.get("providerId"):
        edges.append(_link("provider_of", "organization", payment["providerId"],
                           f"/api/admin/organizations/{payment['providerId']}"))

    return {"root": "payment", "rootId": payment_id, "nodes": nodes, "edges": edges}


async def _graph_for_dispute(db, dispute_id: str) -> Dict[str, Any]:
    dispute = await db.disputes.find_one({"id": dispute_id}, {"_id": 0})
    if dispute is None:
        dispute = await db.disputes.find_one({"disputeId": dispute_id}, {"_id": 0})
    if dispute is None:
        raise HTTPException(status_code=404, detail="dispute not found")

    nodes: List[Dict[str, Any]] = [_node("dispute", dispute_id, dispute)]
    edges: List[Dict[str, Any]] = [
        _link("timeline_of", "dispute", dispute_id,
              f"/api/admin/disputes/{dispute_id}/timeline"),
    ]

    booking_id = dispute.get("bookingId")
    if booking_id:
        booking = await db.bookings.find_one({"id": booking_id}, {"_id": 0})
        if booking:
            nodes.append(_node("booking", booking_id, booking))
            edges.append(_link("booking_of", "dispute", dispute_id,
                               f"/api/admin/bookings/{booking_id}"))

        async for payment in db.service_payments.find({"bookingId": booking_id}, {"_id": 0}):
            pid = payment.get("id") or payment.get("paymentId")
            nodes.append(_node("payment", pid, payment))
            edges.append(_link("payment_for", "booking", booking_id,
                               f"/api/admin/payments/{pid}"))
            edges.append(_link("chronology_of", "payment", pid,
                               f"/api/admin/payments/{pid}/chronology"))

    return {"root": "dispute", "rootId": dispute_id, "nodes": nodes, "edges": edges}


# ─── routes ───────────────────────────────────────────────────────────────

_DISPATCH = {
    "booking":  _graph_for_booking,
    "payment":  _graph_for_payment,
    "dispute":  _graph_for_dispute,
}


@router.get("/{entity_type}/{entity_id}")
async def get_forensic_graph(
    entity_type: str = Path(..., pattern=r"^(booking|payment|dispute)$"),
    entity_id: str = Path(..., min_length=1, max_length=128),
    db=Depends(get_db),
):
    """Return the navigation graph rooted at the given entity.

    Shape:
      {
        "root":    "booking" | "payment" | "dispute",
        "rootId":  "<id>",
        "nodes":   [{ "kind": ..., "id": ..., "data": {...} }, ...],
        "edges":   [{ "rel": ..., "kind": ..., "id": ..., "deeplink": "/api/..." }, ...]
      }

    `edges[].deeplink` is a canonical admin URL the caller can follow to
    get the related entity's detail or chronology.
    """
    handler = _DISPATCH[entity_type]
    return await handler(db, entity_id)


@router.get("/")
async def describe_forensic_graph():
    """Schema description — what root types are supported and what edges
    are emitted from each. Admin UIs can use this to render legend / node
    palette without hardcoding it client-side."""
    return {
        "supportedRoots": list(_DISPATCH.keys()),
        "edgeTypes": [
            "payment_for", "chronology_of", "dispute_of", "review_of",
            "booking_of", "booking_for", "timeline_of",
            "customer_of", "provider_of",
            "stripe_payment_intent", "stripe_transfer",
        ],
        "doctrine": (
            "READ-ONLY composition over existing collections. No new business "
            "facts are invented here — every node and edge points at a record "
            "that already lives in service_payments / bookings / disputes / "
            "provider_reviews. Deeplinks are canonical admin URLs."
        ),
    }
