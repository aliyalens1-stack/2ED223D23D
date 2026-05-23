"""observatory.aggregator — pure deterministic compositional read.

Reads from existing live systems. Does NOT create new substrate.
Returns raw signals; phrase synthesis lives in interpreter.py.

Substrate sources (read-only, all optional — gracefully skipped if missing):
  timeline_events, notifications, assignments, reputation_snapshots,
  verification_rejection_history, inspection_drafts, offline_replay_log,
  governance_actions, demand_action_executions, system_logs (shadow runtime).

The aggregator never invents data. If all sources yield zero — caller emits
{ok: false, reason: "insufficient_decision_context"}.
"""
from __future__ import annotations
from datetime import datetime, timezone, timedelta
from typing import Any

# Sources whose presence we count toward substrate sufficiency.
# Order is meaningful for "dominantPosture" tie-breaks (first wins).
SUBSTRATE_SOURCES = (
    "timeline_events",
    "notifications",
    "assignments",
    "reputation_snapshots",
    "verification_rejection_history",
    "inspection_drafts",
    "offline_replay_log",
    "governance_actions",
    "demand_action_executions",
    "system_logs",
)

# Minimum total documents across all sources to consider substrate "sufficient".
# Below this, observatory returns insufficient_decision_context.
SUBSTRATE_FLOOR = 3


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat()


async def _safe_count(db, collection_name: str, query: dict | None = None) -> int:
    """count_documents that never raises (missing collection → 0)."""
    try:
        return int(await db[collection_name].count_documents(query or {}))
    except Exception:
        return 0


async def _safe_recent(db, collection_name: str, hours: int, ts_field: str = "createdAt") -> int:
    """Count documents in the last N hours by ISO ts_field. Falls back to 0."""
    cutoff = _iso(_now() - timedelta(hours=hours))
    try:
        return int(await db[collection_name].count_documents({ts_field: {"$gte": cutoff}}))
    except Exception:
        return 0


async def gather_substrate(db) -> dict[str, Any]:
    """Read every substrate source once. Returns raw counts + cycle markers."""
    out: dict[str, Any] = {"sources": {}, "windows": {}, "topZones": [], "topPostures": []}

    # Per-source totals (forever) + last 24h windows.
    total = 0
    for src in SUBSTRATE_SOURCES:
        c_all = await _safe_count(db, src)
        c_24h = await _safe_recent(db, src, hours=24)
        out["sources"][src] = c_all
        out["windows"][src] = c_24h
        total += c_all

    out["substrateTotal"] = total

    # Dominant posture: pick most active source in last 24h (tie → SUBSTRATE_SOURCES order).
    if total > 0:
        ranked = sorted(
            out["windows"].items(),
            key=lambda kv: (-kv[1], SUBSTRATE_SOURCES.index(kv[0])),
        )
        out["topPostures"] = [name for name, c in ranked[:3] if c > 0]
        if not out["topPostures"]:
            # No 24h activity but there's history → fall back to all-time totals
            ranked_all = sorted(
                out["sources"].items(),
                key=lambda kv: (-kv[1], SUBSTRATE_SOURCES.index(kv[0])),
            )
            out["topPostures"] = [name for name, c in ranked_all[:3] if c > 0]

    # Top zones from governance_actions + demand_action_executions in last 24h.
    cutoff_24h = _iso(_now() - timedelta(hours=24))
    try:
        cursor = db.governance_actions.aggregate([
            {"$match": {"createdAt": {"$gte": cutoff_24h}, "zoneId": {"$exists": True}}},
            {"$group": {"_id": "$zoneId", "n": {"$sum": 1}}},
            {"$sort": {"n": -1}},
            {"$limit": 5},
        ])
        async for row in cursor:
            zid = row.get("_id") or "unknown"
            out["topZones"].append({"zoneId": zid, "actions": int(row["n"])})
    except Exception:
        pass

    # Shadow structures snapshot — derived from existing collections.
    blocked = await _safe_count(db, "verification_rejection_history")
    # "waiting" = drafts that exist but were never submitted
    try:
        waiting = await db.inspection_drafts.count_documents({"status": {"$ne": "submitted"}})
    except Exception:
        waiting = 0
    # "unresolved" = offline_replay records still in pending state
    try:
        unresolved = await db.offline_replay_log.count_documents({"status": {"$ne": "applied"}})
    except Exception:
        unresolved = 0

    out["shadow"] = {
        "blocked": int(blocked),
        "waiting": int(waiting),
        "unresolved": int(unresolved),
    }

    # Continuity markers: oldest and newest timeline events define an arc.
    try:
        oldest = await db.timeline_events.find_one({}, sort=[("createdAt", 1)], projection={"_id": 0, "createdAt": 1})
        newest = await db.timeline_events.find_one({}, sort=[("createdAt", -1)], projection={"_id": 0, "createdAt": 1})
    except Exception:
        oldest, newest = None, None
    out["continuity"] = {
        "first": (oldest or {}).get("createdAt"),
        "last": (newest or {}).get("createdAt"),
        "timelineCount": out["sources"].get("timeline_events", 0),
    }

    # Reputation accumulation: distinct user_ids with reputation snapshots.
    try:
        rep_users = await db.reputation_snapshots.distinct("userId")
        out["reputationDepth"] = len(rep_users or [])
    except Exception:
        out["reputationDepth"] = 0

    # Alignment seed: distinct zoneId roots seen across governance + demand.
    seen_zones: set[str] = set()
    for col in ("governance_actions", "demand_action_executions"):
        try:
            zs = await db[col].distinct("zoneId")
            for z in zs:
                if z:
                    seen_zones.add(str(z))
        except Exception:
            pass
    out["alignmentSymbols"] = sorted(seen_zones)[:5]

    out["generatedAt"] = _iso(_now())
    return out


def is_substrate_sufficient(substrate: dict[str, Any]) -> bool:
    """Hard floor: require at least SUBSTRATE_FLOOR documents across all sources."""
    return int(substrate.get("substrateTotal", 0)) >= SUBSTRATE_FLOOR
