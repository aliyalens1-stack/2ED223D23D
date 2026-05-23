"""app.integrations.router_stripe — public Stripe surface (credentials-backed).

Endpoints:
  GET  /api/payments/stripe/config         — publishable key for clients
  POST /api/payments/stripe/payment-intent — create PaymentIntent for a booking
  POST /api/payments/stripe/refund         — admin-only refund (uses verify_admin_token)
  POST /api/webhooks/stripe                — Stripe → backend webhook (raw body, signed)
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.db import db
from app.core.security import verify_admin_token

from . import stripe_service

logger = logging.getLogger(__name__)

router_payments = APIRouter(prefix="/api/payments/stripe", tags=["payments-stripe"])
router_webhook = APIRouter(prefix="/api/webhooks", tags=["webhooks"])


# ─────────────────────────────────────────────────────────────────────
# Public: publishable key for clients
# ─────────────────────────────────────────────────────────────────────

@router_payments.get("/config")
async def get_config():
    """Returns publishable key + enabled flag for clients."""
    pk = await stripe_service.get_publishable_key(db)
    return {
        "enabled": pk is not None,
        "publishable_key": pk,
    }


# ─────────────────────────────────────────────────────────────────────
# Public: PaymentIntent creation
# ─────────────────────────────────────────────────────────────────────

class PaymentIntentRequest(BaseModel):
    amount_eur: float = Field(..., gt=0, le=10000)
    currency: str = Field(default="eur")
    booking_id: str | None = None
    user_id: str | None = None
    customer_email: str | None = None


@router_payments.post("/payment-intent")
async def create_payment_intent(body: PaymentIntentRequest):
    """Create a PaymentIntent. Returns client_secret for client confirmation."""
    try:
        amount_cents = int(round(body.amount_eur * 100))
        result = await stripe_service.create_payment_intent(
            db,
            amount_cents=amount_cents,
            currency=body.currency,
            booking_id=body.booking_id,
            user_id=body.user_id,
            customer_email=body.customer_email,
        )
        # Persist a payment record (for reconciliation + refund traceability).
        await db["stripe_payments"].insert_one({
            "payment_intent_id": result["payment_intent_id"],
            "booking_id": body.booking_id,
            "user_id": body.user_id,
            "amount_cents": amount_cents,
            "currency": body.currency,
            "status": result["status"],
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        return result
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except stripe.StripeError as e:
        raise HTTPException(status_code=502, detail=str(e))


# ─────────────────────────────────────────────────────────────────────
# Admin: refund
# ─────────────────────────────────────────────────────────────────────

class RefundRequest(BaseModel):
    payment_intent_id: str
    amount_eur: float | None = None
    booking_id: str | None = None


@router_payments.post("/refund", dependencies=[Depends(verify_admin_token)])
async def create_refund(body: RefundRequest):
    try:
        amount_cents = int(round(body.amount_eur * 100)) if body.amount_eur is not None else None
        result = await stripe_service.create_refund(
            db,
            payment_intent_id=body.payment_intent_id,
            amount_cents=amount_cents,
            booking_id=body.booking_id,
        )
        await db["stripe_refunds"].insert_one({
            **result,
            "payment_intent_id": body.payment_intent_id,
            "booking_id": body.booking_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        return result
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except stripe.StripeError as e:
        raise HTTPException(status_code=502, detail=str(e))


# ─────────────────────────────────────────────────────────────────────
# Webhook
# ─────────────────────────────────────────────────────────────────────

@router_webhook.post("/stripe")
async def stripe_webhook(request: Request):
    """Stripe webhook receiver. Verifies signature, dispatches event types."""
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")
    if not sig_header:
        raise HTTPException(status_code=400, detail="missing stripe-signature header")
    try:
        event = await stripe_service.verify_webhook(db, payload=payload, sig_header=sig_header)
    except RuntimeError as e:
        # Stripe not enabled / not configured → 503 (Stripe will retry).
        raise HTTPException(status_code=503, detail=str(e))
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid payload")
    except stripe.error.SignatureVerificationError:
        raise HTTPException(status_code=400, detail="invalid signature")

    event_type = event.get("type")
    obj = event.get("data", {}).get("object", {})

    # Persist raw event for audit trail.
    await db["stripe_webhook_events"].insert_one({
        "event_id": event.get("id"),
        "type": event_type,
        "received_at": datetime.now(timezone.utc).isoformat(),
        "object_id": obj.get("id"),
    })

    if event_type == "payment_intent.succeeded":
        pi_id = obj.get("id")
        booking_id = (obj.get("metadata") or {}).get("booking_id")
        await db["stripe_payments"].update_one(
            {"payment_intent_id": pi_id},
            {"$set": {"status": "succeeded", "succeeded_at": datetime.now(timezone.utc).isoformat()}},
        )
        if booking_id:
            await db["bookings"].update_one(
                {"id": booking_id},
                {"$set": {"payment_status": "paid"}},
            )
    elif event_type == "payment_intent.payment_failed":
        pi_id = obj.get("id")
        last_err = obj.get("last_payment_error") or {}
        await db["stripe_payments"].update_one(
            {"payment_intent_id": pi_id},
            {"$set": {
                "status": "failed",
                "failure_code": last_err.get("code"),
                "failure_message": last_err.get("message"),
            }},
        )
    elif event_type in ("refund.succeeded", "charge.refunded"):
        # Idempotent best-effort.
        pi_id = obj.get("payment_intent") or obj.get("id")
        if pi_id:
            await db["stripe_payments"].update_one(
                {"payment_intent_id": pi_id},
                {"$set": {"refund_status": "succeeded"}},
            )

    return {"received": True}
