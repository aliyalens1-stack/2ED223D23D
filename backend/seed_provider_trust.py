"""Sprint 5 seed — create realistic provider trust data.

Picks 5 existing organizations, creates customer/provider user pairs
and synthesizes 6-12 released service_requests + revealed mutual reviews
per provider, then recomputes provider_reputation aggregate.

Result: 5 trust profiles ready for screenshots / demos.
"""
import asyncio
import random
import uuid
from datetime import datetime, timezone, timedelta

import bcrypt
from motor.motor_asyncio import AsyncIOMotorClient

MONGO = "mongodb://localhost:27017"
DB = "test_database"

POSITIVE = ["fast", "professional", "quality_work", "communicative", "punctual", "clean"]
NEGATIVE = ["late", "expensive"]
CATEGORIES = ["repair", "wash", "battery", "detailing", "tow", "inspection"]
TITLES = {
    "repair": ["Замена тормозных колодок", "Диагностика двигателя", "Замена масла", "Развал-схождение"],
    "wash": ["Комплексная мойка", "Химчистка салона", "Мойка двигателя"],
    "battery": ["Запуск аккумулятора", "Замена АКБ"],
    "detailing": ["Полировка кузова", "Керамическое покрытие", "Детейлинг салона"],
    "tow": ["Эвакуация на сервис", "Эвакуация после ДТП"],
    "inspection": ["Предпокупочный осмотр", "Диагностика подвески"],
}
COMMENTS_POSITIVE = [
    "Сделали быстро и аккуратно. Рекомендую!",
    "Профессиональный подход, цена соответствует качеству.",
    "Всё чётко. Приехал вовремя, объяснил каждый шаг.",
    "Машина как новая. Спасибо!",
    "Отличный сервис, буду обращаться ещё.",
    "На связи весь процесс, без сюрпризов по цене.",
    "Очень доволен, мастер своё дело знает.",
    "",  # some reviews without comment
    "",
]
COMMENTS_MIXED = [
    "Работа сделана, но цена выше ожидаемой.",
    "Качественно, но пришлось подождать дольше обещанного.",
    "Норм, в целом ОК.",
]


def now_iso(offset_hours=0):
    return (datetime.now(timezone.utc) - timedelta(hours=offset_hours)).isoformat()


