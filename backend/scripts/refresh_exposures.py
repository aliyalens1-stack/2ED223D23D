"""Refresh TTL on existing exposures so user can actually test the take-flow.

Targets the seeded inspector (inspector@autoservice.com → its org).
For each STILL-OPEN job they have a visible exposure on,
re-stamps expiresAt = now + 24h. Idempotent.

Usage:
    /root/.venv/bin/python /app/backend/scripts/refresh_exposures.py [target_email]
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone
from motor.motor_asyncio import AsyncIOMotorClient


async def main():
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    db_name = os.environ.get("DB_NAME", "test_database")
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    target_email = sys.argv[1] if len(sys.argv) > 1 else "inspector@autoservice.com"
    print(f"[refresh] target inspector email: {target_email}")

    user = await db.users.find_one({"email": target_email})
    if not user:
        print(f"[refresh] FATAL: user not found: {target_email}")
        return

    uid = str(user["_id"])
    print(f"[refresh] user._id = {uid}")

    # Find the inspector org for this user
    # Strategy: mimic backend resolve_inspector_org_id() — organizations.ownerId OR raw user_id
    inspector_id = None
    org = await db.organizations.find_one({"ownerId": uid}, {"_id": 1})
    if org:
        inspector_id = str(org["_id"])
        print(f"[refresh] using organizations._id (ownerId match) = {inspector_id}")
    else:
        # Fallback: backend treats user_id as inspectorId for inspector-role users
        inspector_id = uid
        print(f"[refresh] using raw user_id as inspectorId = {inspector_id} (fallback)")

    # Find open jobs without any visible exposure for this inspector
    open_jobs = await db.inspection_jobs.find({"status": "open"}).to_list(length=1000)
    print(f"[refresh] found {len(open_jobs)} open jobs")

    now = datetime.now(timezone.utc)
    new_expires = now + timedelta(hours=24)

    # 1. Extend TTL of existing visible exposures for this inspector
    res = await db.inspector_exposures.update_many(
        {"inspectorId": inspector_id, "status": "visible"},
        {"$set": {"expiresAt": new_expires}},
    )
    print(f"[refresh] extended {res.modified_count} existing visible exposures")

    # 2. Re-open expired exposures owned by this inspector → set visible + 24h TTL
    res2 = await db.inspector_exposures.update_many(
        {
            "inspectorId": inspector_id,
            "status": "expired",
        },
        {"$set": {"status": "visible", "expiresAt": new_expires}},
    )
    print(f"[refresh] re-opened {res2.modified_count} expired exposures")

    # 3. For open jobs that have ZERO exposures for this inspector, create one
    created = 0
    for job in open_jobs:
        existing = await db.inspector_exposures.find_one(
            {"jobId": job["_id"], "inspectorId": inspector_id}
        )
        if existing:
            continue
        # Read request to fill request snapshot
        req = await db.car_requests.find_one({"_id": job.get("requestId")})
        if not req:
            continue
        exposure = {
            "_id": __import__("uuid").uuid4().hex,
            "jobId": job["_id"],
            "requestId": job.get("requestId"),
            "inspectorId": inspector_id,
            "status": "visible",
            "rank": 1,
            "score": 0.85,
            "scoreParts": {"quality": 0.8, "speed": 0.8, "reliability": 0.9,
                           "activity": 1.0, "fairness": 1.0},
            "city": job.get("city") or "berlin",
            "priceEstimate": 149,
            "exposedAt": now,
            "expiresAt": new_expires,
            "request": {
                "type": req.get("type"),
                "brand": req.get("brand"),
                "model": req.get("model"),
                "budget": req.get("budget"),
                "country": req.get("country"),
                "urgency": req.get("urgency"),
                "links": req.get("links") or [],
                "comment": req.get("comment"),
                "yearFrom": req.get("yearFrom"),
                "yearTo": req.get("yearTo"),
                "fuel": req.get("fuel"),
                "transmission": req.get("transmission"),
                "mileageMax": req.get("mileageMax"),
            },
        }
        await db.inspector_exposures.insert_one(exposure)
        created += 1
        if created >= 50:
            break

    print(f"[refresh] created {created} new exposures for open jobs")

    # Final count
    total_visible = await db.inspector_exposures.count_documents(
        {"inspectorId": inspector_id, "status": "visible",
         "expiresAt": {"$gt": now}}
    )
    print(f"[refresh] inspector now has {total_visible} VISIBLE non-expired exposures")
    print("[refresh] DONE — refresh the app, кнопка 'Взять' будет рабочей.")


if __name__ == "__main__":
    asyncio.run(main())
