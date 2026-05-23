"""Pricing projection — deterministic calculator + Mongo storage.

This is the SINGLE source of truth for inspection quotes. The flow:

  request created
      ↓
  geo resolved (inspector base ↔ vehicle location)
      ↓
  distance.haversine_km()
      ↓
  calculate_projection()       ← pure function, no I/O
      ↓
  save_projection(db, ...)     ← writes a `pending` quote for a job
      ↓
  confirm_projection(db, ...)  ← customer accepts → `confirmed`, IMMUTABLE

Once a projection moves to `confirmed`, it is NEVER recomputed —
even if tiers/rates change later. The customer sees what they agreed to,
forever. Re-saves on a confirmed projection are silently no-op'd.

Projection shape (Mongo: `inspection_pricing_projection`):

  {
    "jobId": "job_123",
    "pricingVersion": "v1",
    "basePrice": 199,
    "currency": "EUR",
    "includedKm": 100,
    "distanceKm": 220,
    "extraKm": 120,
    "remoteTier": "standard_remote",
    "distanceRate": 0.45,
    "distanceSurcharge": 54,
    "manualReview": false,
    "customerTotal": 253,
    "inspectorDistancePayout": 46,
    "platformDistanceFee": 8,
    "createdAt": "...",
    "geo": { "from": [lat,lng], "to": [lat,lng], "source": "haversine" }
  }
"""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Optional, Tuple, Dict, Any

from app.pricing.tiers import (
    PRICING_VERSION, INCLUDED_KM, CURRENCY,
    INSPECTOR_DISTANCE_PAYOUT_PCT, PLATFORM_DISTANCE_FEE_PCT,
    find_tier,
)
from app.pricing.distance import haversine_km


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# Short human digest — for support, inspector lists, admin grids.
# Example: "220 km · standard_remote · +€54".
def make_digest(projection: Dict[str, Any]) -> str:
    distance = int(round(projection.get("distanceKm", 0)))
    tier = projection.get("remoteTier", "included")
    surcharge = projection.get("distanceSurcharge", 0)
    currency = projection.get("currency", "EUR")
    sym = "€" if currency == "EUR" else "$" if currency == "USD" else currency
    if tier == "included":
        return f"{distance} km · included"
    return f"{distance} km · {tier} · +{sym}{int(round(surcharge))}"


def calculate_projection(
    *,
    base_price: float,
    distance_km: float,
    currency: str = CURRENCY,
) -> Dict[str, Any]:
    """Pure deterministic calculator. No DB, no I/O.

    Returns a fully populated projection dict (without `jobId` / `geo`,
    which are added by `save_projection`).
    """
    if base_price < 0:
        raise ValueError("base_price must be >= 0")
    if distance_km < 0:
        raise ValueError("distance_km must be >= 0")

    distance_km = round(float(distance_km), 1)
    tier = find_tier(distance_km)

    if tier is None:
        # Inside included radius — no surcharge.
        result = {
            "pricingVersion": PRICING_VERSION,
            "basePrice": round(float(base_price), 2),
            "currency": currency,
            "includedKm": INCLUDED_KM,
            "distanceKm": distance_km,
            "extraKm": 0,
            "remoteTier": "included",
            "distanceRate": 0.0,
            "distanceSurcharge": 0.0,
            "manualReview": False,
            "customerTotal": round(float(base_price), 2),
            "inspectorDistancePayout": 0.0,
            "platformDistanceFee": 0.0,
        }
        result["digest"] = make_digest(result)
        return result

    extra_km = round(distance_km - INCLUDED_KM, 1)
    calculated = extra_km * tier.rate_per_km
    surcharge = max(calculated, tier.minimum_fee)
    # Round to whole euro for clean UX — never round DOWN on customer total.
    surcharge = float(round(surcharge))

    inspector_payout = round(surcharge * INSPECTOR_DISTANCE_PAYOUT_PCT, 2)
    platform_fee = round(surcharge - inspector_payout, 2)  # avoid rounding drift

    result = {
        "pricingVersion": PRICING_VERSION,
        "basePrice": round(float(base_price), 2),
        "currency": currency,
        "includedKm": INCLUDED_KM,
        "distanceKm": distance_km,
        "extraKm": extra_km,
        "remoteTier": tier.tier,
        "distanceRate": tier.rate_per_km,
        "distanceSurcharge": surcharge,
        "manualReview": tier.manual_review,
        "customerTotal": round(float(base_price) + surcharge, 2),
        "inspectorDistancePayout": inspector_payout,
        "platformDistanceFee": platform_fee,
    }
    result["digest"] = make_digest(result)
    return result


