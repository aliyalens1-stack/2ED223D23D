"""Payments-1 — snapshot-bound checkout.

THE invariant of this module:
  Checkout reads `car_requests.pricing` snapshot ONLY.
  It NEVER recomputes price from distance / tiers / rates.
  It NEVER imports `app.pricing.projection`.

This module's only contracts with the pricing layer are:
  • Mongo collection `car_requests` — read `.pricing` field.
  • Mongo collection `inspection_pricing_projection` — implicit existence
    check (we don't read the docs themselves, only require the snapshot
    has populated `confirmedAt`).

If the snapshot is missing or unconfirmed, the endpoint refuses to
create a payment intent. That is the anti-drift wall between
"customer agreed to a price" and "we charge their card".

Endpoints (mounted at /api/payments/snapshot):

  POST /api/payments/snapshot/checkout/{request_id}
       body: { originUrl, method? }     # method: "stripe" (default) | "mock"
       → 409 if pricing snapshot is missing / unconfirmed
       → 200 { sessionId, url, amount, currency, pricingSnapshot }
       → creates `payment_transactions` doc with the full snapshot copy

  GET  /api/payments/snapshot/transaction/{session_id}
       → status of the payment_transactions doc (paid / unpaid / failed)
       → identical shape regardless of provider

  POST /api/payments/snapshot/checkout/{request_id}/dev-mark-paid   (DEV ONLY)
       → flips the most recent unpaid tx to paid. Guarded by ENV.
       → Used by Pricing-1/2/3 tests, NOT a customer surface.

When Stripe keys are absent the endpoint can still operate in "mock"
mode (status=503 by default, opt-in via body.method="mock"). Mock mode
exists ONLY to keep the rest of the checkout flow exercisable in dev /
QA without provisioning Stripe — production must always use Stripe.
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.db import get_db
from app.core.identity_runtime import IdentityContext, require_account_kind

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/payments/snapshot", tags=["payments:snapshot"])

_customer_required = require_account_kind("customer")
CURRENCY = "eur"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Schemas ──────────────────────────────────────────────────────────
class CheckoutBody(BaseModel):
    originUrl: str = Field(..., description="Frontend origin for Stripe success/cancel redirects")
    method: str = Field(default="stripe", description='"stripe" | "mock". Mock is dev-only.')


class CheckoutResponse(BaseModel):
    sessionId: str
    url: str
    amount: float
    currency: str
    pricingSnapshot: Dict[str, Any]
    provider: str  # "stripe" | "mock"


class TxStatusResponse(BaseModel):
    sessionId: str
    requestId: str
    amount: float
    currency: str
    status: str              # initiated | paid | failed | expired
    paymentStatus: str       # paid | unpaid | no_payment_required
    paid: bool
    pricingSnapshot: Optional[Dict[str, Any]] = None
    createdAt: str
    paidAt: Optional[str] = None


# ── Helpers ──────────────────────────────────────────────────────────
async def _load_confirmed_snapshot(db, request_id: str, user_id: str) -> Dict[str, Any]:
    """Load `car_requests.pricing` for `request_id`. Strict gate:

      • Request must exist and belong to the caller.
      • `pricing` must be present.
      • `pricing.confirmedAt` must be a non-empty string.

    Anything else → HTTPException with a precise machine-readable detail.
    """
    req = await db.car_requests.find_one(
        {"_id": request_id},
        {"_id": 1, "userId": 1, "pricing": 1, "type": 1},
    )
    if not req:
        raise HTTPException(404, "Request not found")
    if req.get("userId") and req["userId"] != user_id:
        raise HTTPException(403, "Not your request")

    snap: Optional[Dict[str, Any]] = req.get("pricing")
    if not snap or not isinstance(snap, dict):
        raise HTTPException(
            409,
            {
                "code": "PRICING_SNAPSHOT_MISSING",
                "message": "No pricing snapshot. Call POST /api/customer/requests/{id}/quote then /quote/confirm first.",
            },
        )
    if not snap.get("confirmedAt"):
        raise HTTPException(
            409,
            {
                "code": "PRICING_SNAPSHOT_UNCONFIRMED",
                "message": "Pricing exists but is not confirmed yet. Customer must accept the quote first.",
            },
        )

    total = snap.get("customerTotal")
    if not isinstance(total, (int, float)) or total <= 0:
        # Bug-fence: confirmed snapshots MUST carry a positive total.
        raise HTTPException(500, "Confirmed snapshot has invalid customerTotal")

    return snap


def _make_session_id() -> str:
    return f"snap_{uuid.uuid4().hex}"


# ── Endpoints ────────────────────────────────────────────────────────
@router.post("/checkout/{request_id}", response_model=CheckoutResponse)
async def create_snapshot_checkout(
    request_id: str,
    body: CheckoutBody,
    http_request: Request,
    ctx_: IdentityContext = Depends(_customer_required),  # noqa: B008
):
    """Create a payment session bound to a CONFIRMED pricing snapshot.

    `amount` comes EXCLUSIVELY from `car_requests.pricing.customerTotal`.
    Frontend cannot influence the charged amount — there is no `amount`
    field in the body. This is the central anti-tampering wall.
    """
    db = get_db()
    snap = await _load_confirmed_snapshot(db, request_id, ctx_.user_id)
    amount = float(snap["customerTotal"])

    session_id = _make_session_id()
    provider: str
    redirect_url: str

    if body.method == "mock" or os.environ.get("PAYMENTS_FORCE_MOCK") == "1":
        # Dev / QA path. Returns a deterministic URL we can navigate to in
        # tests without provisioning Stripe. Production MUST NOT hit this.
        provider = "mock"
        redirect_url = (
            f"{body.originUrl.rstrip('/')}/payment-success"
            f"?session_id={session_id}&mock=1"
        )
    else:
        api_key = os.environ.get("STRIPE_API_KEY")
        if not api_key:
            raise HTTPException(
                503,
                {
                    "code": "STRIPE_NOT_CONFIGURED",
                    "message": "STRIPE_API_KEY is not set. Set it or call with method='mock' for dev.",
                },
            )
        try:
            from emergentintegrations.payments.stripe.checkout import (  # type: ignore
                StripeCheckout, CheckoutSessionRequest,
            )
        except Exception:
            raise HTTPException(503, "emergentintegrations stripe SDK not installed")

        host_url = str(http_request.base_url).rstrip("/")
        webhook_url = f"{host_url}/api/webhook/stripe"
        sc = StripeCheckout(api_key=api_key, webhook_url=webhook_url)
        success_url = f"{body.originUrl.rstrip('/')}/payment-success?session_id={{CHECKOUT_SESSION_ID}}"
        cancel_url = f"{body.originUrl.rstrip('/')}/payment-cancelled"
        req_obj = CheckoutSessionRequest(
            amount=amount,
            currency=CURRENCY,
            success_url=success_url,
            cancel_url=cancel_url,
            metadata={
                "requestId": request_id,
                "pricingVersion": snap.get("pricingVersion", "v1"),
                "pricingDigest": snap.get("digest", ""),
                "internalSessionId": session_id,
            },
        )
        session = await sc.create_checkout_session(req_obj)
        # Override our placeholder session_id with Stripe's (so polling
        # works against either id).
        session_id = session.session_id
        provider = "stripe"
        redirect_url = session.url

    # Persist the transaction WITH the full snapshot copy. From here on
    # the request can be deleted/archived and the payment stays
    # self-contained. This is the Payments-1 "self-contained payment"
    # invariant.
    tx_doc = {
        "_id": session_id,
        "sessionId": session_id,
        "provider": provider,
        "requestId": request_id,
        "userId": ctx_.user_id,
        "amount": amount,
        "currency": CURRENCY,
        "status": "initiated",
        "paymentStatus": "unpaid",
        # Snapshot copy — verbatim. Decisions downstream (refunds,
        # disputes, audit) read THIS, not the request doc.
        "pricingSnapshot": snap,
        "createdAt": _now_iso(),
        "paidAt": None,
    }
    await db.payment_transactions.insert_one(tx_doc)

    return CheckoutResponse(
        sessionId=session_id,
        url=redirect_url,
        amount=amount,
        currency=CURRENCY,
        pricingSnapshot=snap,
        provider=provider,
    )


@router.get("/transaction/{session_id}", response_model=TxStatusResponse)
async def get_snapshot_transaction(
    session_id: str,
    ctx_: IdentityContext = Depends(_customer_required),  # noqa: B008
):
    """Status of a snapshot-bound payment transaction."""
    db = get_db()
    tx = await db.payment_transactions.find_one({"_id": session_id})
    if not tx:
        raise HTTPException(404, "Transaction not found")
    if tx.get("userId") and tx["userId"] != ctx_.user_id:
        raise HTTPException(403, "Not your transaction")

    return TxStatusResponse(
        sessionId=tx["sessionId"],
        requestId=tx["requestId"],
        amount=tx["amount"],
        currency=tx["currency"],
        status=tx.get("status", "initiated"),
        paymentStatus=tx.get("paymentStatus", "unpaid"),
        paid=tx.get("paymentStatus") == "paid",
        pricingSnapshot=tx.get("pricingSnapshot"),
        createdAt=tx.get("createdAt", _now_iso()),
        paidAt=tx.get("paidAt"),
    )


@router.post("/transaction/{session_id}/dev-mark-paid")
async def dev_mark_paid(
    session_id: str,
    ctx_: IdentityContext = Depends(_customer_required),  # noqa: B008
):
    """DEV-ONLY: flip a transaction to paid. Guarded by env flag so it
    can never accidentally ship to prod."""
    if os.environ.get("PAYMENTS_DEV_FAKE_PAID") != "1":
        raise HTTPException(403, "dev-mark-paid is disabled (set PAYMENTS_DEV_FAKE_PAID=1)")
    db = get_db()
    tx = await db.payment_transactions.find_one({"_id": session_id})
    if not tx:
        raise HTTPException(404, "Transaction not found")
    if tx.get("userId") and tx["userId"] != ctx_.user_id:
        raise HTTPException(403, "Not your transaction")
    if tx.get("paymentStatus") == "paid":
        return {"sessionId": session_id, "alreadyPaid": True}
    await db.payment_transactions.update_one(
        {"_id": session_id},
        {"$set": {"status": "paid", "paymentStatus": "paid", "paidAt": _now_iso()}},
    )
    return {"sessionId": session_id, "alreadyPaid": False, "paid": True}


__all__ = ["router"]
