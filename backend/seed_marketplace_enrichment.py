"""seed_marketplace_enrichment.py — backfill marketplace showcase data.

Цель: для каждой организации, у которой ещё нет полной витрины, создать:
  • 1 строку в `provider_locations` (GPS-снапшот для карт)
  • 3–5 строк в `providerservices` (услуги с ценой и длительностью)
  • 4–12 строк в `reviews` (отзывы с реалистичными авторами и текстами)

Идемпотентность:
  - provider_locations: ключ providerId (slug). Перезаписываем по slug.
  - providerservices: ключ (organizationId, serviceId) — добавляем только если нет.
  - reviews: помечаем seedTag='marketplace-enrichment'; повторный запуск
    подчищает старые seed-отзывы только если кол-во для org < target.

Usage:
    python /app/backend/seed_marketplace_enrichment.py
"""
from __future__ import annotations
import asyncio
import os
import random
import sys
import uuid
from datetime import datetime, timedelta, timezone

from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)
load_dotenv(os.path.join(ROOT, ".env"))

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ.get("DB_NAME", "test_database")
SEED_TAG = "marketplace-enrichment"

# Real-feel review authors (mix of DE / UA / RU / PL / EN names).
AUTHORS = [
    "Михаил К.", "Дмитрий С.", "Андрей П.", "Олег В.", "Иван Г.",
    "Klaus Berger", "Sven Hoffmann", "Markus Wagner", "Hans Müller", "Thomas Bauer",
    "Anna Schmidt", "Lisa Meier", "Julia Krause", "Sophie Becker", "Emma Fischer",
    "Tomasz Nowak", "Piotr Kowalski", "Jan Wiśniewski", "Kasia Wójcik",
    "Tomas Petrauskas", "Vita Krista", "Mart Tamm",
    "Олена М.", "Тарас Л.", "Юрій К.", "Ірина Б.",
]

REVIEW_TEMPLATES = [
    ("Отличный сервис! Всё сделали быстро и качественно.", 5),
    ("Профессионально и без обмана. Рекомендую.", 5),
    ("Solid Werkstatt. Faire Preise, schnelle Diagnose.", 5),
    ("Sehr kompetent, alles erklärt — TÜV-Vorbereitung perfekt.", 5),
    ("Pre-purchase Check war detailliert, danke!", 5),
    ("Хорошие специалисты, нашли проблему которую другие пропустили.", 5),
    ("Нормально. Цена соответствует качеству.", 4),
    ("Окей, но ждал немного дольше обещанного.", 4),
    ("Friendly staff. Good service, parts on stock.", 4),
    ("Sauber gemacht, allerdings etwas teuer.", 4),
    ("Service good but waited 30 min past appointment.", 3),
    ("Можно было быстрее, но в целом норм.", 4),
    ("Inspection report was thorough. Worth the price.", 5),
    ("Polecam. Rzetelna diagnostyka, uczciwa cena.", 5),
    ("Bardzo profesjonalna obsługa, polecam każdemu.", 5),
]

