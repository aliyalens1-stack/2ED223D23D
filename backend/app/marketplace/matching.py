"""Sprint 21 C10: extracted from server.py 1-to-1.

Endpoints live on `router` (APIRouter). Registered via
app.marketplace.router.include_router → include_router in server.py,
ДО catch-all NestJS proxy.
"""
from __future__ import annotations
import asyncio
import random
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from app.core.constants import PRE_ENGAGEMENT_BOOST, PRE_ENGAGEMENT_TTL_MIN
from app.core.context import ctx
from app.core.db import db, get_db
from app.core.geo import haversine, resolve_zone
from app.core.realtime import emit_realtime_event
from app.core.security import verify_admin_token
from app.core.utils import now_utc, uid
from app.performance import get_performance_multiplier  # Sprint 26 — perf scoring


# Sprint 21 C10: PROBLEM_SKILL_MAP inlined (единственный consumer — ниже).
PROBLEM_SKILL_MAP = {
    "wont-start": ["engine", "electric", "diagnostics"],
    "tow": ["tow"],
    "diagnostics": ["diagnostics", "engine"],
    "oil": ["maintenance"],
    "brakes": ["brakes", "suspension"],
    "electric": ["electric"],
    "battery": ["electric"],
    "suspension": ["suspension", "brakes"],
    "body": ["body"],
    "general": ["diagnostics", "engine", "maintenance"],
}


# `db` — lazy-proxy (см. providers.py комментарий).

router = APIRouter()


@router.post("/api/matching/advanced")
async def advanced_matching(request: Request):
    """Context-aware matching engine V2 with skills, performance, trust"""
    body = await request.json()
    lat = body.get("lat", 50.4501)
    lng = body.get("lng", 30.5234)
    problem = body.get("problem", "general")
    limit_val = body.get("limit", 10)
    
    W_conf = await db.matching_config.find_one({"type": "weights"}, {"_id": 0})
    W = W_conf or {"distance": 0.25, "rating": 0.20, "response": 0.15, "availability": 0.10, "skillMatch": 0.15, "performance": 0.10, "trust": 0.05}
    required_skills = set(PROBLEM_SKILL_MAP.get(problem, ["diagnostics"]))
    
    orgs = await db.organizations.find({"status": "active"}, {"_id": 0}).to_list(50)
    all_perf = {p["providerSlug"]: p async for p in db.provider_performance.find({}, {"_id": 0})}
    all_skills = {}
    async for s in db.provider_skills.find({}, {"_id": 0}):
        all_skills.setdefault(s["providerSlug"], []).append(s)
    all_avail = {a["providerSlug"]: a async for a in db.provider_availability.find({}, {"_id": 0})}
    
    results = []
    for o in orgs:
        slug = o.get("slug", "")
        coords = o.get("location", {}).get("coordinates", [30.52, 50.45])
        dist = haversine(lat, lng, coords[1], coords[0])
        rating = o.get("ratingAvg", 4.0)
        resp_time = o.get("avgResponseTimeMinutes", 15)
        
        dist_s = max(0, min(1, 1 - dist / 15))
        rat_s = max(0, min(1, rating / 5))
        rsp_s = max(0, min(1, 1 - resp_time / 30))
        
        avail = all_avail.get(slug, {})
        avl_s = 1.0 if avail.get("isOnline") else 0.3
        
        p_skills = all_skills.get(slug, [])
        p_cats = {s["category"] for s in p_skills}
        matched_sk = required_skills & p_cats
        skl_s = len(matched_sk) / max(len(required_skills), 1) if required_skills else 0.5
        for s in p_skills:
            if s["category"] in matched_sk and s.get("level", 1) >= 4:
                skl_s = min(1.0, skl_s + 0.1)
        
        perf = all_perf.get(slug, {})
        prf_s = (perf.get("acceptanceRate", 80)/100*0.3 + perf.get("completionRate", 90)/100*0.3 + perf.get("qualityScore", 75)/100*0.3 + (1-perf.get("cancelRate", 5)/100)*0.1)
        tst_s = (rat_s*0.5 + perf.get("completionRate", 90)/100*0.2 + (1-perf.get("cancelRate", 5)/50)*0.15 + (0.15 if o.get("isVerified") else 0))
        
        base = dist_s*W.get("distance",0.25) + rat_s*W.get("rating",0.20) + rsp_s*W.get("response",0.15) + avl_s*W.get("availability",0.10) + skl_s*W.get("skillMatch",0.15) + prf_s*W.get("performance",0.10) + tst_s*W.get("trust",0.05)
        promo = min(o.get("promotionBoost", 0), 0.25) if o.get("isPromoted") else 0
        final = base + promo
        
        why = []
        if dist < 2: why.append("Очень близко")
        if rating >= 4.8: why.append("Топ рейтинг")
        if rsp_s > 0.7: why.append("Быстро отвечает")
        if avl_s == 1.0: why.append("Доступен сейчас")
        if skl_s >= 0.8: why.append("Специалист по запросу")
        if promo > 0: why.append(o.get("promotedLabel", "Рекомендуем"))
        
        eta = max(3, int(dist * 4 + random.uniform(-2, 3)))
        results.append({
            "slug": slug, "name": o.get("name"), "type": o.get("type"),
            "ratingAvg": rating, "reviewsCount": o.get("reviewsCount", 0),
            "distance": round(dist, 1), "eta": eta,
            "priceFrom": o.get("priceFrom", 500), "isOnline": o.get("isOnline"),
            "isVerified": o.get("isVerified"), "badges": o.get("badges", []),
            "scores": {"distance": round(dist_s, 3), "rating": round(rat_s, 3), "response": round(rsp_s, 3), "availability": round(avl_s, 3), "skillMatch": round(skl_s, 3), "performance": round(prf_s, 3), "trust": round(tst_s, 3)},
            "baseScore": round(base, 4), "promotionBoost": round(promo, 4), "finalScore": round(final, 4),
            "isPromoted": promo > 0, "promotedLabel": o.get("promotedLabel") if promo > 0 else None,
            "whyReasons": why[:4], "matchedSkills": list(matched_sk),
            "performanceHighlights": {"acceptanceRate": perf.get("acceptanceRate"), "completionRate": perf.get("completionRate"), "qualityScore": perf.get("qualityScore")},
        })
    
    results.sort(key=lambda x: -x["finalScore"])
    return {"providers": results[:limit_val], "total": len(results), "matchingWeights": {k: v for k, v in W.items() if k != "type"}, "problemCategory": problem, "requiredSkills": list(required_skills)}


