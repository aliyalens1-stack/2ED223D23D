"""app.geo.coverage_projection — Geo-3 sprint.

Operational coverage projection.

This is NOT a map. It's a *projection* over the canonical geography
namespace + provider topology + partners, exposing read-only marketplace
density data to dashboards.

Architectural invariants (enforced by API shape):
    frontend never computes counts
    frontend never aggregates collections
    frontend renders projection as-is

When the projection lies, ops sees it immediately — single observability
surface for "where does our marketplace actually exist today?".

Source-of-truth chain:
    db.provider_topology  ← canonical inspector base (Geo-2)
    db.organizations      ← partners (workshops, detailing, washes) — `status=active`
    CITY_CATALOGUE        ← canonical cities + country mapping

Country activation rule (v1):
    active = (provider_count > 0) OR (partner_count > 0)

Future hook: explicit `db.country_activation` collection with manual
`active=true/false` flags (kept out of v1 to avoid speculative complexity).
"""
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.db import db
from app.core.redis_state import rate_limit_public
from app.marketplace.cities import CITY_CATALOGUE
from app.geo import COUNTRY_DISPLAY  # canonical display names + flags

router = APIRouter(tags=["geo:coverage"])


# ── Projection contracts ─────────────────────────────────────────────────


class CountryCoverage(BaseModel):
    countryCode: str         # ISO-3166-1 alpha-2
    countryName: str         # in country's primary language
    flag: str
    active: bool             # marketplace exists in this country
    providers: int           # count from provider_topology
    partners: int            # count from organizations (status=active)
    cities: int              # count of cities with ≥1 provider OR partner


class CityCoverage(BaseModel):
    cityId: str              # canonical id (CITY_CATALOGUE.code)
    cityName: str            # display name
    countryCode: str
    providers: int           # from provider_topology
    partners: int            # from organizations (status=active)
    lat: float               # backend-resolved center
    lng: float
    density: str             # "empty" | "low" | "medium" | "high" — ops hint


# ── Projection logic (sole place where counts are computed) ──────────────


# Build a fast city → country lookup once at import time
_CITY_TO_COUNTRY: dict[str, str] = {c["code"]: c["country"] for c in CITY_CATALOGUE}
_CITY_BY_ID: dict[str, dict] = {c["code"]: c for c in CITY_CATALOGUE}


async def _provider_counts_by_country() -> dict[str, int]:
    pipeline = [{"$group": {"_id": "$baseCountry", "n": {"$sum": 1}}}]
    counts: dict[str, int] = {}
    async for r in db.provider_topology.aggregate(pipeline):
        if r["_id"]:
            counts[r["_id"]] = int(r["n"])
    return counts


async def _provider_counts_by_city() -> dict[str, int]:
    pipeline = [{"$group": {"_id": "$baseCityId", "n": {"$sum": 1}}}]
    counts: dict[str, int] = {}
    async for r in db.provider_topology.aggregate(pipeline):
        if r["_id"]:
            counts[r["_id"]] = int(r["n"])
    return counts


async def _partner_counts_by_city() -> dict[str, int]:
    """Partners = organizations (workshops/detailing/washes) with status=active."""
    pipeline = [
        {"$match": {"status": "active"}},
        {"$group": {"_id": "$city", "n": {"$sum": 1}}},
    ]
    counts: dict[str, int] = {}
    async for r in db.organizations.aggregate(pipeline):
        if r["_id"]:
            counts[r["_id"]] = int(r["n"])
    return counts


def _density(providers: int, partners: int) -> str:
    """v1 heuristic: simple bucketing for UI hint only. Not authoritative."""
    total = providers + partners
    if total == 0:
        return "empty"
    if total <= 2:
        return "low"
    if total <= 10:
        return "medium"
    return "high"


def _country_display(code: str) -> dict:
    return COUNTRY_DISPLAY.get(code, {"name": code, "flag": "🌍"})


