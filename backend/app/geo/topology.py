"""app.geo.topology — Geo-2 sprint.

Provider/Inspector base topology — canonical truth for "where does this
executor operate from".

Architectural invariant:
    frontend may select geography
    backend resolves coordinates

The client MUST NOT send lat/lng. It sends `{countryCode, cityId,
travelRadiusKm}`; the server resolves `lat`/`lng` from
`CITY_CATALOGUE` (single source of truth, see `app/marketplace/cities.py`).

Stored in `db.provider_topology`, keyed by `userId`. One topology per
account (not per role; in 1E the active account is per-user).

Pricing-3 will read `provider_topology.baseCity` instead of accepting
client-supplied `inspectorBases[]`. The legacy payload is still accepted
as a fallback during the migration window.
"""
from typing import Optional, Literal, List
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.db import db
from app.core.security import verify_user_token, verify_admin_token
from app.marketplace.cities import CITY_CATALOGUE

router = APIRouter(tags=["geo:topology"])

# Travel radius — discrete set (no free input). Validated server-side.
ALLOWED_RADIUS_KM: tuple[int, ...] = (50, 100, 150, 250)
DEFAULT_RADIUS_KM: int = 100
COVERAGE_MODE: Literal["base_city_radius"] = "base_city_radius"


# ── Shared writer (used by PUT endpoint, onboarding, backfill, seeds) ────
async def upsert_topology(
    user_id: str,
    country_code: str,
    city_id: str,
    travel_radius_km: int,
    *,
    mirror_to_user: bool = True,
) -> dict:
    """Canonical writer for `provider_topology`.

    Geo-4 invariant: any code path that creates a marketplace-active
    provider MUST go through this writer. That makes the projection
    trustworthy AND the activation gate honest. Onboarding, backfill
    and the PUT endpoint all delegate here.

    Raises:
        ValueError: if radius is outside ALLOWED_RADIUS_KM or city is not in
            the canonical catalogue. (Callers convert to HTTPException as
            appropriate to their surface.)
    """
    if travel_radius_km not in ALLOWED_RADIUS_KM:
        raise ValueError(
            f"travelRadiusKm must be one of {ALLOWED_RADIUS_KM}, got {travel_radius_km}"
        )
    cc = (country_code or "").upper()
    city = next(
        (c for c in CITY_CATALOGUE if c["code"] == city_id and c["country"] == cc),
        None,
    )
    if not city:
        raise ValueError(f"city '{city_id}' not found in country '{cc}'")

    now_iso = datetime.now(timezone.utc).isoformat()
    doc = {
        "userId": user_id,
        "baseCountry": city["country"],
        "baseCityId": city["code"],
        "baseLat": float(city["lat"]),
        "baseLng": float(city["lng"]),
        "travelRadiusKm": int(travel_radius_km),
        "coverageMode": COVERAGE_MODE,
        "updatedAt": now_iso,
    }
    await db.provider_topology.update_one(
        {"userId": user_id},
        {"$set": doc, "$setOnInsert": {"createdAt": now_iso}},
        upsert=True,
    )
    if mirror_to_user:
        await db.users.update_one(
            {"$or": [{"id": user_id}, {"_id": user_id}]},
            {"$set": {
                "baseCountry": doc["baseCountry"],
                "baseCityId": doc["baseCityId"],
                "baseLat": doc["baseLat"],
                "baseLng": doc["baseLng"],
                "travelRadiusKm": doc["travelRadiusKm"],
            }},
        )
    return doc


class TopologyIn(BaseModel):
    """Client → server. ONLY canonical IDs, no coordinates."""
    countryCode: str = Field(..., min_length=2, max_length=2, description="ISO-3166-1 alpha-2")
    cityId: str = Field(..., min_length=1, description="Canonical city id (== CITY_CATALOGUE code)")
    travelRadiusKm: int = Field(default=DEFAULT_RADIUS_KM)


class Topology(BaseModel):
    """Server → client. lat/lng resolved server-side from city catalogue."""
    userId: str
    baseCountry: str
    baseCityId: str
    baseLat: float
    baseLng: float
    travelRadiusKm: int
    coverageMode: Literal["base_city_radius"] = COVERAGE_MODE
    updatedAt: str  # ISO-8601


def _resolve_city(city_id: str, country_code: str) -> dict:
    """Look up a city in the canonical catalogue. 404 if unknown."""
    c = next(
        (x for x in CITY_CATALOGUE if x["code"] == city_id and x["country"] == country_code.upper()),
        None,
    )
    if not c:
        raise HTTPException(404, f"city '{city_id}' not found in country '{country_code}'")
    return c


@router.get("/api/provider/topology/me", response_model=Optional[Topology])
async def get_my_topology(payload=Depends(verify_user_token)):
    """Read my topology. Returns null if not yet set."""
    user_id = str(payload.get("userId") or payload.get("sub") or payload.get("id"))
    doc = await db.provider_topology.find_one({"userId": user_id}, {"_id": 0})
    return doc  # may be null — frontend handles "not configured yet"


