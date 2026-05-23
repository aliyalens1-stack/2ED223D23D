"""app.orchestrator.router — Governance + Orchestrator + Feedback admin API.

Sprint 21 C11: 23 endpoints вынесены из server.py 1-в-1. Все работают с
coll в БД через lazy `db` proxy и делегируют вычисления в cycle.py / feedback.py.

Mutable state (`orchestrator_enabled/cycle_count/last_cycle_at/last_actions_count`)
живёт в app.orchestrator.cycle. Читаем через `cycle.<name>`, пишем через
`cycle.<name> = ...` (Python's `global` не работает кросс-модульно).
"""
from __future__ import annotations
import logging
import random
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from app.core.context import ctx
from app.core.db import db, get_db
from app.core.security import verify_admin_token
# Phase 1B Tier 4 — pure sync cluster enrichment for admin override creation.
from app.core.cluster_writer import enrich_with_cluster
from app.core.utils import now_utc, uid
from app.orchestrator import cycle as _cycle
from app.orchestrator.cycle import (
    orchestrator_run_cycle,
    orchestrator_run_cycle_with_feedback,
    seed_orchestrator_rules,
    ORCHESTRATOR_DEFAULT_RULES,
)
from app.orchestrator.cooldown import orchestrator_cooldowns
from app.orchestrator.feedback import recalculate_strategy_weights, DEFAULT_STRATEGY_WEIGHTS


logger = logging.getLogger("server")
router = APIRouter()


@router.get("/api/admin/governance/actions")
async def get_governance_actions(request: Request, _=Depends(verify_admin_token)):
    """Get governance action history"""
    actions = await db.governance_actions.find({}, {"_id": 0}).sort("createdAt", -1).to_list(50)
    return {"actions": actions}


@router.get("/api/admin/governance/score")
async def governance_score(request: Request, _=Depends(verify_admin_token)):
    """Calculate unified governance score"""
    import math
    
    # Collect component scores (0-100)
    demand_supply = round(random.uniform(50, 95), 1)
    eta = round(random.uniform(55, 90), 1)
    match_success = round(random.uniform(60, 95), 1)
    provider_response = round(random.uniform(45, 90), 1)
    fail_rate_raw = round(random.uniform(3, 25), 1)
    fail_rate_score = round(max(0, 100 - fail_rate_raw * 4), 1)
    incident_count = random.randint(0, 5)
    incident_score = round(max(0, 100 - incident_count * 15), 1)
    automation_stability = round(random.uniform(70, 98), 1)
    
    # Weighted score
    weights = {"demandSupply": 0.2, "eta": 0.15, "matchSuccess": 0.2, "providerResponse": 0.15, "failRate": 0.1, "incidents": 0.1, "automationStability": 0.1}
    components = {
        "demandSupply": demand_supply, "eta": eta, "matchSuccess": match_success,
        "providerResponse": provider_response, "failRate": fail_rate_score,
        "incidents": incident_score, "automationStability": automation_stability,
    }
    
    score = round(sum(components[k] * weights[k] for k in weights), 1)
    status = "healthy" if score >= 75 else "stressed" if score >= 55 else "critical"
    
    # Store snapshot
    snapshot = {
        "id": uid(), "scope": "global", "score": score, "components": components,
        "status": status, "createdAt": now_utc().isoformat(),
    }
    await db.governance_scores.insert_one(snapshot)
    snapshot.pop("_id", None)
    
    return snapshot


@router.get("/api/admin/governance/score/zones")
async def governance_score_zones(request: Request, _=Depends(verify_admin_token)):
    """Get governance scores per zone"""
    zones = [
        ("kyiv-center", "Центр"), ("kyiv-podil", "Подол"), ("kyiv-obolon", "Оболонь"),
        ("lviv-center", "Львов"), ("odessa-center", "Одесса"),
    ]
    results = []
    for zid, zname in zones:
        score = round(random.uniform(40, 95), 1)
        status = "healthy" if score >= 75 else "stressed" if score >= 55 else "critical"
        results.append({"zoneId": zid, "zoneName": zname, "score": score, "status": status,
            "demandSupply": round(random.uniform(40, 95), 1), "eta": round(random.uniform(50, 90), 1),
            "matchSuccess": round(random.uniform(55, 95), 1), "providerResponse": round(random.uniform(40, 90), 1),
        })
    results.sort(key=lambda x: x["score"])
    return {"zones": results}


