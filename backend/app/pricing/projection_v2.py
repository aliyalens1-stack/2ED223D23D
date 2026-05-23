"""app.pricing.projection_v2 — Pricing-v2 calculator (density-aware).

V2 design rules (locked, byte-identical forever):

  1. v1 calculator is NEVER edited. v2 wraps v1's distance surcharge with
     a deterministic density multiplier.
  2. Same inputs → same quote forever. The density snapshot is frozen
     into the projection at save time.
  3. NO surge, NO time-of-day, NO weather, NO AI. Density alone.
  4. Fully explainable: every modifier carries a human-readable reason.
  5. Lives ALONGSIDE v1, not replacing it. Old confirmed v1 quotes stay v1.

Output contract (extends v1 contract):

  {
    "pricingVersion": "v2",
    "basePrice": 199,
    "currency": "EUR",
    "includedKm": 100,
    "distanceKm": 220,
    "extraKm": 120,
    "remoteTier": "standard_remote",
    "distanceRate": 0.45,
    "distanceSurchargeBase": 54,         # ← v1's surcharge, unchanged
    "densityMultiplier": 1.15,           # ← v2 multiplier
    "densitySurchargeDelta": 8.0,        # ← extra €€ due to density
    "distanceSurcharge": 62.0,           # ← v1 base × density multiplier
    "manualReview": false,
    "customerTotal": 261,
    "inspectorDistancePayout": 53,       # ← 85% of v2 distanceSurcharge
    "platformDistanceFee": 9,
    "densitySnapshot": { ... frozen snapshot ... },
    "explanation": [
      { "label": "Base inspection", "amount": 199 },
      { "label": "Distance 220 km · standard_remote", "amount": 54 },
      { "label": "Limited inspector coverage (+15%)", "amount": 8 }
    ]
  }
"""
from __future__ import annotations
from typing import Optional, Tuple, Dict, Any

from app.pricing.tiers import (
    INCLUDED_KM, CURRENCY,
    INSPECTOR_DISTANCE_PAYOUT_PCT,
    find_tier,
)
from app.pricing.distance import haversine_km
from app.pricing.density_projection import (
    DensitySnapshot,
    DENSITY_MULTIPLIER,
    snapshot_to_dict,
)


PRICING_VERSION_V2 = "v2"


def _digest_v2(p: Dict[str, Any]) -> str:
    distance = int(round(p.get("distanceKm", 0)))
    tier = p.get("remoteTier", "included")
    surcharge = p.get("distanceSurcharge", 0)
    density = p.get("densityMultiplier", 1.0)
    currency = p.get("currency", "EUR")
    sym = "€" if currency == "EUR" else "$" if currency == "USD" else currency
    if tier == "included" and density == 1.0:
        return f"{distance} km · included"
    parts = [f"{distance} km"]
    if tier != "included":
        parts.append(tier)
    if density != 1.0:
        parts.append(f"density ×{density:g}")
    parts.append(f"+{sym}{int(round(surcharge))}")
    return " · ".join(parts)


