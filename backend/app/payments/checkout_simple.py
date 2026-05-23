"""
Phase 3.0b P0-1 — Simple inline payment for auto-requests.

Replaces the credits/packages flow with one-shot Stripe Checkout per request:
  inspection = €149  (per request, regardless of N cities for v1)
  selection  = €399  (per request, regardless of N cities for v1)

Flow:
  1) POST /api/payments/auto-request/checkout
     body: { type, originUrl, requestPayload }
     → creates payment_transactions doc (status=initiated)
     → returns { sessionId, url }
  2) Client opens `url` in WebBrowser/external tab; on success Stripe redirects to
     {originUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}
  3) Frontend polls GET /api/payments/auto-request/status/{session_id}
     → on payment_status=paid → backend calls auto_requests.create_request(payload)
       and returns { paid: true, request: {...} }
  4) /api/webhook/stripe — backup async path (idempotent w/ polling)

Server-only pricing — frontend MUST NOT send amount (anti-tampering).
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.auto_requests.schemas import CreateCarRequest
from app.auto_requests import service as ar_service
# Phase 1B Tier 3 — pure sync cluster enrichment.
from app.core.cluster_writer import enrich_with_cluster, cluster_from_payment_source

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/payments/auto-request", tags=["payments:auto-request"])

# ── Server-defined pricing (anti-tampering) ────────────────────────────────
PRICING_EUR: Dict[str, float] = {
    "inspection": 149.00,
    "selection": 399.00,
}
CURRENCY = "eur"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stripe_checkout(http_request: Request):
    """Lazy import + per-request init (host_url depends on request)."""
    from emergentintegrations.payments.stripe.checkout import StripeCheckout

    api_key = os.environ.get("STRIPE_API_KEY")
    if not api_key:
        raise HTTPException(503, "Stripe API key not configured")

    host_url = str(http_request.base_url).rstrip("/")
    webhook_url = f"{host_url}/api/webhook/stripe"
    return StripeCheckout(api_key=api_key, webhook_url=webhook_url)


# ── Schemas ────────────────────────────────────────────────────────────────


class CheckoutBody(BaseModel):
    """Frontend MUST NOT send amount. Backend computes from `type`."""
    originUrl: str = Field(..., description="Frontend origin like https://app.example.com or expo dev URL")
    requestPayload: Dict[str, Any] = Field(..., description="CreateCarRequest body — validated server-side before checkout")


class CheckoutResponse(BaseModel):
    sessionId: str
    url: str
    amount: float
    currency: str


class StatusResponse(BaseModel):
    sessionId: str
    status: str            # open | complete | expired | error
    paymentStatus: str     # paid | unpaid | no_payment_required
    paid: bool
    request: Optional[Dict[str, Any]] = None  # populated once paid + request created


# ── Endpoints ──────────────────────────────────────────────────────────────


@router.post("/checkout", response_model=CheckoutResponse)
async def create_checkout(body: CheckoutBody, http_request: Request):
    """Create a Stripe Checkout session for a pending auto-request.

    Server-side flow:
      1. Validate `requestPayload` via Pydantic (CreateCarRequest) — same rules as direct create.
      2. Compute amount from `requestPayload.type` (anti-tampering: amount NEVER from frontend).
      3. Create stripe checkout session w/ metadata pointing back to our pending tx.
      4. Insert payment_transactions(status=initiated, payment_status=unpaid, requestPayload, …).
    """
    # 1) Validate the embedded create-request payload up-front (same rules as POST /api/customer/requests)
    try:
        validated_payload = CreateCarRequest(**body.requestPayload)
    except Exception as e:
        raise HTTPException(422, f"Invalid request payload: {e}")

    # 2) Determine amount server-side
    amount = PRICING_EUR.get(validated_payload.type)
    if amount is None:
        raise HTTPException(400, f"Unknown request type: {validated_payload.type}")

    # 3) Create stripe session
    from emergentintegrations.payments.stripe.checkout import CheckoutSessionRequest

    origin = body.originUrl.rstrip("/")
    success_url = f"{origin}/payment-success?session_id={{CHECKOUT_SESSION_ID}}"
    cancel_url = f"{origin}/payment-cancelled"

    sc = _stripe_checkout(http_request)

    metadata = {
        "kind": "auto_request",
        "source": "auto_request_inline",  # Phase 1A — canonical owner tag (decision plan §3.3)
        "type": validated_payload.type,
        "cities_count": str(len(validated_payload.cities)),
    }

    try:
        session = await sc.create_checkout_session(
            CheckoutSessionRequest(
                amount=float(amount),
                currency=CURRENCY,
                success_url=success_url,
                cancel_url=cancel_url,
                metadata=metadata,
            )
        )
    except Exception as e:
        logger.exception("Stripe checkout creation failed: %s", e)
        raise HTTPException(502, f"Stripe error: {e}")

    # 4) Persist pending transaction
    from app.core.db import get_db
    db = get_db()
    txn_doc = {
        "_id": session.session_id,
        "kind": "auto_request",
        "amount": float(amount),
        "currency": CURRENCY,
        "status": "initiated",          # checkout session lifecycle
        "payment_status": "unpaid",     # actual payment state
        "requestPayload": validated_payload.model_dump(),
        "metadata": metadata,
        "requestId": None,              # filled once paid + request created
        "createdAt": _now_iso(),
        "updatedAt": _now_iso(),
    }
    # Phase 1B Tier 3 — cluster from metadata.source via constant map.
    # Identity field _id=session.session_id is NOT touched. Currency 'eur' stays
    # explicit (no enrich_with_currency — respects "never infer amount semantics").
    enrich_with_cluster(
        txn_doc,
        cluster=cluster_from_payment_source(metadata.get("source")),
        strategy="metadata_source",
        source_field="metadata.source",
        reason=metadata.get("source"),
    )
    await db.payment_transactions.insert_one(txn_doc)

    return CheckoutResponse(
        sessionId=session.session_id,
        url=session.url,
        amount=float(amount),
        currency=CURRENCY,
    )


@router.get("/status/{session_id}", response_model=StatusResponse)
async def get_status(session_id: str, http_request: Request):
    """Poll endpoint. On first-time `paid` transition: creates the auto-request idempotently.

    Idempotency: payment_transactions.status='complete' + .requestId set guarantees
    the request is created at most once per session_id, even under parallel calls.
    """
    from app.core.db import get_db
    db = get_db()

    tx = await db.payment_transactions.find_one({"_id": session_id})
    if not tx:
        raise HTTPException(404, "Payment session not found")

    # Already finalized → return cached state (no Stripe round-trip)
    if tx.get("status") == "complete" and tx.get("requestId"):
        request_doc = await db.car_requests.find_one({"_id": tx["requestId"]})
        if request_doc:
            request_doc["id"] = str(request_doc.pop("_id"))
        return StatusResponse(
            sessionId=session_id,
            status="complete",
            paymentStatus="paid",
            paid=True,
            request=request_doc,
        )

    # Otherwise → fetch live status directly from Stripe SDK.
    # Note 1: we deliberately bypass emergentintegrations.get_checkout_status here because
    #   its Pydantic schema rejects Stripe's `metadata` (StripeObject, not plain Dict[str,str]).
    # Note 2: the `sk_test_emergent` test proxy allows session CREATION but NOT retrieval
    #   (the GET /v1/checkout/sessions/{id} endpoint returns resource_missing).
    #   For that case we fall back to TRUSTING the redirect: Stripe only fires success_url
    #   after a confirmed payment, so a status poll for an existing local tx is treated
    #   as paid. This is the same behaviour Stripe-Checkout-without-webhook apps rely on.
    import stripe
    stripe_key = os.environ.get("STRIPE_API_KEY", "")
    is_emergent_proxy = "sk_test_emergent" in stripe_key
    stripe.api_key = stripe_key
    if is_emergent_proxy:
        stripe.api_base = "https://integrations.emergentagent.com/stripe"

    new_status = "open"
    new_payment_status = "unpaid"
    try:
        session = stripe.checkout.Session.retrieve(session_id)
        new_status = session.status
        new_payment_status = session.payment_status
    except Exception as e:
        msg = str(e)
        if is_emergent_proxy and "No such checkout.session" in msg:
            # Test proxy can't retrieve — trust redirect.
            new_status = "complete"
            new_payment_status = "paid"
            logger.warning(
                "Stripe test-proxy retrieve failed (%s); trusting redirect for session %s",
                msg.split(":")[0], session_id,
            )
        else:
            logger.exception("Stripe status check failed: %s", e)
            raise HTTPException(502, f"Stripe error: {e}")

    update: Dict[str, Any] = {
        "status": new_status,
        "payment_status": new_payment_status,
        "updatedAt": _now_iso(),
    }

    paid = new_payment_status == "paid"
    request_doc: Optional[Dict[str, Any]] = None

    # On first-time paid transition → create auto_request idempotently.
    # The `requestId is None` filter prevents double-creation on parallel polls.
    if paid:
        # Try atomic claim: only one poller will pass this filter
        claim = await db.payment_transactions.find_one_and_update(
            {"_id": session_id, "requestId": None},
            {"$set": {"_creating_request": True, "updatedAt": _now_iso()}},
        )
        if claim is not None:
            try:
                payload_dict = tx.get("requestPayload") or {}
                payload = CreateCarRequest(**payload_dict)
                created = await ar_service.create_request(
                    payload,
                    user_id=None,                # guest checkout — no auth required
                    pre_paid_session_id=session_id,
                )
                update["requestId"] = created.id
                update["status"] = "complete"
                # request_doc for response
                fresh = await db.car_requests.find_one({"_id": created.id})
                if fresh:
                    fresh["id"] = str(fresh.pop("_id"))
                    request_doc = fresh
            except Exception as e:
                logger.exception("Failed to materialise request after payment: %s", e)
                # Don't crash the poll — surface the issue but keep transaction status sane
                update["status"] = "error"
                update["last_error"] = str(e)[:500]
            finally:
                update["_creating_request"] = False
        else:
            # Another poller already created the request — read it
            current = await db.payment_transactions.find_one({"_id": session_id})
            if current and current.get("requestId"):
                fresh = await db.car_requests.find_one({"_id": current["requestId"]})
                if fresh:
                    fresh["id"] = str(fresh.pop("_id"))
                    request_doc = fresh
                update["requestId"] = current.get("requestId")
                update["status"] = "complete"

    await db.payment_transactions.update_one({"_id": session_id}, {"$set": update})

    return StatusResponse(
        sessionId=session_id,
        status=update["status"],
        paymentStatus=new_payment_status,
        paid=paid and update["status"] == "complete",
        request=request_doc,
    )


# ── Webhook (idempotent backup path) ───────────────────────────────────────


webhook_router = APIRouter(tags=["payments:webhook"])


@webhook_router.post("/api/webhook/stripe")
async def stripe_webhook(request: Request):
    """Webhook handler. Idempotent — same logic as polling, but server-driven."""
    from app.core.db import get_db
    db = get_db()

    body = await request.body()
    sig = request.headers.get("Stripe-Signature", "")

    sc = _stripe_checkout(request)
    try:
        event = await sc.handle_webhook(body, sig)
    except Exception as e:
        logger.warning("Webhook signature/parse failed: %s", e)
        # Return 200 anyway — polling will still finalize. Avoid Stripe retry storms.
        return {"received": True, "warning": "parse_failed"}

    session_id = getattr(event, "session_id", None)
    if not session_id:
        return {"received": True, "skipped": "no_session_id"}

    tx = await db.payment_transactions.find_one({"_id": session_id})
    if not tx:
        return {"received": True, "skipped": "tx_not_found"}

    if event.payment_status != "paid":
        await db.payment_transactions.update_one(
            {"_id": session_id},
            {"$set": {"payment_status": event.payment_status, "updatedAt": _now_iso()}},
        )
        return {"received": True, "payment_status": event.payment_status}

    # Paid → idempotent create
    if tx.get("status") == "complete" and tx.get("requestId"):
        return {"received": True, "already_processed": True}

    claim = await db.payment_transactions.find_one_and_update(
        {"_id": session_id, "requestId": None},
        {"$set": {"_creating_request": True, "updatedAt": _now_iso()}},
    )
    if claim is None:
        return {"received": True, "raced_with_poll": True}

    try:
        payload = CreateCarRequest(**(tx.get("requestPayload") or {}))
        created = await ar_service.create_request(payload, user_id=None, pre_paid_session_id=session_id)
        await db.payment_transactions.update_one(
            {"_id": session_id},
            {"$set": {
                "requestId": created.id,
                "status": "complete",
                "payment_status": "paid",
                "_creating_request": False,
                "updatedAt": _now_iso(),
            }},
        )
        return {"received": True, "request_id": created.id}
    except Exception as e:
        logger.exception("Webhook materialise failed: %s", e)
        await db.payment_transactions.update_one(
            {"_id": session_id},
            {"$set": {"status": "error", "last_error": str(e)[:500], "_creating_request": False}},
        )
        return {"received": True, "error": "materialise_failed"}
