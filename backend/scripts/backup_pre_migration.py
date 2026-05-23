#!/usr/bin/env python3
"""Sprint 1A — DB backup before role-split migration.

Dumps every collection (full documents, BSON ObjectId → str) to
/app/memory/db_backup_pre_migration.json.

NON-DESTRUCTIVE. Read-only. Run once before Sprint 1B/1C migrations.
"""
import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from motor.motor_asyncio import AsyncIOMotorClient
from bson import ObjectId


def _serialize(v):
    if isinstance(v, ObjectId):
        return {"$oid": str(v)}
    if isinstance(v, datetime):
        return {"$date": v.isoformat()}
    if isinstance(v, dict):
        return {k: _serialize(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_serialize(x) for x in v]
    return v


async def main():
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    db_name = os.environ.get("DB_NAME", "auto_search_platform")
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    out_path = Path("/app/memory/db_backup_pre_migration.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    collections = await db.list_collection_names()
    backup = {
        "_meta": {
            "db_name": db_name,
            "backup_at": datetime.now(timezone.utc).isoformat(),
            "purpose": "Sprint 1A — pre role/account/capability split safety net",
            "destructive_changes_after_this_point": False,
        },
        "_counts": {},
        "data": {},
    }

    total = 0
    for coll_name in sorted(collections):
        cursor = db[coll_name].find({})
        docs = []
        async for d in cursor:
            docs.append(_serialize(d))
        backup["_counts"][coll_name] = len(docs)
        backup["data"][coll_name] = docs
        total += len(docs)
        print(f"  {coll_name}: {len(docs)}")

    out_path.write_text(json.dumps(backup, ensure_ascii=False, indent=2), encoding="utf-8")
    size_kb = out_path.stat().st_size // 1024
    print(f"\n✓ Backup written: {out_path}  ({size_kb} KB, {total} docs across {len(collections)} collections)")
    client.close()


if __name__ == "__main__":
    asyncio.run(main())
