"""Sprint 7 — Stripe Connect Express service for escrow marketplace.

Implements separate-charges-and-transfers pattern per Stripe playbook:
    1. Provider onboards via Express Account + AccountLink (Stripe-hosted UX)
    2. Customer pays → PaymentIntent on PLATFORM account (auto-capture)
    3. Platform holds funds in its balance until escrow release
    4. Release → Transfer to provider's connected account (minus platform fee)
    5. Refund → stripe.Refund.create on PaymentIntent (full or partial)

API version pinned to 2026-04-22.dahlia (per Stripe docs).
Webhook signature verification + idempotency via stripe_webhook_events.

Sandbox fallback: when Stripe credentials are not configured, all operations
return synthetic IDs so the higher-level flow (service_payments, disputes,
release) remains testable. Production deployment requires admin to upload
real keys via /api/admin/integrations (stored in integration_credentials).
"""
from __future__ import annotations

import hmac
import hashlib
import logging
import os
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

STRIPE_API_VERSION = "2026-04-22.dahlia"
PLATFORM_FEE_PERCENT = 0.10  # 10% — single source of truth
PAYOUT_DELAY_HOURS = 12  # operational buffer per ops spec


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _uid() -> str:
    return uuid.uuid4().hex


def _is_sandbox(key: Optional[str]) -> bool:
    """True when the configured key is the placeholder sentinel or missing."""
    return (not key) or key == "sk_test_emergent" or key.startswith("sk_test_emergent")


async def _load_stripe(db) -> tuple:
    """Load secret_key + publishable_key + webhook_secret from credentials store.

    Falls back to env STRIPE_API_KEY for bootstrap. Returns (stripe_module|None, sandbox_flag).
    When sandbox_flag is True, callers should use synthetic IDs.

    Connect-specific gate: even when a real Stripe key is present, Connect operations
    require the platform's Stripe account to have Connect enabled. Admin must flip
    `platform_settings.stripe_connect.enabled = true` (or set env STRIPE_CONNECT_ENABLED=1)
    AFTER signing up at https://dashboard.stripe.com/connect. Until then we stay in
    sandbox to preserve the full flow architecture without hitting Stripe's
    "Connect not signed up" error.
    """
    # Connect gate — separate from general Stripe enablement.
    connect_enabled = os.environ.get("STRIPE_CONNECT_ENABLED", "0") == "1"
    if not connect_enabled:
        try:
            ps = await db.platform_settings.find_one({"type": "stripe_connect"}, {"_id": 0, "enabled": 1})
            connect_enabled = bool(ps and ps.get("enabled"))
        except Exception:
            connect_enabled = False
    if not connect_enabled:
        return None, True  # sandbox until Connect explicitly enabled

    try:
        from app.integrations import credentials_service
        rec = await credentials_service.get("stripe", db=db)
    except Exception:
        rec = None

    if rec and rec.get("enabled"):
        payload = rec.get("payload", {})
        secret_key = payload.get("secret_key") or payload.get("restricted_key")
    else:
        secret_key = os.environ.get("STRIPE_API_KEY")

    sandbox = _is_sandbox(secret_key)

    if sandbox:
        return None, True

    try:
        import stripe  # type: ignore
        stripe.api_key = secret_key
        stripe.api_version = STRIPE_API_VERSION
        return stripe, False
    except ImportError:
        logger.warning("[stripe-connect] stripe SDK not installed — sandbox mode")
        return None, True


# ─────────────────────────────────────────────────────────────────────
# Connect Express onboarding
# ─────────────────────────────────────────────────────────────────────

