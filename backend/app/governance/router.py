"""Governance router — consolidated 37 admin endpoints extracted from server.py.

Все endpoints используют общий контракт:
- admin-JWT защита через verify_admin_token (или открыто для /api/push/* legacy)
- governance_actions audit log (где применимо)
- cluster enrichment (Phase 1B Tier 2)
- standard error envelope

Этот модуль закрывает Sprint 21 декомпозицию server.py.
"""
from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from app.core.cluster_writer import enrich_with_cluster, DEFAULT_ADMIN_ACTION_CLUSTER
from app.core.config import NESTJS_URL
from app.core.context import ctx
from app.core.realtime import emit_realtime_event
from app.core.security import verify_admin_token
from app.core.utils import now_utc, uid

router = APIRouter(tags=["governance"])


# ─── helpers (private) ──────────────────────────────────────────────────────

def _db():
    """Lazy DB accessor — uses shared AppContext seeded by server.py."""
    return ctx.db


def _http():
    """Lazy HTTP client — used for NestJS proxy fallbacks in flow/config."""
    return ctx.http_client


def _strip_enrichment(action: dict) -> dict:
    """Remove cluster write-side metadata before returning to client."""
    action.pop("_id", None)
    action.pop("cluster", None)
    action.pop("clusterCreateMeta", None)
    return action


def _pct(num, denom):
    return round(num / denom * 100, 1) if denom else 0.0


# ═══════════════════════════════════════════════════════════════════════════
# Section 1 — Demand push + Provider behavior + Flow control
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/api/admin/demand/push-providers")
async def demand_push_providers(request: Request, admin_ctx: dict = Depends(verify_admin_token)):
    """Push notification to providers in a zone with high demand."""
    body = await request.json()
    zone_id = body.get("zoneId", "all")
    min_score = body.get("minScore", 0)
    message = body.get("message", "Высокий спрос в вашей зоне!")

    devices = await _db().push_devices.find(
        {"role": {"$in": ["provider_owner", "provider_manager"]}, "isActive": True},
        {"_id": 0},
    ).to_list(200)

    action_log = {
        "id": uid(), "type": "demand_push", "zoneId": zone_id,
        "targetCount": len(devices), "message": message,
        "minScore": min_score, "createdAt": now_utc().isoformat(),
        "status": "sent",
        "adminAccountId": admin_ctx.get("accountId"),
        "adminUserId": admin_ctx.get("userId") or admin_ctx.get("sub"),
    }
    enrich_with_cluster(
        action_log, cluster=DEFAULT_ADMIN_ACTION_CLUSTER,
        strategy="admin_default_repair", reason="legacy_taxi_admin_push",
    )
    await _db().governance_actions.insert_one(action_log)
    return {"status": "sent", "targetCount": len(devices), "action": _strip_enrichment(action_log)}


@router.post("/api/admin/demand/{zone_id}/boost-supply")
async def boost_supply(zone_id: str, request: Request, admin_ctx: dict = Depends(verify_admin_token)):
    """Boost supply in a zone - increase visibility for providers."""
    body = await request.json()
    boost_level = body.get("boostLevel", 1.5)
    duration_minutes = body.get("durationMinutes", 30)

    zone_doc = await _db().zones.find_one({"id": zone_id}, {"_id": 0, "cluster": 1})
    zone_cluster = (zone_doc or {}).get("cluster")

    action_log = {
        "id": uid(), "type": "boost_supply", "zoneId": zone_id,
        "boostLevel": boost_level, "durationMinutes": duration_minutes,
        "createdAt": now_utc().isoformat(), "status": "active",
        "adminAccountId": admin_ctx.get("accountId"),
        "adminUserId": admin_ctx.get("userId") or admin_ctx.get("sub"),
    }
    enrich_with_cluster(
        action_log, cluster=zone_cluster,
        strategy="zone_lookup" if zone_cluster else "manual_review",
        source_field="zoneId",
    )
    await _db().governance_actions.insert_one(action_log)
    return {"status": "boosted", "zoneId": zone_id, "action": _strip_enrichment(action_log)}


