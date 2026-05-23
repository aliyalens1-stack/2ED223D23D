"""app.orchestrator.feedback — Phase G strategy learning + zone locks.

Sprint 21 C11: все helpers + два loop-а (feedback_processor, strategy_optimizer)
вынесены 1-в-1. Loop-ы запускаются в server.py startup через create_task.

Phase 1B (2026-05-12): track_action_feedback accepts `cluster` arg from caller
to write cluster-native action_feedback docs (pure, no DB lookup here).
"""
from __future__ import annotations
import asyncio
import logging
import random
from datetime import datetime, timedelta, timezone
from typing import Optional

from app.core.cluster_writer import enrich_with_cluster
from app.core.context import ctx
from app.core.db import db, get_db
from app.core.utils import now_utc, uid

logger = logging.getLogger("server")

# Sprint 21 C11 bridge: zone locks (shared across orchestrator + server.py).
# Sprint 24: переехали в Redis (multi-worker safe). Этот dict оставлен пустым
# для backcompat импортов из server.py.
zone_locks: dict = {}


from app.core.redis_state import (
    acquire_lock as _redis_acquire_lock,
    release_lock as _redis_release_lock,
)


def _zone_lock_key(zone_id: str) -> str:
    return f"lock:zone:{zone_id}"



# ── Sprint 21 C11: strategy learning config ──
DEFAULT_STRATEGY_WEIGHTS = {
    "ENABLE_SURGE": 1.0,
    "PUSH_PROVIDERS": 1.0,
    "SET_FANOUT": 1.0,
    "SET_PRIORITY_BIAS": 1.0,
    "SET_ZONE_BOOST": 1.0,
}
FEEDBACK_DELAY_SECONDS = 180  # 3 minutes between before/after
STRATEGY_RECALC_INTERVAL = 300  # 5 minutes
MIN_SAMPLES_FOR_LEARNING = 50  # FIX 3: Cold start — don't adjust weights below this
ZONE_WEIGHT_BLEND = 0.5  # FIX 4: Overfitting — global + zone * blend


async def acquire_zone_lock(zone_id: str, locked_by: str, ttl_seconds: int = 15) -> bool:
    """Acquire a zone lock — Redis-backed (SET NX EX), TTL auto-release.

    Multi-worker safe **when Redis is reachable**. Used in
    `app.orchestrator.cycle.orchestrator_run_cycle_with_feedback` to
    prevent two workers from acting on the same zone in the same cycle.

    ⚠ FAIL-OPEN CONTRACT (2026-05-12 Redis-Truthfulness pass):
      When Redis is unreachable (current preview environment), this
      function returns True for EVERY caller. Mutual exclusion is LOST.
      The callsite at `cycle.py:475` will accept every claim and proceed
      with the orchestrator cycle. There is no Mongo-side fallback for
      the lock semantic — and there is no plan to add one, because the
      partial mitigation (insert-side dedupe via
      `app.core.dedupe_bucket`) is already wired at the only downstream
      site that observably amplified in runtime: `orchestrator_logs`.
      So the lock vanishing is currently *operationally absorbed* by
      the insert dedupe, not by a parallel lock implementation.

      Treat this helper as: "best-effort exclusion when Redis is up;
      no exclusion when Redis is down". Do NOT add new callers expecting
      hard mutual-exclusion guarantees.
    """
    return await _redis_acquire_lock(_zone_lock_key(zone_id), ttl=min(ttl_seconds, 30))


async def release_zone_lock(zone_id: str, locked_by: str = "orchestrator") -> None:
    """Release a zone lock (Redis DEL).

    NOTE: предпочтительно полагаться на TTL auto-release, manual release —
    risk освободить чужой lock при race condition. Здесь мы освобождаем
    в happy-path после успешной обработки зоны.
    """
    await _redis_release_lock(_zone_lock_key(zone_id))