async def create_or_get_connect_account(
    db,
    *,
    provider_id: str,
    email: Optional[str],
    country: str = "DE",
) -> Dict[str, Any]:
    """Create an Express connected account for a provider, or return existing.

    Idempotent: if provider already has stripe_account_id, retrieves status.
    """
    user = await db.users.find_one({"_id": provider_id}, {"_id": 0, "stripeAccountId": 1, "email": 1}) or {}
    existing_id = user.get("stripeAccountId")
    stripe, sandbox = await _load_stripe(db)

    if existing_id and not sandbox and stripe is not None:
        try:
            account = stripe.Account.retrieve(existing_id)
            return {
                "stripeAccountId": existing_id,
                "chargesEnabled": bool(account.get("charges_enabled")),
                "payoutsEnabled": bool(account.get("payouts_enabled")),
                "detailsSubmitted": bool(account.get("details_submitted")),
                "sandbox": False,
            }
        except Exception as e:
            logger.warning(f"[stripe-connect] retrieve existing account failed: {e}")

    if sandbox:
        # Sandbox: generate stable synthetic ID per provider.
        acct_id = existing_id or f"acct_sandbox_{provider_id[:16]}"
        await db.users.update_one(
            {"_id": provider_id},
            {"$set": {
                "stripeAccountId": acct_id,
                "stripeChargesEnabled": True,  # auto-enabled in sandbox
                "stripePayoutsEnabled": True,
                "stripeDetailsSubmitted": True,
                "stripeSandbox": True,
                "stripeOnboardedAt": _now_iso(),
            }},
        )
        return {
            "stripeAccountId": acct_id,
            "chargesEnabled": True,
            "payoutsEnabled": True,
            "detailsSubmitted": True,
            "sandbox": True,
        }

    # Real Stripe Connect Express creation.
    account = stripe.Account.create(
        type="express",
        country=country,
        email=email or user.get("email"),
        capabilities={
            "card_payments": {"requested": True},
            "transfers": {"requested": True},
        },
        business_profile={"product_description": "Auto-service marketplace provider"},
        metadata={"provider_id": str(provider_id)},
    )
    await db.users.update_one(
        {"_id": provider_id},
        {"$set": {
            "stripeAccountId": account.id,
            "stripeChargesEnabled": bool(account.get("charges_enabled")),
            "stripePayoutsEnabled": bool(account.get("payouts_enabled")),
            "stripeDetailsSubmitted": bool(account.get("details_submitted")),
            "stripeSandbox": False,
        }},
    )
    return {
        "stripeAccountId": account.id,
        "chargesEnabled": bool(account.get("charges_enabled")),
        "payoutsEnabled": bool(account.get("payouts_enabled")),
        "detailsSubmitted": bool(account.get("details_submitted")),
        "sandbox": False,
    }


async def create_account_link(
    db,
    *,
    stripe_account_id: str,
    refresh_url: str,
    return_url: str,
) -> Dict[str, Any]:
    """Generate a Stripe-hosted onboarding URL for the Express account."""
    stripe, sandbox = await _load_stripe(db)
    if sandbox or stripe is None:
        # Sandbox: synthetic onboarding URL → return our return_url directly
        # so a frontend can simulate completion.
        return {
            "url": f"{return_url}?sandbox=1&account={stripe_account_id}",
            "sandbox": True,
        }
    link = stripe.AccountLink.create(
        account=stripe_account_id,
        type="account_onboarding",
        refresh_url=refresh_url,
        return_url=return_url,
    )
    return {"url": link.url, "sandbox": False}


async def get_account_status(db, *, stripe_account_id: str) -> Dict[str, Any]:
    """Fetch current Express account status (charges / payouts / details)."""
    stripe, sandbox = await _load_stripe(db)
    if sandbox or stripe is None:
        return {
            "id": stripe_account_id,
            "chargesEnabled": True,
            "payoutsEnabled": True,
            "detailsSubmitted": True,
            "sandbox": True,
        }
    account = stripe.Account.retrieve(stripe_account_id)
    return {
        "id": account.id,
        "chargesEnabled": bool(account.get("charges_enabled")),
        "payoutsEnabled": bool(account.get("payouts_enabled")),
        "detailsSubmitted": bool(account.get("details_submitted")),
        "sandbox": False,
    }


# ─────────────────────────────────────────────────────────────────────
# Escrow PaymentIntent (customer pays into platform balance)
# ─────────────────────────────────────────────────────────────────────

async def create_escrow_payment_intent(
    db,
    *,
    request_id: str,
    customer_id: str,
    provider_id: str,
    amount_cents: int,
    currency: str = "eur",
    customer_email: Optional[str] = None,
) -> Dict[str, Any]:
    """Create a PaymentIntent on the platform account (separate charges & transfers).

    Returns {payment_intent_id, client_secret, sandbox} so client can confirm.
    """
    stripe, sandbox = await _load_stripe(db)
    if sandbox or stripe is None:
        pi_id = f"pi_sandbox_{_uid()[:16]}"
        return {
            "paymentIntentId": pi_id,
            "clientSecret": f"{pi_id}_secret_sandbox",
            "amount": amount_cents,
            "currency": currency,
            "sandbox": True,
        }
    pi = stripe.PaymentIntent.create(
        amount=amount_cents,
        currency=currency,
        capture_method="automatic",
        payment_method_types=["card"],
        receipt_email=customer_email,
        metadata={
            "request_id": request_id,
            "customer_id": customer_id,
            "provider_id": provider_id,
            "escrow": "true",
        },
    )
    return {
        "paymentIntentId": pi.id,
        "clientSecret": pi.client_secret,
        "amount": amount_cents,
        "currency": currency,
        "sandbox": False,
    }


# ─────────────────────────────────────────────────────────────────────
# Release: platform → provider Transfer (separate charges and transfers)
# ─────────────────────────────────────────────────────────────────────