# Map kind → typical service IDs they offer (by name).
KIND_SERVICE_PROFILES = {
    "workshop":  ["Компьютерная диагностика", "Диагностика ходовой", "Замена масла",
                  "Замена тормозных колодок", "Полное ТО", "Развал-схождение"],
    "inspector": ["Компьютерная диагностика", "Диагностика ходовой", "Полное ТО"],
    "dealer":    ["Полное ТО", "Замена масла", "Компьютерная диагностика"],
    "carwash":   ["Замена масла"],  # минимальный сервис, по сути мойка
    "sto":       ["Компьютерная диагностика", "Диагностика ходовой", "Замена масла",
                  "Замена тормозных колодок", "Ремонт подвески", "Развал-схождение"],
    "inspection":["Компьютерная диагностика", "Диагностика ходовой", "Полное ТО"],
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _uid() -> str:
    return str(uuid.uuid4())


async def _services_index(db) -> dict:
    """name → service _id ObjectId."""
    out = {}
    async for s in db.services.find({}, {"name": 1, "priceFrom": 1, "durationMinutes": 1}):
        out[s["name"]] = s
    return out


async def _backfill_provider_locations(db, orgs: list[dict]) -> int:
    """Create one provider_locations doc per org (idempotent by providerId)."""
    existing_pids = set()
    async for pl in db.provider_locations.find({}, {"providerId": 1}):
        existing_pids.add(pl.get("providerId"))

    to_insert = []
    for org in orgs:
        pid = org.get("slug") or str(org.get("id") or org.get("_id"))
        if pid in existing_pids:
            continue
        coords = org.get("location", {}).get("coordinates") or [0.0, 0.0]
        zone = f"{org.get('city', 'unknown')}-zone-{(hash(pid) % 4) + 1}"
        to_insert.append({
            "providerId": pid,
            "organizationId": org.get("id") or str(org.get("_id")),
            "location": {"type": "Point", "coordinates": coords},
            "zoneId": zone,
            "isOnline": True,
            "heading": 0,
            "speed": 0,
            "updatedAt": _now().isoformat(),
            "seedTag": SEED_TAG,
        })
        existing_pids.add(pid)

    if to_insert:
        CHUNK = 500
        for i in range(0, len(to_insert), CHUNK):
            await db.provider_locations.insert_many(to_insert[i:i + CHUNK])
    return len(to_insert)


async def _backfill_provider_services(db, orgs: list[dict], svc_index: dict) -> int:
    """Add 3–5 providerservices rows for each org that has none."""
    existing_org_ids = set()
    async for ps in db.providerservices.find({}, {"organizationId": 1}):
        existing_org_ids.add(str(ps.get("organizationId")))

    to_insert = []
    for org in orgs:
        oid = str(org.get("id") or org.get("_id"))
        if oid in existing_org_ids:
            continue
        kind = org.get("kind") or org.get("type") or "workshop"
        rng = random.Random(oid)
        profile = KIND_SERVICE_PROFILES.get(kind, KIND_SERVICE_PROFILES["workshop"])
        chosen_names = rng.sample(profile, k=min(len(profile), rng.randint(3, 5)))

        for name in chosen_names:
            svc = svc_index.get(name)
            if not svc:
                continue
            base = svc.get("priceFrom", 500)
            price_from = int(base * (0.9 + rng.random() * 0.4))   # ±0.9–1.3x
            price_min = int(price_from * (1.3 + rng.random() * 0.7))
            to_insert.append({
                "organizationId": svc.get("_id").__class__(oid) if False else oid,  # keep as string for new orgs
                "branchId": None,
                "serviceId": svc["_id"],
                "priceFrom": price_from,
                "priceMin": price_min,
                "description": name,
                "durationMinutes": svc.get("durationMinutes", 60),
                "status": "active",
                "createdAt": _now().isoformat(),
                "seedTag": SEED_TAG,
            })

    if to_insert:
        CHUNK = 500
        for i in range(0, len(to_insert), CHUNK):
            await db.providerservices.insert_many(to_insert[i:i + CHUNK])
    return len(to_insert)


async def _backfill_reviews(db, orgs: list[dict]) -> int:
    """Add 4–12 reviews per org. Targets only orgs with < 3 reviews."""
    # Count existing reviews per org
    counts = {}
    async for row in db.reviews.aggregate([
        {"$group": {"_id": "$organizationId", "n": {"$sum": 1}}},
    ]):
        counts[str(row["_id"])] = row["n"]

    to_insert = []
    for org in orgs:
        oid = str(org.get("id") or org.get("_id"))
        if counts.get(oid, 0) >= 3:
            continue
        rng = random.Random(f"reviews-{oid}")
        n = rng.randint(4, 12)
        for i in range(n):
            text, rating = rng.choice(REVIEW_TEMPLATES)
            days_ago = rng.randint(1, 365)
            to_insert.append({
                "_id": _uid(),
                "organizationId": oid,
                "userId": _uid(),  # synthetic reviewer
                "bookingId": _uid(),
                "authorName": rng.choice(AUTHORS),
                "rating": rating,
                "text": text,
                "createdAt": (_now() - timedelta(days=days_ago)).isoformat(),
                "seedTag": SEED_TAG,
            })

    if to_insert:
        CHUNK = 1000
        for i in range(0, len(to_insert), CHUNK):
            await db.reviews.insert_many(to_insert[i:i + CHUNK])
    return len(to_insert)


async def _refresh_org_aggregates(db) -> int:
    """Recompute reviewsCount + ratingAvg for orgs that received new reviews."""
    pipeline = [
        {"$group": {
            "_id": "$organizationId",
            "n": {"$sum": 1},
            "avg": {"$avg": "$rating"},
        }},
    ]
    updated = 0
    async for row in db.reviews.aggregate(pipeline):
        oid = row["_id"]
        if not oid:
            continue
        # Match by id (string) OR _id (ObjectId) — orgs come from both old & new seeds.
        from bson import ObjectId
        match = {"$or": [{"id": str(oid)}]}
        try:
            match["$or"].append({"_id": ObjectId(oid)})
        except Exception:
            pass
        res = await db.organizations.update_one(
            match,
            {"$set": {
                "reviewsCount": int(row["n"]),
                "ratingAvg": round(float(row["avg"]), 2),
                "statsUpdatedAt": _now(),
            }},
        )
        if res.modified_count:
            updated += 1
    return updated


async def main() -> None:
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]

    print("Loading services catalogue…")
    svc_index = await _services_index(db)
    print(f"  services in catalogue: {len(svc_index)}")

    print("Loading organizations…")
    orgs = await db.organizations.find({}).to_list(length=None)
    print(f"  total organizations: {len(orgs)}")

    print("\nBackfilling provider_locations…")
    n_loc = await _backfill_provider_locations(db, orgs)
    print(f"  ✓ inserted {n_loc} provider_locations")

    print("\nBackfilling providerservices…")
    n_svc = await _backfill_provider_services(db, orgs, svc_index)
    print(f"  ✓ inserted {n_svc} providerservices")

    print("\nBackfilling reviews…")
    n_rev = await _backfill_reviews(db, orgs)
    print(f"  ✓ inserted {n_rev} reviews")

    print("\nRefreshing organization aggregates (ratingAvg, reviewsCount)…")
    n_agg = await _refresh_org_aggregates(db)
    print(f"  ✓ updated {n_agg} organizations")

    # Stats
    print("\n=== Final collection sizes ===")
    for c in ("organizations", "provider_locations", "providerservices", "reviews"):
        total = await db[c].count_documents({})
        print(f"  {c}: {total}")

    client.close()


if __name__ == "__main__":
    asyncio.run(main())
