#!/usr/bin/env python3
"""Sprint 1C — additive, idempotent migration.

For each existing `users` document, ensure there is at least one row in the
`accounts` collection (and, for professional users, one row in
`account_capabilities`). Re-running this script is a no-op for already-migrated
users — it only fills gaps. NOTHING is ever deleted; `users.role` stays.

What gets created:

    customer / admin user
        accounts: { kind: <role>, isPrimary: True, legacyRole: <role> }
        # No capabilities (principals).

    provider / provider_owner / inspector
        accounts: { kind: 'inspector', isPrimary: True, legacyRole: <role> }
        account_capabilities: { capability: 'inspect', status: 'verified' }

    service_provider
        accounts: { kind: 'service_provider', ... }
        account_capabilities: { capability: 'repair', status: 'verified' }

    dealer
        accounts: { kind: 'dealer', ... }
        account_capabilities: { capability: 'sell', status: 'verified' }

    transport / transport_provider
        accounts: { kind: 'transport_provider', ... }
        account_capabilities: { capability: 'transport', status: 'verified' }

Everything is keyed on (userId, kind) — re-running upserts but never duplicates.
Run:   python /app/backend/scripts/migrate_users_to_accounts.py
"""
from __future__ import annotations
import asyncio
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, "/app/backend")

from motor.motor_asyncio import AsyncIOMotorClient
from bson import ObjectId

from app.core.capability import (
    derive_account_kind_from_legacy,
    derive_capabilities_from_legacy,
)


async def main():
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    db_name = os.environ.get("DB_NAME", "auto_search_platform")
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    print(f"\n=== Sprint 1C migration · {db_name} (additive, idempotent) ===\n")

    now = datetime.now(timezone.utc)

    accounts_created = 0
    accounts_skipped = 0
    caps_created = 0
    caps_skipped = 0
    users_processed = 0

    cur = db.users.find({}, {
        "_id": 1, "email": 1, "firstName": 1, "lastName": 1, "role": 1, "avatar": 1,
    })
    async for u in cur:
        users_processed += 1
        user_id = str(u["_id"])
        legacy_role = (u.get("role") or "customer").strip().lower()
        kind = derive_account_kind_from_legacy(u)
        capabilities = derive_capabilities_from_legacy(u)

        display_name = (
            f"{u.get('firstName', '')} {u.get('lastName', '')}".strip()
            or u.get("email", "")
        )

        # Idempotent upsert by (userId, kind) — same key as the unique compound index.
        result = await db.accounts.update_one(
            {"userId": user_id, "kind": kind},
            {
                "$setOnInsert": {
                    "userId": user_id,
                    "kind": kind,
                    "status": "active",
                    "displayName": display_name,
                    "avatar": u.get("avatar"),
                    "legacyRole": legacy_role,
                    "isPrimary": True,
                    "stats": {
                        "rating": 0.0,
                        "reviewsCount": 0,
                        "completedJobs": 0,
                        "cancelledJobs": 0,
                        "earningsTotalCents": 0,
                    },
                    "createdAt": now,
                },
                # We never overwrite — but it's nice to refresh updatedAt so admin
                # tools can see when migration last touched the row.
                "$set": {"updatedAt": now},
            },
            upsert=True,
        )
        if result.upserted_id is not None:
            accounts_created += 1
            account_id = str(result.upserted_id)
        else:
            accounts_skipped += 1
            existing = await db.accounts.find_one({"userId": user_id, "kind": kind}, {"_id": 1})
            account_id = str(existing["_id"]) if existing else None

        if not account_id:
            continue  # defensive — should never happen after upsert

        # Attach capabilities for professional accounts.
        for verb in capabilities:
            cap_result = await db.account_capabilities.update_one(
                {"accountId": account_id, "capability": verb},
                {
                    "$setOnInsert": {
                        "accountId": account_id,
                        "capability": verb,
                        "status": "verified",   # legacy providers are de-facto verified
                        "specializations": [],
                        "verifiedAt": now,
                        "verifiedBy": "system:1c-migration",
                        "createdAt": now,
                    },
                    "$set": {"updatedAt": now},
                },
                upsert=True,
            )
            if cap_result.upserted_id is not None:
                caps_created += 1
            else:
                caps_skipped += 1

    print(f"  users scanned         : {users_processed}")
    print(f"  accounts created      : {accounts_created}")
    print(f"  accounts already done : {accounts_skipped}")
    print(f"  capabilities created  : {caps_created}")
    print(f"  capabilities already  : {caps_skipped}")

    total_acc = await db.accounts.count_documents({})
    total_cap = await db.account_capabilities.count_documents({})
    print(f"\n  Final state:")
    print(f"    accounts             : {total_acc}")
    print(f"    account_capabilities : {total_cap}")

    by_kind = {}
    cur = db.accounts.aggregate([{"$group": {"_id": "$kind", "n": {"$sum": 1}}}])
    async for row in cur:
        by_kind[row["_id"]] = row["n"]
    if by_kind:
        print("    accounts by kind     :", ", ".join(f"{k}={v}" for k, v in sorted(by_kind.items())))

    by_cap = {}
    cur = db.account_capabilities.aggregate([{"$group": {"_id": "$capability", "n": {"$sum": 1}}}])
    async for row in cur:
        by_cap[row["_id"]] = row["n"]
    if by_cap:
        print("    capabilities         :", ", ".join(f"{k}={v}" for k, v in sorted(by_cap.items())))

    print("\n✓ Sprint 1C migration complete. users.role left intact (legacy fallback).\n")
    client.close()


if __name__ == "__main__":
    asyncio.run(main())