async def create_release_transfer(
    db,
    *,
    request_id: str,
    payment_id: str,
    provider_account_id: str,
    amount_cents: int,
    currency: str = "eur",
    fee_percent: Optional[float] = None,
) -> Dict[str, Any]:
    """Transfer escrow funds from platform balance to provider's Express account.

    Fee retained as the difference (platform fee = amount × PLATFORM_FEE_PERCENT).
    Returns {transferId, payoutAmount, applicationFee, sandbox}.
    """
    pct = fee_percent if fee_percent is not None else PLATFORM_FEE_PERCENT
    fee_cents = int(round(amount_cents * pct))
    payout_cents = amount_cents - fee_cents

    stripe, sandbox = await _load_stripe(db)
    if sandbox or stripe is None:
        return {
            "transferId": f"tr_sandbox_{_uid()[:16]}",
            "payoutAmount": payout_cents,
            "applicationFee": fee_cents,
            "sandbox": True,
        }
    transfer = stripe.Transfer.create(
        amount=payout_cents,
        currency=currency,
        destination=provider_account_id,
        transfer_group=f"req:{request_id}",
        metadata={
            "request_id": request_id,
            "payment_id": payment_id,
            "application_fee_amount": str(fee_cents),
        },
        idempotency_key=f"transfer:{payment_id}",
    )
    return {
        "transferId": transfer.id,
        "payoutAmount": payout_cents,
        "applicationFee": fee_cents,
        "sandbox": False,
    }


# ─────────────────────────────────────────────────────────────────────
# Refunds (dispute outcomes)
# ─────────────────────────────────────────────────────────────────────

async def create_refund(
    db,
    *,
    payment_intent_id: str,
    payment_id: str,
    amount_cents: Optional[int] = None,
    reason: str = "requested_by_customer",
) -> Dict[str, Any]:
    """Refund a PaymentIntent (full or partial). For dispute resolution.

    None amount = full refund.
    """
    stripe, sandbox = await _load_stripe(db)
    if sandbox or stripe is None:
        return {
            "refundId": f"re_sandbox_{_uid()[:16]}",
            "amount": amount_cents,
            "status": "succeeded",
            "sandbox": True,
        }
    kwargs: Dict[str, Any] = {
        "payment_intent": payment_intent_id,
        "metadata": {"payment_id": payment_id},
        "reason": reason if reason in ("duplicate", "fraudulent", "requested_by_customer") else "requested_by_customer",
        "idempotency_key": f"refund:{payment_id}:{amount_cents or 'full'}",
    }
    if amount_cents is not None:
        kwargs["amount"] = amount_cents
    refund = stripe.Refund.create(**kwargs)
    return {
        "refundId": refund.id,
        "amount": refund.amount,
        "status": refund.status,
        "sandbox": False,
    }


# ─────────────────────────────────────────────────────────────────────
# Webhook verification + idempotency log
# ─────────────────────────────────────────────────────────────────────

async def verify_and_record_webhook(
    db,
    *,
    raw_payload: bytes,
    sig_header: Optional[str],
    webhook_secret: Optional[str] = None,
) -> Dict[str, Any]:
    """Verify Stripe signature, dedup event_id, return parsed event.

    Returns:
        {event, duplicate: bool, sandbox: bool}
    Raises HTTPException on verification failure.
    """
    from fastapi import HTTPException

    if not raw_payload:
        raise HTTPException(400, "Empty payload")

    secret = webhook_secret
    if not secret:
        try:
            from app.integrations import credentials_service
            rec = await credentials_service.get("stripe", db=db)
            if rec and rec.get("enabled"):
                secret = rec.get("payload", {}).get("webhook_secret")
        except Exception:
            pass

    sandbox = False
    event: Dict[str, Any]

    if not secret or _is_sandbox(os.environ.get("STRIPE_API_KEY")):
        # Sandbox: skip verification, parse JSON best-effort.
        import json
        try:
            event = json.loads(raw_payload)
        except Exception:
            raise HTTPException(400, "Invalid JSON")
        sandbox = True
    else:
        try:
            import stripe  # type: ignore
            event = stripe.Webhook.construct_event(
                payload=raw_payload,
                sig_header=sig_header or "",
                secret=secret,
            )
            # Convert StripeObject → dict for storage.
            event = dict(event)
        except Exception as e:
            logger.warning(f"[stripe-connect] webhook signature verification failed: {e}")
            raise HTTPException(400, f"Signature verification failed: {e}")

    event_id = event.get("id")
    if not event_id:
        raise HTTPException(400, "Missing event id")

    # Idempotency: try to insert event_id. If already present, mark duplicate.
    duplicate = False
    try:
        await db.stripe_webhook_events.insert_one({
            "_id": event_id,
            "type": event.get("type"),
            "receivedAt": _now_iso(),
            "sandbox": sandbox,
        })
    except Exception:
        # Duplicate key → already processed.
        duplicate = True

    return {"event": event, "duplicate": duplicate, "sandbox": sandbox}


async def ensure_indexes(db) -> None:
    await db.stripe_webhook_events.create_index([("type", 1), ("receivedAt", -1)])
    await db.platform_settings.create_index([("type", 1)])
    logger.info("[stripe-connect] indexes ensured")
