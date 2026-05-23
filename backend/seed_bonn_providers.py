"""Idempotent seed for Bonn-area providers (coords ~50.7374, 7.0982).

Run: cd /app/backend && python seed_bonn_providers.py

Why: user opened mobile app in Bonn → map showed "0 мастеров рядом" because
all seeded providers are in Berlin/Munich/Hamburg/Kyiv. This adds 6 real-shaped
provider organizations + branches around Bonn covering all 4 clusters
(inspection / selection / repair / delivery) so the map populates immediately
in the user's locale.

Idempotent: keyed on `slug` — re-running upserts in place, never duplicates.
"""
import asyncio
import os
from datetime import datetime, timezone
from motor.motor_asyncio import AsyncIOMotorClient

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")
NOW = datetime.now(timezone.utc).isoformat()

BONN_PROVIDERS = [
    {
        "name": "Bonn Pre-Purchase Check", "slug": "bonn-pre-purchase-check",
        "description": "TÜV-style pre-purchase inspection. 60-point check, PDF report in 24h.",
        "type": "mobile", "address": "Bonn Zentrum, mobile inspector",
        "lat": 50.7374, "lng": 7.0982,
        "ratingAvg": 4.9, "reviewsCount": 73, "bookingsCount": 118, "completedBookingsCount": 115,
        "avgResponseTimeMinutes": 8, "visibilityScore": 92, "visibilityState": "boosted",
        "badges": ["verified", "tuv", "fast_response"],
        "whyReasons": ["TÜV-certified", "Bonn-based", "PDF in 24h"],
        "priceFrom": 149, "workHours": "Mo-Sa 08:00-20:00",
        "clusters": ["inspection"], "providerType": "inspector",
        "isVerified": True,
    },
    {
        "name": "Rhein Auto Selection", "slug": "rhein-auto-selection",
        "description": "Подбор авто в Германии под ваш бюджет. mobile.de, autoscout24 coverage.",
        "type": "sto", "address": "Bonn-Beuel, Adenauerallee 12",
        "lat": 50.7330, "lng": 7.1100,
        "ratingAvg": 4.8, "reviewsCount": 52, "bookingsCount": 84, "completedBookingsCount": 82,
        "avgResponseTimeMinutes": 25, "visibilityScore": 86, "visibilityState": "normal",
        "badges": ["verified", "expert", "premium"],
        "whyReasons": ["8+ лет опыта", "Полная проверка истории", "Без скрытых платежей"],
        "priceFrom": 450, "workHours": "Mo-Fr 09:00-18:00",
        "clusters": ["selection", "inspection"], "providerType": "buyer",
        "isVerified": True,
    },
    {
        "name": "EU Pригон Bonn", "slug": "eu-prigon-bonn",
        "description": "Пригон авто из Германии под ключ. Растаможка, оплата, доставка.",
        "type": "mobile", "address": "Bonn → EU + Ukraine",
        "lat": 50.7400, "lng": 7.0850,
        "ratingAvg": 4.7, "reviewsCount": 96, "bookingsCount": 142, "completedBookingsCount": 138,
        "avgResponseTimeMinutes": 40, "visibilityScore": 84, "visibilityState": "boosted",
        "badges": ["verified", "logistics", "insured"],
        "whyReasons": ["Door-to-door", "Insured shipping", "EU + UA"],
        "priceFrom": 350, "workHours": "Mo-Fr 09:00-19:00",
        "clusters": ["delivery"], "providerType": "transporter",
        "isVerified": True,
    },
    {
        "name": "AutoService Bonn-Mitte", "slug": "autoservice-bonn-mitte",
        "description": "СТО полного цикла: диагностика, ремонт двигателя, тормоза, электрика.",
        "type": "sto", "address": "Bonn, Münsterplatz 7",
        "lat": 50.7345, "lng": 7.0958,
        "ratingAvg": 4.6, "reviewsCount": 218, "bookingsCount": 412, "completedBookingsCount": 394,
        "avgResponseTimeMinutes": 12, "visibilityScore": 81, "visibilityState": "normal",
        "badges": ["verified", "warranty"],
        "whyReasons": ["12 мес гарантия", "Oригинальные запчасти", "218 отзывов"],
        "priceFrom": 60, "workHours": "Mo-Fr 08:00-19:00",
        "clusters": ["repair"], "providerType": "mechanic",
        "isVerified": True,
    },
    {
        "name": "Bonn Mobile Mechanic 24/7", "slug": "bonn-mobile-mechanic",
        "description": "Выездной механик 24/7. Прикурить, поменять колесо, диагностика на месте.",
        "type": "mobile", "address": "Bonn, mobile",
        "lat": 50.7280, "lng": 7.0700,
        "ratingAvg": 4.8, "reviewsCount": 134, "bookingsCount": 287, "completedBookingsCount": 280,
        "avgResponseTimeMinutes": 18, "visibilityScore": 89, "visibilityState": "boosted",
        "badges": ["verified", "mobile", "24_7"],
        "whyReasons": ["Приедет за 30 мин", "Работает 24/7", "Без скрытых платежей"],
        "priceFrom": 45, "workHours": "24/7",
        "clusters": ["repair"], "providerType": "mobile_mechanic",
        "isVerified": True,
    },
    {
        "name": "Bonn Abschlepp 24", "slug": "bonn-abschlepp-24",
        "description": "Эвакуатор 24/7 по Bonn и окрестностям. Любой вес до 3.5т.",
        "type": "mobile", "address": "Bonn, region-wide",
        "lat": 50.7420, "lng": 7.1050,
        "ratingAvg": 4.7, "reviewsCount": 187, "bookingsCount": 356, "completedBookingsCount": 348,
        "avgResponseTimeMinutes": 22, "visibilityScore": 87, "visibilityState": "normal",
        "badges": ["verified", "24_7", "top_tow"],
        "whyReasons": ["Приедет за 25 мин", "Работает 24/7", "187 отзывов"],
        "priceFrom": 89, "workHours": "24/7",
        "clusters": ["repair", "delivery"], "providerType": "transporter",
        "isVerified": True,
    },
]