@router.get("/api/matching/nearby")
async def matching_nearby(lat: float = 50.4501, lng: float = 30.5234, radius: float = 5, limit: int = 10, cluster: str | None = None):
    """Geo-indexed nearby search. Sprint 33: cluster-aware filter (default=all)."""
    query: dict = {"status": "active", "location": {"$near": {"$geometry": {"type": "Point", "coordinates": [lng, lat]}, "$maxDistance": radius * 1000}}}
    if cluster:
        from app.marketplace.clusters import normalize_cluster
        canonical = normalize_cluster(cluster)
        query["clusters"] = canonical
    orgs = await db.organizations.find(query, {"_id": 0}).to_list(limit)
    if cluster and not orgs:
        # Fallback: empty result for cluster → fall back to repair so UI never breaks
        query.pop("clusters", None)
        query["clusters"] = "repair"
        orgs = await db.organizations.find(query, {"_id": 0}).to_list(limit)
    for o in orgs:
        coords = o.get("location", {}).get("coordinates", [lng, lat])
        o["distance"] = round(haversine(lat, lng, coords[1], coords[0]), 1)
        o["eta"] = max(3, int(o["distance"] * 4))
        o.pop("ownerId", None)
        o.pop("location", None)
    return {"providers": orgs, "total": len(orgs), "center": {"lat": lat, "lng": lng}, "radiusKm": radius, "cluster": cluster or "all"}


