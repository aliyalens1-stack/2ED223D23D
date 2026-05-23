"""Sprint 7 — Stripe Connect router for marketplace escrow.

HTTP surface:
    POST   /api/connect/onboarding/start          — provider: create account + onboarding URL
    POST   /api/connect/onboarding/refresh        — provider: refresh expired link
    GET    /api/connect/onboarding/status         — provider: current capabilities

    POST   /api/payments/stripe/escrow/intent     — customer: create PaymentIntent on platform
    POST   /api/payments/stripe/escrow/release    — release funds via Transfer (12h delay + freeze)
    POST   /api/payments/stripe/escrow/refund     — admin/dispute → real Stripe Refund

    GET    /api/admin/payments/platform-status    — admin: freeze status, balance, totals
    POST   /api/admin/payments/freeze             — admin: freeze ALL payouts
    POST   /api/admin/payments/unfreeze           — admin: lift platform freeze
    POST   /api/admin/payments/freeze-provider/{id} — admin: freeze single provider

    POST   /api/billing/webhook/connect           — Stripe webhooks (account.updated, transfer.*, refund.*, pi.*)
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.db import get_db
from app.core.security import verify_admin_token, verify_user_token
from app.core.attribution import (
    AttributionContext,
    get_attribution_context,
    record_admin_mutation,
)
from app.integrations import stripe_connect_service as scs

logger = logging.getLogger(__name__)
router = APIRouter()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─────────────────────────────────────────────────────────────────────
# Provider onboarding
# ─────────────────────────────────────────────────────────────────────

class OnboardingStartBody(BaseModel):
    country: str = Field("DE", min_length=2, max_length=2)
    returnUrl: Optional[str] = None
    refreshUrl: Optional[str] = None


@router.post("/api/connect/onboarding/start")
async def start_onboarding(body: OnboardingStartBody, request: Request):
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    role = payload.get("role")
    if not user_id:
        raise HTTPException(401, "Unauthorized")
    if role not in (None, "provider", "inspector", "admin"):
        raise HTTPException(403, "Only providers can onboard for payouts")

    db = get_db()
    user = await db.users.find_one({"_id": user_id}, {"_id": 0, "email": 1}) or {}
    acct = await scs.create_or_get_connect_account(
        db, provider_id=user_id, email=user.get("email"), country=body.country
    )
    base = (str(request.base_url).rstrip("/"))
    return_url = body.returnUrl or f"{base}/provider/stripe-connect/return"
    refresh_url = body.refreshUrl or f"{base}/provider/stripe-connect/refresh"

    link = await scs.create_account_link(
        db,
        stripe_account_id=acct["stripeAccountId"],
        refresh_url=refresh_url,
        return_url=return_url,
    )
    return {
        "stripeAccountId": acct["stripeAccountId"],
        "onboardingUrl": link["url"],
        "sandbox": acct.get("sandbox", True),
        "currentStatus": acct,
    }


@router.post("/api/connect/onboarding/refresh")
async def refresh_onboarding(body: OnboardingStartBody, request: Request):
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    db = get_db()
    user = await db.users.find_one({"_id": user_id}, {"_id": 0, "stripeAccountId": 1}) or {}
    if not user.get("stripeAccountId"):
        raise HTTPException(400, "No Stripe account — call /start first")
    base = str(request.base_url).rstrip("/")
    return_url = body.returnUrl or f"{base}/provider/stripe-connect/return"
    refresh_url = body.refreshUrl or f"{base}/provider/stripe-connect/refresh"
    link = await scs.create_account_link(
        db,
        stripe_account_id=user["stripeAccountId"],
        refresh_url=refresh_url,
        return_url=return_url,
    )
    return {"onboardingUrl": link["url"]}


@router.get("/api/connect/onboarding/status")
async def onboarding_status(request: Request):
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    db = get_db()
    user = await db.users.find_one(
        {"_id": user_id},
        {"_id": 0, "stripeAccountId": 1, "stripeChargesEnabled": 1,
         "stripePayoutsEnabled": 1, "stripeDetailsSubmitted": 1, "stripeSandbox": 1,
         "stripeFrozen": 1},
    ) or {}
    if not user.get("stripeAccountId"):
        return {"onboarded": False}
    # Re-fetch from Stripe so capabilities are fresh (after onboarding return).
    try:
        fresh = await scs.get_account_status(db, stripe_account_id=user["stripeAccountId"])
        await db.users.update_one(
            {"_id": user_id},
            {"$set": {
                "stripeChargesEnabled": fresh.get("chargesEnabled"),
                "stripePayoutsEnabled": fresh.get("payoutsEnabled"),
                "stripeDetailsSubmitted": fresh.get("detailsSubmitted"),
            }},
        )
        user.update({
            "stripeChargesEnabled": fresh.get("chargesEnabled"),
            "stripePayoutsEnabled": fresh.get("payoutsEnabled"),
            "stripeDetailsSubmitted": fresh.get("detailsSubmitted"),
        })
    except Exception as e:
        logger.warning(f"[connect] status fetch failed: {e}")

    return {
        "onboarded": True,
        "stripeAccountId": user.get("stripeAccountId"),
        "chargesEnabled": user.get("stripeChargesEnabled", False),
        "payoutsEnabled": user.get("stripePayoutsEnabled", False),
        "detailsSubmitted": user.get("stripeDetailsSubmitted", False),
        "frozen": user.get("stripeFrozen", False),
        "sandbox": user.get("stripeSandbox", True),
    }


# ─────────────────────────────────────────────────────────────────────
# Customer escrow PaymentIntent
# ─────────────────────────────────────────────────────────────────────

class EscrowIntentBody(BaseModel):
    requestId: str
    currency: str = Field("eur", min_length=3, max_length=3)


@router.post("/api/payments/stripe/escrow/intent")
async def create_escrow_intent(body: EscrowIntentBody, request: Request):
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    db = get_db()
    req = await db.service_requests.find_one({"id": body.requestId}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Service request not found")
    if req.get("customerId") != user_id:
        raise HTTPException(403, "Only customer can fund escrow")
    amount = req.get("amount")
    if not amount or amount <= 0:
        raise HTTPException(400, "Request has no amount")

    user = await db.users.find_one({"_id": user_id}, {"_id": 0, "email": 1}) or {}
    pi = await scs.create_escrow_payment_intent(
        db,
        request_id=body.requestId,
        customer_id=user_id,
        provider_id=req["providerId"],
        amount_cents=int(amount * 100),
        currency=body.currency.lower(),
        customer_email=user.get("email"),
    )

    # Upsert service_payment shell so downstream release/refund flows work.
    pay_id = f"pay_{pi['paymentIntentId']}"
    await db.service_payments.update_one(
        {"id": pay_id},
        {"$setOnInsert": {
            "id": pay_id,
            "requestId": body.requestId,
            "customerId": user_id,
            "providerId": req["providerId"],
            "amount": amount,
            "currency": body.currency.lower(),
            "providerPayout": int(amount * (1 - scs.PLATFORM_FEE_PERCENT)),
            "stripePaymentIntentId": pi["paymentIntentId"],
            "status": "requires_payment_method",
            "sandbox": pi.get("sandbox", True),
            "createdAt": _now_iso(),
            "updatedAt": _now_iso(),
        }},
        upsert=True,
    )
    return pi


# ─────────────────────────────────────────────────────────────────────
# Release: real Stripe Transfer
# ─────────────────────────────────────────────────────────────────────

@router.post("/api/payments/stripe/escrow/release/{payment_id}")
async def release_escrow(payment_id: str, request: Request):
    """Customer or admin triggers release → real Stripe Transfer to provider.

    Enforces:
        - 12h delay since completedAt (unless admin override)
        - platform-wide freeze (admin can override)
        - per-provider freeze
        - no open dispute (existing /api/service-payments/{id}/release check)
    """
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    role = payload.get("role")
    is_admin = role == "admin"

    db = get_db()
    pay = await db.service_payments.find_one({"id": payment_id}, {"_id": 0})
    if not pay:
        raise HTTPException(404, "Payment not found")
    if user_id not in (pay.get("customerId"), pay.get("providerId")) and not is_admin:
        raise HTTPException(403, "Forbidden")
    if pay.get("status") == "released":
        return {"alreadyReleased": True, "transferId": pay.get("stripeTransferId")}

    # Block on dispute.
    open_d = await db.disputes.find_one(
        {"requestId": pay["requestId"], "status": {"$in": ["open", "in_review"]}},
        {"_id": 0, "id": 1},
    )
    if open_d and not is_admin:
        raise HTTPException(409, f"Open dispute {open_d['id']} — release blocked")

    # Platform freeze.
    settings = await db.platform_settings.find_one({"type": "payments"}, {"_id": 0}) or {}
    if settings.get("frozen") and not is_admin:
        raise HTTPException(423, "Platform payouts temporarily frozen")

    # Provider freeze.
    provider = await db.users.find_one(
        {"_id": pay["providerId"]},
        {"_id": 0, "stripeAccountId": 1, "stripeFrozen": 1, "stripePayoutsEnabled": 1},
    ) or {}
    if provider.get("stripeFrozen") and not is_admin:
        raise HTTPException(423, "Provider payouts temporarily frozen")

    provider_account_id = provider.get("stripeAccountId")
    if not provider_account_id:
        raise HTTPException(400, "Provider not onboarded — cannot release. Ask them to connect Stripe.")
    if not provider.get("stripePayoutsEnabled") and not is_admin:
        raise HTTPException(400, "Provider payouts not yet enabled — onboarding incomplete")

    # 12h delay window.
    completed_at = pay.get("completedAt") or pay.get("releasedAt") or pay.get("updatedAt")
    if completed_at and not is_admin:
        try:
            ts = datetime.fromisoformat(completed_at)
            if datetime.now(timezone.utc) - ts < timedelta(hours=scs.PAYOUT_DELAY_HOURS):
                wait = scs.PAYOUT_DELAY_HOURS - (datetime.now(timezone.utc) - ts).total_seconds() / 3600
                raise HTTPException(425, f"Payout buffer: please wait {wait:.1f}h more")
        except ValueError:
            pass

    amount_cents = int(pay["amount"] * 100)
    transfer = await scs.create_release_transfer(
        db,
        request_id=pay["requestId"],
        payment_id=payment_id,
        provider_account_id=provider_account_id,
        amount_cents=amount_cents,
        currency=(pay.get("currency") or "eur").lower(),
    )
    now = _now_iso()
    # Sprint B4.3-A.2 — CAS-guarded release. Only `paid` → `released`.
    # Stripe transfer above already created — if CAS now misses, we DO
    # NOT roll back the transfer (Stripe is the source of truth for cash
    # movement); we surface the race to the caller and let the operator
    # reconcile in stripe_webhook_events. This matches the existing
    # 3-truth-layer doctrine: Stripe is provider evidence, platform is
    # operational state.
    from app.payments.status_cas import cas_set_payment_status
    outcome, current = await cas_set_payment_status(
        db,
        payment_id=payment_id,
        expected_from=["paid"],
        next_status="released",
        extra_fields={
            "stripeTransferId": transfer["transferId"],
            "payoutAmount": transfer["payoutAmount"] / 100,
            "applicationFee": transfer["applicationFee"] / 100,
            "releasedAt": now,
            "releasedBy": user_id,
        },
    )
    if outcome == "idempotent":
        # Already released concurrently. The Stripe transfer we just
        # created is a duplicate — log loudly so ops can reconcile.
        logger.warning(
            f"[connect] release CAS idempotent: payment={payment_id} "
            f"already 'released' but Stripe transfer {transfer['transferId']} "
            f"was just created — POSSIBLE DUPLICATE TRANSFER, reconcile manually"
        )
    elif outcome == "forbidden":
        # Status drift (e.g. concurrent refund). Same disclaimer as above.
        logger.error(
            f"[connect] release CAS forbidden: payment={payment_id} "
            f"current status '{current}' — Stripe transfer "
            f"{transfer['transferId']} created without platform release; "
            f"reconcile manually"
        )
        try:
            from app.payments.chronology.writer import append_payment_event
            await append_payment_event(
                db, payment_id=payment_id, kind="escrow.release_rejected",
                actor_id="platform", actor_role="platform",
                meta={"reason": "concurrent_modification",
                      "currentStatus": current,
                      "transferId": transfer["transferId"]},
            )
        except Exception:
            pass
        raise HTTPException(
            409,
            f"Cannot release: payment status changed concurrently to '{current}'. "
            f"Stripe transfer was created — contact support for reconciliation.",
        )
    elif outcome == "missing":
        raise HTTPException(409, "Payment row not found during release write")
    await db.service_requests.update_one(
        {"id": pay["requestId"]},
        {"$set": {"status": "released", "updatedAt": now}},
    )
    logger.info(f"[connect] released payment={payment_id} transfer={transfer['transferId']} sandbox={transfer.get('sandbox')}")
    # Sprint 9 — structured log envelope for production grep.
    try:
        from app.core.structured_log import sl
        sl(
            "escrow.release.succeeded",
            payment_id=payment_id,
            request_id=pay["requestId"],
            provider_id=pay.get("providerId"),
            customer_id=pay.get("customerId"),
            actor_id=user_id,
            meta={
                "transferId": transfer["transferId"],
                "payoutAmount": transfer["payoutAmount"] / 100,
                "applicationFee": transfer["applicationFee"] / 100,
                "sandbox": transfer.get("sandbox", True),
            },
        )
    except Exception:
        pass
    return {
        "released": True,
        "transferId": transfer["transferId"],
        "payoutAmount": transfer["payoutAmount"] / 100,
        "applicationFee": transfer["applicationFee"] / 100,
        "sandbox": transfer.get("sandbox", True),
    }


# ─────────────────────────────────────────────────────────────────────
# Refund (called by dispute resolution)
# ─────────────────────────────────────────────────────────────────────

class StripeRefundBody(BaseModel):
    paymentId: str
    amount: Optional[float] = None  # euros; None = full
    reason: str = "requested_by_customer"


@router.post("/api/payments/stripe/escrow/refund")
async def refund_escrow(
    body: StripeRefundBody,
    _: dict = Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
):
    db = get_db()
    pay = await db.service_payments.find_one({"id": body.paymentId}, {"_id": 0})
    if not pay:
        raise HTTPException(404, "Payment not found")
    pi_id = pay.get("stripePaymentIntentId")
    if not pi_id:
        raise HTTPException(400, "No PaymentIntent — cannot refund via Stripe")
    amount_cents = int(body.amount * 100) if body.amount else None
    refund = await scs.create_refund(
        db,
        payment_intent_id=pi_id,
        payment_id=body.paymentId,
        amount_cents=amount_cents,
        reason=body.reason,
    )
    refund_record = {
        "refundId": refund["refundId"],
        "amount": (refund["amount"] / 100) if refund.get("amount") else None,
        "status": refund["status"],
        "createdAt": _now_iso(),
        "sandbox": refund.get("sandbox", True),
    }
    await db.service_payments.update_one(
        {"id": body.paymentId},
        {"$push": {"stripeRefunds": refund_record},
         "$set": {"updatedAt": _now_iso()}},
    )
    # P6.B.2 — Attribution: governance trail for admin-driven Stripe refund.
    # This is a MONEY MUTATION on Stripe (real or sandbox) — must carry attribution.
    try:
        await record_admin_mutation(
            db, ctx,
            action="payment.stripe_refund",
            domain="payment",
            entity_id=body.paymentId,
            payment_kind="refund.requested",
            extra={
                "stripeRefundId":   refund.get("refundId"),
                "stripePIId":       pi_id,
                "amountCents":      amount_cents if amount_cents is not None else (
                                       int(pay.get("amount", 0) * 100)),
                "currency":         pay.get("currency"),
                "reason":           body.reason,
                "sandbox":          bool(refund.get("sandbox", True)),
                "providerId":       pay.get("providerId"),
                "customerId":       pay.get("customerId"),
                "requestId":        pay.get("requestId"),
            },
        )
    except Exception as _attr_e:
        logger.warning(f"[connect] attribution stripe_refund failed: {_attr_e}")
    return refund


# ─────────────────────────────────────────────────────────────────────
# Admin: platform / provider freeze controls
# ─────────────────────────────────────────────────────────────────────

class FreezeBody(BaseModel):
    reason: Optional[str] = None


@router.get("/api/admin/payments/platform-status")
async def admin_platform_status(_: dict = Depends(verify_admin_token)):
    db = get_db()
    settings = await db.platform_settings.find_one({"type": "payments"}, {"_id": 0}) or {}
    total_paid = await db.service_payments.count_documents({"status": {"$in": ["paid", "released", "resolved_partial"]}})
    total_disputed = await db.service_payments.count_documents({"status": "disputed"})
    total_refunded = await db.service_payments.count_documents({"status": "refunded"})
    onboarded = await db.users.count_documents({"stripeAccountId": {"$exists": True}})
    return {
        "frozen": settings.get("frozen", False),
        "frozenAt": settings.get("frozenAt"),
        "frozenReason": settings.get("frozenReason"),
        "totalPaid": total_paid,
        "totalDisputed": total_disputed,
        "totalRefunded": total_refunded,
        "providersOnboarded": onboarded,
    }


@router.post("/api/admin/payments/freeze")
async def admin_freeze(
    body: FreezeBody,
    _: dict = Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
):
    db = get_db()
    await db.platform_settings.update_one(
        {"type": "payments"},
        {"$set": {
            "type": "payments",
            "frozen": True,
            "frozenAt": _now_iso(),
            "frozenReason": body.reason,
        }},
        upsert=True,
    )
    logger.warning(f"[connect] PLATFORM PAYOUTS FROZEN — reason: {body.reason}")
    # P6.B — Attribution saturation: governance trail for platform freeze.
    try:
        await record_admin_mutation(
            db, ctx,
            action="payments.freeze",
            domain="config",
            entity_id="platform_settings:payments",
            extra={"reason": body.reason, "scope": "platform"},
        )
    except Exception as _attr_e:
        logger.warning(f"[connect] attribution freeze failed: {_attr_e}")
    return {"frozen": True}


@router.post("/api/admin/payments/unfreeze")
async def admin_unfreeze(
    _: dict = Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
):
    db = get_db()
    await db.platform_settings.update_one(
        {"type": "payments"},
        {"$set": {"frozen": False, "frozenAt": None, "frozenReason": None}},
        upsert=True,
    )
    logger.info("[connect] platform payouts unfrozen")
    try:
        await record_admin_mutation(
            db, ctx,
            action="payments.unfreeze",
            domain="config",
            entity_id="platform_settings:payments",
            extra={"scope": "platform"},
        )
    except Exception as _attr_e:
        logger.warning(f"[connect] attribution unfreeze failed: {_attr_e}")
    return {"frozen": False}


@router.post("/api/admin/payments/freeze-provider/{provider_id}")
async def admin_freeze_provider(
    provider_id: str,
    body: FreezeBody,
    _: dict = Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
):
    db = get_db()
    await db.users.update_one(
        {"_id": provider_id},
        {"$set": {"stripeFrozen": True, "stripeFrozenReason": body.reason, "stripeFrozenAt": _now_iso()}},
    )
    try:
        await record_admin_mutation(
            db, ctx,
            action="payments.freeze_provider",
            domain="user",
            entity_id=provider_id,
            extra={"reason": body.reason},
        )
    except Exception as _attr_e:
        logger.warning(f"[connect] attribution freeze_provider failed: {_attr_e}")
    return {"frozen": True, "providerId": provider_id}


@router.post("/api/admin/payments/unfreeze-provider/{provider_id}")
async def admin_unfreeze_provider(
    provider_id: str,
    _: dict = Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
):
    db = get_db()
    await db.users.update_one(
        {"_id": provider_id},
        {"$set": {"stripeFrozen": False, "stripeFrozenReason": None}},
    )
    try:
        await record_admin_mutation(
            db, ctx,
            action="payments.unfreeze_provider",
            domain="user",
            entity_id=provider_id,
        )
    except Exception as _attr_e:
        logger.warning(f"[connect] attribution unfreeze_provider failed: {_attr_e}")
    return {"frozen": False, "providerId": provider_id}


# ─────────────────────────────────────────────────────────────────────
# Connect webhook
# ─────────────────────────────────────────────────────────────────────

@router.post("/api/billing/webhook/connect")
async def connect_webhook(request: Request):
    """Stripe webhook for Connect/payment lifecycle events.

    Handles (with idempotency):
        account.updated, payment_intent.succeeded/failed,
        transfer.created/reversed, refund.created, charge.refunded
    """
    db = get_db()
    raw = await request.body()
    sig = request.headers.get("stripe-signature")
    verified = await scs.verify_and_record_webhook(db, raw_payload=raw, sig_header=sig)
    if verified["duplicate"]:
        return {"received": True, "duplicate": True}

    event = verified["event"]
    event_type = event.get("type", "")
    obj = event.get("data", {}).get("object", {})
    now = _now_iso()

    try:
        if event_type == "account.updated":
            acct_id = obj.get("id")
            await db.users.update_one(
                {"stripeAccountId": acct_id},
                {"$set": {
                    "stripeChargesEnabled": bool(obj.get("charges_enabled")),
                    "stripePayoutsEnabled": bool(obj.get("payouts_enabled")),
                    "stripeDetailsSubmitted": bool(obj.get("details_submitted")),
                    "stripeUpdatedAt": now,
                }},
            )

        elif event_type == "payment_intent.succeeded":
            pi_id = obj.get("id")
            # Sprint B4.3-A.2 — CAS-guarded. Same transition table as
            # the mock webhook handler in escrow/router_payments.py.
            from app.payments.status_cas import cas_set_payment_status
            # Lookup id first so we can use the CAS helper (it takes
            # `payment_id`, not `stripePaymentIntentId`).
            pay_row = await db.service_payments.find_one(
                {"stripePaymentIntentId": pi_id}, {"_id": 0, "id": 1}
            )
            if pay_row:
                outcome, current = await cas_set_payment_status(
                    db,
                    payment_id=pay_row["id"],
                    expected_from=["pending", "failed", "requires_payment_method"],
                    next_status="paid",
                    extra_fields={
                        "stripeChargeId": ((obj.get("charges") or {}).get("data") or [{}])[0].get("id"),
                        "paidAt": now,
                    },
                )
                if outcome == "modified":
                    # P0.b.C.g — chronology translation (side-effect, never blocking)
                    await _chron_append_from_pi(db, pi_id, "escrow.held", event.get("id"), obj)
                elif outcome == "idempotent":
                    logger.info(f"[connect] payment_intent.succeeded duplicate for {pi_id} — already 'paid'")
                else:
                    logger.warning(f"[connect] payment_intent.succeeded skipped for {pi_id}: status drift to '{current}'")

        elif event_type == "payment_intent.payment_failed":
            pi_id = obj.get("id")
            from app.payments.status_cas import cas_set_payment_status
            pay_row = await db.service_payments.find_one(
                {"stripePaymentIntentId": pi_id}, {"_id": 0, "id": 1}
            )
            if pay_row:
                outcome, current = await cas_set_payment_status(
                    db,
                    payment_id=pay_row["id"],
                    expected_from=["pending", "requires_payment_method"],
                    next_status="failed",
                    extra_fields={},
                )
                if outcome == "modified":
                    # P0.b.C.g — chronology translation
                    await _chron_append_from_pi(db, pi_id, "payment.failed", event.get("id"), obj)
                elif outcome == "idempotent":
                    logger.info(f"[connect] payment_intent.payment_failed duplicate for {pi_id} — already 'failed'")
                else:
                    logger.warning(f"[connect] payment_intent.payment_failed skipped for {pi_id}: status '{current}'")

        elif event_type in ("transfer.created", "transfer.updated"):
            md = obj.get("metadata") or {}
            pid = md.get("payment_id")
            if pid:
                await db.service_payments.update_one(
                    {"id": pid},
                    {"$set": {"stripeTransferStatus": event_type.split(".")[1], "updatedAt": now}},
                )
            # P0.b.C.g — chronology translation
            # transfer.created   → transfer.initiated
            # transfer.updated   → succeeded if status=paid, failed if status=failed, else (none)
            await _chron_append_from_transfer(db, event_type, obj, event.get("id"))

        elif event_type == "transfer.reversed":
            md = obj.get("metadata") or {}
            pid = md.get("payment_id")
            if pid:
                # Sprint B4.3-A.2 — CAS-guarded. transfer.reversed only
                # applies after a successful transfer (status=released).
                from app.payments.status_cas import cas_set_payment_status
                outcome, current = await cas_set_payment_status(
                    db,
                    payment_id=pid,
                    expected_from=["released"],
                    next_status="transfer_reversed",
                    extra_fields={},
                )
                if outcome == "modified":
                    logger.info(f"[connect] transfer.reversed applied to {pid}")
                elif outcome == "idempotent":
                    logger.info(f"[connect] transfer.reversed duplicate for {pid} — already 'transfer_reversed'")
                else:
                    logger.warning(f"[connect] transfer.reversed skipped for {pid}: status '{current}' not 'released'")
            # P0.b.C.g — `transfer.reversed` kind is DEFERRED per F.1. Admin
            # sees the raw row in stripe_webhook_events. No chronology append.

        elif event_type in ("refund.created", "refund.updated", "charge.refunded"):
            md = obj.get("metadata") or {}
            pid = md.get("payment_id")
            if pid:
                await db.service_payments.update_one(
                    {"id": pid},
                    {"$set": {"refundStatus": obj.get("status"), "updatedAt": now}},
                )
            # P0.b.C.g — chronology translation
            # charge.refunded             → refund.succeeded (1:1)
            # refund.updated:succeeded    → refund.succeeded
            # refund.updated:failed       → refund.failed
            # refund.created              → (none, covered by platform refund.requested)
            await _chron_append_from_refund(db, event_type, obj, event.get("id"))
    except Exception as e:
        logger.warning(f"[connect] webhook handler {event_type} failed: {e}")

    return {"received": True, "type": event_type, "sandbox": verified.get("sandbox", True)}


# ─────────────────────────────────────────────────────────────────────
# P0.b.C.g — Webhook → payment_events chronology translators.
#
# These are SIDE-EFFECTS of the webhook handler. They MUST never raise
# back into the handler — chronology append failure is observability,
# not transactionality. Wrapped in try/except below.
# ─────────────────────────────────────────────────────────────────────


async def _chron_append_from_pi(db, pi_id, kind, webhook_id, obj):
    """Translate payment_intent webhook → chronology row."""
    try:
        if not pi_id:
            return
        pay = await db.service_payments.find_one(
            {"stripePaymentIntentId": pi_id}, {"_id": 0, "id": 1}
        )
        if not pay:
            return
        from app.payments.chronology.writer import append_payment_event
        amount = obj.get("amount")  # minor units already
        currency = (obj.get("currency") or "EUR").upper()
        await append_payment_event(
            db,
            payment_id=pay["id"],
            kind=kind,
            actor_id="stripe",
            actor_role="stripe",
            meta={"amount": amount, "currency": currency},
            source_webhook_id=webhook_id,
        )
    except Exception as e:
        logger.warning(f"[chronology] PI append {kind} failed: {e}")


async def _chron_append_from_transfer(db, event_type, obj, webhook_id):
    """Translate transfer.* webhook → chronology row.
    Filtered: only the status-meaningful transitions become rows."""
    try:
        md = obj.get("metadata") or {}
        pid = md.get("payment_id")
        if not pid:
            return
        from app.payments.chronology.writer import append_payment_event
        amount = obj.get("amount")
        currency = (obj.get("currency") or "EUR").upper()
        transfer_ref = obj.get("id")

        kind = None
        if event_type == "transfer.created":
            kind = "transfer.initiated"
        elif event_type == "transfer.updated":
            status = obj.get("status")
            if status == "paid":
                kind = "transfer.succeeded"
            elif status == "failed":
                kind = "transfer.failed"
            # other statuses → telemetry only, no chronology row
        if not kind:
            return

        await append_payment_event(
            db,
            payment_id=pid,
            kind=kind,
            actor_id="stripe",
            actor_role="stripe",
            meta={
                "amount": amount,
                "currency": currency,
                "transferRef": transfer_ref,
                "payoutAmount": amount,
            },
            source_webhook_id=webhook_id,
        )
    except Exception as e:
        logger.warning(f"[chronology] transfer append failed: {e}")


async def _chron_append_from_refund(db, event_type, obj, webhook_id):
    """Translate refund/charge webhook → chronology row.
    Filtered: refund.created produces no chronology row (covered by the
    platform-side refund.requested append). Only landed-state events here.
    """
    try:
        md = obj.get("metadata") or {}
        pid = md.get("payment_id")
        if not pid:
            return
        from app.payments.chronology.writer import append_payment_event
        amount = obj.get("amount") or obj.get("amount_refunded")
        currency = (obj.get("currency") or "EUR").upper()

        kind = None
        if event_type == "charge.refunded":
            kind = "refund.succeeded"
        elif event_type == "refund.updated":
            status = obj.get("status")
            if status == "succeeded":
                kind = "refund.succeeded"
            elif status == "failed":
                kind = "refund.failed"
        # refund.created → no chronology row by design (F.1)
        if not kind:
            return

        await append_payment_event(
            db,
            payment_id=pid,
            kind=kind,
            actor_id="stripe",
            actor_role="stripe",
            meta={"amount": amount, "currency": currency},
            source_webhook_id=webhook_id,
        )
    except Exception as e:
        logger.warning(f"[chronology] refund append failed: {e}")
