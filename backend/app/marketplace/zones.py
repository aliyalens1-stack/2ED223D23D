"""Sprint 21 C10: extracted from server.py 1-to-1.

Endpoints live on `router` (APIRouter). Registered via
app.marketplace.router.include_router → include_router in server.py,
ДО catch-all NestJS proxy.
"""
from __future__ import annotations
import asyncio
import random
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from app.core.context import ctx
from app.core.db import db, get_db
from app.core.geo import haversine, resolve_zone
# Phase 1B Tier 4 — pure sync cluster enrichment for manual zone recalc snapshot.
from app.core.cluster_writer import enrich_with_cluster
from app.core.realtime import emit_realtime_event
from app.core.redis_state import rate_limit_public  # Sprint 24
from app.core.security import verify_admin_token
from app.core.utils import now_utc, uid


# `db` — lazy-proxy (см. providers.py комментарий).

router = APIRouter()


@router.post("/api/demand/event")
async def create_demand_event(request: Request):
    """Track a demand event (booking created/assigned/completed/cancelled)"""
    body = await request.json()
    lat = body.get("lat", 50.4501)
    lng = body.get("lng", 30.5234)
    event_type = body.get("type", "created")
    
    zone_id = resolve_zone(lat, lng)
    
    event = {
        "id": uid(),
        "zoneId": zone_id,
        "type": event_type,
        "bookingId": body.get("bookingId"),
        "serviceId": body.get("serviceId"),
        "lat": lat, "lng": lng,
        "timestamp": now_utc().isoformat(),
    }
    await db.booking_demand_events.insert_one(event)
    event.pop("_id", None)
    
    # Emit demand event
    await emit_realtime_event("demand:event", {"zoneId": zone_id, "type": event_type})
    
    return {"status": "tracked", "event": event}


@router.get("/api/demand/events")
async def get_demand_events(zoneId: str = None, minutes: int = 60, limit: int = 100):
    """Get recent demand events"""
    since = (now_utc() - timedelta(minutes=minutes)).isoformat()
    query = {"timestamp": {"$gte": since}}
    if zoneId:
        query["zoneId"] = zoneId
    events = await db.booking_demand_events.find(query, {"_id": 0}).sort("timestamp", -1).to_list(limit)
    
    # Aggregate by type
    by_type = {}
    for e in events:
        t = e.get("type", "unknown")
        by_type.setdefault(t, 0)
        by_type[t] += 1
    
    return {"events": events, "total": len(events), "byType": by_type, "periodMinutes": minutes}


@router.get("/api/demand/heatmap")
async def demand_heatmap(minutes: int = 60):
    """Get demand heatmap data from recent events"""
    since = (now_utc() - timedelta(minutes=minutes)).isoformat()
    events = await db.booking_demand_events.find(
        {"timestamp": {"$gte": since}, "type": "created"},
        {"_id": 0, "lat": 1, "lng": 1, "zoneId": 1}
    ).to_list(500)
    
    # Aggregate by zone
    zone_demand = {}
    for e in events:
        zid = e.get("zoneId", "unknown")
        zone_demand.setdefault(zid, {"count": 0, "points": []})
        zone_demand[zid]["count"] += 1
        zone_demand[zid]["points"].append({"lat": e.get("lat"), "lng": e.get("lng")})
    
    # Build heatmap with zone centers
    zones = await db.zones.find({}, {"_id": 0}).to_list(50)
    heatmap = []
    max_demand = max((d["count"] for d in zone_demand.values()), default=1)
    for z in zones:
        zid = z["id"]
        center = z.get("center", {})
        demand_count = zone_demand.get(zid, {}).get("count", 0) + z.get("demandScore", 0)
        intensity = min(1.0, demand_count / max(max_demand * 2, 1))
        heatmap.append({
            "zoneId": zid, "name": z.get("name"),
            "lat": center.get("lat", 50.45), "lng": center.get("lng", 30.52),
            "intensity": round(intensity, 3),
            "demand": z.get("demandScore", 0), "supply": z.get("supplyScore", 0),
            "ratio": z.get("ratio", 1), "surge": z.get("surgeMultiplier", 1),
            "status": z.get("status", "BALANCED"), "color": z.get("color", "#22C55E"),
        })
    
    return {"heatmap": heatmap, "total": len(heatmap), "periodMinutes": minutes}