@router.put("/api/provider/topology/me", response_model=Topology)
async def upsert_my_topology(
    body: TopologyIn,
    payload=Depends(verify_user_token),
):
    """Set/update my topology.

    - Rejects free-text city — `cityId` MUST be in CITY_CATALOGUE.
    - Rejects radius outside `ALLOWED_RADIUS_KM`.
    - Resolves lat/lng server-side. Client coordinates are never trusted.
    """
    user_id = str(payload.get("userId") or payload.get("sub") or payload.get("id"))
    try:
        return await upsert_topology(
            user_id=user_id,
            country_code=body.countryCode,
            city_id=body.cityId,
            travel_radius_km=body.travelRadiusKm,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/api/admin/provider-topology")
async def admin_list_topologies(
    country: Optional[str] = None,
    city: Optional[str] = None,
    _admin=Depends(verify_admin_token),
):
    """Admin: list every provider's topology, with optional filters.

    Used by Geo-3 (coverage map) and ops to verify expansion adoption.
    """
    q: dict = {}
    if country:
        q["baseCountry"] = country.upper()
    if city:
        q["baseCityId"] = city
    cursor = db.provider_topology.find(q, {"_id": 0}).sort([("baseCountry", 1), ("baseCityId", 1)])
    items: List[dict] = []
    async for d in cursor:
        items.append(d)
    return {"items": items, "count": len(items)}


@router.get("/api/geo/topology/options")
async def list_topology_options():
    """Discrete UI options the client may offer for radius. Single source of
    truth; the PUT handler validates against the same constant."""
    return {
        "travelRadiusKm": list(ALLOWED_RADIUS_KM),
        "defaultRadiusKm": DEFAULT_RADIUS_KM,
        "coverageMode": [COVERAGE_MODE],
    }



# ── Geo-3 seed hook ──────────────────────────────────────────────────────
# Operational Coverage depends on `provider_topology` being populated.
# Without at least one demo topology row, the projection always reports
# `0 providers` everywhere and the admin observability surface lies.
# This seed plants the canonical demo provider (provider@test.com) at
# Berlin/DE so the Coverage screen reflects a non-trivial topology.
#
# Idempotent. Safe on every cold start.

DEMO_PROVIDER_EMAIL = "provider@test.com"
DEMO_BASE_CITY_ID = "berlin"
DEMO_BASE_COUNTRY = "DE"
DEMO_TRAVEL_RADIUS_KM = 100


async def seed_demo_topology() -> None:
    """Plant one canonical `provider_topology` row for the demo provider.

    Tied to Berlin (matches Geo-1 demo cities + Geo-3 organizations seed
    which already place 3 partners in Berlin). Without this, every Geo-3
    coverage tile shows `providers: 0` — projection becomes untrustworthy.
    """
    provider = await db.users.find_one({"email": DEMO_PROVIDER_EMAIL})
    if not provider:
        # No demo provider — nothing to seed. Not an error.
        return

    user_id = str(provider.get("_id") or provider.get("id"))
    if not user_id:
        return

    try:
        await upsert_topology(
            user_id=user_id,
            country_code=DEMO_BASE_COUNTRY,
            city_id=DEMO_BASE_CITY_ID,
            travel_radius_km=DEMO_TRAVEL_RADIUS_KM,
        )
    except ValueError:
        # Demo constants are guarded by unit tests; swallow to keep seed
        # non-fatal in case CITY_CATALOGUE is mid-migration.
        return



# ── Geo-4 marketplace-active gate ────────────────────────────────────────
# Invariant: a provider may be `status='active'` in `organizations` but
# is NOT marketplace-active until they have a `provider_topology` row.
# Matching/pricing/quote-resolution should call this helper instead of
# trusting `organizations.status` alone.


async def is_marketplace_active(owner_id: str) -> bool:
    """True iff the provider's account has a topology row AND their
    organization is `status='active'`. Conservative — if either signal
    is missing we return False rather than guessing.
    """
    if not owner_id:
        return False
    topo = await db.provider_topology.find_one(
        {"userId": str(owner_id)}, {"_id": 1}
    )
    if not topo:
        return False
    org = await db.organizations.find_one(
        {"ownerId": str(owner_id), "status": "active"}, {"_id": 1}
    )
    return org is not None


@router.get("/api/provider/topology/me/marketplace-active")
async def get_my_marketplace_active(payload=Depends(verify_user_token)):
    """Provider-facing self-check. Returns whether the calling provider
    is marketplace-active and, if not, the missing signal — so the UI
    can route them to the topology screen instead of "Why am I not
    receiving leads?" support tickets.
    """
    user_id = str(payload.get("userId") or payload.get("sub") or payload.get("id"))
    topo = await db.provider_topology.find_one({"userId": user_id}, {"_id": 0})
    org = await db.organizations.find_one(
        {"ownerId": user_id, "status": "active"}, {"_id": 0, "slug": 1, "status": 1}
    )
    return {
        "marketplaceActive": bool(topo and org),
        "hasTopology": bool(topo),
        "hasActiveOrg": bool(org),
        "missing": (
            None if (topo and org)
            else "topology" if not topo
            else "active_org"
        ),
    }