@router.get("/api/admin/governance/score/history")
async def governance_score_history(request: Request, _=Depends(verify_admin_token)):
    """Get governance score history (24h)"""
    history = []
    for h in range(24):
        ts = (now_utc() - timedelta(hours=h)).isoformat()
        score = round(random.uniform(55, 90), 1)
        status = "healthy" if score >= 75 else "stressed" if score >= 55 else "critical"
        history.append({"score": score, "status": status, "createdAt": ts})
    return {"history": list(reversed(history))}


@router.get("/api/orchestrator/state")
async def orchestrator_state():
    """Get full orchestrator state: zones + active actions + metrics"""
    zones = await db.zones.find({}, {"_id": 0}).to_list(50)
    rules = await db.orchestrator_rules.find({}, {"_id": 0}).to_list(10)
    rules_map = {r["severity"]: r for r in rules}

    overrides = await db.orchestrator_overrides.find({"isActive": True}, {"_id": 0}).to_list(50)
    overrides_map = {ov["zoneId"]: ov for ov in overrides}

    # Get recent actions per zone (last hour)
    one_hour_ago = (now_utc() - timedelta(hours=1)).isoformat()
    recent_logs = await db.orchestrator_logs.find(
        {"createdAt": {"$gte": one_hour_ago}},
        {"_id": 0}
    ).sort("createdAt", -1).to_list(200)

    # Build per-zone log counts
    zone_action_counts = {}
    zone_last_actions = {}
    for log in recent_logs:
        zid = log["zoneId"]
        zone_action_counts[zid] = zone_action_counts.get(zid, 0) + len(log.get("actions", []))
        if zid not in zone_last_actions:
            zone_last_actions[zid] = [a["type"] for a in log.get("actions", [])]

    zone_states = []
    for z in zones:
        zid = z.get("id")
        severity = z.get("status", "BALANCED")
        rule = rules_map.get(severity, {})
        override = overrides_map.get(zid)

        active_action_types = []
        if rule.get("enableSurge") and not (override and override.get("overrides", {}).get("disableSurge")):
            active_action_types.append("surge")
        if rule.get("enablePushProviders") and not (override and override.get("overrides", {}).get("disablePushProviders")):
            active_action_types.append("push")
        if rule.get("enableFanoutOverride") and not (override and override.get("overrides", {}).get("disableFanoutOverride")):
            active_action_types.append("fanout")
        if rule.get("enablePriorityBias"):
            active_action_types.append("priority_bias")
        if rule.get("enableZoneBoost"):
            active_action_types.append("zone_boost")

        zone_states.append({
            "id": zid,
            "name": z.get("name", zid),
            "status": severity,
            "color": z.get("color", "#22C55E"),
            "demand": z.get("demandScore", 0),
            "supply": z.get("supplyScore", 0),
            "ratio": z.get("ratio", 0),
            "avgEta": z.get("avgEta", 0),
            "surgeMultiplier": z.get("surgeMultiplier", 1.0),
            "matchRate": z.get("matchRate", 0),
            "activeActions": active_action_types,
            "lastActions": zone_last_actions.get(zid, []),
            "actionsLastHour": zone_action_counts.get(zid, 0),
            "hasOverride": override is not None,
            "overrideReason": override.get("reason") if override else None,
        })

    # Global metrics
    total_executed = 0
    total_failed = 0
    total_skipped = 0
    for log in recent_logs:
        for a in log.get("actions", []):
            if a["status"] == "executed":
                total_executed += 1
            elif a["status"] == "failed":
                total_failed += 1
            elif a["status"] == "skipped":
                total_skipped += 1

    return {
        "enabled": _cycle.orchestrator_enabled,
        "cycleCount": _cycle.orchestrator_cycle_count,
        "lastCycleAt": _cycle.orchestrator_last_cycle_at,
        "lastActionsCount": _cycle.orchestrator_last_actions_count,
        "cycleIntervalSeconds": 10,
        "zones": zone_states,
        "metrics": {
            "totalActionsLastHour": total_executed + total_failed + total_skipped,
            "executedLastHour": total_executed,
            "failedLastHour": total_failed,
            "skippedLastHour": total_skipped,
            "activeOverrides": len(overrides),
            "zonesMonitored": len(zones),
            "criticalZones": sum(1 for z in zones if z.get("status") == "CRITICAL"),
            "surgeZones": sum(1 for z in zones if z.get("status") == "SURGE"),
        },
        "rulesConfigured": len(rules),
    }