async def main():
    client = AsyncIOMotorClient(MONGO)
    db = client[DB]
    pwd_hash = bcrypt.hashpw(b"Test1234!", bcrypt.gensalt()).decode()

    # Pick 5 random workshops to use as providers (these have real slugs in marketplace).
    orgs_cursor = db.organizations.find({"providerType": "workshop"}, {"_id": 1, "name": 1, "slug": 1}).limit(5)
    orgs = await orgs_cursor.to_list(length=5)
    if not orgs:
        # Fallback: any 5
        orgs = await db.organizations.find({}, {"_id": 1, "name": 1, "slug": 1}).limit(5).to_list(length=5)

    print(f"Seeding trust for {len(orgs)} providers")

    # Reset prior demo data so re-running is idempotent.
    await db.provider_reviews.delete_many({"requestId": {"$regex": "^trust-seed-"}})
    await db.provider_reputation.delete_many({"providerId": {"$regex": "^trust-seed-provider-"}})
    await db.service_requests.delete_many({"id": {"$regex": "^trust-seed-"}})
    await db.users.delete_many({"_id": {"$regex": "^trust-seed-"}})

    for idx, org in enumerate(orgs):
        provider_id = f"trust-seed-provider-{idx}"
        org_id = org["_id"]
        # Create provider user.
        await db.users.insert_one({
            "_id": provider_id,
            "id": provider_id,
            "email": f"{provider_id}@demo.local",
            "passwordHash": pwd_hash,
            "role": "provider",
            "firstName": org.get("name", "Provider")[:20],
            "lastName": "",
            "subscriptionTier": random.choice(["pro", "pro", "premium", "free"]),
            "linkedOrganizationId": org_id,
            "isActive": True,
            "createdAt": now_iso(720),
        })

        # Generate 8-12 customers + released requests with mutual reviews.
        n_jobs = random.randint(8, 14)
        rating_pool = [5] * 6 + [4] * 3 + [3] * 1  # skewed positive
        random.shuffle(rating_pool)

        for j in range(n_jobs):
            customer_id = f"trust-seed-customer-{idx}-{j}"
            request_id = f"trust-seed-req-{idx}-{j}"
            cat = random.choice(CATEGORIES)
            title = random.choice(TITLES[cat])
            amount = random.choice([50, 80, 120, 150, 220, 300, 400, 600])
            response_seconds = random.randint(120, 900)  # 2-15 min
            completed_at = now_iso(random.randint(2, 600))

            await db.users.insert_one({
                "_id": customer_id,
                "id": customer_id,
                "email": f"{customer_id}@demo.local",
                "passwordHash": pwd_hash,
                "role": "customer",
                "firstName": random.choice(["Иван", "Михаил", "Анна", "Сергей", "Ольга", "Дмитрий", "Елена"]),
                "isActive": True,
                "createdAt": now_iso(720),
            })

            await db.service_requests.insert_one({
                "id": request_id,
                "customerId": customer_id,
                "providerId": provider_id,
                "category": cat,
                "title": title,
                "status": "released",
                "amount": amount,
                "responseSeconds": response_seconds,
                "completedAt": completed_at,
                "releasedAt": completed_at,
                "updatedAt": completed_at,
            })

            rating = rating_pool[j % len(rating_pool)]
            tags = (
                random.sample(POSITIVE, k=random.randint(1, 3))
                if rating >= 4
                else random.sample(NEGATIVE + ["incomplete"], k=random.randint(1, 2))
            )
            comment_pool = COMMENTS_POSITIVE if rating >= 4 else COMMENTS_MIXED
            comment = random.choice(comment_pool) or None

            # Customer → Provider (revealed)
            await db.provider_reviews.insert_one({
                "id": uuid.uuid4().hex,
                "requestId": request_id,
                "providerId": provider_id,
                "customerId": customer_id,
                "authorRole": "customer",
                "authorId": customer_id,
                "targetRole": "provider",
                "rating": rating,
                "tags": tags,
                "comment": comment,
                "visibility": "revealed",
                "createdAt": completed_at,
                "revealedAt": completed_at,
            })
            # Provider → Customer (revealed, mostly 5)
            await db.provider_reviews.insert_one({
                "id": uuid.uuid4().hex,
                "requestId": request_id,
                "providerId": provider_id,
                "customerId": customer_id,
                "authorRole": "provider",
                "authorId": provider_id,
                "targetRole": "customer",
                "rating": random.choice([5, 5, 5, 4]),
                "tags": random.sample(POSITIVE, k=random.randint(0, 2)),
                "comment": random.choice(["", "Хороший клиент.", "Спасибо за заказ!"]) or None,
                "visibility": "revealed",
                "createdAt": completed_at,
                "revealedAt": completed_at,
            })

        # Recompute aggregate.
        from app.provider_trust.engine import recompute_provider_reputation
        snap = await recompute_provider_reputation(db, provider_id)
        print(f"  ✓ provider={provider_id} avg={snap['avgRating']} reviews={snap['totalReviews']} jobs={snap['completedJobs']} badges={snap['badges']}")

    # Add one provider with very few reviews to test rising_star
    rising_id = "trust-seed-provider-rising"
    await db.users.insert_one({
        "_id": rising_id,
        "id": rising_id,
        "email": f"{rising_id}@demo.local",
        "passwordHash": pwd_hash,
        "role": "provider",
        "firstName": "New Rising",
        "lastName": "",
        "subscriptionTier": "free",
        "isActive": True,
        "createdAt": now_iso(72),
    })
    for j in range(4):
        cid = f"trust-seed-customer-rising-{j}"
        rid = f"trust-seed-req-rising-{j}"
        completed_at = now_iso(random.randint(6, 96))
        await db.users.insert_one({
            "_id": cid, "id": cid, "email": f"{cid}@demo.local", "passwordHash": pwd_hash,
            "role": "customer", "firstName": "Demo", "isActive": True, "createdAt": now_iso(72),
        })
        await db.service_requests.insert_one({
            "id": rid, "customerId": cid, "providerId": rising_id,
            "category": "wash", "title": "Комплексная мойка", "status": "released",
            "amount": 35, "responseSeconds": 240, "completedAt": completed_at,
            "releasedAt": completed_at, "updatedAt": completed_at,
        })
        await db.provider_reviews.insert_one({
            "id": uuid.uuid4().hex, "requestId": rid, "providerId": rising_id,
            "customerId": cid, "authorRole": "customer", "authorId": cid, "targetRole": "provider",
            "rating": 5, "tags": ["fast", "clean"], "comment": "Отличный новичок!",
            "visibility": "revealed", "createdAt": completed_at, "revealedAt": completed_at,
        })
        await db.provider_reviews.insert_one({
            "id": uuid.uuid4().hex, "requestId": rid, "providerId": rising_id,
            "customerId": cid, "authorRole": "provider", "authorId": rising_id, "targetRole": "customer",
            "rating": 5, "tags": [], "comment": None,
            "visibility": "revealed", "createdAt": completed_at, "revealedAt": completed_at,
        })
    import sys
    sys.path.insert(0, "/app/backend")
    from app.provider_trust.engine import recompute_provider_reputation
    snap = await recompute_provider_reputation(db, rising_id)
    print(f"  ✓ rising={rising_id} avg={snap['avgRating']} reviews={snap['totalReviews']} badges={snap['badges']}")

    # Also create pending review pairs for the test customer (for /review/pending demo)
    pending_customer_id = "trust-seed-customer-pending"
    pending_provider_id = "trust-seed-provider-0"  # reuse first seeded provider
    await db.users.delete_many({"_id": pending_customer_id})
    await db.users.insert_one({
        "_id": pending_customer_id,
        "id": pending_customer_id,
        "email": "trust-pending@demo.local",
        "passwordHash": pwd_hash,
        "role": "customer",
        "firstName": "Pending",
        "lastName": "Demo",
        "isActive": True,
        "createdAt": now_iso(48),
    })
    for k in range(3):
        rid = f"trust-seed-pending-req-{k}"
        completed_at = now_iso(random.randint(2, 24))
        cat = random.choice(["repair", "wash", "battery"])
        await db.service_requests.insert_one({
            "id": rid, "customerId": pending_customer_id, "providerId": pending_provider_id,
            "category": cat, "title": random.choice(TITLES[cat]),
            "status": "released", "amount": random.choice([45, 90, 150]),
            "responseSeconds": 200, "completedAt": completed_at,
            "releasedAt": completed_at, "updatedAt": completed_at,
        })

    print(f"\n✓ Seed complete. Demo customer (3 pending reviews): trust-pending@demo.local / Test1234!")
    print(f"✓ Trust profile URLs (mobile):")
    for i in range(len(orgs)):
        print(f"    /trust/provider/trust-seed-provider-{i}")
    print(f"    /trust/provider/{rising_id}")


if __name__ == "__main__":
    asyncio.run(main())