async def main():
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    upserted = 0
    for p in BONN_PROVIDERS:
        org_doc = {
            "name": p["name"], "slug": p["slug"],
            "description": p["description"], "type": p["type"],
            "ownerId": f"bonn-seed-{p['slug']}",
            "status": "active", "isVerified": p["isVerified"],
            "location": {"type": "Point", "coordinates": [p["lng"], p["lat"]]},
            "address": p["address"],
            "ratingAvg": p["ratingAvg"], "reviewsCount": p["reviewsCount"],
            "bookingsCount": p["bookingsCount"], "completedBookingsCount": p["completedBookingsCount"],
            "avgResponseTimeMinutes": p["avgResponseTimeMinutes"],
            "visibilityScore": p["visibilityScore"], "visibilityState": p["visibilityState"],
            "serviceIds": [], "isOnline": True,
            "badges": p["badges"], "whyReasons": p["whyReasons"],
            "priceFrom": p["priceFrom"], "workHours": p["workHours"],
            "clusters": p["clusters"], "providerType": p["providerType"],
            "createdAt": NOW, "updatedAt": NOW,
            "seedTag": "bonn",
        }
        result = await db.organizations.update_one(
            {"slug": p["slug"]}, {"$set": org_doc}, upsert=True
        )
        # Get the org _id for branch link
        org = await db.organizations.find_one({"slug": p["slug"]}, {"_id": 1})
        await db.branches.update_one(
            {"organizationId": org["_id"], "seedTag": "bonn"},
            {"$set": {
                "organizationId": org["_id"],
                "name": p["name"], "address": p["address"],
                "location": {"type": "Point", "coordinates": [p["lng"], p["lat"]]},
                "city": "Bonn", "status": "active",
                "isMobile": p["type"] == "mobile",
                "phone": "+49 228 555-0000",
                "workHours": p["workHours"],
                "createdAt": NOW, "seedTag": "bonn",
            }},
            upsert=True,
        )
        upserted += 1
    # Ensure geo index
    try:
        await db.organizations.create_index([("location", "2dsphere")])
        await db.branches.create_index([("location", "2dsphere")])
    except Exception:
        pass
    # Backfill Bonn city if cities collection exists
    bonn_city = {
        "code": "bonn", "name": "Bonn", "country": "DE",
        "lat": 50.7374, "lng": 7.0982,
        "timezone": "Europe/Berlin", "currency": "EUR",
        "aliases": ["Bonn"], "updatedAt": NOW,
    }
    await db.cities.update_one({"code": "bonn"}, {"$set": bonn_city}, upsert=True)
    print(f"[seed_bonn_providers] upserted={upserted} providers + branches near Bonn ({len(BONN_PROVIDERS)} clusters covered).")
    client.close()


if __name__ == "__main__":
    asyncio.run(main())
