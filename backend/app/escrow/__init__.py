"""Sprint 3A — Escrow & Monetization Core.

Превращает marketplace из «доски объявлений» в transactional платформу.
Все деньги идут через платформу: accept-bid → service_payments → checkout →
webhook → escrow → release.

Production-ready архитектура: gateway абстрагирован, реальный Stripe
подключается одной строкой в `gateway.py` без изменений в роутерах.

Components:
  - models.py             Pydantic + статусы + планы подписок
  - gateway.py            PaymentGateway interface + MockGateway
  - router_payments.py    /api/service-payments/*  +  /api/payments/webhook/stripe
  - router_subscriptions.py /api/provider/subscriptions/*
  - router_admin.py       /api/admin/revenue/dashboard
"""
from .router_payments import (
    customer_payments_router,
    webhook_router,
)
from .router_subscriptions import subscriptions_router
from .router_admin import admin_revenue_router

__all__ = [
    "customer_payments_router",
    "webhook_router",
    "subscriptions_router",
    "admin_revenue_router",
]
