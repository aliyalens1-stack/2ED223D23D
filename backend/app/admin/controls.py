"""app.admin.controls — Sprint 21 C12B zone/strategy controls.

9 endpoints (логика 1-в-1 из server.py, никаких изменений):
  GET/POST/DELETE /api/admin/zones/{id}/override
  GET            /api/admin/zones/overrides
  GET            /api/admin/zones/{id}/timeline
  GET/POST       /api/admin/strategy/{zoneId}
  GET            /api/admin/strategies
  GET/POST       /api/admin/matching/weights
  GET            /api/admin/config/features
  GET/POST       /api/admin/config/commission-tiers

Зависимости (`OVERRIDE_MODE_MAP`, `get_active_override`, `_proxy_to`,
`emit_realtime_event`, `write_audit`) всё ещё физически в server.py —
подтягиваются локальным import в теле endpoint-а (runtime-safe). В C13
переедут в `app/core/overrides.py` и локальные импорты уйдут.
"""
from __future__ import annotations
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request

from app.core.db import db
from app.core.overrides import OVERRIDE_MODE_MAP, get_active_override
from app.core.proxy import proxy_to_nest
# Phase 1B Tier 4 — pure sync cluster enrichment for admin override orchestrator_logs.
from app.core.cluster_writer import enrich_with_cluster
from app.core.realtime import emit_realtime_event
from app.core.security import verify_admin_token
from app.core.attribution import (
    AttributionContext,
    get_attribution_context,
    record_admin_mutation,
)
from app.core.utils import now_utc
from prod_readiness import write_audit


router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════════
# Matching weights (Sprint 15/16)
# ══════════════════════════════════════════════════════════════════════════════
@router.get("/api/admin/matching/weights")
async def get_matching_weights(_=Depends(verify_admin_token)):
    config = await db.matching_config.find_one({"type": "weights"}, {"_id": 0})
    if not config:
        config = {"type": "weights", "distance": 0.25, "rating": 0.20, "response": 0.15, "availability": 0.10, "skillMatch": 0.15, "performance": 0.10, "trust": 0.05}
    return config


@router.post("/api/admin/matching/weights")
async def update_matching_weights(
    request: Request,
    _=Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
):
    body = await request.json()
    await db.matching_config.update_one({"type": "weights"}, {"$set": {**body, "type": "weights", "updatedAt": now_utc().isoformat()}}, upsert=True)
    # P6.B — Attribution saturation: governance trail for marketplace matching weights.
    try:
        await record_admin_mutation(
            db, ctx,
            action="matching.weights.update",
            domain="config",
            entity_id="matching_weights",
            after={k: v for k, v in body.items() if k not in ("_id",)},
        )
    except Exception:
        pass
    return {"status": "updated", "weights": body}


# ══════════════════════════════════════════════════════════════════════════════
# Admin config — feature-flags (proxy) + commission tiers (native)
# ══════════════════════════════════════════════════════════════════════════════
@router.get("/api/admin/config/features")
async def compat_admin_config_features(request: Request, _=Depends(verify_admin_token)):
    return await proxy_to_nest(request, "admin/feature-flags")


@router.get("/api/admin/config/commission-tiers")
async def compat_admin_commission_tiers(request: Request, _=Depends(verify_admin_token)):
    existing = await db.platformconfigs.find_one({"type": "commission_tiers"}, {"_id": 0})
    if existing:
        return existing
    return {
        "type": "commission_tiers",
        "tiers": [
            {"name": "Bronze",   "minScore": 0,  "maxScore": 49,  "commissionPct": 25.0},
            {"name": "Silver",   "minScore": 50, "maxScore": 74,  "commissionPct": 20.0},
            {"name": "Gold",     "minScore": 75, "maxScore": 89,  "commissionPct": 15.0},
            {"name": "Platinum", "minScore": 90, "maxScore": 100, "commissionPct": 10.0},
        ],
        "updatedAt": now_utc().isoformat(),
    }