@router.get("/api/orchestrator/rules")
async def orchestrator_get_rules():
    """Get all orchestrator rules"""
    rules = await db.orchestrator_rules.find({}, {"_id": 0}).to_list(10)
    if not rules:
        await seed_orchestrator_rules()
        rules = await db.orchestrator_rules.find({}, {"_id": 0}).to_list(10)
    # Sort by severity order
    severity_order = {"BALANCED": 0, "BUSY": 1, "SURGE": 2, "CRITICAL": 3}
    rules.sort(key=lambda r: severity_order.get(r.get("severity"), 99))
    return {"rules": rules}


@router.patch("/api/orchestrator/rules")
async def orchestrator_update_rule(request: Request, _=Depends(verify_admin_token)):
    """Update an orchestrator rule"""
    body = await request.json()
    severity = body.get("severity")
    if severity not in ["BALANCED", "BUSY", "SURGE", "CRITICAL"]:
        raise HTTPException(400, "Invalid severity. Must be BALANCED, BUSY, SURGE, or CRITICAL")

    update_fields = {}
    for key in ["enableSurge", "surgeMultiplier", "enablePushProviders", "pushRadiusKm",
                 "enableFanoutOverride", "fanout", "enablePriorityBias", "priorityBiasLevel",
                 "enableZoneBoost", "zoneBoostScore", "cooldownSeconds"]:
        if key in body:
            update_fields[key] = body[key]

    update_fields["updatedAt"] = now_utc().isoformat()

    result = await db.orchestrator_rules.find_one_and_update(
        {"severity": severity},
        {"$set": update_fields},
        upsert=True,
        return_document=True
    )
    result.pop("_id", None)
    return {"status": "updated", "rule": result}


@router.get("/api/orchestrator/overrides")
async def orchestrator_get_overrides():
    """List active overrides (public read — write requires admin).

    D2: parity with the rest of the orchestrator read-only API
    (/state, /rules, /logs, /metrics, /history, /config) which is also
    public. Mutations stay behind verify_admin_token.
    """
    overrides = await db.orchestrator_overrides.find(
        {"isActive": True},
        {"_id": 0}
    ).to_list(50)
    # Filter expired
    active = []
    for ov in overrides:
        expires = ov.get("expiresAt")
        if expires and expires < now_utc().isoformat():
            await db.orchestrator_overrides.update_one({"id": ov["id"]}, {"$set": {"isActive": False}})
            continue
        active.append(ov)
    return {"overrides": active}


@router.post("/api/orchestrator/overrides")
async def orchestrator_create_override(request: Request, payload=Depends(verify_admin_token)):
    """Create a manual override for a zone"""
    body = await request.json()
    zone_id = body.get("zoneId")
    if not zone_id:
        raise HTTPException(400, "zoneId is required")

    reason = body.get("reason", "Manual admin override")
    expires_minutes = body.get("expiresMinutes")
    expires_at = (now_utc() + timedelta(minutes=expires_minutes)).isoformat() if expires_minutes else None

    override = {
        "id": uid(),
        "zoneId": zone_id,
        "isActive": True,
        "overrides": {
            "disableSurge": body.get("disableSurge", False),
            "forceSurgeMultiplier": body.get("forceSurgeMultiplier"),
            "disablePushProviders": body.get("disablePushProviders", False),
            "forcePushProviders": body.get("forcePushProviders", False),
            "disableFanoutOverride": body.get("disableFanoutOverride", False),
            "forceFanout": body.get("forceFanout"),
        },
        "reason": reason,
        "createdBy": payload.get("email", "admin"),
        "expiresAt": expires_at,
        "createdAt": now_utc().isoformat(),
    }
    await db.orchestrator_overrides.insert_one(override)
    override.pop("_id", None)

    # Log the override creation
    # Phase 1B Tier 4 — caller-side zone lookup.
    zone_doc_ov = await db.zones.find_one({"id": zone_id}, {"_id": 0, "cluster": 1})
    zone_cluster_ov = (zone_doc_ov or {}).get("cluster")
    ov_log = {
        "id": uid(),
        "zoneId": zone_id,
        "zoneName": zone_id,
        "severity": "OVERRIDE",
        "detectedState": {"demand": 0, "supply": 0, "ratio": 0, "avgEta": 0},
        "actions": [{"type": "ADMIN_OVERRIDE_CREATED", "payload": override["overrides"], "status": "executed"}],
        "source": "admin_override",
        "createdAt": now_utc().isoformat(),
    }
    enrich_with_cluster(
        ov_log,
        cluster=zone_cluster_ov,
        strategy="zone_lookup" if zone_cluster_ov else "manual_review",
        source_field="zoneId",
    )
    await db.orchestrator_logs.insert_one(ov_log)

    return {"status": "created", "override": override}