@router.get("/api/geo/coverage/countries", response_model=List[CountryCoverage])
async def country_coverage(_=Depends(rate_limit_public)):
    """Country-level projection. One row per supported country.

    `active` is derived (providers>0 OR partners>0). Frontend MUST render
    this as-is — do not recompute.
    """
    provider_by_country = await _provider_counts_by_country()
    partner_by_city = await _partner_counts_by_city()

    # Derive partner counts per country via CITY → COUNTRY mapping
    partner_by_country: dict[str, int] = {}
    for city_id, n in partner_by_city.items():
        cc = _CITY_TO_COUNTRY.get(city_id)
        if cc:
            partner_by_country[cc] = partner_by_country.get(cc, 0) + n

    # Count distinct cities-with-presence per country
    cities_with_presence: dict[str, set[str]] = {}
    for city_id in partner_by_city.keys():
        cc = _CITY_TO_COUNTRY.get(city_id)
        if cc:
            cities_with_presence.setdefault(cc, set()).add(city_id)

    provider_by_city = await _provider_counts_by_city()
    for city_id in provider_by_city.keys():
        cc = _CITY_TO_COUNTRY.get(city_id)
        if cc:
            cities_with_presence.setdefault(cc, set()).add(city_id)

    out: List[CountryCoverage] = []
    # Iterate over all supported countries (from CITY_CATALOGUE), not just
    # the ones with presence. Empty countries are part of the projection.
    all_countries = sorted({c["country"] for c in CITY_CATALOGUE})
    for cc in all_countries:
        meta = _country_display(cc)
        providers = provider_by_country.get(cc, 0)
        partners = partner_by_country.get(cc, 0)
        out.append(
            CountryCoverage(
                countryCode=cc,
                countryName=meta["name"],
                flag=meta["flag"],
                active=(providers + partners) > 0,
                providers=providers,
                partners=partners,
                cities=len(cities_with_presence.get(cc, set())),
            )
        )
    return out


@router.get("/api/geo/coverage/countries/{code}", response_model=CountryCoverage)
async def country_coverage_one(code: str, _=Depends(rate_limit_public)):
    code = code.upper()
    rows = await country_coverage()
    row = next((r for r in rows if r.countryCode == code), None)
    if not row:
        raise HTTPException(404, f"country '{code}' not supported")
    return row


@router.get("/api/geo/coverage/cities", response_model=List[CityCoverage])
async def city_coverage(
    country: Optional[str] = None,
    onlyWithPresence: bool = False,
    _=Depends(rate_limit_public),
):
    """City-level projection. Optionally filtered by country.

    Args:
        country: ISO-2 country code filter (DE/UA/LV/...).
        onlyWithPresence: if true, hide cities with zero providers AND zero
            partners — useful for dashboards that only want operational sites.
    """
    provider_by_city = await _provider_counts_by_city()
    partner_by_city = await _partner_counts_by_city()

    out: List[CityCoverage] = []
    for c in CITY_CATALOGUE:
        if country and c["country"] != country.upper():
            continue
        prov = provider_by_city.get(c["code"], 0)
        part = partner_by_city.get(c["code"], 0)
        if onlyWithPresence and prov == 0 and part == 0:
            continue
        out.append(
            CityCoverage(
                cityId=c["code"],
                cityName=c["name"],
                countryCode=c["country"],
                providers=prov,
                partners=part,
                lat=float(c["lat"]),
                lng=float(c["lng"]),
                density=_density(prov, part),
            )
        )
    # Sort: highest density first, then by city name
    DENSITY_RANK = {"high": 0, "medium": 1, "low": 2, "empty": 3}
    out.sort(key=lambda r: (DENSITY_RANK.get(r.density, 9), r.cityName.lower()))
    return out


# ── Topology completeness (Geo-4 trust marker) ───────────────────────────


class TopologyCompleteness(BaseModel):
    """How much of the marketplace topology can be trusted?

    `mapped` / `total` providers — i.e. orgs whose `ownerId` has a
    `provider_topology` row. `percent` is convenience for the UI.
    Coverage screen shows this so operators know how much of the
    projection is real vs. blank.
    """
    totalProviders: int
    mappedProviders: int
    percent: float
    unmappedSamples: List[str]  # ≤ 10 org slugs missing topology


@router.get("/api/geo/coverage/topology-completeness", response_model=TopologyCompleteness)
async def topology_completeness(_=Depends(rate_limit_public)):
    """Geo-4 trust marker. Anyone reading the coverage projection should
    glance at this first — if it's 30%, the projection is wishful thinking.
    """
    total = await db.organizations.count_documents({"status": "active"})
    if total == 0:
        return TopologyCompleteness(
            totalProviders=0, mappedProviders=0, percent=0.0, unmappedSamples=[]
        )

    mapped = 0
    unmapped: list[str] = []
    cursor = db.organizations.find(
        {"status": "active"},
        {"_id": 0, "slug": 1, "ownerId": 1},
    )
    async for org in cursor:
        owner_id = org.get("ownerId")
        if not owner_id:
            if len(unmapped) < 10 and org.get("slug"):
                unmapped.append(org["slug"])
            continue
        exists = await db.provider_topology.find_one(
            {"userId": str(owner_id)}, {"_id": 1}
        )
        if exists:
            mapped += 1
        elif len(unmapped) < 10 and org.get("slug"):
            unmapped.append(org["slug"])

    pct = round(mapped / total * 100, 1) if total else 0.0
    return TopologyCompleteness(
        totalProviders=total,
        mappedProviders=mapped,
        percent=pct,
        unmappedSamples=unmapped,
    )
