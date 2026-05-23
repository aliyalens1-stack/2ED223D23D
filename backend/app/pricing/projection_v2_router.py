"""Pricing-v2 router — preview + version registry endpoint.

Read-only endpoints. The freeze-into-quote path remains in
`projection_router.py` for now (v1) and will be migrated when we wire
v2 into the request lifecycle. This module is intentionally minimal:
it exposes v2 numbers to the frontend WITHOUT mutating state, so the
customer can see the breakdown before committing.

Endpoints:

  GET  /api/pricing/versions
       Lists every known version (locked-or-not), plus `current`.

  POST /api/pricing/v2/preview
       Pure preview of a v2 quote.
       Body: { basePrice, distanceKm?, cityId?, countryCode?,
               inspectorBase?, vehicleLocation? }
       Returns: a v2 projection dict (NEVER persisted).

  GET  /api/pricing/density/{cityId}
       Reports the density snapshot the platform would attach to a
       quote in that city RIGHT NOW. Helpful for ops + operator
       observability surface ("what would Berlin look like today?").
"""
from __future__ import annotations
from typing import Optional, Tuple

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field

from app.core.db import get_db
from app.pricing.version_registry import (
    KNOWN_VERSIONS, current_version, is_version_known,
)
from app.pricing.density_projection import (
    resolve_density, snapshot_to_dict,
    DENSITY_MULTIPLIER, DENSITY_REASON,
)
from app.pricing.projection_v2 import (
    calculate_projection_v2,
    calculate_projection_v2_from_geo,
)


router = APIRouter()


# ── Version registry ─────────────────────────────────────────────────────

@router.get("/api/pricing/versions")
async def get_versions():
    """Public list. Frontend can sanity-check which version it's reading
    and tools can ensure version locks are advertised correctly."""
    return {
        "current": current_version(),
        "versions": [
            {"version": k, **v} for k, v in KNOWN_VERSIONS.items()
        ],
    }


# ── Density preview (read-only) ──────────────────────────────────────────

@router.get("/api/pricing/density/{city_id}")
async def get_city_density(city_id: str, countryCode: Optional[str] = None):
    """What density tier would Pricing-v2 attach to a quote in this city
    right now? Useful for ops/observability — NOT for the customer
    explanation layer (that comes embedded in `/v2/preview`).
    """
    db = get_db()
    try:
        snap = await resolve_density(db, city_id=city_id, country_code=countryCode)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return snapshot_to_dict(snap)


# ── v2 preview ───────────────────────────────────────────────────────────


class V2PreviewIn(BaseModel):
    basePrice: float = Field(..., ge=0)
    distanceKm: Optional[float] = Field(None, ge=0)
    cityId: Optional[str] = None
    countryCode: Optional[str] = None
    # If geo points are given, we derive distance via haversine and
    # attach `geo` provenance. `cityId` should still be passed so density
    # resolution doesn't fall back to country aggregates.
    inspectorBase: Optional[Tuple[float, float]] = None
    vehicleLocation: Optional[Tuple[float, float]] = None
    currency: str = "EUR"


@router.post("/api/pricing/v2/preview")
async def v2_preview(body: V2PreviewIn):
    """Pure preview — no DB write, no state change. Used by the
    customer-facing quote screen to show the v2 breakdown before they
    commit. Idempotent (same inputs → same output, at this moment).
    """
    if body.cityId is None and body.countryCode is None:
        raise HTTPException(
            400, "cityId or countryCode is required so density can resolve",
        )

    db = get_db()
    try:
        if body.inspectorBase and body.vehicleLocation:
            proj = await calculate_projection_v2_from_geo(
                db,
                base_price=body.basePrice,
                inspector_base=body.inspectorBase,
                vehicle_location=body.vehicleLocation,
                city_id=body.cityId,
                country_code=body.countryCode,
                currency=body.currency,
            )
        else:
            if body.distanceKm is None:
                raise HTTPException(
                    400,
                    "Provide either distanceKm or both inspectorBase + vehicleLocation",
                )
            density = await resolve_density(
                db, city_id=body.cityId, country_code=body.countryCode,
            )
            proj = calculate_projection_v2(
                base_price=body.basePrice,
                distance_km=body.distanceKm,
                density=density,
                currency=body.currency,
            )
    except ValueError as e:
        raise HTTPException(400, str(e))

    return proj


# ── Modifier table (transparency) ────────────────────────────────────────

@router.get("/api/pricing/v2/modifiers")
async def get_modifier_table():
    """Public modifier table. Customers can be shown this verbatim — no
    dark patterns, no hidden coefficients. The platform commits to these
    numbers staying locked for the v2 version."""
    return {
        "version": "v2",
        "tiers": [
            {
                "density": d,
                "multiplier": DENSITY_MULTIPLIER[d],
                "reason": DENSITY_REASON[d],
                "forcesManualReview": d == "scarce",
            }
            for d in ("high", "medium", "low", "scarce")
        ],
    }