@router.post("/api/admin/config/commission-tiers")
async def compat_admin_commission_tiers_save(
    request: Request,
    _=Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
):
    body = await request.json()
    body["type"] = "commission_tiers"
    body["updatedAt"] = now_utc().isoformat()
    await db.platformconfigs.update_one({"type": "commission_tiers"},
                                         {"$set": body}, upsert=True)
    # P6.B — Attribution saturation: governance trail for commission edit.
    try:
        await record_admin_mutation(
            db, ctx,
            action="config.commission_tiers.save",
            domain="config",
            entity_id="commission_tiers",
            after={k: v for k, v in body.items() if k not in ("_id",)},
        )
    except Exception:
        pass
    return {"status": "saved", "config": body}


# ══════════════════════════════════════════════════════════════════════════════
# Sprint 9 BLOCK 1 — Zone Override API (manual market control)
# ══════════════════════════════════════════════════════════════════════════════
@router.post("/api/admin/zones/{zone_id}/override")
async def create_zone_override(
    zone_id: str,
    request: Request,
    _=Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
):
    body = await request.json()
    mode = body.get("mode", "FORCE_BALANCED")
    if mode not in OVERRIDE_MODE_MAP:
        raise HTTPException(400, f"Invalid mode. Allowed: {list(OVERRIDE_MODE_MAP.keys())}")
    fanout = int(body.get("fanout", 4))
    priority_only = bool(body.get("priorityOnly", False))
    ttl_seconds = int(body.get("ttlSeconds", 600))

    zone = await db.zones.find_one({"id": zone_id}, {"_id": 0, "id": 1, "name": 1})
    if not zone:
        raise HTTPException(404, "Zone not found")

    actor = _.get("email", "admin") if isinstance(_, dict) else "admin"
    expires_at = (now_utc() + timedelta(seconds=ttl_seconds)).isoformat()
    override = {
        "zoneId": zone_id,
        "mode": mode,
        "fanout": fanout,
        "priorityOnly": priority_only,
        "expiresAt": expires_at,
        "createdAt": now_utc().isoformat(),
        "createdBy": actor,
    }
    await db.zone_overrides.update_one({"zoneId": zone_id}, {"$set": override}, upsert=True)

    # Immediately apply to zone state
    status, color, surge = OVERRIDE_MODE_MAP[mode]
    await db.zones.update_one({"id": zone_id}, {"$set": {
        "status": status, "color": color, "surgeMultiplier": surge,
        "overriddenUntil": expires_at, "overrideMode": mode,
        "updatedAt": now_utc().isoformat(),
    }})
    await emit_realtime_event("zone:overridden", {
        "zoneId": zone_id, "mode": mode, "fanout": fanout,
        "priorityOnly": priority_only, "expiresAt": expires_at,
    })
    # Phase 1B Tier 4 — caller-side zone lookup (helper stays pure).
    zone_doc = await db.zones.find_one({"id": zone_id}, {"_id": 0, "cluster": 1})
    zone_cluster = (zone_doc or {}).get("cluster")
    log_apply = {
        "timestamp": now_utc().isoformat(),
        "zoneId": zone_id,
        "actionType": "ADMIN_OVERRIDE",
        "reason": f"Manual override: {mode}",
        "params": {"mode": mode, "fanout": fanout, "priorityOnly": priority_only, "ttlSeconds": ttl_seconds},
        "source": "admin",
        "actor": actor,
    }
    enrich_with_cluster(
        log_apply,
        cluster=zone_cluster,
        strategy="zone_lookup" if zone_cluster else "manual_review",
        source_field="zoneId",
    )
    await db.orchestrator_logs.insert_one(log_apply)
    await write_audit(db, actor=actor, action="zone.override.apply", target=zone_id,
                      details={"mode": mode, "fanout": fanout, "priorityOnly": priority_only,
                               "ttlSeconds": ttl_seconds})
    # P6.B — Attribution saturation: governance trail row alongside legacy write_audit.
    try:
        await record_admin_mutation(
            db, ctx,
            action="zone.override.apply",
            domain="config",
            entity_id=zone_id,
            extra={"mode": mode, "fanout": fanout, "priorityOnly": priority_only,
                   "ttlSeconds": ttl_seconds, "expiresAt": expires_at},
        )
    except Exception:
        pass
    return {"status": "overridden", "zoneId": zone_id, **override}


