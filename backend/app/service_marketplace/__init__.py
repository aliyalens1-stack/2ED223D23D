"""Service Marketplace v1 — единая биржа заявок (Sprint 1 + Sprint 2 + Public).

Sprint 1: 9 категорий услуг, customer/provider/admin endpoints.
Sprint 2: Geo registry, matching pipeline, dispatch notifications, bid ranking,
         admin heatmap, fast quick-bid.
Public:   Open marketplace feed — no-auth browse for guests / customers /
         executors. Bid endpoint requires provider auth but lives under the
         same `/api/marketplace/*` namespace for surface clarity. See
         `router_public.py` for the rationale.

Этот модуль работает параллельно с существующими auto_requests/car_selection.
Anti-bypass: контакты провайдера скрыты до accept_bid.
"""
from .router_customer import router as customer_router
from .router_provider import router as provider_router
from .router_admin import router as admin_router
from .router_public import router as public_router
from .router_geo import (
    provider_geo_router,
    admin_dispatch_router,
    notifications_router,
)

__all__ = [
    "customer_router",
    "provider_router",
    "admin_router",
    "public_router",
    "provider_geo_router",
    "admin_dispatch_router",
    "notifications_router",
]
