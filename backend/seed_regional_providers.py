"""
Seed providers across all 7 supported countries: DE, PL, LT, LV, EE, BY, UA.

Per city we create FOUR partner kinds (matches the map UI):
  • workshop   — partner-СТО (yellow 🔧 marker)
  • inspector  — partner-подборщики / mobile car inspectors (blue 🔍)
  • dealer     — partner-дилерские салоны (purple 🏢)
  • carwash    — partner-мойки (cyan 🚿, shown only when a city is selected)

Idempotent: re-creates by `slug` (so the same script can grow over time).

Usage:
    cd /app/backend && python seed_regional_providers.py
"""
import ast
import asyncio
import os
import random
import re
import sys
import uuid
from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)
load_dotenv(os.path.join(ROOT, ".env"))


def _load_cities_catalogue() -> list:
    """Parse CITY_CATALOGUE from app/marketplace/cities.py without triggering
    its `from server import db` side effect (circular import)."""
    path = os.path.join(ROOT, "app", "marketplace", "cities.py")
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()
    m = re.search(r"CITY_CATALOGUE\s*:\s*[^=]*=\s*(\[.+?\n\])", src, re.DOTALL)
    if not m:
        raise RuntimeError("CITY_CATALOGUE not found in cities.py")
    return ast.literal_eval(m.group(1))


CITY_CATALOGUE = _load_cities_catalogue()
SUPPORTED = {"DE", "AT", "PL", "LT", "LV", "EE", "BY", "UA"}

# Per-kind counts per city. Workshops + washes are most common, dealers rarest.
KIND_COUNTS = {
    "workshop":  5,   # партнёрские СТО
    "inspector": 3,   # партнёрские подборщики (mobile inspectors)
    "dealer":    2,   # партнёрские дилерские салоны
    "carwash":   5,   # партнёрские мойки (city-scoped on the map)
}

KIND_DISPLAY = {
    "workshop":  ("Auto-Service",      "Партнёрское СТО"),
    "inspector": ("Mobile Inspector",  "Подборщик-партнёр"),
    "dealer":    ("Auto Salon",        "Дилерский салон"),
    "carwash":   ("Car Wash",          "Автомойка-партнёр"),
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def make_org(city: dict, kind: str, idx: int) -> dict:
    """Build one organization document for the given city + kind + index."""
    name_en, name_ru = KIND_DISPLAY[kind]
    slug = f"{city['code']}-{kind}-{idx}"
    # Spread sibling orgs around the city centre (~1-3 km offsets).
    rng = random.Random(slug)
    jitter_lat = (rng.random() - 0.5) * 0.025
    jitter_lng = (rng.random() - 0.5) * 0.040
    return {
        "id": str(uuid.uuid4()),
        "slug": slug,
        "name": f"{city['name']} {name_en} #{idx}",
        "displayName": f"{name_ru} · {city['name']} #{idx}",
        "city": city["code"],
        "country": city["country"],
        "address": f"{city['name']}, {kind} hub #{idx}",
        "location": {
            "type": "Point",
            "coordinates": [
                round(city["lng"] + jitter_lng, 6),
                round(city["lat"] + jitter_lat, 6),
            ],
        },
        # Numeric helpers used downstream:
        "ratingAvg": round(4.3 + rng.random() * 0.7, 2),  # 4.3 — 5.0
        "reviewsCount": rng.randint(8, 180),
        "isOnline": True,
        "isVerified": True,
        "isPromoted": False,
        "status": "active",
        "kind": kind,
        # Partner contract — UI consumes this for filter chips:
        "partnerType": kind,
        "isPartner": True,
        "serviceIds": [],
        "avgResponseTimeMinutes": rng.randint(5, 25),
        "completedBookingsCount": rng.randint(15, 320),
        "createdAt": now_iso(),
    }


async def main() -> None:
    mongo_url = os.environ["MONGO_URL"]
    db_name = os.environ.get("DB_NAME", "test_database")
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    target_cities = [c for c in CITY_CATALOGUE if c["country"] in SUPPORTED]
    print(f"Target cities: {len(target_cities)} across {len(SUPPORTED)} countries")
    print(f"Kinds per city: {KIND_COUNTS}")

    existing_slugs = {
        d["slug"] async for d in db.organizations.find({}, {"_id": 0, "slug": 1}) if d.get("slug")
    }
    print(f"Existing org slugs in DB: {len(existing_slugs)}")

    to_insert = []
    for city in target_cities:
        for kind, count in KIND_COUNTS.items():
            for idx in range(1, count + 1):
                org = make_org(city, kind, idx)
                if org["slug"] in existing_slugs:
                    continue
                to_insert.append(org)
                existing_slugs.add(org["slug"])

    if not to_insert:
        print("Nothing to insert — all targets already seeded.")
    else:
        print(f"Inserting {len(to_insert)} new organizations…")
        # Insert in chunks to avoid hitting BSON limits on huge runs.
        CHUNK = 500
        for i in range(0, len(to_insert), CHUNK):
            await db.organizations.insert_many(to_insert[i:i + CHUNK])

    # Stats
    pipeline = [
        {"$match": {"country": {"$in": list(SUPPORTED)}}},
        {"$group": {"_id": {"country": "$country", "kind": "$kind"}, "count": {"$sum": 1}}},
        {"$sort": {"_id.country": 1, "_id.kind": 1}},
    ]
    print("\nProviders per country × kind after seed:")
    async for row in db.organizations.aggregate(pipeline):
        c = row["_id"]["country"]
        k = row["_id"]["kind"] or "(legacy)"
        print(f"  {c} · {k}: {row['count']}")

    total = await db.organizations.count_documents({"country": {"$in": list(SUPPORTED)}})
    print(f"\nGrand total in 7-country region: {total}")
    print("Done.")
    client.close()


if __name__ == "__main__":
    asyncio.run(main())
