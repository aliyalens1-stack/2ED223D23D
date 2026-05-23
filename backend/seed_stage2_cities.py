"""Stage 2 — Seed additional cities (Munich, Hamburg, Lviv, Odesa)."""
import asyncio
import os
from motor.motor_asyncio import AsyncIOMotorClient


CITY_SEEDS = [
    # Munich
    {"city": "munich", "lat": 48.1351, "lng": 11.5820, "name": "AutoZentrum München",  "slug": "autozentrum-muenchen",  "address": "München, Maximilianstr. 12"},
    {"city": "munich", "lat": 48.1400, "lng": 11.5650, "name": "Bayern Werkstatt",     "slug": "bayern-werkstatt",      "address": "München, Marienplatz 5"},
    # Hamburg
    {"city": "hamburg", "lat": 53.5511, "lng": 9.9937, "name": "Hafen Auto Service",   "slug": "hafen-auto-service",    "address": "Hamburg, Reeperbahn 15"},
    {"city": "hamburg", "lat": 53.5680, "lng": 9.9870, "name": "Nord KFZ Express",     "slug": "nord-kfz-express",      "address": "Hamburg, Altona 8"},
    # Lviv
    {"city": "lviv",    "lat": 49.8397, "lng": 24.0297, "name": "Львів Авто-Сервіс",   "slug": "lviv-auto-servis",      "address": "Львів, пл. Ринок 10"},
    {"city": "lviv",    "lat": 49.8350, "lng": 24.0250, "name": "Галицький Майстер",   "slug": "galytskyi-maister",     "address": "Львів, вул. Городоцька 25"},
    # Odesa
    {"city": "odesa",   "lat": 46.4825, "lng": 30.7233, "name": "Чорноморський Авто",  "slug": "chornomorskyi-avto",    "address": "Одеса, вул. Дерибасівська 12"},
    {"city": "odesa",   "lat": 46.4900, "lng": 30.7400, "name": "Привоз Service",      "slug": "pryvoz-service",        "address": "Одеса, Приморський бульвар 3"},
]


async def main() -> None:
    client = AsyncIOMotorClient(os.getenv("MONGO_URL", "mongodb://localhost:27017"))
    db = client["auto_platform"]

    inserted = 0
    skipped = 0
    for s in CITY_SEEDS:
        existing = await db.organizations.find_one({"slug": s["slug"]}, {"_id": 1})
        if existing:
            skipped += 1
            continue
        doc = {
            "name": s["name"],
            "slug": s["slug"],
            "city": s["city"],
            "address": s["address"],
            "description": f"{s['name']} — verified workshop in {s['city'].title()}",
            "type": "garage",
            "status": "active",
            "isVerified": True,
            "isOnline": True,
            "ratingAvg": 4.5,
            "reviewsCount": 24,
            "bookingsCount": 80,
            "completedBookingsCount": 75,
            "avgResponseTimeMinutes": 12,
            "visibilityScore": 0.7,
            "visibilityState": "active",
            "serviceIds": ["oil_change", "brakes", "diagnostics"],
            "badges": ["verified"],
            "whyReasons": ["Verified", "Quick response"],
            "priceFrom": 80,
            "workHours": "Mo-Fr 08:00-19:00",
            "clusters": ["repair", "inspection"],
            "providerType": "garage",
            "location": {"type": "Point", "coordinates": [s["lng"], s["lat"]]},
        }
        await db.organizations.insert_one(doc)
        inserted += 1

    print(f"Seeded: inserted={inserted}, skipped(existing)={skipped}")
    # totals per city
    pipeline = [{"$match": {"status": "active"}}, {"$group": {"_id": "$city", "n": {"$sum": 1}}}]
    async for r in db.organizations.aggregate(pipeline):
        print(f"  city={r['_id']!s:20} n={r['n']}")


if __name__ == "__main__":
    asyncio.run(main())