async def capture_zone_snapshot(zone_id: str) -> dict:
    """Capture current zone metrics as a snapshot"""
    zone = await db.zones.find_one({"id": zone_id}, {"_id": 0})
    if not zone:
        return {"eta": 0, "demand": 0, "supply": 0, "ratio": 0, "conversion": 0, "gmv": 0, "surge": 1.0}

    # Calculate approximate conversion & GMV from recent data
    recent_bookings = await db.orchestrator_logs.count_documents({
        "zoneId": zone_id,
        "createdAt": {"$gte": (now_utc() - timedelta(minutes=30)).isoformat()}
    })
    demand = zone.get("demandScore", 1)
    conversion = min(95, max(5, round(100 * zone.get("matchRate", 50) / 100, 1)))
    gmv_estimate = demand * conversion * random.uniform(80, 150)  # Estimated GMV per matched request

    return {
        "eta": zone.get("avgEta", 10),
        "demand": demand,
        "supply": zone.get("supplyScore", 1),
        "ratio": zone.get("ratio", 1.0),
        "conversion": conversion,
        "gmv": round(gmv_estimate),
        "surge": zone.get("surgeMultiplier", 1.0),
        "matchRate": zone.get("matchRate", 50),
        "status": zone.get("status", "BALANCED"),
    }


def calculate_effectiveness(before: dict, after: dict) -> dict:
    """Calculate action effectiveness from before/after snapshots
    FIX 2: External factor bias correction
    FIX 5: GMV as #1 KPI (0.40 weight)
    """
    # ETA improvement (lower is better) — normalized to 0..1
    eta_before = max(before.get("eta", 10), 1)
    eta_after = max(after.get("eta", 10), 1)
    eta_improvement = (eta_before - eta_after) / eta_before
    eta_score = max(-1, min(1, eta_improvement))

    # Conversion growth (higher is better) — normalized
    conv_before = max(before.get("conversion", 50), 1)
    conv_after = max(after.get("conversion", 50), 1)
    conv_growth = (conv_after - conv_before) / conv_before
    conv_score = max(-1, min(1, conv_growth))

    # GMV growth (higher is better) — FIX 5: THIS IS NOW #1 KPI
    gmv_before = max(before.get("gmv", 100), 1)
    gmv_after = max(after.get("gmv", 100), 1)
    gmv_growth = (gmv_after - gmv_before) / gmv_before
    gmv_score = max(-1, min(1, gmv_growth))

    # Ratio improvement (lower is better for CRITICAL/SURGE)
    ratio_before = before.get("ratio", 1)
    ratio_after = after.get("ratio", 1)
    ratio_improvement = (ratio_before - ratio_after) / max(ratio_before, 0.1)
    ratio_score = max(-1, min(1, ratio_improvement))

    # ── FIX 2: External factor bias correction ──
    # If demand changed significantly but action is not demand-related, dampen effectiveness
    demand_before = before.get("demand", 5)
    demand_after = after.get("demand", 5)
    demand_change_pct = abs(demand_after - demand_before) / max(demand_before, 1)
    supply_before = before.get("supply", 3)
    supply_after = after.get("supply", 3)
    supply_change_pct = abs(supply_after - supply_before) / max(supply_before, 1)

    # If external environment shifted a lot (>40% demand/supply change), dampen score
    external_noise = max(demand_change_pct, supply_change_pct)
    bias_dampener = 1.0
    if external_noise > 0.4:
        bias_dampener = 0.5  # Heavy dampen: environment changed too much
    elif external_noise > 0.25:
        bias_dampener = 0.75  # Moderate dampen

    # ── FIX 5: GMV-first weighted effectiveness score ──
    raw_effectiveness = (
        gmv_score * 0.40 +       # GMV = #1 KPI
        conv_score * 0.25 +      # Conversion = #2
        eta_score * 0.20 +       # ETA = #3
        ratio_score * 0.15       # Ratio balance = #4
    )
    effectiveness = raw_effectiveness * bias_dampener

    delta = {
        "eta": round(after.get("eta", 0) - before.get("eta", 0), 1),
        "demand": after.get("demand", 0) - before.get("demand", 0),
        "supply": after.get("supply", 0) - before.get("supply", 0),
        "ratio": round(after.get("ratio", 0) - before.get("ratio", 0), 2),
        "conversion": round(after.get("conversion", 0) - before.get("conversion", 0), 1),
        "gmv": round(after.get("gmv", 0) - before.get("gmv", 0)),
        "surge": round(after.get("surge", 1) - before.get("surge", 1), 2),
    }

    return {
        "effectivenessScore": round(effectiveness, 4),
        "rawScore": round(raw_effectiveness, 4),
        "biasDampener": round(bias_dampener, 2),
        "externalNoise": round(external_noise, 4),
        "delta": delta,
        "componentScores": {
            "gmv": round(gmv_score, 4),
            "conversion": round(conv_score, 4),
            "eta": round(eta_score, 4),
            "ratio": round(ratio_score, 4),
        },
    }