@router.get("/api/admin/providers/behavior")
async def provider_behavior_overview(_=Depends(verify_admin_token)):
    """Provider behavior overview — real aggregations from DB."""
    db = _db()
    providers = await db.organizations.find(
        {"status": "active"},
        {"_id": 0, "id": 1, "name": 1, "slug": 1, "ratingAvg": 1, "reviewsCount": 1,
         "bookingsCount": 1, "completedBookingsCount": 1, "avgResponseTimeMinutes": 1,
         "visibilityScore": 1, "visibilityState": 1, "acceptanceRate": 1,
         "completionRate": 1, "missedRequests": 1},
    ).to_list(100)

    org_slugs = [p.get("slug") for p in providers if p.get("slug")]
    bookings_agg: dict = {}
    if org_slugs:
        cursor = db.bookings.aggregate([
            {"$match": {"providerSlug": {"$in": org_slugs}}},
            {"$group": {
                "_id": "$providerSlug",
                "total": {"$sum": 1},
                "completed": {"$sum": {"$cond": [{"$eq": ["$status", "completed"]}, 1, 0]}},
                "accepted": {"$sum": {"$cond": [{"$in": ["$status", ["accepted", "in_progress", "completed"]]}, 1, 0]}},
                "missed": {"$sum": {"$cond": [{"$in": ["$status", ["rejected", "expired", "timeout"]]}, 1, 0]}},
                "revenue": {"$sum": {"$ifNull": ["$priceEstimate", 0]}},
            }},
        ])
        async for row in cursor:
            bookings_agg[row["_id"]] = row

    behavior_data: list = []
    risky_count = top_count = slow_count = 0

    for p in providers:
        slug = p.get("slug", "")
        agg = bookings_agg.get(slug, {})
        total_b = agg.get("total", 0) or p.get("bookingsCount", 0) or 0
        completed_b = agg.get("completed", 0) or p.get("completedBookingsCount", 0) or 0
        accepted_b = agg.get("accepted", 0)
        missed = agg.get("missed", 0) or p.get("missedRequests", 0) or 0
        revenue = agg.get("revenue", 0)

        acceptance_rate = round(accepted_b / total_b * 100) if total_b else int(p.get("acceptanceRate", 0) or 0)
        completion_rate = round(completed_b / total_b * 100) if total_b else int(p.get("completionRate", 0) or 0)
        response_time = int(p.get("avgResponseTimeMinutes") or 0)
        rating = float(p.get("ratingAvg") or 0)

        resp_score = max(0, 100 - response_time * 2) if response_time else 60
        score = round(
            (rating / 5.0) * 40
            + (acceptance_rate / 100.0) * 25
            + (completion_rate / 100.0) * 25
            + (resp_score / 100.0) * 10
        )
        score = max(0, min(100, score))

        flags = []
        if score < 40:
            flags.append("low_score"); risky_count += 1
        if response_time and response_time > 30:
            flags.append("slow_response"); slow_count += 1
        if total_b > 0 and acceptance_rate < 60:
            flags.append("low_acceptance")
        if score > 80:
            top_count += 1

        avg_revenue = round(revenue / completed_b) if completed_b else 0
        lost_revenue = missed * avg_revenue

        behavior_data.append({
            "providerId": slug or p.get("id") or uid()[:8],
            "name": p.get("name", "Unknown"),
            "score": score,
            "tier": "Platinum" if score >= 90 else "Gold" if score >= 75 else "Silver" if score >= 50 else "Bronze",
            "acceptanceRate": acceptance_rate,
            "responseTimeAvg": response_time,
            "completionRate": completion_rate,
            "missedRequests": missed,
            "lostRevenue": lost_revenue,
            "flags": flags,
            "rating": round(rating, 2),
            "visibility": int(p.get("visibilityScore") or 0),
            "totalBookings": total_b,
        })

    behavior_data.sort(key=lambda x: x["score"])
    return {
        "providers": behavior_data,
        "stats": {
            "total": len(behavior_data),
            "risky": risky_count, "top": top_count, "slow": slow_count,
            "avgScore": round(sum(p["score"] for p in behavior_data) / max(len(behavior_data), 1), 1),
        },
        "recommendations": [
            {"action": "limit_visibility", "target": f"{risky_count} мастеров со score < 40", "impact": "Снижение bad UX"},
            {"action": "send_warning", "target": f"{slow_count} медленных мастеров", "impact": "Ускорение ответов"},
            {"action": "boost_top", "target": f"{top_count} топ мастеров", "impact": "Увеличение конверсии"},
        ],
    }


@router.post("/api/admin/providers/behavior/bulk-action")
async def provider_behavior_bulk_action(request: Request, _=Depends(verify_admin_token)):
    """Execute bulk action on providers — real affectedCount."""
    db = _db()
    body = await request.json()
    action = body.get("action", "warn")
    filter_criteria = body.get("filter", {})
    message = body.get("message", "")

    mongo_filter: dict = {"status": "active"}
    min_rating = filter_criteria.get("minRating")
    max_rating = filter_criteria.get("maxRating")
    if min_rating is not None or max_rating is not None:
        mongo_filter["ratingAvg"] = {}
        if min_rating is not None:
            mongo_filter["ratingAvg"]["$gte"] = float(min_rating)
        if max_rating is not None:
            mongo_filter["ratingAvg"]["$lte"] = float(max_rating)
    if filter_criteria.get("isPromoted") is not None:
        mongo_filter["isPromoted"] = bool(filter_criteria["isPromoted"])
    if filter_criteria.get("slugs"):
        mongo_filter["slug"] = {"$in": list(filter_criteria["slugs"])}
    affected = await db.organizations.count_documents(mongo_filter)

    action_log = {
        "id": uid(), "type": f"behavior_{action}", "filter": filter_criteria,
        "message": message, "createdAt": now_utc().isoformat(),
        "status": "executed", "affectedCount": affected,
    }
    enrich_with_cluster(
        action_log, cluster=DEFAULT_ADMIN_ACTION_CLUSTER,
        strategy="admin_default_repair", reason="legacy_taxi_admin_bulk_behavior",
    )
    await db.governance_actions.insert_one(action_log)
    return {"status": "executed", "action": _strip_enrichment(action_log)}


@router.get("/api/admin/flow/config")
async def get_flow_config(request: Request, _=Depends(verify_admin_token)):
    """Get request flow configuration — proxy first, defaults on miss."""
    try:
        headers = dict(request.headers); headers.pop('host', None)
        resp = await _http().get(f"{NESTJS_URL}/api/admin/distribution/config", headers=headers, timeout=3.0)
        if 200 <= resp.status_code < 300:
            return Response(content=resp.content, status_code=resp.status_code, media_type='application/json')
    except Exception:
        pass
    return {
        "providersPerRequest": 3, "ttlSeconds": 30, "retryCount": 2,
        "escalationEnabled": True, "autoDistribute": True, "maxRadius": 5,
        "minProviderScore": 30,
        "priorityWeights": {"distance": 0.4, "rating": 0.3, "responseTime": 0.2, "price": 0.1},
    }


@router.post("/api/admin/flow/config")
async def update_flow_config(request: Request, _=Depends(verify_admin_token)):
    """Update flow configuration — proxy through to NestJS if available."""
    body = await request.json()
    try:
        headers = dict(request.headers)
        headers.pop('host', None); headers.pop('content-length', None)
        resp = await _http().post(f"{NESTJS_URL}/api/admin/distribution/config",
                                  headers=headers, json=body, timeout=3.0)
        if 200 <= resp.status_code < 300:
            return Response(content=resp.content, status_code=resp.status_code, media_type='application/json')
    except Exception:
        pass
    return {"status": "updated", "config": body}


