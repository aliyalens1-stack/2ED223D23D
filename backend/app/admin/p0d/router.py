"""P0.d aggregate router.

Combines payouts + payments + reviews moderation under one APIRouter
that server.py mounts via app.include_router(p0d_router).
"""
from fastapi import APIRouter

from .payouts import router as payouts_router
from .payments import router as payments_router
from .reviews import router as reviews_router

router = APIRouter()
router.include_router(payouts_router)
router.include_router(payments_router)
router.include_router(reviews_router)