@router.get("/api/zones/live-state")
async def get_zones_live_state(_=Depends(rate_limit_public)):
    """Get comprehensive live state of all zones (public)"""
    zones = await db.zones.find({}, {"_id": 0}).to_list(50)

    # Enrich with provider counts
    for z in zones:
        z["onlineProviders"] = await db.provider_locations.count_documents({"zoneId": z["id"], "isOnline": True})
        z["totalProviders"] = await db.provider_locations.count_documents({"zoneId": z["id"]})

    # Sprint 23: enrich with ML forecast (p10/p50/p90 + mae) when available.
    # Lazy import чтобы не ломать модуль если sklearn не загрузился.
    try:
        from app.ml.predictor import SKLEARN_OK, DemandPredictor
        if SKLEARN_OK:
            for z in zones:
                zid = z["id"]
                meta = DemandPredictor.metadata.get(zid, {})
                interval = None
                try:
                    interval = await DemandPredictor.predict_with_interval(zid)
                except Exception:
                    interval = None
                z["forecast"] = {
                    "p10": interval.get("p10") if interval else None,
                    "p50": interval.get("p50") if interval else None,
                    "p90": interval.get("p90") if interval else None,
                    "mae": meta.get("mae"),
                    "residualStd": interval.get("residualStd") if interval else None,
                    "source": "ml" if interval else "ewma",
                }
    except Exception:
        # Forecast — best-effort enrichment, never breaks the response
        for z in zones:
            z.setdefault("forecast", None)

    total_demand = sum(z.get("demandScore", 0) for z in zones)
    total_supply = sum(z.get("supplyScore", 0) for z in zones)

    by_status = {}
    for z in zones:
        st = z.get("status", "BALANCED")
        by_status.setdefault(st, 0)
        by_status[st] += 1

    critical = [z for z in zones if z.get("status") in ("CRITICAL", "SURGE")]

    return {
        "zones": zones,
        "summary": {
            "totalZones": len(zones),
            "totalDemand": total_demand,
            "totalSupply": total_supply,
            "avgRatio": round(total_demand / max(total_supply, 1), 2),
            "byStatus": by_status,
        },
        "alerts": [
            {"zoneId": z["id"], "name": z.get("name"), "status": z["status"],
             "ratio": z.get("ratio"), "surge": z.get("surgeMultiplier"),
             "message": f"{z.get('name')}: {z['status']} (ratio {z.get('ratio', '?')})"}
            for z in critical
        ],
        "updatedAt": now_utc().isoformat(),
    }


@router.get("/api/zones/{zone_id}/analytics")
async def get_zone_analytics(zone_id: str, hours: int = 24):
    """Get zone analytics with timeline + stats"""
    zone = await db.zones.find_one({"id": zone_id}, {"_id": 0})
    if not zone:
        raise HTTPException(404, "Zone not found")
    
    since = (now_utc() - timedelta(hours=hours)).isoformat()
    snapshots = await db.zone_snapshots.find(
        {"zoneId": zone_id, "timestamp": {"$gte": since}},
        {"_id": 0}
    ).sort("timestamp", 1).to_list(500)
    
    # Stats
    if snapshots:
        avg_demand = round(sum(s.get("demand", 0) for s in snapshots) / len(snapshots), 1)
        avg_supply = round(sum(s.get("supply", 0) for s in snapshots) / len(snapshots), 1)
        avg_ratio = round(sum(s.get("ratio", 0) for s in snapshots) / len(snapshots), 2)
        max_surge = max(s.get("surge", 1) for s in snapshots)
        min_eta = min(s.get("avgEta", 10) for s in snapshots)
        max_eta = max(s.get("avgEta", 10) for s in snapshots)
    else:
        avg_demand = avg_supply = avg_ratio = max_surge = min_eta = max_eta = 0
    
    # Demand events in this zone
    demand_events = await db.booking_demand_events.count_documents({"zoneId": zone_id, "timestamp": {"$gte": since}})
    
    # Online providers
    online_providers = await db.provider_locations.count_documents({"zoneId": zone_id, "isOnline": True})
    
    return {
        "zone": zone,
        "timeline": snapshots,
        "stats": {
            "avgDemand": avg_demand, "avgSupply": avg_supply, "avgRatio": avg_ratio,
            "maxSurge": max_surge, "minEta": min_eta, "maxEta": max_eta,
            "totalDemandEvents": demand_events, "onlineProviders": online_providers,
            "dataPoints": len(snapshots),
        },
        "periodHours": hours,
    }