@router.get("/api/admin/zones/{zone_id}/override")
async def get_zone_override(zone_id: str, _=Depends(verify_admin_token)):
    o = await get_active_override(zone_id)
    return o or {"zoneId": zone_id, "active": False}


@router.delete("/api/admin/zones/{zone_id}/override")
async def clear_zone_override(
    zone_id: str,
    _=Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
):
    actor = _.get("email", "admin") if isinstance(_, dict) else "admin"
    res = await db.zone_overrides.delete_one({"zoneId": zone_id})
    await db.zones.update_one({"id": zone_id}, {"$unset": {"overriddenUntil": "", "overrideMode": ""}})
    await emit_realtime_event("zone:override_cleared", {"zoneId": zone_id})
    # Phase 1B Tier 4 — caller-side zone lookup (helper stays pure).
    zone_doc_clear = await db.zones.find_one({"id": zone_id}, {"_id": 0, "cluster": 1})
    zone_cluster_clear = (zone_doc_clear or {}).get("cluster")
    log_clear = {
        "timestamp": now_utc().isoformat(), "zoneId": zone_id,
        "actionType": "ADMIN_OVERRIDE_CLEARED", "reason": "Override cleared",
        "source": "admin", "actor": actor,
    }
    enrich_with_cluster(
        log_clear,
        cluster=zone_cluster_clear,
        strategy="zone_lookup" if zone_cluster_clear else "manual_review",
        source_field="zoneId",
    )
    await db.orchestrator_logs.insert_one(log_clear)
    await write_audit(db, actor=actor, action="zone.override.clear", target=zone_id,
                      details={"deleted": res.deleted_count})
    # P6.B — Attribution saturation: canonical governance trail alongside legacy write_audit.
    try:
        await record_admin_mutation(
            db, ctx,
            action="zone.override.clear",
            domain="config",
            entity_id=zone_id,
            extra={"deleted": res.deleted_count},
        )
    except Exception:
        pass
    return {"status": "cleared", "zoneId": zone_id, "deleted": res.deleted_count}


@router.get("/api/admin/zones/overrides")
async def list_zone_overrides(_=Depends(verify_admin_token)):
    docs = await db.zone_overrides.find({}, {"_id": 0}).to_list(50)
    out = []
    for d in docs:
        if d.get("expiresAt") and d["expiresAt"] >= now_utc().isoformat():
            out.append(d)
    return {"overrides": out, "total": len(out)}