async def track_action_feedback(zone_id: str, zone_name: str, action_type: str, severity: str, action_payload: dict, *, cluster: Optional[str] = None):
    """Create a pending feedback record with BEFORE snapshot.

    Phase 1B: `cluster` is passed by the caller (orchestrator cycle holds
    the zone dict and reads `zone.get('cluster')`). Pure enrichment — no DB
    lookup inside this writer.
    """
    before_snapshot = await capture_zone_snapshot(zone_id)

    feedback_record = {
        "id": uid(),
        "zoneId": zone_id,
        "zoneName": zone_name,
        "actionType": action_type,
        "severity": severity,
        "actionPayload": action_payload,
        "before": before_snapshot,
        "after": None,
        "delta": None,
        "effectivenessScore": None,
        "componentScores": None,
        "status": "pending",  # pending → completed
        "captureAfterAt": (now_utc() + timedelta(seconds=FEEDBACK_DELAY_SECONDS)).isoformat(),
        "createdAt": now_utc().isoformat(),
        "completedAt": None,
    }
    # Phase 1B — cluster auto-tag from caller-provided value (pure).
    enrich_with_cluster(feedback_record, cluster=cluster,
                        strategy="zone_lookup" if cluster else "manual_review",
                        source_field="zoneId")
    await db.action_feedback.insert_one(feedback_record)
    return feedback_record["id"]


async def feedback_processor_loop():
    """Background loop: process pending feedback records (capture AFTER + calc effectiveness)"""
    # Create indexes
    await db.action_feedback.create_index([("status", 1), ("captureAfterAt", 1)])
    await db.action_feedback.create_index([("zoneId", 1), ("actionType", 1)])
    await db.action_feedback.create_index([("createdAt", -1)])
    await db.strategy_weights.create_index("zoneId", unique=True)

    logger.info("Phase G: Action Feedback Processor started (15s cycle)")

    while True:
        try:
            now = now_utc().isoformat()
            # Find pending feedback records that are ready for AFTER capture
            pending = await db.action_feedback.find(
                {"status": "pending", "captureAfterAt": {"$lte": now}},
                {"_id": 0}
            ).to_list(50)

            for record in pending:
                zone_id = record["zoneId"]
                before = record["before"]

                # Capture AFTER snapshot
                after = await capture_zone_snapshot(zone_id)

                # Calculate effectiveness
                result = calculate_effectiveness(before, after)

                # Update record
                await db.action_feedback.update_one(
                    {"id": record["id"]},
                    {"$set": {
                        "after": after,
                        "delta": result["delta"],
                        "effectivenessScore": result["effectivenessScore"],
                        "componentScores": result["componentScores"],
                        "status": "completed",
                        "completedAt": now_utc().isoformat(),
                    }}
                )

            if pending:
                logger.info(f"Feedback processor: completed {len(pending)} feedback records")

        except Exception as e:
            logger.error(f"Feedback processor error: {e}")

        await asyncio.sleep(15)


