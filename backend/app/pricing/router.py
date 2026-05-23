"""Dynamic pricing — admin-controlled, frontend-read.

Single source of truth for product/package prices. Frontend must NEVER
hardcode prices — it MUST call GET /api/pricing.

Storage: Mongo collection `pricing_config` with one document per `productId`:
  {
    _id: 'inspection',
    packages: [{id, count, price, currency, badge?}, ...],
    updatedAt
  }
  {
    _id: 'selection',
    plans: [{id, name, cars, price, currency, badge?}, ...],
    updatedAt
  }

If a product has no document yet, the seed is auto-inserted on first read.
"""
from __future__ import annotations
from datetime import datetime, timezone
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auto_requests.auth import get_user_id_required
from app.core.db import get_db
from app.core.attribution import (
    AttributionContext,
    get_attribution_context,
    record_admin_mutation,
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Default pricing (seed if collection empty) ──────────────────────
DEFAULT_INSPECTION = {
    "_id": "inspection",
    "type": "inspection",
    "packages": [
        {"id": "p1", "count": 1, "price": 149, "currency": "EUR", "badge": None},
        {"id": "p3", "count": 3, "price": 399, "currency": "EUR", "badge": "MOST POPULAR"},
        {"id": "p5", "count": 5, "price": 599, "currency": "EUR", "badge": "BEST VALUE"},
    ],
}

DEFAULT_SELECTION = {
    "_id": "selection",
    "type": "selection",
    "plans": [
        {"id": "basic",   "name": "Basic",   "cars": 3, "price": 499, "currency": "EUR", "badge": None},
        {"id": "pro",     "name": "Pro",     "cars": 5, "price": 699, "currency": "EUR", "badge": "MOST POPULAR"},
        {"id": "premium", "name": "Premium", "cars": 7, "price": 999, "currency": "EUR", "badge": None},
    ],
}


# ── Schemas ────────────────────────────────────────────────────────────
class PackageItem(BaseModel):
    id: str
    count: int = Field(ge=1, le=20)
    price: int = Field(ge=0)
    currency: str = Field(default="EUR", min_length=3, max_length=3)
    badge: Optional[str] = None


class PlanItem(BaseModel):
    id: str
    name: str
    cars: int = Field(ge=1, le=20)
    price: int = Field(ge=0)
    currency: str = Field(default="EUR", min_length=3, max_length=3)
    badge: Optional[str] = None


class InspectionPricing(BaseModel):
    type: Literal["inspection"]
    packages: List[PackageItem]


class SelectionPricing(BaseModel):
    type: Literal["selection"]
    plans: List[PlanItem]


class PricingResponse(BaseModel):
    inspection: InspectionPricing
    selection: SelectionPricing


class PricingUpdate(BaseModel):
    inspection: Optional[InspectionPricing] = None
    selection: Optional[SelectionPricing] = None


# ── Helpers ────────────────────────────────────────────────────────────
async def _get_or_seed(product_id: str, default: dict) -> dict:
    db = get_db()
    doc = await db.pricing_config.find_one({"_id": product_id})
    if not doc:
        seed = {**default, "updatedAt": _now()}
        await db.pricing_config.insert_one(seed)
        doc = seed
    return doc


def _to_response(doc: dict) -> dict:
    return {k: v for k, v in doc.items() if k not in ("_id", "updatedAt")}


# ── Routers ────────────────────────────────────────────────────────────
public_router = APIRouter(tags=["pricing"])
admin_router = APIRouter(prefix="/api/admin", tags=["pricing:admin"])


@public_router.get("/api/pricing", response_model=PricingResponse)
async def get_pricing():
    """Public — frontend reads this to render pricing screens."""
    insp = await _get_or_seed("inspection", DEFAULT_INSPECTION)
    sel = await _get_or_seed("selection", DEFAULT_SELECTION)
    return {
        "inspection": _to_response(insp),
        "selection": _to_response(sel),
    }


async def _require_admin(uid: str = Depends(get_user_id_required)) -> str:
    db = get_db()
    user = await db.users.find_one({"_id": uid}, {"role": 1})
    if not user or user.get("role") != "admin":
        raise HTTPException(403, "admin required")
    return uid


@admin_router.put("/pricing")
async def update_pricing(
    payload: PricingUpdate,
    uid: str = Depends(_require_admin),
    ctx: AttributionContext = Depends(get_attribution_context),
):
    """Admin — replace inspection.packages or selection.plans (or both)."""
    db = get_db()
    now = _now()
    touched: list[str] = []
    if payload.inspection is not None:
        await db.pricing_config.update_one(
            {"_id": "inspection"},
            {"$set": {
                "type": "inspection",
                "packages": [p.model_dump() for p in payload.inspection.packages],
                "updatedAt": now,
            }},
            upsert=True,
        )
        touched.append("inspection")
    if payload.selection is not None:
        await db.pricing_config.update_one(
            {"_id": "selection"},
            {"$set": {
                "type": "selection",
                "plans": [p.model_dump() for p in payload.selection.plans],
                "updatedAt": now,
            }},
            upsert=True,
        )
        touched.append("selection")
    insp = await _get_or_seed("inspection", DEFAULT_INSPECTION)
    sel = await _get_or_seed("selection", DEFAULT_SELECTION)
    # P6.B.2 — Attribution: pricing config edit (money-config change).
    try:
        await record_admin_mutation(
            db, ctx,
            action="pricing.update",
            domain="config",
            entity_id="pricing_config",
            extra={"touched": touched,
                   "inspectionPackages": [p.model_dump() for p in payload.inspection.packages] if payload.inspection else None,
                   "selectionPlans": [p.model_dump() for p in payload.selection.plans] if payload.selection else None},
        )
    except Exception:
        pass
    return {
        "status": "ok",
        "inspection": _to_response(insp),
        "selection": _to_response(sel),
    }


__all__ = ["public_router", "admin_router"]
