"""scripts/phase1a_backfill.py — Phase 1A additive backfill (idempotent).

Goal
----
Set `cluster` field on documents in Category A collections (Sprint 33 declared
multi-cluster runtime). Each updated doc also receives `clusterBackfillMeta`
provenance breadcrumb.

Invariants
----------
- READ-ONLY by default. Pass `--apply` to write.
- IDEMPOTENT: docs already having `cluster` are skipped.
- NO collection deletion. NO row deletion. NO field deletion.
- NO reader is changed.
- Unknown/ambiguous docs → manual_review marker (no guessing).

Provenance schema (per updated doc)
-----------------------------------
    cluster: str                  # repair | inspection | selection | delivery
    clusterBackfillMeta: {
        phase:        '1A',
        strategy:     'frozen_org_mapping' | 'zone_doc_inference' |
                      'zone_join' | 'hardcode_repair_legacy' |
                      'event_type_inference' | 'org_join_via_id' |
                      'manual_review',
        backfilledAt: '<ISO-8601>',
        sourceField:  '<which field drove the decision>',  # optional
        reason:       '<one-line explanation>',            # optional
    }

For docs that cannot be inferred, instead of `cluster` we write:
    clusterBackfillMeta: { phase: '1A', strategy: 'manual_review',
                           reason: '...', backfilledAt: '...' }
The `cluster` field stays absent → caller can find unresolved with
{cluster: {$exists: false}, clusterBackfillMeta.strategy: 'manual_review'}.

Usage
-----
    cd /app/backend
    python scripts/phase1a_backfill.py            # dry-run (default)
    python scripts/phase1a_backfill.py --apply    # actually write
    python scripts/phase1a_backfill.py --apply --collections zones organizations

Exit codes
----------
    0 — success (or dry-run completed)
    1 — verification mismatch / abort
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any, Optional

# Add backend/ to path (script invoked from anywhere)
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from motor.motor_asyncio import AsyncIOMotorClient
from app.core.clusters_phase1 import (
    CLUSTER_REPAIR,
    CLUSTER_INSPECTION,
    is_valid_cluster,
    zone_to_cluster,
    event_type_to_cluster,
    action_type_to_cluster_hint,
)
from phase1a_org_mapping import (
    FROZEN_ORG_MAPPING,
    get_frozen_mapping_by_id,
    assert_distribution_invariants,
)


MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

PHASE = "1A"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─────────────────────────────────────────────────────────────────────
# Strategy registry — one async function per collection
# Each returns: list of {filter, set_doc, strategy} planned operations
# ─────────────────────────────────────────────────────────────────────


async def plan_organizations(db) -> list[dict]:
    """Apply frozen 11-org mapping. Cross-check slug to prevent _id drift."""
    plans = []
    frozen_by_id = get_frozen_mapping_by_id()
    async for doc in db.organizations.find({}, {"_id": 1, "slug": 1, "cluster": 1}):
        _id_str = str(doc["_id"])
        if doc.get("cluster"):
            continue  # idempotent skip
        cluster = frozen_by_id.get(_id_str)
        if cluster:
            plans.append({
                "filter": {"_id": doc["_id"]},
                "set": {
                    "cluster": cluster,
                    "clusterBackfillMeta": {
                        "phase": PHASE,
                        "strategy": "frozen_org_mapping",
                        "backfilledAt": now_iso(),
                        "sourceField": "_id",
                        "reason": f"slug={doc.get('slug')} matched frozen entry",
                    },
                },
                "strategy": "frozen_org_mapping",
            })
        else:
            # Unknown org — flag for manual review (do NOT guess)
            plans.append({
                "filter": {"_id": doc["_id"]},
                "set": {
                    "clusterBackfillMeta": {
                        "phase": PHASE,
                        "strategy": "manual_review",
                        "backfilledAt": now_iso(),
                        "reason": (
                            f"org _id={_id_str} slug={doc.get('slug')} "
                            f"not in frozen mapping; needs explicit review"
                        ),
                    },
                },
                "strategy": "manual_review",
            })
    return plans


async def plan_zones(db) -> list[dict]:
    plans = []
    async for doc in db.zones.find({}, {}):
        if doc.get("cluster"):
            continue
        cluster = zone_to_cluster(doc)
        if cluster:
            plans.append({
                "filter": {"_id": doc["_id"]},
                "set": {
                    "cluster": cluster,
                    "clusterBackfillMeta": {
                        "phase": PHASE,
                        "strategy": "zone_doc_inference",
                        "backfilledAt": now_iso(),
                        "sourceField": "country+currency",
                        "reason": f"country={doc.get('country')} + currency={doc.get('currency')}",
                    },
                },
                "strategy": "zone_doc_inference",
            })
        else:
            plans.append({
                "filter": {"_id": doc["_id"]},
                "set": {
                    "clusterBackfillMeta": {
                        "phase": PHASE,
                        "strategy": "manual_review",
                        "backfilledAt": now_iso(),
                        "reason": (
                            f"zone id={doc.get('id')} country={doc.get('country')} "
                            f"currency={doc.get('currency')} — no zone_to_cluster match"
                        ),
                    },
                },
                "strategy": "manual_review",
            })
    return plans


async def _zone_id_to_cluster_map(db) -> dict[str, str]:
    """Build {zone.id: cluster} from already-tagged zones (preferred)
    OR from inline inference (so dry-run shows realistic preview).
    """
    m = {}
    async for z in db.zones.find({}, {}):
        if not z.get("id"):
            continue
        # 1st choice: existing tag
        if z.get("cluster"):
            m[z["id"]] = z["cluster"]
            continue
        # Fallback: inline inference (matches what plan_zones would write)
        c = zone_to_cluster(z)
        if c:
            m[z["id"]] = c
    return m


async def plan_zone_derived(db, collection_name: str, zone_id_field_candidates: list[str]) -> list[dict]:
    """Generic helper for collections that derive cluster from a zone reference."""
    zone_map = await _zone_id_to_cluster_map(db)
    plans = []
    async for doc in db[collection_name].find({"cluster": {"$exists": False}}, {}):
        zid = None
        for f in zone_id_field_candidates:
            if doc.get(f):
                zid = doc[f]
                break
        cluster = zone_map.get(zid) if zid else None
        if cluster:
            plans.append({
                "filter": {"_id": doc["_id"]},
                "set": {
                    "cluster": cluster,
                    "clusterBackfillMeta": {
                        "phase": PHASE,
                        "strategy": "zone_join",
                        "backfilledAt": now_iso(),
                        "sourceField": f"zoneId→{zid}",
                    },
                },
                "strategy": "zone_join",
            })
        else:
            # Try action_type hint for action_feedback
            if collection_name == "action_feedback":
                at = doc.get("actionType") or doc.get("action_type")
                hint = action_type_to_cluster_hint(at)
                if hint:
                    plans.append({
                        "filter": {"_id": doc["_id"]},
                        "set": {
                            "cluster": hint,
                            "clusterBackfillMeta": {
                                "phase": PHASE,
                                "strategy": "action_type_hint",
                                "backfilledAt": now_iso(),
                                "sourceField": f"actionType={at}",
                            },
                        },
                        "strategy": "action_type_hint",
                    })
                    continue
            plans.append({
                "filter": {"_id": doc["_id"]},
                "set": {
                    "clusterBackfillMeta": {
                        "phase": PHASE,
                        "strategy": "manual_review",
                        "backfilledAt": now_iso(),
                        "reason": f"no zoneId/no hint for {collection_name}",
                    },
                },
                "strategy": "manual_review",
            })
    return plans


async def plan_reviews(db) -> list[dict]:
    """Reviews → cluster via organizations._id (after orgs backfilled).

    Dry-run safe: falls back to frozen mapping when orgs aren't yet tagged.
    """
    org_id_to_cluster: dict[str, str] = {}
    # 1st choice: already-tagged orgs from DB
    async for o in db.organizations.find({"cluster": {"$exists": True}}, {"_id": 1, "cluster": 1}):
        org_id_to_cluster[str(o["_id"])] = o["cluster"]
    # Fallback: frozen mapping (so dry-run previews realistic counts)
    frozen = get_frozen_mapping_by_id()
    for oid, cl in frozen.items():
        org_id_to_cluster.setdefault(oid, cl)

    plans = []
    async for doc in db.reviews.find({"cluster": {"$exists": False}}, {}):
        oid = doc.get("organizationId")
        cluster = org_id_to_cluster.get(oid) if oid else None
        if cluster:
            plans.append({
                "filter": {"_id": doc["_id"]},
                "set": {
                    "cluster": cluster,
                    "clusterBackfillMeta": {
                        "phase": PHASE,
                        "strategy": "org_join_via_id",
                        "backfilledAt": now_iso(),
                        "sourceField": f"organizationId={oid}",
                    },
                },
                "strategy": "org_join_via_id",
            })
        else:
            plans.append({
                "filter": {"_id": doc["_id"]},
                "set": {
                    "clusterBackfillMeta": {
                        "phase": PHASE,
                        "strategy": "manual_review",
                        "backfilledAt": now_iso(),
                        "reason": f"reviews.organizationId={oid} unresolved",
                    },
                },
                "strategy": "manual_review",
            })
    return plans


async def plan_runtime_ledger(db) -> list[dict]:
    plans = []
    async for doc in db.runtime_ledger_events.find({"cluster": {"$exists": False}}, {}):
        et = doc.get("eventType")
        cluster = event_type_to_cluster(et)
        if cluster:
            plans.append({
                "filter": {"_id": doc["_id"]},
                "set": {
                    "cluster": cluster,
                    "clusterBackfillMeta": {
                        "phase": PHASE,
                        "strategy": "event_type_inference",
                        "backfilledAt": now_iso(),
                        "sourceField": f"eventType={et}",
                    },
                },
                "strategy": "event_type_inference",
            })
        else:
            plans.append({
                "filter": {"_id": doc["_id"]},
                "set": {
                    "clusterBackfillMeta": {
                        "phase": PHASE,
                        "strategy": "manual_review",
                        "backfilledAt": now_iso(),
                        "reason": f"runtime_ledger eventType={et} unmatched",
                    },
                },
                "strategy": "manual_review",
            })
    return plans


async def plan_hardcode_repair(db, collection_name: str) -> list[dict]:
    """Collections whose existing rows are universally legacy=repair."""
    plans = []
    async for doc in db[collection_name].find({"cluster": {"$exists": False}}, {"_id": 1}):
        plans.append({
            "filter": {"_id": doc["_id"]},
            "set": {
                "cluster": CLUSTER_REPAIR,
                "clusterBackfillMeta": {
                    "phase": PHASE,
                    "strategy": "hardcode_repair_legacy",
                    "backfilledAt": now_iso(),
                    "reason": f"all existing {collection_name} rows are legacy taxi-marketplace",
                },
            },
            "strategy": "hardcode_repair_legacy",
        })
    return plans


async def plan_appliesto_clusters(db, collection_name: str) -> list[dict]:
    """Collections that get appliesToClusters: ['repair'] default (legacy automation/governance config)."""
    plans = []
    async for doc in db[collection_name].find(
        {"appliesToClusters": {"$exists": False}}, {"_id": 1}
    ):
        plans.append({
            "filter": {"_id": doc["_id"]},
            "set": {
                "appliesToClusters": [CLUSTER_REPAIR],
                "clusterBackfillMeta": {
                    "phase": PHASE,
                    "strategy": "hardcode_repair_legacy",
                    "backfilledAt": now_iso(),
                    "reason": f"all existing {collection_name} entries authored for repair cluster",
                },
            },
            "strategy": "hardcode_repair_legacy",
        })
    return plans


async def plan_payment_transactions(db) -> list[dict]:
    """payment_transactions: ONLY new write-side adds metadata.source.

    Per Phase 1A directive: existing transactions stay in manual_review bucket.
    DO NOT guess source by amount.
    """
    plans = []
    async for doc in db.payment_transactions.find({"cluster": {"$exists": False}}, {}):
        # Already explicit cluster? skip
        # Explicit metadata.source? infer + mark
        meta = doc.get("metadata") or {}
        src = (meta.get("source") or "").lower()
        if "stage4" in src or "quote" in src:
            cluster, strat = CLUSTER_REPAIR, "metadata_source_stage4"
        elif "auto_request" in src or "auto-request" in src:
            cluster, strat = CLUSTER_INSPECTION, "metadata_source_auto_request"
        elif "billing" in src or "boost" in src:
            cluster, strat = CLUSTER_REPAIR, "metadata_source_boost"
        else:
            cluster, strat = None, "manual_review"

        if cluster:
            plans.append({
                "filter": {"_id": doc["_id"]},
                "set": {
                    "cluster": cluster,
                    "clusterBackfillMeta": {
                        "phase": PHASE,
                        "strategy": strat,
                        "backfilledAt": now_iso(),
                        "sourceField": f"metadata.source={meta.get('source')}",
                    },
                },
                "strategy": strat,
            })
        else:
            plans.append({
                "filter": {"_id": doc["_id"]},
                "set": {
                    "clusterBackfillMeta": {
                        "phase": PHASE,
                        "strategy": "manual_review",
                        "backfilledAt": now_iso(),
                        "reason": (
                            f"tx without metadata.source — not guessing. "
                            f"currency={doc.get('currency')} amount={doc.get('amount')}"
                        ),
                    },
                },
                "strategy": "manual_review",
            })
    return plans


# ─────────────────────────────────────────────────────────────────────
# Master plan — ordered by dependency
# ─────────────────────────────────────────────────────────────────────


COLLECTION_ORDER = [
    # (collection_name, planner_fn, planner_kwargs)
    ("organizations",         plan_organizations,        {}),
    ("zones",                 plan_zones,                {}),
    ("payment_transactions",  plan_payment_transactions, {}),
    # Zone-derived (must come AFTER zones backfilled)
    ("orchestrator_logs",     plan_zone_derived,         {"zone_id_field_candidates": ["zoneId", "zone_id"]}),
    ("pre_engagement_events", plan_zone_derived,         {"zone_id_field_candidates": ["zoneId", "zone_id"]}),
    ("zone_snapshots",        plan_zone_derived,         {"zone_id_field_candidates": ["zoneId", "zone_id"]}),
    ("action_feedback",       plan_zone_derived,         {"zone_id_field_candidates": ["zoneId", "zone_id"]}),
    # Org-derived (after orgs backfilled)
    ("reviews",               plan_reviews,              {}),
    # Event-typed
    ("runtime_ledger_events", plan_runtime_ledger,       {}),
    # Hardcoded legacy
    ("automation_feedback",   plan_hardcode_repair,      {}),
    ("governance_actions",    plan_hardcode_repair,      {}),
    # appliesToClusters config collections
    ("feature_flags",         plan_appliesto_clusters,   {}),
    ("automation_rules",      plan_appliesto_clusters,   {}),
    ("failsafe_rules",        plan_appliesto_clusters,   {}),
    ("action_chains",         plan_appliesto_clusters,   {}),
]


async def execute_plan(db, collection: str, plans: list[dict], apply: bool) -> dict:
    """Execute or pretend-execute plan operations. Returns counters."""
    strategy_counter = Counter()
    cluster_counter = Counter()
    for op in plans:
        strategy_counter[op["strategy"]] += 1
        if "cluster" in op["set"]:
            cluster_counter[op["set"]["cluster"]] += 1

    written = 0
    if apply and plans:
        for op in plans:
            res = await db[collection].update_one(op["filter"], {"$set": op["set"]})
            if res.modified_count:
                written += res.modified_count

    return {
        "planned": len(plans),
        "written": written,
        "by_strategy": dict(strategy_counter),
        "by_cluster": dict(cluster_counter),
    }


# ─────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────


async def main():
    parser = argparse.ArgumentParser(description="Phase 1A cluster backfill")
    parser.add_argument("--apply", action="store_true",
                        help="Actually write to DB (default: dry-run)")
    parser.add_argument("--collections", nargs="+",
                        help="Limit to specific collections")
    args = parser.parse_args()

    # Pre-flight sanity
    assert_distribution_invariants()
    print(f"\n{'='*70}")
    print(f"  PHASE 1A BACKFILL — {'APPLY' if args.apply else 'DRY-RUN'} MODE")
    print(f"  Mongo: {MONGO_URL} · DB: {DB_NAME}")
    print(f"  Frozen org mapping: {len(FROZEN_ORG_MAPPING)} entries (distribution verified)")
    print(f"{'='*70}\n")

    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]

    grand_totals = defaultdict(int)
    per_collection_results = {}

    for coll, planner, kwargs in COLLECTION_ORDER:
        if args.collections and coll not in args.collections:
            continue
        total_before = await db[coll].estimated_document_count()
        tagged_before = await db[coll].count_documents({"cluster": {"$exists": True}})

        if planner is plan_zone_derived:
            plans = await planner(db, coll, **kwargs)
        elif planner is plan_hardcode_repair:
            plans = await planner(db, coll)
        elif planner is plan_appliesto_clusters:
            plans = await planner(db, coll)
        else:
            plans = await planner(db)

        result = await execute_plan(db, coll, plans, args.apply)

        # Verification: re-count after apply
        tagged_after = await db[coll].count_documents({"cluster": {"$exists": True}}) if args.apply else tagged_before
        manual_review = result["by_strategy"].get("manual_review", 0)

        per_collection_results[coll] = {
            "total": total_before,
            "tagged_before": tagged_before,
            "planned": result["planned"],
            "written": result["written"],
            "tagged_after": tagged_after,
            "manual_review": manual_review,
            "by_strategy": result["by_strategy"],
            "by_cluster": result["by_cluster"],
        }

        grand_totals["planned"] += result["planned"]
        grand_totals["written"] += result["written"]
        grand_totals["manual_review"] += manual_review

        # Print line
        sym = "✏️ " if args.apply else "👀"
        print(f"{sym} {coll:<26} total={total_before:>5} "
              f"tagged={tagged_before}→{tagged_after} "
              f"planned={result['planned']:>4} written={result['written']:>4} "
              f"manual={manual_review:>2} "
              f"strategies={result['by_strategy']}")

    print()
    print(f"{'='*70}")
    print(f"  SUMMARY")
    print(f"{'='*70}")
    print(f"  Planned ops:    {grand_totals['planned']}")
    print(f"  Written ops:    {grand_totals['written']} {'(DRY-RUN: nothing written)' if not args.apply else ''}")
    print(f"  Manual review:  {grand_totals['manual_review']}")
    print()

    # Cluster distribution sanity check (only meaningful after apply)
    if args.apply:
        dist = Counter()
        for coll, _, _ in COLLECTION_ORDER:
            async for d in db[coll].find({"cluster": {"$exists": True}}, {"cluster": 1, "_id": 0}):
                dist[d["cluster"]] += 1
        print(f"  Post-backfill cluster distribution across all collections:")
        for c, n in dist.most_common():
            print(f"    {c:<12} {n}")
        print()
        print("  ✅ Backfill complete. Readers UNCHANGED (Phase 1A invariant).")
        print("  ⏭️  Next: run scripts/phase1a_verification.py to validate")
    else:
        print("  ℹ️  Re-run with --apply to write changes.")

asyncio.run(main())