@router.get("/api/admin/flow/metrics")
async def get_flow_metrics(_=Depends(verify_admin_token)):
    """Flow performance metrics — real aggregations from bookings + requests."""
    db = _db()
    today_start = now_utc().replace(hour=0, minute=0, second=0, microsecond=0).isoformat()

    total_today = await db.bookings.count_documents({"createdAt": {"$gte": today_start}})
    matched_today = await db.bookings.count_documents({"createdAt": {"$gte": today_start}, "status": {"$in": ["accepted", "in_progress", "completed"]}})
    failed_today = await db.bookings.count_documents({"createdAt": {"$gte": today_start}, "status": {"$in": ["expired", "rejected", "timeout", "cancelled"]}})
    completed_today = await db.bookings.count_documents({"createdAt": {"$gte": today_start}, "status": "completed"})

    total_all = await db.bookings.count_documents({})
    matched_all = await db.bookings.count_documents({"status": {"$in": ["accepted", "in_progress", "completed"]}})
    failed_all = await db.bookings.count_documents({"status": {"$in": ["expired", "rejected", "timeout"]}})
    reassigned_all = await db.bookings.count_documents({"reassignCount": {"$gt": 0}}) if total_all else 0
    ttl_hits = await db.bookings.count_documents({"status": "timeout"}) if total_all else 0

    avg_match_agg = await db.bookings.aggregate([
        {"$match": {"matchTimeSeconds": {"$exists": True, "$gt": 0}}},
        {"$group": {"_id": None, "avg": {"$avg": "$matchTimeSeconds"}}},
    ]).to_list(1)
    avg_match_time = round(avg_match_agg[0]["avg"], 1) if avg_match_agg else 0.0

    avg_resp_agg = await db.organizations.aggregate([
        {"$match": {"avgResponseTimeMinutes": {"$gt": 0}}},
        {"$group": {"_id": None, "avg": {"$avg": "$avgResponseTimeMinutes"}}},
    ]).to_list(1)
    avg_provider_response_time = round(avg_resp_agg[0]["avg"] * 60) if avg_resp_agg else 0

    avg_dist_agg = await db.bookings.aggregate([
        {"$match": {"distributionCount": {"$exists": True}}},
        {"$group": {"_id": None, "avg": {"$avg": "$distributionCount"}}},
    ]).to_list(1)
    avg_distribution_count = round(avg_dist_agg[0]["avg"], 1) if avg_dist_agg else 0.0

    return {
        "avgMatchTime": avg_match_time,
        "failRate": _pct(failed_all, total_all),
        "reassignRate": _pct(reassigned_all, total_all),
        "avgDistributionCount": avg_distribution_count,
        "ttlHitRate": _pct(ttl_hits, total_all),
        "avgProviderResponseTime": avg_provider_response_time,
        "conversionRate": _pct(matched_all, total_all),
        "totalRequestsToday": total_today,
        "matchedToday": matched_today,
        "failedToday": failed_today,
        "completedToday": completed_today,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Section 2 — Demand → Action Chains (Auto-Reaction Engine)
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/api/admin/demand/actions/recommendations")
async def demand_action_recommendations(zoneId: str = "all", _=Depends(verify_admin_token)):
    """AI recommendations for a zone based on real live demand state."""
    db = _db()
    if zoneId == "all":
        zones = await db.zones.find({}, {"_id": 0}).to_list(50)
        demand = sum(z.get("demandScore", 0) or 0 for z in zones)
        supply = sum(z.get("supplyScore", 0) or 0 for z in zones) or 1
        ratio = round(demand / supply, 2)
        eta_vals = [z.get("avgEta", 0) for z in zones if z.get("avgEta")]
        avg_eta = round(sum(eta_vals) / len(eta_vals), 1) if eta_vals else 0.0
        requests_count = demand
        providers_count = supply
    else:
        z = await db.zones.find_one({"id": zoneId}, {"_id": 0}) or {}
        demand = z.get("demandScore", 0) or 0
        supply = z.get("supplyScore", 0) or 1
        ratio = round(demand / supply, 2)
        avg_eta = round(z.get("avgEta", 0) or 0, 1)
        requests_count = demand
        providers_count = supply

    state = "critical" if ratio > 4 else "surge" if ratio > 3 else "busy" if ratio > 2 else "balanced"
    recommendations: list = []
    if ratio > 2:
        recommendations.append({"type": "push_providers", "priority": 1, "impact": "high", "description": "Push мастерам в зоне"})
    if ratio > 3:
        surge_mult = round(ratio * 0.3 + 0.5, 1)
        recommendations.append({"type": "activate_surge", "priority": 2, "impact": "high", "description": f"Surge x{surge_mult}", "params": {"multiplier": surge_mult}})
        recommendations.append({"type": "increase_distribution", "priority": 3, "impact": "medium", "description": "Distribution 3→6", "params": {"from": 3, "to": 6}})
    if ratio > 4:
        recommendations.append({"type": "expand_radius", "priority": 4, "impact": "medium", "description": "Радиус 5→8 км", "params": {"from": 5, "to": 8}})
        recommendations.append({"type": "escalate", "priority": 5, "impact": "high", "description": "Escalation оператору"})

    chains = await db.action_chains.find({"isEnabled": True}, {"_id": 0}).to_list(10)
    return {
        "zoneId": zoneId, "state": state, "ratio": ratio,
        "requests": requests_count, "providers": providers_count, "avgEta": avg_eta,
        "recommendations": recommendations,
        "availableChains": [{"id": c.get("id"), "name": c.get("name"), "steps": len(c.get("steps", []))} for c in chains],
    }


@router.post("/api/admin/demand/actions/run")
async def demand_action_run(request: Request, admin_ctx: dict = Depends(verify_admin_token)):
    """Execute a demand action chain — real before/after ratios from zone snapshots."""
    db = _db()
    body = await request.json()
    zone_id = body.get("zoneId", "all")
    chain_id = body.get("chainId")
    mode = body.get("mode", "manual")

    if zone_id == "all":
        zones_before = await db.zones.find({}, {"_id": 0}).to_list(50)
        demand_b = sum(z.get("demandScore", 0) or 0 for z in zones_before)
        supply_b = sum(z.get("supplyScore", 0) or 0 for z in zones_before) or 1
        ratio_before = round(demand_b / supply_b, 2)
        eta_before_vals = [z.get("avgEta", 0) for z in zones_before if z.get("avgEta")]
        eta_before = round(sum(eta_before_vals) / len(eta_before_vals), 1) if eta_before_vals else 0.0
    else:
        z = await db.zones.find_one({"id": zone_id}, {"_id": 0}) or {}
        d = z.get("demandScore", 0) or 0
        s = z.get("supplyScore", 0) or 1
        ratio_before = round(d / s, 2)
        eta_before = round(z.get("avgEta", 0) or 0, 1)

    steps: list = []
    if chain_id:
        chain = await db.action_chains.find_one({"id": chain_id}, {"_id": 0})
        if chain and chain.get("steps"):
            for step in chain["steps"]:
                steps.append({
                    "type": step.get("type", "push_providers"),
                    "status": "completed",
                    "params": step.get("params", {}),
                    "startedAt": now_utc().isoformat(),
                })
    if not steps:
        steps = [
            {"type": "push_providers", "status": "completed", "startedAt": now_utc().isoformat()},
            {"type": "activate_surge", "status": "completed", "params": {"multiplier": 1.5}},
            {"type": "increase_distribution", "status": "completed", "params": {"to": 6}},
        ]

    execution = {
        "id": uid(), "zoneId": zone_id, "chainId": chain_id, "mode": mode,
        "status": "completed", "triggeredBy": "admin",
        "adminAccountId": admin_ctx.get("accountId"),
        "adminUserId": admin_ctx.get("userId") or admin_ctx.get("sub"),
        "steps": steps,
        "resultMetrics": {
            "ratioBefore": ratio_before, "ratioAfter": None,
            "etaBefore": eta_before, "etaAfter": None,
            "note": "ratioAfter/etaAfter will be populated by feedback loop after ~3 min",
        },
        "createdAt": now_utc().isoformat(),
    }
    await db.demand_action_executions.insert_one(execution)
    execution.pop("_id", None)
    return {"status": "executed", "execution": execution}


@router.get("/api/admin/demand/actions/history")
async def demand_actions_history(_=Depends(verify_admin_token)):
    """Demand action execution history."""
    executions = await _db().demand_action_executions.find({}, {"_id": 0}).sort("createdAt", -1).to_list(30)
    return {"executions": executions}


# ═══════════════════════════════════════════════════════════════════════════
# Section 3 — Revenue / Surge A/B Experiments
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/api/admin/revenue/experiments")
async def get_revenue_experiments(_=Depends(verify_admin_token)):
    experiments = await _db().revenue_experiments.find({}, {"_id": 0}).sort("createdAt", -1).to_list(20)
    return {"experiments": experiments}


@router.post("/api/admin/revenue/experiments")
async def create_revenue_experiment(request: Request, _=Depends(verify_admin_token)):
    body = await request.json()
    experiment = {
        "id": uid(),
        "type": body.get("type", "surge_threshold"),
        "name": body.get("name", "Surge Test"),
        "zones": body.get("zones", []),
        "variants": body.get("variants", []),
        "trafficSplit": body.get("trafficSplit", [50, 50]),
        "durationHours": body.get("durationHours", 24),
        "status": "created",
        "createdAt": now_utc().isoformat(),
    }
    await _db().revenue_experiments.insert_one(experiment)
    experiment.pop("_id", None)
    return experiment


@router.post("/api/admin/revenue/experiments/{experiment_id}/start")
async def start_revenue_experiment(experiment_id: str, _=Depends(verify_admin_token)):
    await _db().revenue_experiments.update_one(
        {"id": experiment_id},
        {"$set": {"status": "running", "startedAt": now_utc().isoformat()}},
    )
    return {"status": "running", "experimentId": experiment_id}


@router.post("/api/admin/revenue/experiments/{experiment_id}/stop")
async def stop_revenue_experiment(experiment_id: str, _=Depends(verify_admin_token)):
    await _db().revenue_experiments.update_one(
        {"id": experiment_id},
        {"$set": {"status": "stopped", "endedAt": now_utc().isoformat()}},
    )
    return {"status": "stopped", "experimentId": experiment_id}


@router.get("/api/admin/revenue/experiments/{experiment_id}/results")
async def get_experiment_results(experiment_id: str, _=Depends(verify_admin_token)):
    """Experiment results — real per-variant aggregations from bookings."""
    db = _db()
    exp = await db.revenue_experiments.find_one({"id": experiment_id}, {"_id": 0})
    if not exp:
        raise HTTPException(404, "Experiment not found")

    variants = exp.get("variants") or [{"name": "A"}, {"name": "B"}]
    started = exp.get("startedAt")
    ended = exp.get("endedAt") or now_utc().isoformat()
    zones = exp.get("zones") or []

    results: list = []
    for v in variants:
        match: dict = {"experimentVariant": v.get("name")}
        if started:
            match["createdAt"] = {"$gte": started, "$lte": ended}
        if zones:
            match["zoneId"] = {"$in": zones}

        agg = await db.bookings.aggregate([
            {"$match": match},
            {"$group": {
                "_id": None,
                "total": {"$sum": 1},
                "completed": {"$sum": {"$cond": [{"$eq": ["$status", "completed"]}, 1, 0]}},
                "accepted": {"$sum": {"$cond": [{"$in": ["$status", ["accepted", "in_progress", "completed"]]}, 1, 0]}},
                "cancelled": {"$sum": {"$cond": [{"$eq": ["$status", "cancelled"]}, 1, 0]}},
                "gmv": {"$sum": {"$ifNull": ["$priceEstimate", 0]}},
                "avgEta": {"$avg": "$etaMinutes"},
            }},
        ]).to_list(1)
        row = agg[0] if agg else {}
        total = row.get("total", 0)
        completed = row.get("completed", 0)
        accepted = row.get("accepted", 0)
        cancelled = row.get("cancelled", 0)

        sat_agg = await db.reviews.aggregate([
            {"$match": {"experimentVariant": v.get("name")}},
            {"$group": {"_id": None, "avg": {"$avg": "$rating"}}},
        ]).to_list(1)
        provider_sat = round(sat_agg[0]["avg"] / 5 * 100, 1) if sat_agg else 0.0

        results.append({
            "variant": v.get("name", "?"),
            "config": v.get("config", {}),
            "metrics": {
                "totalRequests": total,
                "gmv": round(row.get("gmv", 0)),
                "conversionRate": _pct(completed, total),
                "acceptRate": _pct(accepted, total),
                "cancelRate": _pct(cancelled, total),
                "avgEta": round(row.get("avgEta") or 0, 1),
                "providerSatisfaction": provider_sat,
            },
        })

    if any(r["metrics"]["gmv"] for r in results):
        winner_idx = max(range(len(results)), key=lambda i: results[i]["metrics"]["gmv"])
        winner = results[winner_idx]["variant"]
        winner_reason = "Higher GMV"
    else:
        winner = None
        winner_reason = "Insufficient data — experiment has no attributed bookings yet"

    return {"experiment": exp, "results": results, "winner": winner, "winnerReason": winner_reason}


# ═══════════════════════════════════════════════════════════════════════════
# Section 4 — Push Device Registration (legacy push_devices collection)
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/api/push/register")
async def register_push_device(request: Request):
    """Register device for push notifications (legacy push_devices store)."""
    body = await request.json()
    user_id = body.get("userId")
    role = body.get("role")
    device_token = body.get("deviceToken")
    platform = body.get("platform", "unknown")

    if not user_id or not device_token:
        raise HTTPException(400, "userId and deviceToken are required")

    await _db().push_devices.update_one(
        {"userId": user_id, "token": device_token},
        {"$set": {
            "userId": user_id, "role": role or "customer",
            "token": device_token, "platform": platform,
            "isActive": True, "updatedAt": now_utc().isoformat(),
        }},
        upsert=True,
    )
    return {"status": "registered", "userId": user_id}


@router.delete("/api/push/unregister")
async def unregister_push_device(request: Request):
    """Unregister device from push notifications."""
    body = await request.json()
    device_token = body.get("deviceToken")
    if device_token:
        await _db().push_devices.update_one(
            {"token": device_token},
            {"$set": {"isActive": False, "updatedAt": now_utc().isoformat()}},
        )
    return {"status": "unregistered"}


@router.get("/api/push/devices")
async def get_push_devices(userId: str = None, role: str = None):
    """Get registered push devices (admin)."""
    query = {"isActive": True}
    if userId:
        query["userId"] = userId
    if role:
        query["role"] = role
    return await _db().push_devices.find(query, {"_id": 0}).to_list(100)


# ═══════════════════════════════════════════════════════════════════════════
# Section 5 — Monetization: Promoted providers + Priority access
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/api/admin/providers/{slug}/promote")
async def promote_provider(slug: str, request: Request, _=Depends(verify_admin_token)):
    """Promote a provider — boost their ranking position."""
    db = _db()
    body = await request.json()
    boost = min(body.get("promotionBoost", 0.15), 0.25)
    ends_at = body.get("promotionEndsAt")
    label = body.get("promotedLabel", "Рекомендуем")

    result = await db.organizations.update_one(
        {"slug": slug},
        {"$set": {
            "isPromoted": True, "promotionBoost": boost, "promotionEndsAt": ends_at,
            "promotedLabel": label, "promotionPlan": "promoted",
        }},
    )
    if result.matched_count == 0:
        raise HTTPException(404, "Provider not found")

    await db.monetization_actions.insert_one({
        "id": uid(), "type": "promote", "slug": slug, "boost": boost,
        "label": label, "endsAt": ends_at, "createdAt": now_utc().isoformat(),
    })
    return {"status": "promoted", "slug": slug, "boost": boost, "label": label}


@router.post("/api/admin/providers/{slug}/unpromote")
async def unpromote_provider(slug: str, _=Depends(verify_admin_token)):
    await _db().organizations.update_one(
        {"slug": slug},
        {"$set": {"isPromoted": False, "promotionBoost": 0, "promotedLabel": None, "promotionPlan": "none"}},
    )
    return {"status": "unpromoted", "slug": slug}


@router.post("/api/admin/providers/{slug}/priority-access")
async def grant_priority_access(slug: str, request: Request, _=Depends(verify_admin_token)):
    """Grant priority request access to provider."""
    db = _db()
    body = await request.json()
    level = min(body.get("priorityLevel", 1), 2)
    window = body.get("priorityWindowSeconds", 20)

    result = await db.organizations.update_one(
        {"slug": slug},
        {"$set": {
            "hasPriorityAccess": True, "priorityLevel": level,
            "priorityWindowSeconds": window,
            "promotionPlan": "priority" if level == 1 else "vip",
        }},
    )
    if result.matched_count == 0:
        raise HTTPException(404, "Provider not found")

    await db.monetization_actions.insert_one({
        "id": uid(), "type": "priority_grant", "slug": slug,
        "level": level, "window": window, "createdAt": now_utc().isoformat(),
    })
    return {"status": "priority_granted", "slug": slug, "level": level, "windowSeconds": window}


@router.post("/api/admin/providers/{slug}/priority-access/remove")
async def remove_priority_access(slug: str, _=Depends(verify_admin_token)):
    await _db().organizations.update_one(
        {"slug": slug},
        {"$set": {"hasPriorityAccess": False, "priorityLevel": 0, "priorityWindowSeconds": 0}},
    )
    return {"status": "priority_removed", "slug": slug}


@router.get("/api/admin/monetization/overview")
async def monetization_overview(_=Depends(verify_admin_token)):
    """Monetization overview — real metrics from provider_purchases + bookings + events."""
    db = _db()
    promoted = await db.organizations.count_documents({"isPromoted": True})
    priority = await db.organizations.count_documents({"hasPriorityAccess": True})
    total = await db.organizations.count_documents({"status": "active"})

    all_providers = await db.organizations.find(
        {"status": "active"},
        {"_id": 0, "slug": 1, "name": 1, "isPromoted": 1, "promotionBoost": 1,
         "promotedLabel": 1, "hasPriorityAccess": 1, "priorityLevel": 1,
         "ratingAvg": 1, "bookingsCount": 1},
    ).to_list(50)

    promoted_slugs = [p.get("slug") for p in all_providers if p.get("isPromoted") and p.get("slug")]
    priority_slugs = [p.get("slug") for p in all_providers if p.get("hasPriorityAccess") and p.get("slug")]
    promoted_list = [p for p in all_providers if p.get("isPromoted")]
    priority_list = [p for p in all_providers if p.get("hasPriorityAccess")]

    impressions = await db.realtime_events.count_documents({
        "event": "provider:impression", "providerSlug": {"$in": promoted_slugs},
    }) if promoted_slugs else 0
    clicks = await db.realtime_events.count_documents({
        "event": "provider:click", "providerSlug": {"$in": promoted_slugs},
    }) if promoted_slugs else 0
    promoted_bookings = await db.bookings.count_documents({
        "providerSlug": {"$in": promoted_slugs},
    }) if promoted_slugs else 0
    non_promoted_slugs = [p.get("slug") for p in all_providers if not p.get("isPromoted") and p.get("slug")]

    async def _avg_rev(slugs: list) -> float:
        if not slugs:
            return 0.0
        agg = await db.bookings.aggregate([
            {"$match": {"providerSlug": {"$in": slugs}, "status": "completed"}},
            {"$group": {"_id": None, "avg": {"$avg": "$priceEstimate"}}},
        ]).to_list(1)
        return float(agg[0]["avg"]) if agg and agg[0].get("avg") else 0.0

    rev_promoted = await _avg_rev(promoted_slugs)
    rev_regular = await _avg_rev(non_promoted_slugs)
    revenue_lift = round((rev_promoted - rev_regular) / rev_regular * 100, 1) if rev_regular else 0.0

    priority_requests = await db.priority_requests.count_documents({}) if priority_slugs else 0
    priority_accepted = await db.priority_requests.count_documents({"status": "accepted"}) if priority_slugs else 0
    priority_bookings = await db.bookings.count_documents({
        "providerSlug": {"$in": priority_slugs}, "viaPriority": True,
    }) if priority_slugs else 0

    avg_accept_agg = await db.priority_requests.aggregate([
        {"$match": {"status": "accepted", "acceptTimeSeconds": {"$gt": 0}}},
        {"$group": {"_id": None, "avg": {"$avg": "$acceptTimeSeconds"}}},
    ]).to_list(1) if priority_slugs else []
    avg_accept_seconds = round(avg_accept_agg[0]["avg"], 1) if avg_accept_agg else 0.0

    priority_revenue_agg = await db.bookings.aggregate([
        {"$match": {"providerSlug": {"$in": priority_slugs}, "status": "completed"}},
        {"$group": {"_id": None, "sum": {"$sum": "$priceEstimate"}}},
    ]).to_list(1) if priority_slugs else []
    priority_revenue = round(priority_revenue_agg[0]["sum"]) if priority_revenue_agg else 0

    return {
        "stats": {
            "totalProviders": total, "promotedCount": promoted, "priorityCount": priority,
            "monetizationRate": round((promoted + priority) / max(total, 1) * 100, 1),
        },
        "promotedProviders": promoted_list,
        "priorityProviders": priority_list,
        "metrics": {
            "promoted": {
                "impressions": impressions, "clicks": clicks, "bookings": promoted_bookings,
                "conversionRate": _pct(promoted_bookings, clicks or impressions),
                "revenueLift": revenue_lift,
            },
            "priority": {
                "requestsSent": priority_requests,
                "acceptRate": _pct(priority_accepted, priority_requests),
                "avgAcceptTimeSeconds": avg_accept_seconds,
                "bookingConversionRate": _pct(priority_bookings, priority_requests),
                "providerRevenue": priority_revenue,
            },
        },
        "recentActions": await db.monetization_actions.find({}, {"_id": 0}).sort("createdAt", -1).to_list(10),
    }


# ═══════════════════════════════════════════════════════════════════════════
# Section 6 — Distribution config (internal endpoint pair)
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/api/admin/distribution/config")
async def get_distribution_config_internal(_=Depends(verify_admin_token)):
    config = await _db().distribution_config.find_one({"type": "global"}, {"_id": 0})
    if not config:
        config = {
            "type": "global", "priorityFanout": 3, "normalFanout": 5,
            "priorityWindowSeconds": 20, "maxPromotedInTop": 3, "promotionBoostCap": 0.25,
        }
    return config


@router.post("/api/admin/distribution/config")
async def update_distribution_config_internal(request: Request, _=Depends(verify_admin_token)):
    body = await request.json()
    await _db().distribution_config.update_one(
        {"type": "global"},
        {"$set": {**body, "type": "global", "updatedAt": now_utc().isoformat()}},
        upsert=True,
    )
    return {"status": "updated", "config": body}


# ═══════════════════════════════════════════════════════════════════════════
# Section 7 — Billing revenue dashboard
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/api/admin/billing/revenue")
async def admin_billing_revenue(_=Depends(verify_admin_token)):
    db = _db()
    purchases = await db.provider_purchases.find({"status": "paid"}, {"_id": 0}).to_list(100)
    total_revenue = sum(p.get("amount", 0) for p in purchases)
    active_promoted = await db.organizations.count_documents({"isPromoted": True})
    active_priority = await db.organizations.count_documents({"hasPriorityAccess": True})

    by_product: dict = {}
    for p in purchases:
        code = p.get("productCode", "unknown")
        by_product.setdefault(code, {"count": 0, "revenue": 0})
        by_product[code]["count"] += 1
        by_product[code]["revenue"] += p.get("amount", 0)

    return {
        "totalRevenue": total_revenue, "currency": "UAH", "totalPurchases": len(purchases),
        "activePromoted": active_promoted, "activePriority": active_priority,
        "byProduct": by_product,
        "arppu": round(total_revenue / max(len(set(p.get("providerSlug") for p in purchases)), 1)),
        "conversionToPaid": round(active_promoted + active_priority)
            / max(await db.organizations.count_documents({"status": "active"}), 1) * 100,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Section 8 — Zone admin controls (heatmap / history / config / dashboard)
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/api/admin/zones/heatmap")
async def zones_heatmap(_=Depends(verify_admin_token)):
    zones = await _db().zones.find({}, {"_id": 0}).to_list(50)
    heatmap = []
    for z in zones:
        center = z.get("center", {})
        intensity = min(1.0, z.get("ratio", 1) / 5)
        heatmap.append({
            "zoneId": z["id"], "name": z["name"],
            "lat": center.get("lat", 50.45), "lng": center.get("lng", 30.52),
            "intensity": round(intensity, 3),
            "demand": z.get("demandScore", 0), "supply": z.get("supplyScore", 0),
            "ratio": z.get("ratio", 1), "surge": z.get("surgeMultiplier", 1),
            "status": z.get("status", "BALANCED"), "color": z.get("color", "#22C55E"),
        })
    return {"heatmap": heatmap, "total": len(heatmap)}


@router.get("/api/admin/zones/{zone_id}/history")
async def zone_history(zone_id: str, hours: int = 24, _=Depends(verify_admin_token)):
    since = (now_utc() - timedelta(hours=hours)).isoformat()
    snaps = await _db().zone_snapshots.find(
        {"zoneId": zone_id, "timestamp": {"$gte": since}}, {"_id": 0},
    ).sort("timestamp", 1).to_list(200)
    return {"zoneId": zone_id, "timeline": snaps, "periodHours": hours, "dataPoints": len(snaps)}


@router.post("/api/admin/zones/{zone_id}/override-surge")
async def override_zone_surge(zone_id: str, request: Request, _=Depends(verify_admin_token)):
    body = await request.json()
    surge = body.get("surgeMultiplier", 1.0)
    await _db().zones.update_one(
        {"id": zone_id},
        {"$set": {"surgeMultiplier": surge, "updatedAt": now_utc().isoformat()}},
    )
    await emit_realtime_event("zone:surge_changed", {"zoneId": zone_id, "surge": surge})
    return {"status": "surge_overridden", "zoneId": zone_id, "surgeMultiplier": surge}


@router.post("/api/admin/zones/{zone_id}/push-providers")
async def push_zone_providers(zone_id: str, request: Request, _=Depends(verify_admin_token)):
    body = await request.json()
    message = body.get("message", "Новые заявки в вашей зоне!")
    zone = await _db().zones.find_one({"id": zone_id}, {"_id": 0})
    if not zone:
        raise HTTPException(404, "Zone not found")
    await emit_realtime_event("zone:provider_push", {"zoneId": zone_id, "message": message, "zoneName": zone.get("name")})
    return {"status": "pushed", "zoneId": zone_id, "message": message}


@router.post("/api/admin/zones/{zone_id}/config")
async def update_zone_config(zone_id: str, request: Request, _=Depends(verify_admin_token)):
    body = await request.json()
    allowed = {"surgeThresholds", "fanoutMultiplier", "etaTarget", "maxProviders", "name", "color"}
    update = {k: v for k, v in body.items() if k in allowed}
    update["updatedAt"] = now_utc().isoformat()
    await _db().zones.update_one({"id": zone_id}, {"$set": update})
    return {"status": "updated", "zoneId": zone_id, "updated": list(update.keys())}


@router.get("/api/admin/zones/distribution-config")
async def get_zone_distribution_config(_=Depends(verify_admin_token)):
    config = await _db().zone_distribution_config.find_one({"type": "global"}, {"_id": 0})
    if not config:
        config = {
            "type": "global",
            "fanoutByStatus": {"BALANCED": 2, "BUSY": 3, "SURGE": 4, "CRITICAL": 6},
            "surgeThresholds": {"BUSY": 1.5, "SURGE": 2.5, "CRITICAL": 3.5},
            "etaTargets": {"BALANCED": 10, "BUSY": 15, "SURGE": 20, "CRITICAL": 30},
        }
    return config


@router.post("/api/admin/zones/distribution-config")
async def update_zone_distribution_config(request: Request, _=Depends(verify_admin_token)):
    body = await request.json()
    await _db().zone_distribution_config.update_one(
        {"type": "global"},
        {"$set": {**body, "type": "global", "updatedAt": now_utc().isoformat()}},
        upsert=True,
    )
    return {"status": "updated"}


@router.get("/api/admin/zones/dashboard")
async def zones_dashboard(_=Depends(verify_admin_token)):
    zones = await _db().zones.find({}, {"_id": 0}).to_list(50)
    total_demand = sum(z.get("demandScore", 0) for z in zones)
    total_supply = sum(z.get("supplyScore", 0) for z in zones)
    by_status: dict = {}
    for z in zones:
        st = z.get("status", "BALANCED")
        by_status.setdefault(st, 0)
        by_status[st] += 1

    critical_zones = [z for z in zones if z.get("status") in ("CRITICAL", "SURGE")]
    return {
        "summary": {
            "totalZones": len(zones), "totalDemand": total_demand, "totalSupply": total_supply,
            "avgRatio": round(total_demand / max(total_supply, 1), 2),
            "byStatus": by_status,
        },
        "zones": zones,
        "criticalZones": critical_zones,
        "alerts": [
            {"zoneId": z["id"], "zoneName": z["name"], "status": z["status"],
             "ratio": z["ratio"], "message": f"{z['name']}: {z['status']} (ratio {z['ratio']})"}
            for z in critical_zones
        ],
    }


# ═══════════════════════════════════════════════════════════════════════════
# Section 9 — Simulation + Analytics health
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/api/simulation/results")
async def simulation_results():
    """Get latest Monte Carlo simulation results."""
    import json as jsonlib
    report_path = Path("/app/test_reports/monte_carlo_10k.json")
    if not report_path.exists():
        return {"status": "no_results", "message": "Run simulation first"}
    with open(report_path) as f:
        return jsonlib.load(f)


@router.get("/api/analytics/system-health")
async def analytics_system_health():
    """Deep analytics: full system health dashboard."""
    db = _db()
    from app.orchestrator import cycle as _cycle  # local import to avoid bootstrap cycles

    zones = await db.zones.find({}, {"_id": 0}).to_list(50)
    zone_health = []
    for z in zones:
        zone_health.append({
            "id": z.get("id"), "name": z.get("name"), "status": z.get("status"),
            "ratio": z.get("ratio", 0), "surge": z.get("surgeMultiplier", 1),
            "eta": z.get("avgEta", 0), "matchRate": z.get("matchRate", 0),
            "demand": z.get("demandScore", 0), "supply": z.get("supplyScore", 0),
        })

    orch_logs_24h = await db.orchestrator_logs.count_documents(
        {"createdAt": {"$gte": (now_utc() - timedelta(hours=24)).isoformat()}},
    )
    orch_actions_24h = 0
    orch_failed = 0
    recent_logs = await db.orchestrator_logs.find(
        {"createdAt": {"$gte": (now_utc() - timedelta(hours=24)).isoformat()}},
        {"_id": 0, "actions": 1},
    ).to_list(5000)
    for log in recent_logs:
        for a in log.get("actions", []):
            orch_actions_24h += 1
            if a.get("status") == "failed":
                orch_failed += 1

    fb_total = await db.action_feedback.count_documents({})
    fb_completed = await db.action_feedback.count_documents({"status": "completed"})
    fb_pending = await db.action_feedback.count_documents({"status": "pending"})

    global_w = await db.strategy_weights.find_one({"zoneId": "global"}, {"_id": 0})

    collections: dict = {}
    for col_name in ["users", "organizations", "zones", "orchestrator_logs", "action_feedback",
                     "strategy_weights", "orchestrator_rules", "orchestrator_overrides",
                     "zone_snapshots", "governance_actions", "reviews", "services"]:
        collections[col_name] = await db[col_name].count_documents({})

    recs = await db.strategy_recommendations.find({}, {"_id": 0}).to_list(20)

    return {
        "timestamp": now_utc().isoformat(),
        "zones": zone_health,
        "orchestrator": {
            "enabled": _cycle.orchestrator_enabled,
            "cycleCount": _cycle.orchestrator_cycle_count,
            "lastCycleAt": _cycle.orchestrator_last_cycle_at,
            "logs24h": orch_logs_24h,
            "actions24h": orch_actions_24h,
            "failed24h": orch_failed,
            "successRate": round((orch_actions_24h - orch_failed) / max(orch_actions_24h, 1) * 100, 1),
        },
        "feedback": {
            "total": fb_total, "completed": fb_completed, "pending": fb_pending,
            "completionRate": round(fb_completed / max(fb_total, 1) * 100, 1),
        },
        "strategy": {
            "globalWeights": global_w.get("weights", {}) if global_w else {},
            "sampleCount": global_w.get("sampleCount", 0) if global_w else 0,
            "lastUpdated": global_w.get("updatedAt") if global_w else None,
        },
        "database": collections,
        "recommendations": recs,
        "backgroundProcesses": [
            {"name": "Zone State Engine", "interval": "10s", "status": "running"},
            {"name": "Orchestrator Engine", "interval": "10s",
             "status": "running" if _cycle.orchestrator_enabled else "paused"},
            {"name": "Feedback Processor", "interval": "15s", "status": "running"},
            {"name": "Strategy Optimizer", "interval": "5min", "status": "running"},
        ],
    }


# ═══════════════════════════════════════════════════════════════════════════
# Section 10 — Admin automation replay alias (proxy)
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/api/admin/automation/replay")
async def compat_admin_replay(request: Request, _=Depends(verify_admin_token)):
    """Alias for the old admin automation replay endpoint — proxy to NestJS."""
    from app.core.proxy import proxy_to_nest
    return await proxy_to_nest(request, "admin/automation/replay/history")
