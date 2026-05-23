"""scripts/phase1a_rollback.py — Idempotent rollback of Phase 1A backfill.

Strategy
--------
$unset {cluster, clusterBackfillMeta, appliesToClusters} on all Category A
collections. Safe because Phase 1A readers DO NOT use these fields yet.

Invariants
----------
- IDEMPOTENT: $unset on non-existent field is no-op
- NO collection drop
- NO row deletion
- Reverts ONLY documents that carry the Phase-1A breadcrumb
  (`clusterBackfillMeta.phase == '1A'`)
  → docs touched by later phases stay intact when this script reruns

Usage
-----
    cd /app/backend
    python scripts/phase1a_rollback.py            # dry-run (default)
    python scripts/phase1a_rollback.py --apply    # actually unset

Exit codes
----------
    0 — success
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from motor.motor_asyncio import AsyncIOMotorClient

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

# Collections touched by Phase 1A backfill (must mirror phase1a_backfill.COLLECTION_ORDER)
COLLECTIONS = [
    "organizations",
    "zones",
    "payment_transactions",
    "orchestrator_logs",
    "pre_engagement_events",
    "zone_snapshots",
    "action_feedback",
    "reviews",
    "runtime_ledger_events",
    "automation_feedback",
    "governance_actions",
    "feature_flags",
    "automation_rules",
    "failsafe_rules",
    "action_chains",
]


async def main():
    parser = argparse.ArgumentParser(description="Phase 1A backfill rollback")
    parser.add_argument("--apply", action="store_true",
                        help="Actually $unset (default: dry-run)")
    args = parser.parse_args()

    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"\n{'='*70}")
    print(f"  PHASE 1A ROLLBACK — {mode} MODE")
    print(f"  Mongo: {MONGO_URL} · DB: {DB_NAME}")
    print(f"  Scope: documents with clusterBackfillMeta.phase == '1A'")
    print(f"{'='*70}\n")

    grand_modified = 0
    for coll in COLLECTIONS:
        # Count docs that will be touched
        filter_expr = {"clusterBackfillMeta.phase": "1A"}
        candidates = await db[coll].count_documents(filter_expr)

        if candidates == 0:
            print(f"  ⏭  {coll:<26} clean — no Phase 1A breadcrumbs")
            continue

        if args.apply:
            res = await db[coll].update_many(
                filter_expr,
                {"$unset": {
                    "cluster": "",
                    "clusterBackfillMeta": "",
                    "appliesToClusters": "",
                }},
            )
            grand_modified += res.modified_count
            print(f"  ↩️  {coll:<26} unset on {res.modified_count}/{candidates} docs")
        else:
            print(f"  👀 {coll:<26} would unset cluster + meta on {candidates} docs")

    print()
    print(f"{'='*70}")
    if args.apply:
        print(f"  ✅ Rollback complete. Modified: {grand_modified} docs.")
        print(f"  Verification: each collection should now have 0 docs with cluster field "
              f"from Phase 1A breadcrumb.")
    else:
        print(f"  ℹ️  Re-run with --apply to execute rollback.")
    print(f"{'='*70}\n")


asyncio.run(main())
