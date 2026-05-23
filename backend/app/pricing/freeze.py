"""app.pricing.freeze — version-aware freeze entry point (Pricing-v2B).

Single funnel for "compute and persist a quote for a job". Routes between
v1 and v2 calculators based on `current_version()` AND respects the
immutability invariant:

  • If the existing projection is `status='confirmed'`, return it
    unchanged regardless of current_version. Confirmed v1 quotes stay v1
    forever; confirmed v2 quotes stay v2 forever.
  • For pending/new projections, the calculator is `current_version()`'s.

This is the SOLE writer that v2 freezes should go through. The v1
`save_projection` is preserved for backwards-compat and for already-on-disk
v1 docs, but new freezes should use this module.

Architectural notes:
  • Density snapshot is resolved server-side and embedded into the v2
    projection doc verbatim. No recompute at read time.
  • `explanation` array is part of the frozen doc — future copy changes
    do NOT mutate historical quote semantics. Same principle as
    customer-grammar checksums.
  • v1 path is untouched. Calling code can still freeze v1 explicitly
    via `app.pricing.projection.save_projection` for migrations.
"""
from __future__ import annotations
from typing import Any, Dict, Optional, Tuple

from app.pricing.tiers import CURRENCY
from app.pricing.projection import (
    calculate_projection as _v1_calculate,
    calculate_projection_from_geo as _v1_calculate_from_geo,
    save_projection as _save,
    get_projection,
)
from app.pricing.projection_v2 import (
    calculate_projection_v2 as _v2_calculate,
    calculate_projection_v2_from_geo as _v2_calculate_from_geo,
)
from app.pricing.density_projection import resolve_density
from app.pricing.version_registry import current_version


async def freeze_for_job(
    db,
    *,
    job_id: str,
    base_price: float,
    inspector_base: Optional[Tuple[float, float]] = None,
    vehicle_location: Optional[Tuple[float, float]] = None,
    city_id: Optional[str] = None,
    country_code: Optional[str] = None,
    currency: str = CURRENCY,
) -> Dict[str, Any]:
    """Compute the projection for `job_id` and persist as `pending`
    (or refresh existing pending). Idempotent. NEVER touches confirmed
    projections (they're locked).

    Routing:
      • `current_version()=="v1"` → v1 calculator (no density)
      • `current_version()=="v2"` → v2 calculator (resolves density from
        the inspection LOCATION, not the inspector base)

    For v2 to work, callers SHOULD pass `city_id` so density resolves
    against the city. Falling back to `country_code` is allowed but gives
    coarser density data. With neither, v2 still works but density
    defaults to `scarce` (no signal = conservative cost).
    """
    # Honour the immutability invariant first — confirmed quotes are
    # frozen no matter what version is current today.
    existing = await get_projection(db, job_id=job_id)
    if existing and existing.get("status") == "confirmed":
        return existing

    version = current_version()

    # ── v1 path (legacy, kept for explicit migrations) ─────────────
    if version == "v1":
        if inspector_base and vehicle_location:
            proj = _v1_calculate_from_geo(
                base_price=base_price,
                inspector_base=inspector_base,
                vehicle_location=vehicle_location,
                currency=currency,
            )
        else:
            proj = _v1_calculate(base_price=base_price, distance_km=0, currency=currency)
        return await _save(db, job_id=job_id, projection=proj)

    # ── v2 path (current default) ──────────────────────────────────
    if inspector_base and vehicle_location:
        proj = await _v2_calculate_from_geo(
            db,
            base_price=base_price,
            inspector_base=inspector_base,
            vehicle_location=vehicle_location,
            city_id=city_id,
            country_code=country_code,
            currency=currency,
        )
    else:
        # Pure distance / in-city quote.
        density = await resolve_density(
            db, city_id=city_id, country_code=country_code or "DE",
        )
        proj = _v2_calculate(
            base_price=base_price, distance_km=0,
            density=density, currency=currency,
        )

    return await _save(db, job_id=job_id, projection=proj)
