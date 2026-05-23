"""app.billing.stripe_payments — Sprint 22 Stripe integration.

Принципы (по ТЗ):
- Только test mode.
- Конфиг (secret_key + webhook_secret + enabled) — ТОЛЬКО из MongoDB
  (collection `platform_settings`, doc `{type:"stripe", ...}`).
- Никаких env-зависимостей в коде (env используется только как опциональный fallback
  для admin bootstrap, чтобы было что вбить в форму первый раз).
- Webhook URL фиксированный: /api/billing/webhook. В админке настраивается ТОЛЬКО:
    secret_key, webhook_secret, enabled (toggle).
- Идемпотентность: upsert по session_id в коллекции `payment_transactions`,
  при повторном webhook'е не апдейтим уже completed транзакцию.
- Цены — ТОЛЬКО из BILLING_PRODUCTS на бэкенде (никаких amount от клиента).

Endpoints:
- GET  /api/admin/billing/stripe-config              (admin)
- POST /api/admin/billing/stripe-config              (admin)
- POST /api/billing/checkout                         (provider/auth)
- GET  /api/billing/checkout/status/{session_id}     (auth, polling)
- POST /api/billing/webhook                          (Stripe → us)
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Request, HTTPException, Depends
from pydantic import BaseModel

from emergentintegrations.payments.stripe.checkout import (
    StripeCheckout,
    CheckoutSessionRequest,
    CheckoutSessionResponse,
    CheckoutStatusResponse,
)

from app.core.db import db
from app.core.security import verify_admin_token
from app.core.utils import now_utc, uid
# Phase 1B Tier 3 — pure sync cluster enrichment for payment writers.
from app.core.cluster_writer import enrich_with_cluster, cluster_from_payment_source

# Импортируем каталог продуктов из существующего billing.router (single source of truth)
from app.billing.router import BILLING_PRODUCTS


logger = logging.getLogger("server")

router = APIRouter()

STRIPE_SETTINGS_KEY = "stripe"
WEBHOOK_PATH = "/api/billing/webhook"


# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────


async def get_stripe_config() -> Optional[dict]:
    """Read stripe config from Mongo. Returns None if not configured."""
    doc = await db.platform_settings.find_one(
        {"type": STRIPE_SETTINGS_KEY}, {"_id": 0}
    )
    return doc


async def require_stripe_config() -> dict:
    """Get config or raise 400 if Stripe is not configured / disabled."""
    cfg = await get_stripe_config()
    if not cfg or not cfg.get("enabled") or not cfg.get("secret_key"):
        raise HTTPException(400, "Stripe not configured. Configure it in admin panel.")
    return cfg


def _build_webhook_url(request: Request) -> str:
    """Build absolute webhook URL from incoming request host."""
    host_url = str(request.base_url).rstrip("/")
    return f"{host_url}{WEBHOOK_PATH}"


def _make_stripe_client(request: Request, cfg: dict) -> StripeCheckout:
    """Build StripeCheckout instance for the current request."""
    return StripeCheckout(
        api_key=cfg["secret_key"],
        webhook_url=_build_webhook_url(request),
    )


def _mask_secret(value: Optional[str]) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "***"
    return f"{value[:7]}...{value[-4:]}"


# ──────────────────────────────────────────────────────────────────────
# Admin: Stripe config (GET / POST)
# ──────────────────────────────────────────────────────────────────────


class StripeConfigPayload(BaseModel):
    secret_key: Optional[str] = None
    webhook_secret: Optional[str] = None
    enabled: Optional[bool] = None


@router.get("/api/admin/billing/stripe-config")
async def admin_get_stripe_config(_=Depends(verify_admin_token)):
    """Return current stripe config (with masked keys).

    Если конфиг отсутствует, возвращаем пустой объект с enabled=False
    и подсказкой о fallback'е из env (только для первичной подсказки админу).
    """
    cfg = await get_stripe_config()
    env_fallback = os.environ.get("STRIPE_API_KEY") or ""
    if not cfg:
        return {
            "configured": False,
            "enabled": False,
            "secret_key_masked": "",
            "webhook_secret_masked": "",
            "webhook_url_hint": WEBHOOK_PATH,
            "env_fallback_available": bool(env_fallback),
        }
    return {
        "configured": True,
        "enabled": bool(cfg.get("enabled")),
        "secret_key_masked": _mask_secret(cfg.get("secret_key")),
        "webhook_secret_masked": _mask_secret(cfg.get("webhook_secret")),
        "webhook_url_hint": WEBHOOK_PATH,
        "env_fallback_available": bool(env_fallback),
        "updated_at": cfg.get("updated_at"),
    }


@router.post("/api/admin/billing/stripe-config")
async def admin_set_stripe_config(
    payload: StripeConfigPayload, _=Depends(verify_admin_token)
):
    """Upsert stripe config in platform_settings.

    Поля, переданные как None — НЕ обновляются. Это позволяет, например,
    переключить enabled, не пересылая secret_key.
    """
    update: dict = {"type": STRIPE_SETTINGS_KEY, "updated_at": now_utc().isoformat()}
    if payload.secret_key is not None and payload.secret_key != "":
        update["secret_key"] = payload.secret_key.strip()
    if payload.webhook_secret is not None and payload.webhook_secret != "":
        update["webhook_secret"] = payload.webhook_secret.strip()
    if payload.enabled is not None:
        update["enabled"] = bool(payload.enabled)

    # Не позволяем включить интеграцию без secret_key
    existing = await get_stripe_config() or {}
    final_secret = update.get("secret_key", existing.get("secret_key"))
    if update.get("enabled") and not final_secret:
        raise HTTPException(400, "Cannot enable Stripe without secret_key")

    await db.platform_settings.update_one(
        {"type": STRIPE_SETTINGS_KEY}, {"$set": update}, upsert=True
    )
    return {"status": "ok", "updated_fields": [k for k in update if k not in ("type", "updated_at")]}


# ──────────────────────────────────────────────────────────────────────
# Provider: create checkout session
# ──────────────────────────────────────────────────────────────────────


class CheckoutPayload(BaseModel):
    productCode: str
    providerSlug: str = "avtomaster-pro"
    originUrl: str  # frontend window.location.origin


@router.post("/api/billing/checkout")
async def billing_create_checkout(payload: CheckoutPayload, request: Request):
    """Create a Stripe Checkout Session for a billing product.

    Цена ТОЛЬКО из BILLING_PRODUCTS (никогда не от клиента).
    """
    cfg = await require_stripe_config()

    product = next((p for p in BILLING_PRODUCTS if p["code"] == payload.productCode), None)
    if not product:
        raise HTTPException(400, "Product not found")

    # Stripe expects float in major currency unit; library posts via API.
    amount = float(product["price"])
    currency = product["currency"].lower()  # 'uah' / 'usd' etc

    # Build success / cancel URLs from frontend origin (NOT hardcoded)
    origin = payload.originUrl.rstrip("/")
    success_url = f"{origin}/billing/success?session_id={{CHECKOUT_SESSION_ID}}"
    cancel_url = f"{origin}/billing/cancel"

    metadata = {
        "providerSlug": payload.providerSlug,
        "productCode": payload.productCode,
        "productName": product["name"],
        "durationDays": str(product["durationDays"]),
        "source": "billing_boost",  # Phase 1A — canonical owner tag (decision plan §3.3)
    }

    stripe_client = _make_stripe_client(request, cfg)

    try:
        req = CheckoutSessionRequest(
            amount=amount,
            currency=currency,
            success_url=success_url,
            cancel_url=cancel_url,
            metadata=metadata,
        )
        session: CheckoutSessionResponse = await stripe_client.create_checkout_session(req)
    except Exception as exc:
        logger.exception("Stripe create_checkout_session failed")
        raise HTTPException(502, f"Stripe error: {exc}")

    # MANDATORY: create payment_transactions record BEFORE returning URL
    txn = {
        "id": uid(),
        "session_id": session.session_id,
        "providerSlug": payload.providerSlug,
        "productCode": payload.productCode,
        "productName": product["name"],
        "amount": amount,
        "currency": product["currency"],
        "status": "initiated",  # initiated | pending | paid | expired | failed
        "payment_status": "unpaid",
        "metadata": metadata,
        "stripe_url": session.url,
        "created_at": now_utc().isoformat(),
        "updated_at": now_utc().isoformat(),
    }
    # Phase 1B Tier 3 — cluster from metadata.source via constant map (no currency touch).
    # NOTE: writer dict is NOT returned to client (response is a separate dict below),
    # so no scrub needed. Identity fields (session_id) are untouched.
    enrich_with_cluster(
        txn,
        cluster=cluster_from_payment_source(metadata.get("source")),
        strategy="metadata_source",
        source_field="metadata.source",
        reason=metadata.get("source"),
    )
    await db.payment_transactions.insert_one(txn)
    txn.pop("_id", None)

    return {
        "checkoutUrl": session.url,
        "sessionId": session.session_id,
        "amount": amount,
        "currency": product["currency"],
    }


# ──────────────────────────────────────────────────────────────────────
# Polling: checkout status
# ──────────────────────────────────────────────────────────────────────


@router.get("/api/billing/checkout/status/{session_id}")
async def billing_checkout_status(session_id: str, request: Request):
    """Poll status from Stripe + return current DB record. Idempotent.

    DB-fallback: если Stripe не может вернуть статус (transient error,
    "No such checkout.session" с тестовым ключом и т.п.) — отдаём
    последнее известное состояние из payment_transactions. Webhook
    при настоящей оплате всё равно проставит статус=paid.
    """
    cfg = await require_stripe_config()

    txn = await db.payment_transactions.find_one({"session_id": session_id}, {"_id": 0})
    if not txn:
        raise HTTPException(404, "Transaction not found")

    stripe_client = _make_stripe_client(request, cfg)
    stripe_status_obj: Optional[CheckoutStatusResponse] = None
    stripe_error: Optional[str] = None
    try:
        stripe_status_obj = await stripe_client.get_checkout_status(session_id)
    except Exception as exc:
        # DB-fallback. Не 502 — просто отдаём текущее состояние из БД.
        stripe_error = str(exc)
        logger.warning(
            f"Stripe get_checkout_status fallback to DB for {session_id}: {exc}"
        )

    # If Stripe responded → reconcile DB
    if stripe_status_obj is not None and txn.get("status") != "paid":
        new_status = txn.get("status")
        if stripe_status_obj.payment_status == "paid":
            new_status = "paid"
        elif stripe_status_obj.status == "expired":
            new_status = "expired"
        elif stripe_status_obj.status == "complete":
            new_status = "completed"
        if new_status != txn.get("status"):
            await db.payment_transactions.update_one(
                {"session_id": session_id},
                {
                    "$set": {
                        "status": new_status,
                        "payment_status": stripe_status_obj.payment_status,
                        "updated_at": now_utc().isoformat(),
                    }
                },
            )
            if new_status == "paid":
                await _activate_purchase(session_id)
            txn = await db.payment_transactions.find_one(
                {"session_id": session_id}, {"_id": 0}
            )

    return {
        "session_id": session_id,
        "status": txn.get("status"),
        "payment_status": txn.get("payment_status"),
        "amount": txn.get("amount"),
        "currency": txn.get("currency"),
        "stripe_status": stripe_status_obj.status if stripe_status_obj else None,
        "stripe_payment_status": stripe_status_obj.payment_status if stripe_status_obj else None,
        "stripe_error": stripe_error,
    }


# ──────────────────────────────────────────────────────────────────────
# Webhook
# ──────────────────────────────────────────────────────────────────────


@router.post("/api/billing/webhook")
async def billing_webhook(request: Request):
    """Handle Stripe webhook. Only processes `checkout.session.completed`.

    Idempotent: повторный webhook на тот же session_id → no-op + 200.
    """
    cfg = await get_stripe_config()
    if not cfg or not cfg.get("enabled"):
        # Stripe всё равно ретраит → возвращаем 200, чтобы не зацикливать.
        logger.warning("billing/webhook: stripe disabled, ignoring event")
        return {"status": "ignored", "reason": "disabled"}

    raw_body: bytes = await request.body()
    signature: Optional[str] = request.headers.get("Stripe-Signature")
    if not signature:
        logger.warning("Stripe webhook: missing signature header")
        raise HTTPException(400, "Missing Stripe-Signature header")

    stripe_client = _make_stripe_client(request, cfg)

    try:
        webhook_resp = await stripe_client.handle_webhook(raw_body, signature)
    except Exception as exc:
        logger.warning(f"Stripe webhook: invalid signature ({exc})")
        raise HTTPException(400, f"Webhook verification failed: {exc}")

    event_type = webhook_resp.event_type
    session_id = webhook_resp.session_id

    if event_type != "checkout.session.completed":
        logger.info(f"Stripe webhook: ignored event_type={event_type} session={session_id}")
        return {"status": "ignored", "event_type": event_type}

    if not session_id:
        return {"status": "ignored", "reason": "no session_id"}

    # Idempotency: if already paid → 200 (defensive double-check)
    txn = await db.payment_transactions.find_one({"session_id": session_id}, {"_id": 0})
    if not txn:
        logger.warning(f"Stripe webhook: unknown session_id={session_id}")
        return {"status": "ignored", "reason": "unknown session"}

    if txn.get("status") == "paid":
        logger.info(f"Stripe webhook: already_processed session={session_id}")
        return {"status": "ok", "already_processed": True}

    logger.info(
        f"Stripe webhook: {event_type} session={session_id} "
        f"payment_status={webhook_resp.payment_status}"
    )

    await db.payment_transactions.update_one(
        {"session_id": session_id},
        {
            "$set": {
                "status": "paid",
                "payment_status": webhook_resp.payment_status or "paid",
                "updated_at": now_utc().isoformat(),
                "webhook_event_id": webhook_resp.event_id,
            }
        },
    )
    await _activate_purchase(session_id)
    return {"status": "ok", "session_id": session_id}


# ──────────────────────────────────────────────────────────────────────
# Entitlement activation (only after confirmed paid status)
# ──────────────────────────────────────────────────────────────────────


async def _activate_purchase(session_id: str) -> None:
    """Activate entitlements + record provider_purchase. Idempotent on session_id."""
    txn = await db.payment_transactions.find_one({"session_id": session_id}, {"_id": 0})
    if not txn:
        return

    existing_purchase = await db.provider_purchases.find_one(
        {"stripeSessionId": session_id}, {"_id": 0}
    )
    if existing_purchase:
        return  # already credited

    product = next(
        (p for p in BILLING_PRODUCTS if p["code"] == txn.get("productCode")), None
    )
    if not product:
        logger.error(f"_activate_purchase: unknown product {txn.get('productCode')}")
        return

    now = now_utc()
    ends_at = now + timedelta(days=product["durationDays"])

    purchase = {
        "id": uid(),
        "providerSlug": txn.get("providerSlug"),
        "productCode": product["code"],
        "productName": product["name"],
        "amount": product["price"],
        "currency": product["currency"],
        "status": "paid",
        "durationDays": product["durationDays"],
        "startsAt": now.isoformat(),
        "endsAt": ends_at.isoformat(),
        "paidAt": now.isoformat(),
        "createdAt": now.isoformat(),
        "stripeSessionId": session_id,
        "featureFlags": product["featureFlags"],
        "config": product["config"],
    }
    await db.provider_purchases.insert_one(purchase)

    config = product["config"]
    flags = product["featureFlags"]
    ent_update = {"updatedAt": now.isoformat()}
    org_update: dict = {}
    if flags.get("promoted"):
        ent_update["promotedActive"] = True
        ent_update["promotedBoost"] = config.get("promotionBoost", 0.15)
        ent_update["promotedLabel"] = config.get("promotedLabel", "⭐ Рекомендуем")
        ent_update["promotedEndsAt"] = ends_at.isoformat()
        org_update["isPromoted"] = True
        org_update["promotionBoost"] = config.get("promotionBoost", 0.15)
        org_update["promotedLabel"] = config.get("promotedLabel")
    if flags.get("priority"):
        ent_update["priorityActive"] = True
        ent_update["priorityLevel"] = config.get("priorityLevel", 1)
        ent_update["priorityWindowSeconds"] = config.get("priorityWindowSeconds", 20)
        ent_update["priorityEndsAt"] = ends_at.isoformat()
        org_update["hasPriorityAccess"] = True
        org_update["priorityLevel"] = config.get("priorityLevel", 1)
        org_update["priorityWindowSeconds"] = config.get("priorityWindowSeconds", 20)
    if flags.get("vip"):
        ent_update["vipActive"] = True
        org_update["promotionPlan"] = "vip"

    await db.provider_entitlements.update_one(
        {"providerSlug": txn.get("providerSlug")},
        {"$set": {**ent_update, "providerSlug": txn.get("providerSlug")}},
        upsert=True,
    )
    if org_update:
        await db.organizations.update_one(
            {"slug": txn.get("providerSlug")}, {"$set": org_update}
        )
    logger.info(
        f"Stripe purchase activated: provider={txn.get('providerSlug')} "
        f"product={product['code']} session={session_id}"
    )