# ══════════════════════════════════════════════════════════════════════════════
# Sprint 9 BLOCK 2 — Zone Timeline (visibility w/ before/after)
# ══════════════════════════════════════════════════════════════════════════════
@router.get("/api/admin/zones/{zone_id}/timeline")
async def get_zone_timeline(zone_id: str, hours: int = 6, _=Depends(verify_admin_token)):
    """Timeline of actions on the zone with before/after impact."""
    cutoff = (now_utc() - timedelta(hours=hours)).isoformat()

    # 1. orchestrator actions
    orch = await db.orchestrator_logs.find(
        {"zoneId": zone_id, "timestamp": {"$gte": cutoff}},
        {"_id": 0}
    ).sort("timestamp", -1).to_list(200)

    # 2. snapshots to reconstruct before/after
    snaps = await db.zone_snapshots.find(
        {"zoneId": zone_id, "timestamp": {"$gte": cutoff}},
        {"_id": 0}
    ).sort("timestamp", 1).to_list(2000)

    def snap_at(t: str):
        best = None
        for s in snaps:
            if s["timestamp"] <= t:
                best = s
            else:
                break
        return best

    def snap_after(t: str, delta_min: int = 5):
        target = (datetime.fromisoformat(t.replace("Z","+00:00") if t.endswith("Z") else t) + timedelta(minutes=delta_min)).isoformat()
        for s in snaps:
            if s["timestamp"] >= target:
                return s
        return snaps[-1] if snaps else None

    # 3. feedback effectiveness joined by time+zone+action
    fb = await db.action_feedback.find(
        {"zoneId": zone_id, "createdAt": {"$gte": cutoff}},
        {"_id": 0, "actionType": 1, "effectivenessScore": 1, "status": 1, "createdAt": 1}
    ).to_list(1000)
    fb_by_action = {}
    for f in fb:
        fb_by_action.setdefault(f.get("actionType"), []).append(f)

    timeline = []
    for ev in orch:
        ts = ev.get("timestamp")
        before = snap_at(ts) or {}
        after = snap_after(ts, 5) or {}
        matching_fb = None
        for f in fb_by_action.get(ev.get("actionType"), []):
            if f.get("createdAt", "") >= ts:
                matching_fb = f
                break
        impact = {}
        if before and after:
            def pct(a, b):
                if not a: return None
                return round(((b - a) / a) * 100, 1)
            impact = {
                "ratioDelta": round((after.get("ratio") or 0) - (before.get("ratio") or 0), 2),
                "etaDelta":   round((after.get("avgEta") or 0) - (before.get("avgEta") or 0), 1),
                "demandPct":  pct(before.get("demand"), after.get("demand")),
                "supplyPct":  pct(before.get("supply"), after.get("supply")),
            }
        if matching_fb:
            impact["effectiveness"] = matching_fb.get("effectivenessScore")
            impact["feedbackStatus"] = matching_fb.get("status")
        timeline.append({
            "time": ts,
            "action": ev.get("actionType"),
            "source": ev.get("source", "orchestrator"),
            "reason": ev.get("reason"),
            "params": ev.get("params"),
            "before": {
                "ratio":  before.get("ratio"),
                "avgEta": before.get("avgEta"),
                "status": before.get("status"),
            } if before else None,
            "after": {
                "ratio":  after.get("ratio"),
                "avgEta": after.get("avgEta"),
                "status": after.get("status"),
            } if after else None,
            "impact": impact,
        })

    return {"zoneId": zone_id, "hours": hours, "timeline": timeline, "total": len(timeline)}


# ══════════════════════════════════════════════════════════════════════════════
# Sprint 9 BLOCK 3 — Strategy Control (AI on/off + weight bounds)
# ══════════════════════════════════════════════════════════════════════════════
@router.get("/api/admin/strategy/{zone_id}")
async def get_strategy(zone_id: str, _=Depends(verify_admin_token)):
    doc = await db.strategy_weights.find_one({"zoneId": zone_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Strategy not found for zone")
    doc.setdefault("auto", doc.get("auto", True))
    doc.setdefault("minWeight", 0.3)
    doc.setdefault("maxWeight", 2.0)
    doc.setdefault("locked", False)
    return doc


@router.post("/api/admin/strategy/{zone_id}")
async def update_strategy(
    zone_id: str,
    request: Request,
    _=Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
):
    body = await request.json()
    allowed = {"auto", "weights", "minWeight", "maxWeight", "locked"}
    upd = {k: v for k, v in body.items() if k in allowed}
    if "weights" in upd and isinstance(upd["weights"], dict):
        mn = float(upd.get("minWeight", body.get("minWeight", 0.3)))
        mx = float(upd.get("maxWeight", body.get("maxWeight", 2.0)))
        upd["weights"] = {k: max(mn, min(mx, float(v))) for k, v in upd["weights"].items()}
    upd["updatedAt"] = now_utc().isoformat()
    upd["updatedBy"] = "admin"
    await db.strategy_weights.update_one({"zoneId": zone_id}, {"$set": upd}, upsert=True)
    doc = await db.strategy_weights.find_one({"zoneId": zone_id}, {"_id": 0})
    # P6.B — Attribution saturation: governance trail for per-zone strategy edit.
    try:
        await record_admin_mutation(
            db, ctx,
            action="strategy.update",
            domain="config",
            entity_id=zone_id,
            after=upd,
        )
    except Exception:
        pass
    return {"status": "updated", "zoneId": zone_id, "strategy": doc}


@router.get("/api/admin/strategies")
async def list_strategies(_=Depends(verify_admin_token)):
    docs = await db.strategy_weights.find({}, {"_id": 0}).to_list(100)
    return {"strategies": docs, "total": len(docs)}
