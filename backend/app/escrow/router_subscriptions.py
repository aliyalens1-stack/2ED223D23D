"""Sprint 3A — Provider Subscriptions router.

Endpoints:
  GET  /api/provider/subscriptions/plans      — каталог тарифов
  GET  /api/provider/subscriptions/me         — моя текущая подписка
  POST /api/provider/subscriptions/subscribe  — подписаться на план → checkout
  POST /api/provider/subscriptions/cancel     — отменить текущую подписку

Хранилище: коллекция provider_subscriptions
  {
    "id": "...",
    "providerId": "...",
    "plan": "starter|pro|fleet",
    "status": "pending_payment|active|expired|cancelled",
    "priceMonthly": 29,
    "currency": "EUR",
    "stripeSubscriptionId": null,
    "currentPeriodStart": "...",
    "currentPeriodEnd": "...",
    "stripeCheckoutUrl": null,
    "createdAt": "...",
    "updatedAt": "..."
  }

Helpers:
  get_active_subscription(provider_id, db) -> dict | None
  apply_subscription_boost(rank_score, plan_key) -> rank_score
"""
from __future__ import annotations
import logging
from datetime import timedelta
from fastapi import APIRouter, HTTPException, Request

from app.core.utils import now_utc, uid
from app.core.db import get_db
from app.core.security import verify_user_token
from .models import SubscribeBody, SUBSCRIPTION_PLANS
from .gateway import get_gateway


logger = logging.getLogger(__name__)
subscriptions_router = APIRouter(tags=["escrow:subscriptions"])


def _provider_only(payload: dict) -> str:
    role = payload.get("role") or payload.get("kind")
    if role not in ("provider_owner", "inspector", "provider"):
        raise HTTPException(403, "Provider/inspector role required")
    return payload.get("sub") or payload.get("userId")


# ── Helpers (используются из ranking) ─────────────────────────────────────
async def get_active_subscription(provider_id: str, db) -> dict | None:
    """Возвращает active subscription или None."""
    if not provider_id:
        return None
    doc = await db.provider_subscriptions.find_one(
        {"providerId": provider_id, "status": "active"},
        {"_id": 0},
    )
    return doc


def apply_subscription_boost(rank_score: float, plan_key: str | None) -> float:
    """Применяет subscription boost к ранк-скору."""
    if not plan_key:
        return rank_score
    plan = SUBSCRIPTION_PLANS.get(plan_key)
    if not plan:
        return rank_score
    return round(rank_score * plan["rankBoost"], 4)


# ── GET /api/provider/subscriptions/plans ─────────────────────────────────
@subscriptions_router.get("/api/provider/subscriptions/plans")
async def list_plans():
    """Каталог тарифов (публичный)."""
    return {"plans": [SUBSCRIPTION_PLANS[k] for k in ("starter", "pro", "fleet")]}


# ── GET /api/provider/subscriptions/me ────────────────────────────────────
@subscriptions_router.get("/api/provider/subscriptions/me")
async def my_subscription(request: Request):
    """Текущая подписка провайдера. Возвращает {subscription, plan} или
    {subscription: null} если подписки нет."""
    payload = await verify_user_token(request)
    provider_id = _provider_only(payload)
    db = get_db()
    doc = await db.provider_subscriptions.find_one(
        {"providerId": provider_id, "status": {"$in": ["active", "pending_payment"]}},
        {"_id": 0},
        sort=[("createdAt", -1)],
    )
    plan = SUBSCRIPTION_PLANS.get(doc["plan"]) if doc else None
    return {"subscription": doc, "plan": plan}


