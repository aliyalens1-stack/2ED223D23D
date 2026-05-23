"""Pricing projection router.

Endpoints (under existing `pricing` tag, mounted alongside the static
pricing router):

  POST /api/pricing/project        — preview quote from raw inputs
                                     (basePrice + either distanceKm or
                                     two geo points). NEVER writes to DB.

  POST /api/pricing/project/{jobId} — calculate AND freeze for a job
                                     (idempotent upsert on jobId).
                                     Confirmed projections are IMMUTABLE.

  POST /api/pricing/project/{jobId}/confirm
                                   — lock the projection as the
                                     customer-accepted quote. Idempotent.

  GET  /api/pricing/project/{jobId} — read frozen projection (customer view —
                                     inspector payout details are stripped).

  GET  /api/inspector/jobs/{jobId}/pricing
                                   — inspector view: same projection, BUT
                                     includes `inspectorDistancePayout`.
                                     Future revision will check that the
                                     caller is the assigned inspector.

  GET  /api/admin/pricing/projections/{jobId}
                                   — admin read-only: full doc including
                                     payout split + provenance.

  GET  /api/pricing/tiers          — public tier table.
"""
from __future__ import annotations
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field

from app.core.db import get_db
from app.core.identity_runtime import IdentityContext, require_account_kind
from app.pricing.tiers import (
    PRICING_VERSION, INCLUDED_KM, CURRENCY,
    INSPECTOR_DISTANCE_PAYOUT_PCT, PLATFORM_DISTANCE_FEE_PCT,
    REMOTE_TIERS,
)
from app.pricing.projection import (
    calculate_projection,
    calculate_projection_from_geo,
    save_projection,
    confirm_projection,
    get_projection,
)


# Customer-safe view: hides inspector payout split. The customer never needs
# to see the internal economics — showing them invites haggling and confusion
# (see the original product brief).
_INSPECTOR_FIELDS = {"inspectorDistancePayout", "platformDistanceFee"}


def _customer_view(doc: dict) -> dict:
    return {k: v for k, v in doc.items() if k not in _INSPECTOR_FIELDS}


