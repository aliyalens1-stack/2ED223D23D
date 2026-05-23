"""scripts/phase1b_rollback.py — Idempotent rollback of Phase 1B write-side tagging.

Strategy
--------
$unset {cluster, clusterCreateMeta, appliesToClusters} ONLY on documents that
carry the Phase-1B breadcrumb (`clusterCreateMeta.phase == '1B'`).

This is SYMMETRIC with scripts/phase1a_rollback.py:
  • Phase 1A wrote `clusterBackfillMeta.phase: '1A'` → 1A rollback removes those.
  • Phase 1B writes `clusterCreateMeta.phase: '1B'` → 1B rollback removes those.

Running both rollbacks brings the DB back to Phase-0 (cluster-blind) state.
Running 1B rollback alone leaves Phase 1A retro-tags intact.

Invariants
----------
- IDEMPOTENT: $unset on non-existent field is no-op.
- NO collection drop.
- NO row deletion.
- Reverts ONLY documents with `clusterCreateMeta.phase == '1B'` — leaves
  Phase 1A retro-tags (clusterBackfillMeta) alone.

Note: the writer-side edits in source code are NOT reverted by this script.
That is a git revert operation. This script is the runtime symmetric.

Usage
-----
    cd /app/backend
    python scripts/phase1b_rollback.py            # dry-run (default)
    python scripts/phase1b_rollback.py --apply    # actually unset

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

# Collections touched by Phase 1B write-side wiring.
# Tier 1 (this iteration): orchestrator_logs, pre_engagement_events,
# zone_snapshots, action_feedback.
# Future tiers will extend this list. Adding to it is safe — $unset is no-op
# for collections that have never carried a 1B breadcrumb.
COLLECTIONS = [
    # Tier 1 — orchestrator hot path
    "orchestrator_logs",
    "pre_engagement_events",
    "zone_snapshots",
    "action_feedback",
    # Tier 2/3 placeholders (will become populated as tiers ship)
    "governance_actions",
    "payment_transactions",
    "reviews",
    "feature_flags",
]


PHASE_1B_FILTER = {"clusterCreateMeta.phase": "1B"}


async def rollback(apply_mode: bool) -> int:
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]

    header = "PHASE 1B ROLLBACK — APPLY MODE" if apply_mode else "PHASE 1B ROLLBACK — DRY-RUN"
    print("\n" + "=" * 70)
    print(f"  {header}")
    print(f"  Mongo: {MONGO_URL} · DB: {DB_NAME}")
    print(f"  Filter: {PHASE_1B_FILTER}")
    print("=" * 70 + "\n")

    total_modified = 0
    for coll in COLLECTIONS:
        candidates = await db[coll].count_documents(PHASE_1B_FILTER)
        if candidates == 0:
            print(f"  ⏭  {coll:<28} clean — no Phase 1B breadcrumbs")
            continue

        if not apply_mode:
            print(f"  👀 {coll:<28} would unset cluster + clusterCreateMeta + appliesToClusters on {candidates} docs")
            continue

        result = await db[coll].update_many(
            PHASE_1B_FILTER,
            {"$unset": {"cluster": "", "clusterCreateMeta": "", "appliesToClusters": ""}},
        )
        modified = int(result.modified_count or 0)
        total_modified += modified
        print(f"  ✏️  {coll:<28} unset on {modified} docs")

    print("\n" + "=" * 70)
    print(f"  Total modified: {total_modified}")
    if not apply_mode:
        print("  ℹ️  Re-run with --apply to execute rollback.")
    print("=" * 70 + "\n")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Phase 1B rollback (idempotent).")
    parser.add_argument("--apply", action="store_true", help="actually unset (default: dry-run)")
    args = parser.parse_args()
    return asyncio.run(rollback(apply_mode=args.apply))


if __name__ == "__main__":
    sys.exit(main())
