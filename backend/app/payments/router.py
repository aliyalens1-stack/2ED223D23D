"""Stage 4 — Payments (Stripe Checkout) + Revenue.

Endpoints:
  POST /api/payments/create-checkout      — create Stripe session + pending tx
  GET  /api/payments/status/{session_id}  — poll session status → finalize booking
  POST /api/webhook/stripe                — Stripe webhook (idempotent)
  GET  /api/admin/revenue/summary         — paid totals (today / month)
  POST /api/payments/{tx_id}/mock-complete — DEV: mark tx paid without Stripe

Collection: `payment_transactions` (mandatory per playbook).

Security:
- Price is ALWAYS computed server-side from SERVICE_FEES + quote.priceFrom.
- Frontend only sends { quoteId, origin }.
- Success/Cancel URLs constructed from `origin` (never hardcoded).
- Polling is idempotent: once payment_status=='paid' booking is created exactly once.
"""
from __future__ import annotations
import logging
import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from emergentintegrations.payments.stripe.checkout import (
    StripeCheckout,
    CheckoutSessionRequest,
)

from app.core.db import db
from app.core.utils import now_utc, uid
from app.marketplace.requests import accept_quote_and_create_booking
from app.admin.stripe_settings import get_active_config
# Phase 1B Tier 3 — pure sync cluster enrichment for payment writer.
from app.core.cluster_writer import enrich_with_cluster, cluster_from_payment_source

router = APIRouter()
logger = logging.getLogger(__name__)


# ── Service fees (platform commission tier, server-side SOURCE OF TRUTH) ───
SERVICE_FEES_MAJOR: dict[str, float] = {
    # inspection cluster — premium fixed
    "pre_purchase": 149.0,
    "diagnostics":  49.0,
    # repair cluster — platform fee on top of quote (we charge €29 booking)
    "oil_change":   29.0,
    "brakes":       29.0,
    "engine":       29.0,
    "battery":      29.0,
    "tires":        29.0,
    "towing":       29.0,
}
DEFAULT_FEE_MAJOR = 29.0


def compute_platform_fee(req: dict, quote: dict) -> float:
    """Server-side fee resolution. Frontend never supplies amount."""
    service_key = req.get("serviceKey")
    fee = SERVICE_FEES_MAJOR.get(service_key, DEFAULT_FEE_MAJOR)
    return float(fee)


# ── Stripe helper factory (now reads admin-managed config from DB) ────────
async def _resolve_stripe() -> dict:
    """Resolve runtime Stripe config (DB → ENV fallback). Raises 500 if no key."""
    cfg = await get_active_config()
    if not cfg.get("secretKey"):
        raise HTTPException(500, "Stripe is not configured. Set the secret key in Master Admin → Stripe Settings.")
    return cfg


def _checkout_with_key(api_key: str, webhook_url: str = "") -> StripeCheckout:
    return StripeCheckout(api_key=api_key, webhook_url=webhook_url)


async def _retrieve_session_async(stripe_sdk, session_id: str) -> dict:
    """Wrap blocking Stripe SDK call in a thread executor.
    Returns plain dict (via `.to_dict_recursive()` / `dict()` fallback)."""
    import asyncio
    loop = asyncio.get_running_loop()
    session = await loop.run_in_executor(
        None, lambda: stripe_sdk.checkout.Session.retrieve(session_id)
    )
    # StripeObject supports dict() access — convert to plain dict
    try:
        return session.to_dict_recursive()
    except Exception:
        return dict(session)


# ── Request models ────────────────────────────────────────────────────────
class CreateCheckoutBody(BaseModel):
    quoteId: str = Field(..., min_length=1)
    origin: str = Field(..., description="Frontend origin for success/cancel URL building")


