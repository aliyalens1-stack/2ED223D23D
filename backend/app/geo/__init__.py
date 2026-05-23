"""app.geo — canonical geography namespace.

Single source of truth for countries / cities / inspector base-locations.
Read-only projection over `app.marketplace.cities.CITY_CATALOGUE` so
expansion (add a new country / city) happens in ONE place.

Geo-1 sprint contract:
  GET /api/geo/countries                          → supported countries
  GET /api/geo/countries/{code}/cities            → cities for country
  GET /api/geo/cities/{cityId}                    → single city (canonical record)

Geo-2/3 (future):
  - inspector base topology (`{country, cityId, lat, lng, radiusKm}`)
  - coverage rollups by country/city
  - partner topology
"""
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.marketplace.cities import CITY_CATALOGUE
from app.core.geo import CURRENCY_BY_COUNTRY, LOCALE_BY_COUNTRY
from app.core.redis_state import rate_limit_public
from app.core.db import db

router = APIRouter(tags=["geo"])


class Country(BaseModel):
    code: str          # ISO-3166-1 alpha-2 (DE, UA, LV, ...)
    name: str          # display name in *country's* primary language (Deutschland, Україна)
    flag: str          # emoji flag (UI hint, not authoritative)
    currency: str      # ISO-4217 (EUR/UAH/BYN)
    locale: str        # BCP-47 transactional locale (de-DE, lv-LV, ...)
    cityCount: int     # total cities in catalogue
    supported: bool = True


class CityRef(BaseModel):
    id: str            # canonical city id (== code, immutable)
    country: str
    name: str          # display name in local language (Berlin, Київ, Rīga)
    lat: float
    lng: float
    timezone: str
    currency: str
    providersCount: int = 0


# Display names per ISO code, in each country's primary language.
# IMPORTANT: this is the *country* name (Deutschland, Україна), not the
# UI language — frontend never translates these; it shows them as-is.
COUNTRY_DISPLAY: dict[str, dict] = {
    "DE": {"name": "Deutschland", "flag": "🇩🇪"},
    "AT": {"name": "Österreich",  "flag": "🇦🇹"},
    "LV": {"name": "Latvija",     "flag": "🇱🇻"},
    "LT": {"name": "Lietuva",     "flag": "🇱🇹"},
    "EE": {"name": "Eesti",       "flag": "🇪🇪"},
    "BY": {"name": "Беларусь",    "flag": "🇧🇾"},
    "UA": {"name": "Україна",     "flag": "🇺🇦"},
}

# Country display order (used by frontend dropdowns).
COUNTRY_RANK: dict[str, int] = {
    "DE": 0, "AT": 1,
    "LV": 10, "LT": 11, "EE": 12,
    "BY": 20, "UA": 21,
}


def _build_country_index() -> dict[str, list[dict]]:
    """Bucket CITY_CATALOGUE by ISO country code. Pure-functional."""
    out: dict[str, list[dict]] = {}
    for c in CITY_CATALOGUE:
        out.setdefault(c["country"], []).append(c)
    return out


@router.get("/api/geo/countries", response_model=List[Country])
async def list_countries(_=Depends(rate_limit_public)):
    """List ALL supported countries (currently 7).

    Ordered by COUNTRY_RANK (DACH → Baltic → Belarus → Ukraine).
    """
    idx = _build_country_index()
    out: list[Country] = []
    for code, cities in idx.items():
        meta = COUNTRY_DISPLAY.get(code, {"name": code, "flag": "🌍"})
        out.append(
            Country(
                code=code,
                name=meta["name"],
                flag=meta["flag"],
                currency=CURRENCY_BY_COUNTRY.get(code, "EUR"),
                locale=LOCALE_BY_COUNTRY.get(code, "en-US"),
                cityCount=len(cities),
                supported=True,
            )
        )
    out.sort(key=lambda x: (COUNTRY_RANK.get(x.code, 99), x.name))
    return out


@router.get("/api/geo/countries/{code}/cities", response_model=List[CityRef])
async def list_cities_in_country(code: str, _=Depends(rate_limit_public)):
    """List cities for one country, sorted alphabetically by local name.

    Includes `providersCount` so the dropdown can show density hint
    (`Berlin · 3 workshops` vs `Aachen · looking for inspectors`).
    """
    code = code.upper()
    cities = [c for c in CITY_CATALOGUE if c["country"] == code]
    if not cities:
        raise HTTPException(404, f"country '{code}' not supported")

    # Aggregate provider counts in one round-trip
    pipeline = [
        {"$match": {"status": "active", "city": {"$in": [c["code"] for c in cities]}}},
        {"$group": {"_id": "$city", "n": {"$sum": 1}}},
    ]
    counts: dict[str, int] = {}
    async for r in db.organizations.aggregate(pipeline):
        if r["_id"]:
            counts[r["_id"]] = r["n"]

    refs = [
        CityRef(
            id=c["code"],
            country=c["country"],
            name=c["name"],
            lat=c["lat"],
            lng=c["lng"],
            timezone=c["timezone"],
            currency=c["currency"],
            providersCount=counts.get(c["code"], 0),
        )
        for c in cities
    ]
    refs.sort(key=lambda x: x.name.lower())
    return refs


@router.get("/api/geo/cities/{city_id}", response_model=CityRef)
async def get_city_canonical(city_id: str, _=Depends(rate_limit_public)):
    """Canonical record for one city by its immutable id."""
    c = next((x for x in CITY_CATALOGUE if x["code"] == city_id), None)
    if not c:
        raise HTTPException(404, f"city '{city_id}' not found")
    n = await db.organizations.count_documents({"status": "active", "city": city_id})
    return CityRef(
        id=c["code"],
        country=c["country"],
        name=c["name"],
        lat=c["lat"],
        lng=c["lng"],
        timezone=c["timezone"],
        currency=c["currency"],
        providersCount=n,
    )
