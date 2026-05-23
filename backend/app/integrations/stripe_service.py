"""app.integrations.stripe_service — credentials-aware Stripe operations.

ALL Stripe ops in the new path go through this service. Keys are
loaded from `integration_credentials` (NOT .env). Hot-reload happens
when admin upserts credentials (cache invalidation in credentials_service).

Public functions:
  • get_publishable_key(db)
  • create_payment_intent(db, *, amount_cents, currency, booking_id, user_id, customer_email)
  • create_refund(db, *, payment_intent_id, amount_cents, booking_id)
  • verify_webhook(db, *, payload, sig_header)
  • test_connection(db)
"""
from __future__ import annotations

import logging
from typing import Optional

import stripe

from . import credentials_service

logger = logging.getLogger(__name__)

_PROVIDER = "stripe"


# ─────────────────────────────────────────────────────────────────────
# Credential loader
# ─────────────────────────────────────────────────────────────────────

async def _load_secret_key(db) -> str:
    rec = await credentials_service.get(_PROVIDER, db=db)
    if not rec:
        raise RuntimeError("Stripe credentials not configured")
    if not rec.get("enabled"):
        raise RuntimeError("Stripe is disabled in admin settings")
    payload = rec.get("payload", {})
    key = payload.get("secret_key") or payload.get("restricted_key")
    if not key:
        raise RuntimeError("Stripe secret_key (or restricted_key) is missing")
    return key


async def get_publishable_key(db) -> Optional[str]:
    rec = await credentials_service.get(_PROVIDER, db=db)
    if not rec or not rec.get("enabled"):
        return None
    return rec.get("payload", {}).get("publishable_key")


async def _load_webhook_secret(db) -> str:
    rec = await credentials_service.get(_PROVIDER, db=db)
    if not rec or not rec.get("enabled"):
        raise RuntimeError("Stripe not enabled")
    secret = rec.get("payload", {}).get("webhook_secret")
    if not secret:
        raise RuntimeError("Stripe webhook_secret not configured")
    return secret


# ─────────────────────────────────────────────────────────────────────
# Operations (each call re-applies api_key from the latest credentials)
# ─────────────────────────────────────────────────────────────────────

async def create_payment_intent(
    db,
    *,
    amount_cents: int,
    currency: str = "eur",
    booking_id: Optional[str] = None,
    user_id: Optional[str] = None,
    customer_email: Optional[str] = None,
) -> dict:
    """Create a PaymentIntent. Returns minimal client payload."""
    stripe.api_key = await _load_secret_key(db)

    metadata = {}
    if booking_id:
        metadata["booking_id"] = booking_id
    if user_id:
        metadata["user_id"] = user_id

    kwargs = {
        "amount": int(amount_cents),
        "currency": currency,
        "automatic_payment_methods": {"enabled": True},
        "metadata": metadata,
    }
    if customer_email:
        kwargs["receipt_email"] = customer_email

    intent = stripe.PaymentIntent.create(**kwargs)
    return {
        "payment_intent_id": intent.id,
        "client_secret": intent.client_secret,
        "status": intent.status,
        "amount": intent.amount,
        "currency": intent.currency,
    }


async def create_refund(
    db,
    *,
    payment_intent_id: str,
    amount_cents: Optional[int] = None,
    booking_id: Optional[str] = None,
) -> dict:
    stripe.api_key = await _load_secret_key(db)
    kwargs = {"payment_intent": payment_intent_id}
    if amount_cents is not None:
        kwargs["amount"] = int(amount_cents)
    if booking_id:
        kwargs["metadata"] = {"booking_id": booking_id}
    refund = stripe.Refund.create(**kwargs)
    return {
        "refund_id": refund.id,
        "status": refund.status,
        "amount": refund.amount,
        "currency": refund.currency,
    }


async def verify_webhook(db, *, payload: bytes, sig_header: str) -> dict:
    """Verify Stripe webhook signature and return the parsed event."""
    secret = await _load_webhook_secret(db)
    # NOTE: construct_event uses the secret directly; no global stripe.api_key needed.
    event = stripe.Webhook.construct_event(
        payload=payload,
        sig_header=sig_header,
        secret=secret,
    )
    return event


async def test_connection(db) -> dict:
    """Minimal liveness probe — fetches balance (cheap, well-scoped)."""
    try:
        stripe.api_key = await _load_secret_key(db)
    except RuntimeError as e:
        return {"ok": False, "stage": "credentials", "error": str(e)}
    try:
        bal = stripe.Balance.retrieve()
        bal_dict = bal.to_dict() if hasattr(bal, "to_dict") else dict(bal)
        return {
            "ok": True,
            "stage": "live_api",
            "livemode": bool(bal_dict.get("livemode", False)),
            "available_currencies": sorted({b["currency"] for b in bal_dict.get("available", [])}),
        }
    except stripe.StripeError as e:
        return {"ok": False, "stage": "live_api", "error": str(e)}


__all__ = [
    "get_publishable_key",
    "create_payment_intent",
    "create_refund",
    "verify_webhook",
    "test_connection",
]