@router.post("/api/matching/zone-aware")
async def zone_aware_matching(request: Request):
    """Zone-aware matching: combines advanced matching with zone dynamics"""
    body = await request.json()
    lat = body.get("lat", 50.4501)
    lng = body.get("lng", 30.5234)
    problem = body.get("problem", "general")
    limit_val = body.get("limit", 10)
    
    # Resolve zone
    zone_id = resolve_zone(lat, lng)
    zone = await db.zones.find_one({"id": zone_id}, {"_id": 0})
    zone_ratio = zone.get("ratio", 1) if zone else 1
    zone_surge = zone.get("surgeMultiplier", 1) if zone else 1
    zone_status = zone.get("status", "BALANCED") if zone else "BALANCED"
    
    # Zone factor: lower ratio = more lenient matching; higher ratio = stricter
    zone_factor = max(0.1, min(1.0, 1 / max(zone_ratio, 0.5)))
    
    # Distribution fanout based on zone status
    fanout_map = {"BALANCED": 3, "BUSY": 4, "SURGE": 5, "CRITICAL": 6}
    fanout = fanout_map.get(zone_status, 3)
    
    # Get matching weights
    W_conf = await db.matching_config.find_one({"type": "weights"}, {"_id": 0})
    W = W_conf or {"distance": 0.25, "rating": 0.20, "response": 0.15, "availability": 0.10, "skillMatch": 0.15, "performance": 0.10, "trust": 0.05}
    required_skills = set(PROBLEM_SKILL_MAP.get(problem, ["diagnostics"]))
    
    orgs = await db.organizations.find({"status": "active"}, {"_id": 0}).to_list(50)
    all_perf = {p["providerSlug"]: p async for p in db.provider_performance.find({}, {"_id": 0})}
    all_skills = {}
    async for s in db.provider_skills.find({}, {"_id": 0}):
        all_skills.setdefault(s["providerSlug"], []).append(s)
    all_avail = {a["providerSlug"]: a async for a in db.provider_availability.find({}, {"_id": 0})}
    
    results = []
    for o in orgs:
        slug = o.get("slug", "")
        coords = o.get("location", {}).get("coordinates", [30.52, 50.45])
        dist = haversine(lat, lng, coords[1], coords[0])
        rating = o.get("ratingAvg", 4.0)
        resp_time = o.get("avgResponseTimeMinutes", 15)
        
        # Base scores
        dist_s = max(0, min(1, 1 - dist / 15))
        rat_s = max(0, min(1, rating / 5))
        rsp_s = max(0, min(1, 1 - resp_time / 30))
        
        avail = all_avail.get(slug, {})
        avl_s = 1.0 if avail.get("isOnline") else 0.3
        
        p_skills = all_skills.get(slug, [])
        p_cats = {s["category"] for s in p_skills}
        matched_sk = required_skills & p_cats
        skl_s = len(matched_sk) / max(len(required_skills), 1) if required_skills else 0.5
        
        perf = all_perf.get(slug, {})
        prf_s = (perf.get("acceptanceRate", 80)/100*0.3 + perf.get("completionRate", 90)/100*0.3 + perf.get("qualityScore", 75)/100*0.3 + (1-perf.get("cancelRate", 5)/100)*0.1)
        tst_s = (rat_s*0.5 + perf.get("completionRate", 90)/100*0.2 + (1-perf.get("cancelRate", 5)/50)*0.15 + (0.15 if o.get("isVerified") else 0))
        
        # Zone factor integration
        base = (dist_s*W.get("distance",0.25) + rat_s*W.get("rating",0.20) + rsp_s*W.get("response",0.15) + avl_s*W.get("availability",0.10) + skl_s*W.get("skillMatch",0.15) + prf_s*W.get("performance",0.10) + tst_s*W.get("trust",0.05))
        zone_boost = zone_factor * 0.1
        promo = min(o.get("promotionBoost", 0), 0.25) if o.get("isPromoted") else 0
        final = base + zone_boost + promo

        # ─── Sprint 25: Paid Boost (multiplicative ranking) ───────────────
        # final_score = (base + zoneBoost + promo) * boost_multiplier
        # Sprint 27: AUCTION takes precedence — bid-based per-zone multiplier
        # (1st→2.0, 2nd→1.6, 3rd→1.3). If provider has no auction position
        # in this zone, fall back to legacy package boost.
        boost_mult = 1.0
        boost_level_applied: Optional[str] = None
        boost_source: Optional[str] = None

        # 1) Live Auction (Sprint 27) — primary monetisation
        try:
            from app.marketplace.auction import compute_auction_multiplier
            # Sprint 33 C5: cluster-scoped auction (default repair via normalize_cluster)
            cluster_in = body.get("cluster")
            auc_mult, auc_pos = await compute_auction_multiplier(o.get("slug", ""), zone_id, cluster_in)
            if auc_mult > 1.0:
                boost_mult = auc_mult
                boost_level_applied = f"auction_rank_{(auc_pos or 0) + 1}"
                boost_source = "auction"
        except Exception:
            pass

        # 2) Fallback: legacy 7d/24h package boost
        if boost_mult == 1.0:
            b_ends = o.get("boostEndsAt")
            if b_ends:
                try:
                    b_dt = datetime.fromisoformat(b_ends.replace('Z', '+00:00'))
                    if b_dt > now_utc():
                        boost_mult = max(1.0, min(2.0, float(o.get("boostMultiplier", 1.0))))
                        boost_level_applied = o.get("boostLevel")
                        boost_source = "package"
                except Exception:
                    pass
        if boost_mult > 1.0:
            final *= boost_mult

        # ─── Sprint 26: Performance multiplier (clamp 0.5..1.2) ───────────
        # final_score = base * boost * performance_score.
        # Mapping rule: top performers (score≈1) → 1.2x; новички → 1.0x;
        # плохие/абъюзеры → 0.5x. Делает топ-3 = "boost+perf доминируют".
        perf_mult = await get_performance_multiplier(o.get("slug", ""))
        perf_mult = max(0.5, min(1.2, float(perf_mult)))
        if perf_mult != 1.0:
            final *= perf_mult
        # ──────────────────────────────────────────────────────────────────

        # ─── Sprint 18: Pre-Engagement boost ──────────────────────────────
        pre_engaged_boost_applied = False
        pre_engaged_at = o.get("preEngagedAt")
        if pre_engaged_at:
            try:
                pe_dt = datetime.fromisoformat(pre_engaged_at.replace('Z', '+00:00'))
                if (now_utc() - pe_dt).total_seconds() < PRE_ENGAGEMENT_TTL_MIN * 60:
                    final *= PRE_ENGAGEMENT_BOOST
                    pre_engaged_boost_applied = True
            except Exception:
                pass
        # ──────────────────────────────────────────────────────────────────
        
        # Surge-adjusted price
        price_from = o.get("priceFrom", 500)
        surged_price = round(price_from * zone_surge)
        
        eta = max(3, int(dist * 4 + random.uniform(-2, 3)))
        
        why = []
        if dist < 2: why.append("Очень близко")
        if rating >= 4.8: why.append("Топ рейтинг")
        if rsp_s > 0.7: why.append("Быстро отвечает")
        if avl_s == 1.0: why.append("Доступен сейчас")
        if skl_s >= 0.8: why.append("Специалист по запросу")
        if zone_surge > 1.2: why.append(f"Surge x{zone_surge}")
        
        results.append({
            "slug": slug, "name": o.get("name"), "type": o.get("type"),
            "ratingAvg": rating, "reviewsCount": o.get("reviewsCount", 0),
            "distance": round(dist, 1), "eta": eta,
            "priceFrom": price_from, "surgedPrice": surged_price,
            "isOnline": o.get("isOnline"), "isVerified": o.get("isVerified"),
            "badges": o.get("badges", []),
            "scores": {"distance": round(dist_s, 3), "rating": round(rat_s, 3), "response": round(rsp_s, 3), "availability": round(avl_s, 3), "skillMatch": round(skl_s, 3), "performance": round(prf_s, 3), "trust": round(tst_s, 3), "zoneFactor": round(zone_factor, 3)},
            "baseScore": round(base, 4), "zoneBoost": round(zone_boost, 4), "promotionBoost": round(promo, 4), "finalScore": round(final, 4),
            "preEngageBoosted": pre_engaged_boost_applied,
            "boostMultiplier": boost_mult,
            "boostLevel": boost_level_applied,
            "performanceMultiplier": perf_mult,
            "whyReasons": why[:4], "matchedSkills": list(matched_sk),
        })
    
    results.sort(key=lambda x: -x["finalScore"])
    
    return {
        "providers": results[:limit_val],
        "total": len(results),
        "zone": {"id": zone_id, "name": zone.get("name") if zone else zone_id, "status": zone_status, "surge": zone_surge, "ratio": zone_ratio},
        "zoneFactor": round(zone_factor, 3),
        "fanout": fanout,
        "matchingWeights": {k: v for k, v in W.items() if k != "type"},
        "problemCategory": problem,
        "requiredSkills": list(required_skills),
    }


