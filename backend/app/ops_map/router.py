"""Sprint 3 Step 5 — Ops Map HTTP surface.

Endpoint:
    GET /api/admin/ops-map/snapshot

Pure read. No mutation. Polled by the admin SPA every N seconds.
"""
from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends

from app.core.security import verify_admin_token
from app.ops_map.snapshot import compute_snapshot


router = APIRouter()


@router.get("/api/admin/ops-map/snapshot")
async def get_ops_map_snapshot(_: dict = Depends(verify_admin_token)) -> Dict[str, Any]:
    return await compute_snapshot()


__all__ = ["router"]
