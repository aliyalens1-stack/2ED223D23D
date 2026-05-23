"""Sprint 3A — Pydantic-модели и константы для escrow и подписок.

Жёсткий enum статусов и планов, чтобы исключить рассинхрон между
mobile / web / admin / backend.
"""
from __future__ import annotations
from typing import Literal, Optional
from pydantic import BaseModel, Field, ConfigDict


# ── Service Payment statuses ─────────────────────────────────────────────
# Жизненный цикл платежа:
#   pending  → checkout создан, ждём оплаты (или webhook'а)
#   paid     → деньги получены, лежат в escrow на платформе
#   released → escrow освобождён, payout исполнителю отмечен ready
#   failed   → checkout failed / webhook payment_failed
#   refunded → возврат клиенту
PaymentStatus = Literal[
    "pending",
    "paid",
    "released",
    "failed",
    "refunded",
]

# ── Subscription plans ────────────────────────────────────────────────────
SubscriptionPlan = Literal["starter", "pro", "fleet"]

SUBSCRIPTION_PLANS: dict[str, dict] = {
    "starter": {
        "key": "starter",
        "titleEn": "Starter",
        "titleRu": "Старт",
        "priceMonthly": 29,
        "currency": "EUR",
        "rankBoost": 1.05,           # +5% к rankScore при сортировке bid'ов
        "extraRadiusKm": 10,         # +10 км к serviceRadius
        "maxActiveBids": 25,
        "analytics": "basic",
        "priorityMatching": False,
        "features": [
            "+10 km radius",
            "Basic analytics",
            "Up to 25 active bids",
            "Bid boost +5%",
        ],
    },
    "pro": {
        "key": "pro",
        "titleEn": "Pro",
        "titleRu": "Профи",
        "priceMonthly": 79,
        "currency": "EUR",
        "rankBoost": 1.15,
        "extraRadiusKm": 25,
        "maxActiveBids": 100,
        "analytics": "advanced",
        "priorityMatching": True,
        "features": [
            "+25 km radius",
            "Advanced analytics",
            "Up to 100 active bids",
            "Bid boost +15%",
            "Priority matching",
        ],
    },
    "fleet": {
        "key": "fleet",
        "titleEn": "Fleet",
        "titleRu": "Флот",
        "priceMonthly": 199,
        "currency": "EUR",
        "rankBoost": 1.30,
        "extraRadiusKm": 50,
        "maxActiveBids": 1000,
        "analytics": "fleet",
        "priorityMatching": True,
        "features": [
            "+50 km radius",
            "Fleet analytics + API",
            "Unlimited active bids",
            "Bid boost +30%",
            "Priority matching",
            "Dedicated success manager",
        ],
    },
}


# Subscription status lifecycle
SubscriptionStatus = Literal[
    "pending_payment",   # checkout создан, ждём оплаты
    "active",            # активна
    "expired",           # закончилась
    "cancelled",         # отменена пользователем
]


# ── Request bodies ────────────────────────────────────────────────────────
class CheckoutBody(BaseModel):
    """Тело запроса на создание checkout-сессии (опциональный return_url)."""
    model_config = ConfigDict(extra="ignore")
    returnUrl: Optional[str] = Field(None, max_length=512)
    cancelUrl: Optional[str] = Field(None, max_length=512)


class WebhookBody(BaseModel):
    """Stripe-like webhook payload (mock).

    В реальной интеграции сюда придёт verified event от Stripe; до этого
    structure совпадает: type + data.object.
    """
    model_config = ConfigDict(extra="allow")
    id: Optional[str] = None
    type: Literal[
        "payment_intent.succeeded",
        "payment_intent.payment_failed",
        "charge.refunded",
    ]
    data: dict


class ReleaseBody(BaseModel):
    """Тело запроса на release escrow (опциональный note)."""
    model_config = ConfigDict(extra="ignore")
    note: Optional[str] = Field(None, max_length=500)


class SubscribeBody(BaseModel):
    plan: SubscriptionPlan
    returnUrl: Optional[str] = Field(None, max_length=512)