# ── POST /api/provider/subscriptions/subscribe ────────────────────────────
@subscriptions_router.post("/api/provider/subscriptions/subscribe")
async def subscribe(body: SubscribeBody, request: Request):
    """Подписаться на план. Возвращает checkoutUrl.

    Логика:
      - Если уже есть active подписка на тот же план → 409
      - Если есть active на другой план → создаём pending_payment запись
        нового плана (после оплаты webhook её активирует и старую закроет)
      - Иначе → создаём pending_payment + checkout
    """
    payload = await verify_user_token(request)
    provider_id = _provider_only(payload)
    db = get_db()

    plan_meta = SUBSCRIPTION_PLANS.get(body.plan)
    if not plan_meta:
        raise HTTPException(400, "Unknown plan")

    existing = await db.provider_subscriptions.find_one(
        {"providerId": provider_id, "status": "active"},
        {"_id": 0},
    )
    if existing and existing.get("plan") == body.plan:
        raise HTTPException(409, "Already subscribed to this plan")

    now = now_utc()
    sub_id = uid()
    doc = {
        "id": sub_id,
        "providerId": provider_id,
        "plan": body.plan,
        "status": "pending_payment",
        "priceMonthly": plan_meta["priceMonthly"],
        "currency": plan_meta["currency"],
        "rankBoost": plan_meta["rankBoost"],
        "extraRadiusKm": plan_meta["extraRadiusKm"],
        "stripeSubscriptionId": None,
        "stripeCheckoutUrl": None,
        "currentPeriodStart": None,
        "currentPeriodEnd": None,
        "createdAt": now.isoformat(),
        "updatedAt": now.isoformat(),
    }
    await db.provider_subscriptions.insert_one(dict(doc))
    doc.pop("_id", None)

    gateway = get_gateway()
    session = gateway.create_checkout_session(
        payment_id=sub_id,
        amount_cents=int(plan_meta["priceMonthly"] * 100),
        currency=plan_meta["currency"],
        description=f"Provider subscription · {plan_meta['titleEn']}",
        return_url=body.returnUrl,
        metadata={"subscriptionId": sub_id, "providerId": provider_id, "plan": body.plan},
    )
    await db.provider_subscriptions.update_one(
        {"id": sub_id},
        {"$set": {
            "stripeSubscriptionId": session["sessionId"],
            "stripeCheckoutUrl": session["checkoutUrl"],
            "updatedAt": now_utc().isoformat(),
        }},
    )
    doc.update({
        "stripeSubscriptionId": session["sessionId"],
        "stripeCheckoutUrl": session["checkoutUrl"],
    })
    logger.info(f"[escrow] provider {provider_id} subscribed to {body.plan} (pending)")
    return {
        "subscription": doc,
        "plan": plan_meta,
        "checkoutUrl": session["checkoutUrl"],
        "sessionId": session["sessionId"],
    }


# ── POST /api/provider/subscriptions/cancel ───────────────────────────────
@subscriptions_router.post("/api/provider/subscriptions/cancel")
async def cancel_subscription(request: Request):
    """Отменить текущую подписку. Status → cancelled, currentPeriodEnd
    остаётся как доступ до конца оплаченного периода (downgrade-period)."""
    payload = await verify_user_token(request)
    provider_id = _provider_only(payload)
    db = get_db()
    sub = await db.provider_subscriptions.find_one(
        {"providerId": provider_id, "status": "active"},
        {"_id": 0},
    )
    if not sub:
        raise HTTPException(404, "No active subscription")
    now = now_utc().isoformat()
    await db.provider_subscriptions.update_one(
        {"id": sub["id"]},
        {"$set": {"status": "cancelled", "cancelledAt": now, "updatedAt": now}},
    )
    sub.update({"status": "cancelled", "cancelledAt": now})
    return {"subscription": sub}


# ── POST /api/provider/subscriptions/_mock-pay (DEV) ──────────────────────
@subscriptions_router.post("/api/provider/subscriptions/{sub_id}/_mock-activate")
async def mock_activate(sub_id: str, request: Request):
    """DEV-only: активирует pending_payment подписку (mock-оплата).
    В prod заменяется реальным webhook'ом invoice.paid."""
    payload = await verify_user_token(request)
    provider_id = _provider_only(payload)
    gateway = get_gateway()
    if gateway.name != "mock":
        raise HTTPException(410, "Mock-activate disabled in production gateway")
    db = get_db()
    sub = await db.provider_subscriptions.find_one({"id": sub_id}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Subscription not found")
    if sub.get("providerId") != provider_id:
        raise HTTPException(403, "Forbidden")
    if sub.get("status") != "pending_payment":
        raise HTTPException(409, f"Subscription already {sub['status']}")

    now = now_utc()
    period_end = (now + timedelta(days=30)).isoformat()

    # Деактивируем предыдущую active подписку этого провайдера, если есть.
    await db.provider_subscriptions.update_many(
        {"providerId": provider_id, "status": "active", "id": {"$ne": sub_id}},
        {"$set": {"status": "expired", "expiredAt": now.isoformat(), "updatedAt": now.isoformat()}},
    )

    await db.provider_subscriptions.update_one(
        {"id": sub_id},
        {"$set": {
            "status": "active",
            "currentPeriodStart": now.isoformat(),
            "currentPeriodEnd": period_end,
            "activatedAt": now.isoformat(),
            "updatedAt": now.isoformat(),
        }},
    )
    sub.update({"status": "active", "currentPeriodStart": now.isoformat(), "currentPeriodEnd": period_end})
    logger.info(f"[escrow] activated subscription {sub_id} ({sub['plan']}) for provider={provider_id}")
    return {"subscription": sub}
