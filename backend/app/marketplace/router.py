"""Sprint 21 C10: aggregate marketplace / matching / zones routers.

Exported `router` is the APIRouter that server.py include_router's once.
"""
from __future__ import annotations
from fastapi import APIRouter

from app.marketplace.providers import router as providers_router
from app.marketplace.matching import router as matching_router
from app.marketplace.zones import router as zones_router


router = APIRouter()
router.include_router(providers_router)
router.include_router(matching_router)
router.include_router(zones_router)