@router.post("/api/orchestrator/overrides/{override_id}/disable")
async def orchestrator_disable_override(override_id: str, _=Depends(verify_admin_token)):
    """Disable an active override"""
    result = await db.orchestrator_overrides.find_one_and_update(
        {"id": override_id, "isActive": True},
        {"$set": {"isActive": False, "disabledAt": now_utc().isoformat()}},
        return_document=True
    )
    if not result:
        raise HTTPException(404, "Override not found or already disabled")
    result.pop("_id", None)
    return {"status": "disabled", "override": result}


@router.get("/api/orchestrator/logs")
async def orchestrator_get_logs(limit: int = 100, zoneId: str = None, severity: str = None):
    """Get orchestrator action logs"""
    query = {}
    if zoneId:
        query["zoneId"] = zoneId
    if severity:
        query["severity"] = severity

    logs = await db.orchestrator_logs.find(query, {"_id": 0}).sort("createdAt", -1).to_list(limit)

    # Aggregate stats
    stats = {"total": len(logs), "executed": 0, "failed": 0, "skipped": 0, "bySeverity": {}, "byActionType": {}}
    for log in logs:
        sev = log.get("severity", "?")
        stats["bySeverity"][sev] = stats["bySeverity"].get(sev, 0) + 1
        for a in log.get("actions", []):
            atype = a.get("type", "?")
            stats["byActionType"][atype] = stats["byActionType"].get(atype, 0) + 1
            if a["status"] == "executed":
                stats["executed"] += 1
            elif a["status"] == "failed":
                stats["failed"] += 1
            elif a["status"] == "skipped":
                stats["skipped"] += 1

    return {"logs": logs, "stats": stats}


@router.post("/api/orchestrator/run-cycle")
async def orchestrator_manual_run(_=Depends(verify_admin_token)):
    """Manually trigger an orchestrator cycle"""
    await orchestrator_run_cycle()
    return {"status": "ok", "cycleCount": _cycle.orchestrator_cycle_count, "lastActionsCount": _cycle.orchestrator_last_actions_count}


@router.post("/api/orchestrator/toggle")
async def orchestrator_toggle(request: Request, _=Depends(verify_admin_token)):
    """Enable or disable the orchestrator engine"""
    body = await request.json()
    # D2: the previous `global orchestrator_enabled` was a no-op — the
    # name was never bound at module level, so toggling did nothing
    # observable. Cycle reads `_cycle.orchestrator_enabled`, so we
    # write through the same module-level binding.
    _cycle.orchestrator_enabled = bool(body.get("enabled", True))
    return {"enabled": _cycle.orchestrator_enabled}


@router.get("/api/orchestrator/metrics")
async def orchestrator_metrics():
    """Get orchestrator performance metrics over time"""
    # Last 24h aggregated by hour
    metrics_timeline = []
    for h in range(24):
        ts_start = (now_utc() - timedelta(hours=h + 1)).isoformat()
        ts_end = (now_utc() - timedelta(hours=h)).isoformat()

        logs = await db.orchestrator_logs.find(
            {"createdAt": {"$gte": ts_start, "$lt": ts_end}},
            {"_id": 0, "actions": 1, "severity": 1}
        ).to_list(500)

        executed = 0
        failed = 0
        total_actions = 0
        severities = {"BALANCED": 0, "BUSY": 0, "SURGE": 0, "CRITICAL": 0}
        for log in logs:
            sev = log.get("severity", "BALANCED")
            if sev in severities:
                severities[sev] += 1
            for a in log.get("actions", []):
                total_actions += 1
                if a["status"] == "executed":
                    executed += 1
                elif a["status"] == "failed":
                    failed += 1

        metrics_timeline.append({
            "hour": h,
            "timestamp": ts_end,
            "totalActions": total_actions,
            "executed": executed,
            "failed": failed,
            "cycleCount": len(logs),
            "severities": severities,
        })

    # Current zone health summary
    zones = await db.zones.find({}, {"_id": 0, "id": 1, "status": 1, "ratio": 1, "surgeMultiplier": 1}).to_list(50)
    zone_health = {
        "total": len(zones),
        "balanced": sum(1 for z in zones if z.get("status") == "BALANCED"),
        "busy": sum(1 for z in zones if z.get("status") == "BUSY"),
        "surge": sum(1 for z in zones if z.get("status") == "SURGE"),
        "critical": sum(1 for z in zones if z.get("status") == "CRITICAL"),
        "avgRatio": round(sum(z.get("ratio", 0) for z in zones) / max(len(zones), 1), 2),
        "avgSurge": round(sum(z.get("surgeMultiplier", 1) for z in zones) / max(len(zones), 1), 2),
    }

    # Active overrides
    overrides_count = await db.orchestrator_overrides.count_documents({"isActive": True})

    return {
        "enabled": _cycle.orchestrator_enabled,
        "cycleCount": _cycle.orchestrator_cycle_count,
        "lastCycleAt": _cycle.orchestrator_last_cycle_at,
        "cycleIntervalSeconds": 10,
        "timeline": list(reversed(metrics_timeline)),
        "zoneHealth": zone_health,
        "activeOverrides": overrides_count,
    }


