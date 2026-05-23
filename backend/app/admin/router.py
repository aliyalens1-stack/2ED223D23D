"""app.admin.router — Sprint 21 C12A aggregate router.

Собирает все admin-endpoints из C12A-подмодулей (dashboard + forecast).
Ranking остаётся в app.marketplace.quick_request (см. ranking.py).

В server.py регистрируется через `app.include_router(admin_router)` ДО
catch-all proxy_to_nestjs.
"""
from fastapi import APIRouter

from app.admin.controls import router as controls_router
from app.admin.dashboard import router as dashboard_router
from app.admin.forecast import router as forecast_router


router = APIRouter()
router.include_router(dashboard_router)
router.include_router(forecast_router)
router.include_router(controls_router)