@router.post("/api/distribution/zone-aware")
async def zone_aware_distribution(request: Request):
    """Distribute request to providers with zone-based fanout"""
    body = await request.json()
    lat = body.get("lat", 50.4501)
    lng = body.get("lng", 30.5234)
    service_id = body.get("serviceId")
    booking_id = body.get("bookingId")
    
    # Resolve zone
    zone_id = resolve_zone(lat, lng)
    zone = await db.zones.find_one({"id": zone_id}, {"_id": 0})
    zone_status = zone.get("status", "BALANCED") if zone else "BALANCED"
    zone_surge = zone.get("surgeMultiplier", 1) if zone else 1
    
    # Fanout based on zone status
    fanout_map = {"BALANCED": 2, "BUSY": 3, "SURGE": 4, "CRITICAL": 6}
    fanout = fanout_map.get(zone_status, 3)
    
    # Get nearby online providers
    query = {"isOnline": True}
    providers = await db.provider_locations.find(
        {"isOnline": True, "location": {"$near": {"$geometry": {"type": "Point", "coordinates": [lng, lat]}, "$maxDistance": 8000}}},
        {"_id": 0}
    ).to_list(fanout * 2)
    
    # Rank by distance and select top N
    for p in providers:
        coords = p.get("location", {}).get("coordinates", [lng, lat])
        p["distance"] = round(haversine(lat, lng, coords[1], coords[0]), 1)
    providers.sort(key=lambda x: x.get("distance", 999))
    selected = providers[:fanout]
    
    # Log distribution
    distribution = {
        "id": uid(),
        "bookingId": booking_id,
        "zoneId": zone_id,
        "zoneStatus": zone_status,
        "fanout": fanout,
        "surge": zone_surge,
        "distributedTo": [p.get("providerId") for p in selected],
        "totalCandidates": len(providers),
        "createdAt": now_utc().isoformat(),
    }
    await db.zone_distributions.insert_one(distribution)
    distribution.pop("_id", None)
    
    # Emit events to providers
    for p in selected:
        await emit_realtime_event("provider:new_request", {
            "providerId": p.get("providerId"),
            "bookingId": booking_id,
            "distance": p.get("distance"),
            "surge": zone_surge,
        })
    
    # Track demand event
    await db.booking_demand_events.insert_one({
        "id": uid(), "zoneId": zone_id, "type": "distributed",
        "bookingId": booking_id, "lat": lat, "lng": lng,
        "fanout": fanout, "providersNotified": len(selected),
        "timestamp": now_utc().isoformat(),
    })
    
    return {
        "status": "distributed",
        "distribution": distribution,
        "zone": {"id": zone_id, "status": zone_status, "surge": zone_surge},
    }


@router.get("/api/distribution/history")
async def get_distribution_history(zoneId: str = None, limit: int = 30):
    """Get zone distribution history"""
    query = {}
    if zoneId:
        query["zoneId"] = zoneId
    distributions = await db.zone_distributions.find(query, {"_id": 0}).sort("createdAt", -1).to_list(limit)
    return {"distributions": distributions, "total": len(distributions)}