@router.get("/api/orchestrator/zone/{zone_id}/history")
async def orchestrator_zone_history(zone_id: str, limit: int = 50):
    """Get orchestrator action history for a specific zone"""
    logs = await db.orchestrator_logs.find(
        {"zoneId": zone_id},
        {"_id": 0}
    ).sort("createdAt", -1).to_list(limit)

    # Build action timeline
    action_timeline = []
    for log in logs:
        for action in log.get("actions", []):
            action_timeline.append({
                "timestamp": log["createdAt"],
                "severity": log["severity"],
                "actionType": action["type"],
                "status": action["status"],
                "payload": action.get("payload", {}),
                "reason": action.get("reason"),
                "source": log.get("source", "system"),
            })

    return {"zoneId": zone_id, "logs": logs, "actionTimeline": action_timeline[:limit]}


@router.get("/api/orchestrator/config")
async def orchestrator_get_config():
    """Get orchestrator engine configuration"""
    return {
        "enabled": _cycle.orchestrator_enabled,
        "cycleIntervalSeconds": 10,
        "cycleCount": _cycle.orchestrator_cycle_count,
        "lastCycleAt": _cycle.orchestrator_last_cycle_at,
        "cooldowns": {k: v for k, v in orchestrator_cooldowns.items()},
        "defaultRules": ORCHESTRATOR_DEFAULT_RULES,
    }


@router.get("/api/feedback/actions")
async def feedback_get_actions(limit: int = 100, status: str = None, actionType: str = None):
    """Get feedback records"""
    query = {}
    if status:
        query["status"] = status
    if actionType:
        query["actionType"] = actionType
    records = await db.action_feedback.find(query, {"_id": 0}).sort("createdAt", -1).to_list(limit)

    # Aggregate stats
    completed = [r for r in records if r.get("status") == "completed"]
    avg_effectiveness = round(sum(r.get("effectivenessScore", 0) for r in completed) / max(len(completed), 1), 4)

    by_action = {}
    for r in completed:
        at = r["actionType"]
        if at not in by_action:
            by_action[at] = {"count": 0, "totalScore": 0, "avgScore": 0}
        by_action[at]["count"] += 1
        by_action[at]["totalScore"] += r.get("effectivenessScore", 0)
    for at in by_action:
        by_action[at]["avgScore"] = round(by_action[at]["totalScore"] / max(by_action[at]["count"], 1), 4)

    return {
        "records": records,
        "stats": {
            "total": len(records),
            "completed": len(completed),
            "pending": len(records) - len(completed),
            "avgEffectiveness": avg_effectiveness,
            "byActionType": by_action,
        },
    }


@router.get("/api/feedback/zone/{zone_id}")
async def feedback_get_zone(zone_id: str, limit: int = 50):
    """Get feedback for a specific zone"""
    records = await db.action_feedback.find(
        {"zoneId": zone_id, "status": "completed"},
        {"_id": 0}
    ).sort("createdAt", -1).to_list(limit)

    # Per-action breakdown
    by_action = {}
    for r in records:
        at = r["actionType"]
        if at not in by_action:
            by_action[at] = {"scores": [], "avgScore": 0, "count": 0}
        by_action[at]["scores"].append(r.get("effectivenessScore", 0))
        by_action[at]["count"] += 1
    for at in by_action:
        by_action[at]["avgScore"] = round(sum(by_action[at]["scores"]) / max(len(by_action[at]["scores"]), 1), 4)
        by_action[at].pop("scores")

    return {"zoneId": zone_id, "records": records, "breakdown": by_action}