async def strategy_optimizer_loop():
    """Background loop: recalculate strategy weights based on feedback effectiveness"""
    logger.info("Phase H: Strategy Optimizer started (5min cycle)")

    # Seed default strategy weights
    zones = await db.zones.find({}, {"_id": 0, "id": 1}).to_list(50)
    for zone in zones:
        existing = await db.strategy_weights.find_one({"zoneId": zone["id"]})
        if not existing:
            await db.strategy_weights.insert_one({
                "zoneId": zone["id"],
                "weights": {**DEFAULT_STRATEGY_WEIGHTS},
                "updatedAt": now_utc().isoformat(),
                "history": [],
            })
    # Global weights
    existing_global = await db.strategy_weights.find_one({"zoneId": "global"})
    if not existing_global:
        await db.strategy_weights.insert_one({
            "zoneId": "global",
            "weights": {**DEFAULT_STRATEGY_WEIGHTS},
            "updatedAt": now_utc().isoformat(),
            "history": [],
        })

    while True:
        try:
            await recalculate_strategy_weights()
        except Exception as e:
            logger.error(f"Strategy optimizer error: {e}")

        await asyncio.sleep(STRATEGY_RECALC_INTERVAL)


async def recalculate_strategy_weights():
    """Recalculate strategy weights based on recent feedback data"""
    # Get completed feedback from last 24h
    cutoff = (now_utc() - timedelta(hours=24)).isoformat()
    feedbacks = await db.action_feedback.find(
        {"status": "completed", "createdAt": {"$gte": cutoff}},
        {"_id": 0}
    ).to_list(5000)

    if not feedbacks:
        return

    # ── GLOBAL weights ──
    # Sprint 9 — respect manual control (auto=false) + locked + min/max bounds
    global_control = await db.strategy_weights.find_one({"zoneId": "global"}, {"_id": 0}) or {}
    if global_control.get("locked") or global_control.get("auto") is False:
        logger.info("Strategy optimizer: GLOBAL is manual/locked — skipping global recalc")
    else:
        global_scores = {}
        for fb in feedbacks:
            at = fb["actionType"]
            if at not in global_scores:
                global_scores[at] = []
            global_scores[at].append(fb.get("effectivenessScore", 0))

        gmn = float(global_control.get("minWeight", 0.3))
        gmx = float(global_control.get("maxWeight", 2.0))
        global_weights = {**DEFAULT_STRATEGY_WEIGHTS}
        for action_type, scores in global_scores.items():
            if not scores:
                continue
            avg = sum(scores) / len(scores)
            # ── FIX 3: Cold start — don't adjust if too few samples ──
            if len(scores) < MIN_SAMPLES_FOR_LEARNING:
                global_weights[action_type] = 1.0  # Keep default
                continue
            # Adjust weight: effective actions get boosted, ineffective get reduced
            # Sprint 9 — respect per-strategy min/max bounds
            new_weight = max(gmn, min(gmx, 1.0 + avg * 1.5))
            global_weights[action_type] = round(new_weight, 3)

        await db.strategy_weights.update_one(
            {"zoneId": "global"},
            {"$set": {
                "weights": global_weights,
                "updatedAt": now_utc().isoformat(),
                "sampleCount": len(feedbacks),
            },
            "$push": {"history": {
                "$each": [{"weights": global_weights, "timestamp": now_utc().isoformat(), "sampleCount": len(feedbacks)}],
                "$slice": -48,  # Keep last 48 entries
            }}},
            upsert=True,
        )

    # ── PER-ZONE weights ──
    zone_feedbacks = {}
    for fb in feedbacks:
        zid = fb["zoneId"]
        if zid not in zone_feedbacks:
            zone_feedbacks[zid] = {}
        at = fb["actionType"]
        if at not in zone_feedbacks[zid]:
            zone_feedbacks[zid][at] = []
        zone_feedbacks[zid][at].append(fb.get("effectivenessScore", 0))

    for zone_id, action_scores in zone_feedbacks.items():
        # Sprint 9 — per-zone manual / lock respect
        zone_control = await db.strategy_weights.find_one({"zoneId": zone_id}, {"_id": 0}) or {}
        if zone_control.get("locked") or zone_control.get("auto") is False:
            continue
        zmn = float(zone_control.get("minWeight", 0.3))
        zmx = float(zone_control.get("maxWeight", 2.0))
        zone_weights = {**DEFAULT_STRATEGY_WEIGHTS}
        for action_type, scores in action_scores.items():
            if not scores:
                continue
            avg = sum(scores) / len(scores)
            # ── FIX 3: Cold start — per-zone also respects min samples ──
            if len(scores) < max(10, MIN_SAMPLES_FOR_LEARNING // 3):
                zone_weights[action_type] = 1.0
                continue
            new_weight = max(zmn, min(zmx, 1.0 + avg * 1.5))
            zone_weights[action_type] = round(new_weight, 3)

        await db.strategy_weights.update_one(
            {"zoneId": zone_id},
            {"$set": {
                "weights": zone_weights,
                "updatedAt": now_utc().isoformat(),
                "sampleCount": sum(len(v) for v in action_scores.values()),
            },
            "$push": {"history": {
                "$each": [{"weights": zone_weights, "timestamp": now_utc().isoformat()}],
                "$slice": -48,
            }}},
            upsert=True,
        )

    # Generate recommendations
    recommendations = []
    for action_type, scores in global_scores.items():
        avg = sum(scores) / len(scores) if scores else 0
        count = len(scores)
        if avg < -0.1 and count >= 3:
            recommendations.append({
                "type": "warning",
                "action": action_type,
                "message": f"{action_type} неэффективен (avg={round(avg, 2)}, samples={count}). Рассмотрите снижение приоритета.",
                "avgScore": round(avg, 3),
                "sampleCount": count,
            })
        elif avg > 0.3 and count >= 3:
            recommendations.append({
                "type": "boost",
                "action": action_type,
                "message": f"{action_type} высокоэффективен (avg={round(avg, 2)}, samples={count}). Рекомендуется увеличить использование.",
                "avgScore": round(avg, 3),
                "sampleCount": count,
            })

    # Zone-specific recommendations
    for zone_id, action_scores in zone_feedbacks.items():
        for action_type, scores in action_scores.items():
            avg = sum(scores) / len(scores) if scores else 0
            if avg < -0.15 and len(scores) >= 2:
                zone_name = zone_id.replace("kyiv-", "").title()
                recommendations.append({
                    "type": "zone_warning",
                    "action": action_type,
                    "zoneId": zone_id,
                    "message": f"⚠️ {action_type} в {zone_name} неэффективен (avg={round(avg, 2)})",
                    "avgScore": round(avg, 3),
                    "sampleCount": len(scores),
                })
            elif avg > 0.4 and len(scores) >= 2:
                zone_name = zone_id.replace("kyiv-", "").title()
                recommendations.append({
                    "type": "zone_boost",
                    "action": action_type,
                    "zoneId": zone_id,
                    "message": f"🔥 {action_type} в {zone_name} даёт отличный результат (avg={round(avg, 2)})",
                    "avgScore": round(avg, 3),
                    "sampleCount": len(scores),
                })

    if recommendations:
        await db.strategy_recommendations.delete_many({})
        await db.strategy_recommendations.insert_many([{**r, "createdAt": now_utc().isoformat()} for r in recommendations])

    zones_updated = len(zone_feedbacks)
    logger.info(f"Strategy optimizer: recalculated weights — {len(feedbacks)} samples, {zones_updated} zones, {len(recommendations)} recommendations")


async def get_strategy_weight(zone_id: str, action_type: str) -> float:
    """Get the current strategy weight for a zone+action pair
    FIX 4: Overfitting prevention — blend global + zone weights
    """
    global_weight = 1.0
    zone_weight = 1.0

    global_doc = await db.strategy_weights.find_one({"zoneId": "global"}, {"_id": 0})
    if global_doc and action_type in global_doc.get("weights", {}):
        global_weight = global_doc["weights"][action_type]

    zone_doc = await db.strategy_weights.find_one({"zoneId": zone_id}, {"_id": 0})
    if zone_doc and action_type in zone_doc.get("weights", {}):
        zone_weight = zone_doc["weights"][action_type]

    # FIX 4: Blend — global is anchor, zone adjusts by ZONE_WEIGHT_BLEND factor
    # final = global * (1 - blend) + zone * blend
    blended = global_weight * (1 - ZONE_WEIGHT_BLEND) + zone_weight * ZONE_WEIGHT_BLEND
    return round(blended, 3)


# ── MODIFY orchestrator_run_cycle to integrate feedback tracking ──