# ── Schemas ───────────────────────────────────────────────────────────
class GeoPoint(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class ProjectInput(BaseModel):
    basePrice: float = Field(ge=0, description="Base inspection package price in EUR")
    currency: str = Field(default=CURRENCY, min_length=3, max_length=3)
    # One of these two must be supplied:
    distanceKm: Optional[float] = Field(default=None, ge=0)
    inspectorBase: Optional[GeoPoint] = None
    vehicleLocation: Optional[GeoPoint] = None


class TierOut(BaseModel):
    tier: str
    minKm: int
    maxKm: Optional[int]
    ratePerKm: float
    minimumFee: float
    manualReview: bool


class TiersResponse(BaseModel):
    pricingVersion: str
    currency: str
    includedKm: int
    inspectorPayoutPct: float
    platformFeePct: float
    tiers: List[TierOut]


# ── Router ────────────────────────────────────────────────────────────
projection_router = APIRouter(prefix="/api/pricing", tags=["pricing:projection"])


def _project_from_input(payload: ProjectInput) -> dict:
    if payload.distanceKm is not None:
        return calculate_projection(
            base_price=payload.basePrice,
            distance_km=payload.distanceKm,
            currency=payload.currency,
        )
    if payload.inspectorBase and payload.vehicleLocation:
        return calculate_projection_from_geo(
            base_price=payload.basePrice,
            inspector_base=(payload.inspectorBase.lat, payload.inspectorBase.lng),
            vehicle_location=(payload.vehicleLocation.lat, payload.vehicleLocation.lng),
            currency=payload.currency,
        )
    raise HTTPException(
        status_code=400,
        detail="Either `distanceKm` OR both `inspectorBase` and `vehicleLocation` must be provided.",
    )


@projection_router.post("/project")
async def project_preview(payload: ProjectInput) -> dict:
    """Preview pricing for a (basePrice, distance) pair WITHOUT persisting.

    Used by booking UIs to render the cost breakdown live as the user picks
    the inspector / pickup point.
    """
    return _project_from_input(payload)


@projection_router.post("/project/{job_id}")
async def project_freeze(job_id: str, payload: ProjectInput) -> dict:
    """Calculate AND freeze the projection against `job_id`.

    First write creates a `pending` projection. Subsequent writes
    refresh fields while keeping `createdAt`. Once the projection is
    `confirmed`, this endpoint is a no-op — the doc is returned as-is.

    Customer-safe view (no inspector payout details).
    """
    if not job_id or len(job_id) > 128:
        raise HTTPException(400, "Invalid jobId")
    proj = _project_from_input(payload)
    db = get_db()
    saved = await save_projection(db, job_id=job_id, projection=proj)
    return _customer_view(saved)


@projection_router.post("/project/{job_id}/confirm")
async def project_confirm(job_id: str) -> dict:
    """Lock the projection for `job_id` as customer-accepted.

    From this point the projection is IMMUTABLE — calls to
    `POST /api/pricing/project/{jobId}` will be silently no-op'd.

    Idempotent: confirming an already-confirmed projection returns
    the same doc.
    """
    if not job_id or len(job_id) > 128:
        raise HTTPException(400, "Invalid jobId")
    db = get_db()
    confirmed = await confirm_projection(db, job_id=job_id)
    if confirmed is None:
        raise HTTPException(
            404,
            "No pending projection for this jobId — call POST /api/pricing/project/{jobId} first.",
        )
    return _customer_view(confirmed)


@projection_router.get("/project/{job_id}")
async def project_get(job_id: str) -> dict:
    db = get_db()
    doc = await get_projection(db, job_id=job_id)
    if not doc:
        raise HTTPException(404, "Projection not found for this jobId")
    return _customer_view(doc)


@projection_router.get("/tiers", response_model=TiersResponse)
async def get_tiers() -> dict:
    """Public — admin panel, marketing pages, frontend pricing breakdown
    can read the canonical tier table to render explanations consistent
    with the calculator.
    """
    return {
        "pricingVersion": PRICING_VERSION,
        "currency": CURRENCY,
        "includedKm": INCLUDED_KM,
        "inspectorPayoutPct": INSPECTOR_DISTANCE_PAYOUT_PCT,
        "platformFeePct": PLATFORM_DISTANCE_FEE_PCT,
        "tiers": [
            {
                "tier": t.tier,
                "minKm": t.min_km,
                "maxKm": t.max_km,
                "ratePerKm": t.rate_per_km,
                "minimumFee": t.minimum_fee,
                "manualReview": t.manual_review,
            }
            for t in REMOTE_TIERS
        ],
    }


__all__ = ["projection_router", "inspector_pricing_router", "admin_pricing_router"]


# ── Inspector view ────────────────────────────────────────────────────
# Mounted under /api/inspector — inspector view of the SAME projection,
# but with the inspector payout fields visible. Kind-gated.
inspector_pricing_router = APIRouter(
    prefix="/api/inspector", tags=["pricing:inspector"],
)

_inspector_required = require_account_kind("inspector")


@inspector_pricing_router.get("/jobs/{job_id}/pricing")
async def inspector_job_pricing(
    job_id: str,
    ctx_: IdentityContext = Depends(_inspector_required),  # noqa: B008
) -> dict:
    """Inspector's view of a job's pricing projection.

    Surfaces `inspectorDistancePayout` so the inspector can see what they
    will actually receive for the travel BEFORE accepting the job. Without
    this number, remote jobs systematically get declined and the
    marketplace economics collapse — see the v1 design discussion.

    For now any authenticated inspector can read any job's pricing. A
    later sprint will tighten this to "assigned inspector only" once the
    exposure / assignment events expose a clean way to check ownership.
    """
    db = get_db()
    doc = await get_projection(db, job_id=job_id)
    if not doc:
        raise HTTPException(404, "Projection not found for this jobId")
    return doc


# ── Admin read-only view ──────────────────────────────────────────────
# Mounted under /api/admin/pricing — full doc including geo provenance,
# payout split, status, and version. Kind-gated to admin.
admin_pricing_router = APIRouter(
    prefix="/api/admin/pricing", tags=["pricing:admin"],
)

_admin_required = require_account_kind("admin")


@admin_pricing_router.get("/projections/{job_id}")
async def admin_get_projection(
    job_id: str,
    ctx_: IdentityContext = Depends(_admin_required),  # noqa: B008
) -> dict:
    """Admin read-only — full projection doc (all fields, no masking)."""
    db = get_db()
    doc = await get_projection(db, job_id=job_id)
    if not doc:
        raise HTTPException(404, "Projection not found for this jobId")
    return doc


@admin_pricing_router.get("/projections")
async def admin_list_projections(
    status: Optional[str] = None,
    tier: Optional[str] = None,
    limit: int = 50,
) -> dict:
    """Admin read-only list — recent projections with optional filters.

    Used by the future admin pricing-visibility tab. No editor yet.
    """
    limit = max(1, min(limit, 200))
    query: dict = {}
    if status in ("pending", "confirmed"):
        query["status"] = status
    if tier in ("included", "soft_remote", "standard_remote", "far_remote"):
        query["remoteTier"] = tier
    db = get_db()
    cursor = (
        db.inspection_pricing_projection
        .find(query, {"_id": 0})
        .sort("createdAt", -1)
        .limit(limit)
    )
    items = await cursor.to_list(length=limit)
    return {"items": items, "count": len(items)}