@router.get("/api/zones/resolve")
async def zone_resolve(lat: float = 50.4501, lng: float = 30.5234):
    """Resolve which zone a point belongs to"""
    zone_id = resolve_zone(lat, lng)
    zone = await db.zones.find_one({"id": zone_id}, {"_id": 0})
    return {"zoneId": zone_id, "zone": zone, "point": {"lat": lat, "lng": lng}}

# ── ZONES CRUD ──


@router.get("/api/zones")
async def get_all_zones():
    """Get all zones with live state"""
    zones = await db.zones.find({}, {"_id": 0}).to_list(50)
    return {"zones": zones, "total": len(zones)}


@router.get("/api/zones/{zone_id}")
async def get_zone(zone_id: str):
    """Get single zone"""
    zone = await db.zones.find_one({"id": zone_id}, {"_id": 0})
    if not zone:
        raise HTTPException(404, "Zone not found")
    return zone


@router.post("/api/zones/{zone_id}/recalculate")
async def recalculate_zone(zone_id: str):
    """Recalculate zone state from live data"""
    zone = await db.zones.find_one({"id": zone_id}, {"_id": 0})
    if not zone:
        raise HTTPException(404, "Zone not found")
    
    # Count active bookings (demand) and online providers (supply)
    demand = await db.web_bookings.count_documents({"status": {"$in": ["pending", "confirmed", "on_route"]}})
    supply = await db.organizations.count_documents({"status": "active", "isOnline": True})
    demand_zone = max(1, demand + random.randint(-2, 5))
    supply_zone = max(1, supply + random.randint(-1, 2))
    ratio = round(demand_zone / supply_zone, 2)
    
    if ratio < 1: status, surge = "BALANCED", 1.0
    elif ratio < 2: status, surge = "BUSY", round(1 + (ratio - 1) * 0.3, 2)
    elif ratio < 3: status, surge = "SURGE", round(1.3 + (ratio - 2) * 0.4, 2)
    else: status, surge = "CRITICAL", min(2.5, round(1.7 + (ratio - 3) * 0.3, 2))
    
    avg_eta = max(3, int(8 + ratio * 3 + random.uniform(-2, 2)))
    match_rate = max(30, int(90 - ratio * 12 + random.uniform(-5, 5)))
    
    update = {"demandScore": demand_zone, "supplyScore": supply_zone, "ratio": ratio, "surgeMultiplier": surge, "avgEta": avg_eta, "matchRate": match_rate, "status": status, "updatedAt": now_utc().isoformat()}
    await db.zones.update_one({"id": zone_id}, {"$set": update})
    
    # Save snapshot
    snap_doc = {"zoneId": zone_id, "timestamp": now_utc().isoformat(), "demand": demand_zone, "supply": supply_zone, "ratio": ratio, "surge": surge, "avgEta": avg_eta}
    # Phase 1B Tier 4 — zone dict already in scope (line above); pure helper.
    enrich_with_cluster(
        snap_doc,
        cluster=zone.get("cluster"),
        strategy="zone_lookup" if zone.get("cluster") else "manual_review",
        source_field="zoneId",
    )
    await db.zone_snapshots.insert_one(snap_doc)
    
    # Emit realtime event
    await emit_realtime_event("zone:updated", {"zoneId": zone_id, "status": status, "surge": surge, "demand": demand_zone, "supply": supply_zone})
    
    return {**zone, **update}


@router.post("/api/zones/recalculate-all")
async def recalculate_all_zones():
    """Recalculate all zones"""
    zones = await db.zones.find({}, {"_id": 0, "id": 1}).to_list(50)
    results = []
    for z in zones:
        try:
            result = await recalculate_zone(z["id"])
            results.append({"zoneId": z["id"], "status": result.get("status"), "surge": result.get("surgeMultiplier")})
        except Exception:
            pass
    return {"recalculated": len(results), "zones": results}

# ── HEATMAP ──