def calculate_projection_v2(
    *,
    base_price: float,
    distance_km: float,
    density: DensitySnapshot,
    currency: str = CURRENCY,
) -> Dict[str, Any]:
    """Pure deterministic calculator. No DB, no I/O.

    `density` must be a fully-formed `DensitySnapshot`. The caller (router
    or background tasks) is responsible for resolving it from geo state.
    Keeping resolution outside makes the calculator trivially testable
    and ensures the same snapshot can be reused for both preview and
    freeze paths (so what the customer saw equals what gets frozen).
    """
    if base_price < 0:
        raise ValueError("base_price must be >= 0")
    if distance_km < 0:
        raise ValueError("distance_km must be >= 0")

    distance_km = round(float(distance_km), 1)
    tier = find_tier(distance_km)
    multiplier = density.densityMultiplier
    # Defensive: the modifier table is the only source of truth.
    if multiplier not in DENSITY_MULTIPLIER.values():
        raise ValueError(f"density multiplier {multiplier} not in locked table")

    explanation: list[dict] = [
        {"label": "Base inspection", "amount": round(float(base_price), 2)},
    ]

    if tier is None:
        # Inside included radius → no distance surcharge, but density
        # multiplier still applies to … nothing. v2 still emits a tier
        # field so consumers can read uniform shape.
        base_surcharge = 0.0
        density_delta = 0.0
        final_surcharge = 0.0
        remote_tier = "included"
        distance_rate = 0.0
        extra_km = 0.0
        manual_review = density.manualReview  # scarce can still force manual
    else:
        extra_km = round(distance_km - INCLUDED_KM, 1)
        calculated = extra_km * tier.rate_per_km
        base_surcharge = float(round(max(calculated, tier.minimum_fee)))
        # Density multiplier applies to the v1 distance surcharge.
        # Round to whole euro for clean UX. Never round DOWN on customer
        # total — already enforced by `round(half-to-even)` on raw floats
        # because we round AFTER the multiplication.
        final_surcharge = float(round(base_surcharge * multiplier))
        density_delta = float(round(final_surcharge - base_surcharge, 2))
        remote_tier = tier.tier
        distance_rate = tier.rate_per_km
        # manual review: v1 tier may demand it AND scarce density forces it.
        manual_review = bool(tier.manual_review or density.manualReview)

        explanation.append({
            "label": f"Distance {int(round(distance_km))} km · {remote_tier}",
            "amount": base_surcharge,
        })
        if density_delta != 0.0:
            pct_label = f"({'+' if multiplier > 1 else ''}{int(round((multiplier - 1) * 100))}%)"
            explanation.append({
                "label": f"{density.reason} {pct_label}",
                "amount": density_delta,
            })

    inspector_payout = round(final_surcharge * INSPECTOR_DISTANCE_PAYOUT_PCT, 2)
    platform_fee = round(final_surcharge - inspector_payout, 2)

    result: Dict[str, Any] = {
        "pricingVersion": PRICING_VERSION_V2,
        "basePrice": round(float(base_price), 2),
        "currency": currency,
        "includedKm": INCLUDED_KM,
        "distanceKm": distance_km,
        "extraKm": extra_km,
        "remoteTier": remote_tier,
        "distanceRate": distance_rate,
        "distanceSurchargeBase": base_surcharge,
        "densityMultiplier": multiplier,
        "densitySurchargeDelta": density_delta,
        "distanceSurcharge": final_surcharge,
        "manualReview": manual_review,
        "customerTotal": round(float(base_price) + final_surcharge, 2),
        "inspectorDistancePayout": inspector_payout,
        "platformDistanceFee": platform_fee,
        "densitySnapshot": snapshot_to_dict(density),
        "explanation": explanation,
    }
    result["digest"] = _digest_v2(result)
    return result


async def calculate_projection_v2_from_geo(
    db,
    *,
    base_price: float,
    inspector_base: Tuple[float, float],
    vehicle_location: Tuple[float, float],
    city_id: Optional[str] = None,
    country_code: Optional[str] = None,
    currency: str = CURRENCY,
) -> Dict[str, Any]:
    """Convenience: derive `distance_km` via haversine AND resolve
    density from the given location. Attaches `geo` provenance.

    `city_id` / `country_code` describe the LOCATION OF THE INSPECTION
    (where the vehicle is, not where the inspector is based). Density
    of the customer's location is what determines the modifier — that
    is the structural marketplace cost.
    """
    from app.pricing.density_projection import resolve_density
    distance_km = haversine_km(inspector_base, vehicle_location)
    density = await resolve_density(db, city_id=city_id, country_code=country_code)
    proj = calculate_projection_v2(
        base_price=base_price,
        distance_km=distance_km,
        density=density,
        currency=currency,
    )
    proj["geo"] = {
        "from": list(inspector_base),
        "to": list(vehicle_location),
        "source": "haversine",
    }
    return proj