# ── POST /api/payments/create-checkout ────────────────────────────────────
@router.post("/api/payments/create-checkout")
async def create_checkout(body: CreateCheckoutBody, http_request: Request):
    # 1. Load & validate quote
    quote = await db.request_quotes.find_one({"id": body.quoteId}, {"_id": 0})
    if not quote:
        raise HTTPException(404, "Quote not found")
    if quote.get("status") != "pending":
        raise HTTPException(409, f"Quote is {quote['status']}")

    # expiresAt TTL check
    exp = quote.get("expiresAt")
    if exp and exp < now_utc().isoformat():
        await db.request_quotes.update_one(
            {"id": quote["id"]}, {"$set": {"status": "expired"}}
        )
        raise HTTPException(410, "Quote expired")

    req = await db.customer_requests.find_one({"id": quote["requestId"]}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Request not found")
    if req.get("status") == "booked":
        raise HTTPException(409, "Request already booked")

    # 2. Compute fee server-side
    amount_major = compute_platform_fee(req, quote)

    # 3. Resolve admin-managed Stripe config (DB → ENV fallback)
    cfg = await _resolve_stripe()
    currency = cfg["currency"] or "eur"

    # 4. Build URLs from frontend origin (NEVER hardcoded)
    origin = body.origin.rstrip("/")
    success_url = f"{origin}/booking/payment-success?session_id={{CHECKOUT_SESSION_ID}}"
    cancel_url = f"{origin}/booking/payment-cancel"

    # 5. Create Stripe session via emergentintegrations (with admin-config webhook + key)
    host_url = str(http_request.base_url).rstrip("/")
    webhook_url = f"{host_url}/api/webhook/stripe"
    stripe = _checkout_with_key(cfg["secretKey"], webhook_url=webhook_url)

    metadata = {
        "quoteId": quote["id"],
        "requestId": req["id"],
        "userId": str(req.get("userId") or ""),
        "serviceKey": req.get("serviceKey", ""),
        "source": "stage4_checkout",
    }
    session = await stripe.create_checkout_session(
        CheckoutSessionRequest(
            amount=amount_major,
            currency=currency,
            success_url=success_url,
            cancel_url=cancel_url,
            metadata=metadata,
        )
    )

    # 5b. Apply admin-managed payment_method_types via direct Stripe SDK update.
    # The emergentintegrations wrapper sends a default ['card']; here we override
    # if admin configured additional methods (klarna, paypal, sepa, crypto, …).
    pm_types = cfg.get("paymentMethods") or ["card"]
    # Filter pure-frontend pseudo methods that Stripe Checkout doesn't accept directly
    excluded = {"apple_pay", "google_pay"}  # auto-enabled with 'card'
    pm_types = [m for m in pm_types if m not in excluded] or ["card"]
    if set(pm_types) != {"card"}:
        try:
            import stripe as stripe_sdk
            stripe_sdk.api_key = cfg["secretKey"]
            stripe_sdk.checkout.Session.modify(
                session.session_id,
                payment_method_types=pm_types,
            )
            logger.info(f"[checkout] applied payment_method_types={pm_types} to {session.session_id}")
        except Exception as e:
            # Non-fatal — defaults to card if Stripe rejects (e.g. method not enabled in Dashboard)
            logger.warning(f"[checkout] could not apply pm_types={pm_types}: {e}. Falling back to default.")

    # 5. Create pending transaction (BEFORE redirect)
    tx_id = uid()
    tx = {
        "id": tx_id,
        "sessionId": session.session_id,
        "quoteId": quote["id"],
        "requestId": req["id"],
        # P4.1 — Vehicle linkage. Inherited from the parent quote/request
        # (which got it at request creation). Lets us answer "all payments
        # for this vehicle" without joining through requests.
        "vehicleId": quote.get("vehicleId") or req.get("vehicleId"),
        "userId": req.get("userId"),
        "amount": amount_major,
        "amountCents": int(round(amount_major * 100)),
        "currency": currency.upper(),
        "paymentMethods": pm_types,
        "stripeMode": cfg.get("mode", "test"),
        "status": "initiated",
        "paymentStatus": "unpaid",
        "metadata": metadata,
        "bookingId": None,
        "createdAt": now_utc().isoformat(),
        "paidAt": None,
    }
    # Phase 1B Tier 3 — cluster from metadata.source via constant map.
    # Identity fields (sessionId, id) untouched. Currency 'EUR' stays explicit.
    # No enrich_with_currency — respects "never infer amount semantics".
    enrich_with_cluster(
        tx,
        cluster=cluster_from_payment_source(metadata.get("source")),
        strategy="metadata_source",
        source_field="metadata.source",
        reason=metadata.get("source"),
    )
    await db.payment_transactions.insert_one(dict(tx))
    tx.pop("_id", None)

    logger.info(f"Checkout created: tx={tx_id} session={session.session_id} {amount_major} {currency.upper()}")
    return {
        "paymentId": tx_id,
        "sessionId": session.session_id,
        "checkoutUrl": session.url,
        "amount": amount_major,
        "currency": currency.upper(),
        "status": "initiated",
    }


# ── GET /api/payments/status/{session_id} ─────────────────────────────────
@router.get("/api/payments/status/{session_id}")
async def payment_status(session_id: str, http_request: Request):
    """Poll Stripe for latest status + finalize booking if paid.
    Idempotent: booking created exactly once."""
    tx = await db.payment_transactions.find_one({"sessionId": session_id}, {"_id": 0})
    if not tx:
        raise HTTPException(404, "Payment transaction not found")

    # Already finalized — return cached state
    if tx.get("status") == "paid" and tx.get("bookingId"):
        return {
            "sessionId": session_id,
            "paymentId": tx["id"],
            "status": "paid",
            "paymentStatus": "paid",
            "bookingId": tx["bookingId"],
            "amount": tx["amount"],
            "currency": tx["currency"],
        }
    if tx.get("status") in {"expired", "cancelled", "failed"}:
        return {
            "sessionId": session_id,
            "paymentId": tx["id"],
            "status": tx["status"],
            "paymentStatus": tx.get("paymentStatus", "unpaid"),
            "amount": tx["amount"],
            "currency": tx["currency"],
        }

    # Poll Stripe — use stripe SDK directly (emergentintegrations has a Pydantic
    # parse bug on Session objects, so we go to the SDK for robustness).
    import stripe as stripe_sdk
    cfg = await _resolve_stripe()
    stripe_sdk.api_key = cfg["secretKey"]
    try:
        session = await _retrieve_session_async(stripe_sdk, session_id)
    except Exception as e:
        logger.error(f"[payments] Stripe status fetch failed for {session_id}: {e}")
        raise HTTPException(502, "Failed to fetch payment status")

    payment_status_str = session.get("payment_status")  # 'paid' | 'unpaid' | 'no_payment_required'
    session_status = session.get("status")  # 'open' | 'complete' | 'expired'

    # Idempotent finalization
    if payment_status_str == "paid" and session_status == "complete":
        # Prevent race: find-and-update first
        result = await db.payment_transactions.update_one(
            {"sessionId": session_id, "status": {"$ne": "paid"}},
            {"$set": {
                "status": "paid",
                "paymentStatus": "paid",
                "paidAt": now_utc().isoformat(),
            }},
        )
        # Only one caller will have modified_count=1 and creates the booking
        if result.modified_count == 1:
            booking = await accept_quote_and_create_booking(
                tx["quoteId"], user_id=tx.get("userId")
            )
            await db.payment_transactions.update_one(
                {"sessionId": session_id},
                {"$set": {"bookingId": booking["id"]}},
            )
            logger.info(f"Payment {tx['id']} paid → booking {booking['id']}")
        # Reload tx for response
        tx = await db.payment_transactions.find_one({"sessionId": session_id}, {"_id": 0})
        return {
            "sessionId": session_id,
            "paymentId": tx["id"],
            "status": "paid",
            "paymentStatus": "paid",
            "bookingId": tx.get("bookingId"),
            "amount": tx["amount"],
            "currency": tx["currency"],
        }

    if session_status == "expired":
        await db.payment_transactions.update_one(
            {"sessionId": session_id, "status": {"$ne": "paid"}},
            {"$set": {"status": "expired", "paymentStatus": "unpaid"}},
        )
        return {
            "sessionId": session_id,
            "paymentId": tx["id"],
            "status": "expired",
            "paymentStatus": "unpaid",
            "amount": tx["amount"],
            "currency": tx["currency"],
        }

    # Still open / pending
    return {
        "sessionId": session_id,
        "paymentId": tx["id"],
        "status": "pending",
        "paymentStatus": payment_status_str,
        "amount": tx["amount"],
        "currency": tx["currency"],
    }


# ── POST /api/webhook/stripe ──────────────────────────────────────────────
@router.post("/api/webhook/stripe")
async def stripe_webhook(request: Request):
    body = await request.body()
    sig = request.headers.get("Stripe-Signature", "")

    cfg = await _resolve_stripe()
    host_url = str(request.base_url).rstrip("/")
    stripe = _checkout_with_key(cfg["secretKey"], webhook_url=f"{host_url}/api/webhook/stripe")
    try:
        event = await stripe.handle_webhook(body, sig)
    except Exception as e:
        logger.error(f"[webhook] Invalid signature or payload: {e}")
        raise HTTPException(400, "Invalid webhook")

    session_id = event.session_id
    if not session_id:
        return {"ok": True, "ignored": event.event_type}

    tx = await db.payment_transactions.find_one({"sessionId": session_id}, {"_id": 0})
    if not tx:
        return {"ok": True, "unknown_session": True}

    if event.payment_status == "paid" and tx.get("status") != "paid":
        result = await db.payment_transactions.update_one(
            {"sessionId": session_id, "status": {"$ne": "paid"}},
            {"$set": {
                "status": "paid",
                "paymentStatus": "paid",
                "paidAt": now_utc().isoformat(),
            }},
        )
        if result.modified_count == 1:
            booking = await accept_quote_and_create_booking(
                tx["quoteId"], user_id=tx.get("userId")
            )
            await db.payment_transactions.update_one(
                {"sessionId": session_id},
                {"$set": {"bookingId": booking["id"]}},
            )
            logger.info(f"[webhook] Payment {tx['id']} paid → booking {booking['id']}")

    return {"ok": True, "event_type": event.event_type}


# ── DEV: POST /api/payments/{id}/mock-complete ────────────────────────────
# Used by testing agent / preview environments to bypass real Stripe UI.
# R3: hardened dev-guard — defaults to BLOCKED in production unless explicit
# PAYMENTS_ALLOW_MOCK=1 override. ENV must be one of dev/staging to allow.
@router.post("/api/payments/{tx_id}/mock-complete")
async def mock_complete(tx_id: str):
    env = os.getenv("ENV", "dev").lower()
    allow_mock = env != "production" or os.getenv("PAYMENTS_ALLOW_MOCK") == "1"
    if not allow_mock:
        raise HTTPException(
            403,
            "mock-complete disabled in production — use real Stripe checkout",
        )
    tx = await db.payment_transactions.find_one({"id": tx_id}, {"_id": 0})
    if not tx:
        raise HTTPException(404, "Transaction not found")
    if tx.get("status") == "paid":
        return {"status": "paid", "bookingId": tx.get("bookingId"), "idempotent": True}

    result = await db.payment_transactions.update_one(
        {"id": tx_id, "status": {"$ne": "paid"}},
        {"$set": {
            "status": "paid",
            "paymentStatus": "paid",
            "paidAt": now_utc().isoformat(),
        }},
    )
    if result.modified_count != 1:
        tx = await db.payment_transactions.find_one({"id": tx_id}, {"_id": 0})
        return {"status": tx["status"], "bookingId": tx.get("bookingId")}

    booking = await accept_quote_and_create_booking(tx["quoteId"], user_id=tx.get("userId"))
    await db.payment_transactions.update_one(
        {"id": tx_id}, {"$set": {"bookingId": booking["id"]}}
    )
    logger.info(f"[MOCK] Payment {tx_id} completed → booking {booking['id']}")
    return {"status": "paid", "bookingId": booking["id"], "mock": True}


# ── /api/admin/revenue/summary lives in app.revenue.router (Sprint 28).
# This module previously declared a 6-field stub here; it shadowed the
# richer breakdown handler because payments_router is registered first.
# D4: removed to give the Sprint-28 endpoint priority. New code MUST hit
# `app.revenue.router` for revenue aggregations.
