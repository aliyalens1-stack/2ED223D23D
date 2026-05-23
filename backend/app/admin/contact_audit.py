"""Admin · Contact Reveal Audit (Sprint 2 Step 2).

Read-only endpoint exposing `contact_reveal_log` entries for auditing.

GET /api/admin/contact-reveals
  ?jobId=&inspectorId=&customerId=&stage=&limit=

Returns rows ordered by `timestamp` DESC. Strict admin gate (governance).
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query

from app.core.db import get_db
from app.core.security import verify_admin_token

router = APIRouter(prefix="/api/admin", tags=["admin:contact"])


@router.get("/contact-reveals")
async def list_contact_reveals(
    _admin=Depends(verify_admin_token),
    jobId: Optional[str] = Query(None),
    inspectorId: Optional[str] = Query(None, description="matches inspectorAccountId or legacy inspectorId"),
    customerId: Optional[str] = Query(None),
    stage: Optional[str] = Query(None, description="masked|revealed"),
    limit: int = Query(100, ge=1, le=500),
) -> Dict[str, Any]:
    db = get_db()
    q: Dict[str, Any] = {}
    if jobId:
        q["jobId"] = jobId
    if customerId:
        q["customerId"] = customerId
    if stage:
        q["stage"] = stage.lower()
    if inspectorId:
        # Match canonical OR legacy field
        q["$or"] = [
            {"inspectorAccountId": inspectorId},
            {"inspectorId": inspectorId},
        ]

    out: List[Dict[str, Any]] = []
    cursor = (
        db.contact_reveal_log
        .find(q, {"_id": 0})
        .sort("timestamp", -1)
        .limit(limit)
    )
    async for r in cursor:
        out.append(r)
    return {"reveals": out, "count": len(out)}


__all__ = ["router"]