@router.get("/api/feedback/top-actions")
async def feedback_top_actions(limit: int = 20):
    """Get most effective actions"""
    records = await db.action_feedback.find(
        {"status": "completed", "effectivenessScore": {"$ne": None}},
        {"_id": 0}
    ).sort("effectivenessScore", -1).to_list(limit)
    return {"topActions": records}


@router.get("/api/feedback/worst-actions")
async def feedback_worst_actions(limit: int = 20):
    """Get least effective actions"""
    records = await db.action_feedback.find(
        {"status": "completed", "effectivenessScore": {"$ne": None}},
        {"_id": 0}
    ).sort("effectivenessScore", 1).to_list(limit)
    return {"worstActions": records}


@router.get("/api/feedback/strategy")
async def feedback_get_strategy():
    """Get current strategy weights (global + per-zone)"""
    global_w = await db.strategy_weights.find_one({"zoneId": "global"}, {"_id": 0})
    zone_weights = await db.strategy_weights.find({"zoneId": {"$ne": "global"}}, {"_id": 0}).to_list(50)

    return {
        "global": global_w or {"weights": DEFAULT_STRATEGY_WEIGHTS},
        "zones": zone_weights,
        "defaults": DEFAULT_STRATEGY_WEIGHTS,
    }


@router.get("/api/feedback/recommendations")
async def feedback_get_recommendations():
    """Get AI-generated strategy recommendations"""
    recs = await db.strategy_recommendations.find({}, {"_id": 0}).to_list(50)
    return {"recommendations": recs}


@router.post("/api/feedback/recalculate")
async def feedback_recalculate(_=Depends(verify_admin_token)):
    """Manually trigger strategy recalculation"""
    await recalculate_strategy_weights()
    global_w = await db.strategy_weights.find_one({"zoneId": "global"}, {"_id": 0})
    return {"status": "recalculated", "globalWeights": global_w.get("weights", {}) if global_w else {}}


@router.get("/api/feedback/dashboard")
async def feedback_dashboard():
    """Full feedback + strategy dashboard"""
    # Recent feedback stats
    cutoff_1h = (now_utc() - timedelta(hours=1)).isoformat()
    cutoff_24h = (now_utc() - timedelta(hours=24)).isoformat()

    total_1h = await db.action_feedback.count_documents({"createdAt": {"$gte": cutoff_1h}})
    completed_1h = await db.action_feedback.count_documents({"status": "completed", "createdAt": {"$gte": cutoff_1h}})
    total_24h = await db.action_feedback.count_documents({"createdAt": {"$gte": cutoff_24h}})
    completed_24h = await db.action_feedback.count_documents({"status": "completed", "createdAt": {"$gte": cutoff_24h}})
    pending = await db.action_feedback.count_documents({"status": "pending"})

    # Avg effectiveness last 24h
    completed_records = await db.action_feedback.find(
        {"status": "completed", "createdAt": {"$gte": cutoff_24h}},
        {"_id": 0, "effectivenessScore": 1, "actionType": 1, "zoneId": 1}
    ).to_list(5000)

    avg_eff = round(sum(r.get("effectivenessScore", 0) for r in completed_records) / max(len(completed_records), 1), 4)

    # Per-action breakdown
    by_action = {}
    for r in completed_records:
        at = r["actionType"]
        if at not in by_action:
            by_action[at] = {"count": 0, "totalScore": 0}
        by_action[at]["count"] += 1
        by_action[at]["totalScore"] += r.get("effectivenessScore", 0)
    for at in by_action:
        by_action[at]["avgScore"] = round(by_action[at]["totalScore"] / max(by_action[at]["count"], 1), 4)
        by_action[at].pop("totalScore")

    # Strategy weights
    global_w = await db.strategy_weights.find_one({"zoneId": "global"}, {"_id": 0})
    recs = await db.strategy_recommendations.find({}, {"_id": 0}).to_list(20)

    return {
        "stats": {
            "lastHour": {"total": total_1h, "completed": completed_1h},
            "last24h": {"total": total_24h, "completed": completed_24h},
            "pending": pending,
            "avgEffectiveness24h": avg_eff,
        },
        "actionBreakdown": by_action,
        "strategy": {
            "globalWeights": global_w.get("weights", DEFAULT_STRATEGY_WEIGHTS) if global_w else DEFAULT_STRATEGY_WEIGHTS,
            "lastUpdated": global_w.get("updatedAt") if global_w else None,
            "sampleCount": global_w.get("sampleCount", 0) if global_w else 0,
        },
        "recommendations": recs,
    }
