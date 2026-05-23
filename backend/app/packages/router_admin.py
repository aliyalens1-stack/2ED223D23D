"""Admin API for packages / payments / credits."""
from __future__ import annotations
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query

from app.packages import service as svc
from app.packages.schemas import AdminAdjustCredits
from app.core.security import verify_admin_token
from app.core.attribution import (
    AttributionContext,
    get_attribution_context,
    record_admin_mutation,
)
from app.core.db import get_db

router = APIRouter(prefix="/api/admin", tags=["packages:admin"])


@router.get("/payments")
async def list_admin_payments(
    status: Optional[str] = Query(default=None),
    _=Depends(verify_admin_token),
):
    docs = await svc.list_payments(status=status)
    items = [svc.payment_to_out(d).model_dump() for d in docs]
    total_paid = sum(int(d.get("amount", 0)) for d in docs if d.get("status") == "paid")
    return {"items": items, "count": len(items), "totalPaidAmount": total_paid}


@router.get("/credits/{user_id}")
async def admin_get_credits(user_id: str, _=Depends(verify_admin_token)):
    return await svc.get_balance(user_id)


@router.post("/credits/adjust")
async def admin_adjust_credits(
    data: AdminAdjustCredits,
    _=Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
):
    if data.delta == 0:
        raise HTTPException(400, "delta must be non-zero")
    result = await svc.admin_adjust(data.userId, data.delta, data.note)
    # P6.B.2 — Attribution: credits adjustment is a money-adjacent mutation.
    try:
        db = get_db()
        await record_admin_mutation(
            db, ctx,
            action="credits.adjust",
            domain="payment",
            entity_id=data.userId,
            extra={"delta": data.delta, "note": data.note},
        )
    except Exception:
        pass
    return result