def calculate_projection_from_geo(
    *,
    base_price: float,
    inspector_base: Tuple[float, float],
    vehicle_location: Tuple[float, float],
    currency: str = CURRENCY,
) -> Dict[str, Any]:
    """Same as `calculate_projection` but receives the two geo points and
    derives `distance_km` via haversine. Attaches `geo` provenance to the
    returned projection so it can be audited later.
    """
    distance_km = haversine_km(inspector_base, vehicle_location)
    proj = calculate_projection(
        base_price=base_price,
        distance_km=distance_km,
        currency=currency,
    )
    proj["geo"] = {
        "from": list(inspector_base),
        "to": list(vehicle_location),
        "source": "haversine",
    }
    return proj


async def save_projection(db, *, job_id: str, projection: Dict[str, Any]) -> Dict[str, Any]:
    """Persist (or refresh) the `pending` projection for a job.

    Idempotent on `jobId`. Behaviour:
      • If no projection exists → create with `status="pending"`.
      • If a `pending` projection exists → refresh recomputed fields,
        keep original `createdAt`.
      • If a `confirmed` projection exists → IMMUTABLE. Return the
        existing doc unchanged. This is the marketplace invariant:
        once the customer agreed to the total, the platform cannot
        silently change it.

    Returns the projection doc as it ended up in Mongo (so the caller
    can detect a no-op confirm by comparing `status`).
    """
    existing = await db.inspection_pricing_projection.find_one(
        {"jobId": job_id}, {"_id": 0}
    )
    if existing and existing.get("status") == "confirmed":
        # Locked. Do not refresh, do not silently change anything.
        return existing

    doc = {**projection, "jobId": job_id}
    if existing and existing.get("createdAt"):
        doc["createdAt"] = existing["createdAt"]
        doc["status"] = existing.get("status", "pending")
    else:
        doc["createdAt"] = _now_iso()
        doc["status"] = "pending"
    doc["updatedAt"] = _now_iso()
    await db.inspection_pricing_projection.update_one(
        {"jobId": job_id},
        {"$set": doc},
        upsert=True,
    )
    doc.pop("_id", None)
    return doc


async def confirm_projection(db, *, job_id: str, by_user_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Lock the projection as the customer-accepted quote.

    Returns:
      • The frozen projection doc when confirmation succeeds (or was
        already in place — idempotent).
      • None if no projection exists for this job.

    Re-confirming a confirmed projection is a no-op (idempotent).
    """
    existing = await db.inspection_pricing_projection.find_one(
        {"jobId": job_id}, {"_id": 0}
    )
    if not existing:
        return None
    if existing.get("status") == "confirmed":
        return existing  # already frozen

    confirmed_at = _now_iso()
    update_fields: Dict[str, Any] = {
        "status": "confirmed",
        "confirmedAt": confirmed_at,
        "updatedAt": confirmed_at,
    }
    if by_user_id:
        update_fields["confirmedBy"] = by_user_id
    await db.inspection_pricing_projection.update_one(
        {"jobId": job_id},
        {"$set": update_fields},
    )
    return {**existing, **update_fields}


async def get_projection(db, *, job_id: str) -> Optional[Dict[str, Any]]:
    return await db.inspection_pricing_projection.find_one({"jobId": job_id}, {"_id": 0})
