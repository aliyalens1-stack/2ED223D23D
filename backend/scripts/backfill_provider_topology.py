"""CLI: one-shot backfill of `provider_topology` from existing organizations.

Usage:
    cd /app/backend && python scripts/backfill_provider_topology.py [--dry-run] [--radius 100]

Output: deterministic JSON report. Idempotent — re-running is safe
(orgs with topology already bound are skipped, not overwritten).
"""
from __future__ import annotations
import argparse
import asyncio
import json
import os
import sys
import types

# Allow running from /app/backend without PYTHONPATH gymnastics.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(_HERE, "..")))

# Stub `server` to break circular import:
# `app.marketplace.cities` does `from server import db`, but we don't want
# to instantiate the full FastAPI app just to run a backfill. The real
# Motor handle comes from `app.core.db.get_db()`.
if "server" not in sys.modules:
    _stub = types.ModuleType("server")
    _stub.db = None
    sys.modules["server"] = _stub

from app.core.context import ctx  # noqa: E402
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402
from app.geo.backfill import backfill_provider_topology  # noqa: E402


async def _main(dry_run: bool, radius: int) -> int:
    # Bootstrap a Motor handle directly — we don't want to spin up the
    # whole FastAPI app just to backfill. The env follows the same
    # conventions as server.py.
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    db_name = os.environ.get("DB_NAME", "test_database")
    client = AsyncIOMotorClient(mongo_url)
    ctx.db = client[db_name]
    db = ctx.db

    report = await backfill_provider_topology(db, radius_km=radius, dry_run=dry_run)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    client.close()
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill provider_topology")
    parser.add_argument("--dry-run", action="store_true", help="Don't write — just report")
    parser.add_argument("--radius", type=int, default=100, help="Travel radius km (50/100/150/250)")
    args = parser.parse_args()
    sys.exit(asyncio.run(_main(args.dry_run, args.radius)))
