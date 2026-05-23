"""Sprint 21 C10: extracted from server.py 1-to-1.

Endpoints live on `router` (APIRouter). Registered via
app.marketplace.router.include_router → include_router in server.py,
ДО catch-all NestJS proxy.
"""
from __future__ import annotations
import asyncio
import logging
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
# Phase 1B Tier 4 — pure sync cluster enrichment for reviews writer.
from app.core.cluster_writer import enrich_with_cluster
from app.core.redis_state import rate_limit_public  # Sprint 24
from app.core.security import verify_admin_token
from app.core.utils import now_utc, uid
from app.marketplace.trust import compute_trust_profile  # Berlin Launch B3 — Trust Layer
from app.booking import observe_transition  # P0.b.B — best-effort sidecar attach


# Sprint 21 C10: `db` импортируется как lazy-proxy из app.core.db — каждый
# attr-lookup резолвится в момент вызова через ctx.db. Это сохраняет стиль
# кода 1-в-1 с server.py (`await db.organizations.find(...)`) и даёт нам
# тестируемость (подмена ctx.db = mock).

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/api/marketplace/providers")
async def marketplace_providers(lat: float = 50.4501, lng: float = 30.5234, radius: float = 10, limit: int = 20, city: str = None, q: str = None, kinds: str = None, _=Depends(rate_limit_public)):
    """Get providers for web marketplace with RANKING ENGINE + promotion boost.

    Stage 2 — Geo + Search:
    - Optional `?city=<code>` filter (berlin, munich, hamburg, kyiv, lviv, odesa).
      When provided, only orgs tagged with that city are considered.
    - Optional `?q=<text>` — case-insensitive regex search over `name` / `description`.
    - Optional `?kinds=workshop,inspector,dealer,carwash` — comma-separated
      partner kinds (used by the map filter chips). Empty → no kind filter.
    """
    org_filter = {"status": "active"}
    if city:
        org_filter["city"] = city
    if kinds:
        wanted = [k.strip() for k in kinds.split(",") if k.strip()]
        if wanted:
            org_filter["kind"] = {"$in": wanted}
    if q and q.strip():
        safe = q.strip().replace("\\", "\\\\").replace(".", "\\.").replace("*", "\\*")
        org_filter["$or"] = [
            {"name": {"$regex": safe, "$options": "i"}},
            {"description": {"$regex": safe, "$options": "i"}},
        ]
    # Q2-R1 UX-1 — geo prefilter: candidates must be within `radius` km of (lat,lng).
    # Without this, `to_list(limit*2)` cut off providers beyond natural insertion order,
    # so providers in newly-seeded cities (e.g. Bonn) never reached the ranking pass.
    # 2dsphere index on `location` is created in seed.py — falls back to no-geo on error.
    try:
        org_filter["location"] = {
            "$nearSphere": {
                "$geometry": {"type": "Point", "coordinates": [lng, lat]},
                "$maxDistance": int(max(radius, 1) * 1000 * 4),  # 4× radius safety margin
            }
        }
        orgs = await db.organizations.find(org_filter, {"_id": 0}).to_list(2000)
    except Exception:
        org_filter.pop("location", None)
        orgs = await db.organizations.find(org_filter, {"_id": 0}).to_list(2000)
    results = []
    for o in orgs:
        loc = o.get("location", {})
        coords = loc.get("coordinates", [30.52, 50.45])
        dist = haversine(lat, lng, coords[1], coords[0])
        eta = max(3, int(dist * 4 + random.uniform(-2, 3)))
        rating = o.get("ratingAvg", 4.0)
        resp_time = o.get("avgResponseTimeMinutes", 15)
        
        # ═══ RANKING ENGINE ═══
        dist_score = max(0, min(1, 1 - dist / 10))
        rating_score = max(0, min(1, rating / 5))
        resp_score = max(0, min(1, 1 - resp_time / 30))
        avail_score = 1 if o.get("isOnline") else 0.3
        base_score = dist_score * 0.4 + rating_score * 0.25 + resp_score * 0.2 + avail_score * 0.15
        
        # ═══ PROMOTION BOOST (capped at 0.25) ═══
        is_promoted = o.get("isPromoted", False)
        promo_boost = 0
        promo_label = None
        if is_promoted:
            ends_at = o.get("promotionEndsAt")
            if not ends_at or ends_at > now_utc().isoformat():
                promo_boost = min(o.get("promotionBoost", 0), 0.25)
                promo_label = o.get("promotedLabel", "Рекомендуем")
        
        final_score = base_score + promo_boost

        # ── Berlin Launch B3 — Trust Layer ─────────────────────────────
        trust = compute_trust_profile(o)
        final_score *= trust["boostFactor"]
        o["trustProfile"] = trust
        # ───────────────────────────────────────────────────────────────

        # ─── Sprint 18: Pre-Engagement boost ──────────────────────────────
        # Если провайдер вышел онлайн по pre-engagement приглашению — даём
        # ему ranking boost x1.1 в течение 15 минут (как в Sprint 17 plan).
        pre_engaged_at = o.get("preEngagedAt")
        if pre_engaged_at:
            try:
                pe_dt = datetime.fromisoformat(pre_engaged_at.replace('Z', '+00:00'))
                if (now_utc() - pe_dt).total_seconds() < PRE_ENGAGEMENT_TTL_MIN * 60:
                    final_score *= PRE_ENGAGEMENT_BOOST
                    o["preEngageBoosted"] = True
            except Exception:
                pass
        # ──────────────────────────────────────────────────────────────────

        o["distance"] = round(dist, 1)
        o["distanceText"] = f"{round(dist, 1)} km"
        o["eta"] = eta
        o["etaText"] = f"{eta} Min."
        o["baseScore"] = round(base_score, 4)
        o["finalScore"] = round(final_score, 4)
        o["isPromoted"] = promo_boost > 0
        o["promotedLabel"] = promo_label
        o["socialProof"] = f"{random.randint(5, 40)}× heute gewählt" if random.random() > 0.4 else ""
        o["trustBadges"] = []
        if o.get("completedBookingsCount", 0) > 100:
            o["trustBadges"].append(f"{o['completedBookingsCount']}+ Aufträge")
        if o.get("isVerified"):
            o["trustBadges"].append("Verifiziert")
        if o.get("ratingAvg", 0) >= 4.8:
            o["trustBadges"].append("Top-Bewertung")
        o.pop("ownerId", None)
        # Surface flat lat/lng for map markers (Expo /map screen filters by
        # `p.location?.coordinates || (p.lat && p.lng)`). Keep `location`
        # GeoJSON for legacy consumers too.
        o["lat"] = coords[1]
        o["lng"] = coords[0]
        results.append(o)
    
    # Sort by finalScore (promoted providers float to top naturally)
    results.sort(key=lambda x: -x["finalScore"])
    promoted_count = sum(1 for r in results[:3] if r.get("isPromoted"))
    return {"providers": results[:limit], "total": len(results), "promotedCount": promoted_count}


@router.get("/api/marketplace/providers/{slug}")
async def marketplace_provider_detail(slug: str):
    """Get single provider detail"""
    org_raw = await db.organizations.find_one({"slug": slug})
    if not org_raw:
        raise HTTPException(404, "Provider not found")
    org_id = str(org_raw["_id"])
    org_raw.pop("_id", None)
    org_raw.pop("ownerId", None)
    reviews = await db.reviews.find({"organizationId": org_id}, {"_id": 0}).sort("createdAt", -1).to_list(10)
    org_raw["reviews"] = reviews
    services = []
    for sid in org_raw.get("serviceIds", []):
        from bson import ObjectId
        try:
            svc = await db.services.find_one({"_id": ObjectId(sid)}, {"_id": 0})
            if svc:
                services.append(svc)
        except Exception:
            pass
    org_raw["services"] = services
    org_raw.pop("location", None)
    return org_raw


@router.get("/api/marketplace/services")
async def marketplace_services():
    """Get all services with categories"""
    cats = await db.servicecategories.find({"isActive": True}, {"_id": 0}).sort("order", 1).to_list(50)
    svcs = await db.services.find({"isActive": True}, {"_id": 0}).to_list(100)
    return {"categories": cats, "services": svcs}


@router.get("/api/marketplace/stats")
async def marketplace_stats():
    """Get live marketplace stats"""
    online_count = await db.organizations.count_documents({"status": "active", "isOnline": True})
    total = await db.organizations.count_documents({"status": "active"})
    today_bookings = await db.bookings.count_documents({})
    return {
        "onlineProviders": online_count,
        "totalProviders": total,
        "avgEta": random.randint(5, 15),
        "avgRating": 4.7,
        "todayBookings": max(today_bookings, random.randint(30, 80)),
        "demand": "high" if online_count < 5 else "medium" if online_count < 10 else "normal",
        "recentEvents": [
            {"text": "Werkstatt hat Anfrage angenommen", "time": f"vor {random.randint(1, 5)} Min.", "type": "accept"},
            {"text": "Neue Werkstatt ist online gegangen", "time": f"vor {random.randint(3, 10)} Min.", "type": "online"},
            {"text": f"Auftrag mit {random.choice(['4.8', '5.0', '4.9'])} bewertet", "time": f"vor {random.randint(5, 15)} Min.", "type": "complete"},
            {"text": "Schnell-Anfrage abgeschlossen", "time": f"vor {random.randint(10, 20)} Min.", "type": "quick"},
            {"text": "Kunde hat Bewertung abgegeben", "time": f"vor {random.randint(15, 30)} Min.", "type": "review"},
        ],
    }

# --- Disputes list compat: /api/disputes → NestJS /disputes/my ---
# Sprint 21 C8: вынесено в app/system/compat.py (compat_disputes_list).


@router.post("/api/marketplace/quick-request")
async def marketplace_quick_request(request: Request, _=Depends(rate_limit_public)):
    """Quick request - find best provider.

    Sprint 14: accepts both `problem` and `serviceType` (synonyms).
    Mobile and web-app can now share a single contract:
        { problem | serviceType, lat, lng, vehicleId?, urgent? }
    """
    body = await request.json()
    problem = body.get("problem") or body.get("serviceType") or "diagnostics"
    lat = body.get("lat", 50.4501)
    lng = body.get("lng", 30.5234)

    orgs = await db.organizations.find({"status": "active", "isOnline": True}, {"_id": 0}).to_list(20)
    if not orgs:
        orgs = await db.organizations.find({"status": "active"}, {"_id": 0}).to_list(20)

    scored = []
    for o in orgs:
        coords = o.get("location", {}).get("coordinates", [30.52, 50.45])
        dist = haversine(lat, lng, coords[1], coords[0])
        eta = max(3, int(dist * 4 + random.uniform(-2, 3)))
        rating = o.get("ratingAvg", 4.0)
        resp_time = o.get("avgResponseTimeMinutes", 15)
        
        # ═══ RANKING ENGINE with promotion ═══
        dist_s = max(0, min(1, 1 - dist / 10))
        rat_s = max(0, min(1, rating / 5))
        rsp_s = max(0, min(1, 1 - resp_time / 30))
        avl_s = 1 if o.get("isOnline") else 0.3
        base = dist_s * 0.4 + rat_s * 0.25 + rsp_s * 0.2 + avl_s * 0.15
        promo = min(o.get("promotionBoost", 0), 0.25) if o.get("isPromoted") else 0
        score = base + promo
        
        entry = {**o, "distance": round(dist, 1), "distanceText": f"{round(dist, 1)} км", "eta": eta, "etaText": f"{eta} мин", "matchScore": round(score, 4), "isPromoted": promo > 0, "promotedLabel": o.get("promotedLabel") if promo > 0 else None}
        entry.pop("ownerId", None)
        entry.pop("location", None)
        scored.append(entry)

    scored.sort(key=lambda x: -x["matchScore"])
    best = scored[0] if scored else None
    alts = scored[1:4] if len(scored) > 1 else []

    return {
        "provider": best,
        "alternatives": [{"name": a["name"], "slug": a["slug"], "rating": a.get("ratingAvg", 4.0), "eta": a["eta"], "etaText": a["etaText"], "distance": a["distance"], "distanceText": a["distanceText"], "priceFrom": a.get("priceFrom", 500)} for a in alts],
        "matchedCount": len(scored),
        "problem": problem,
    }


@router.get("/api/marketplace/provider/{slug}/slots")
async def marketplace_provider_slots(slug: str, date: str = None):
    """Get available time slots for a provider"""
    org = await db.organizations.find_one({"slug": slug})
    if not org:
        raise HTTPException(404, "Provider not found")
    if not date:
        from datetime import date as datemod
        date = datemod.today().isoformat()
    # Generate realistic slots
    slots = []
    for hour in range(9, 19):
        for minute in [0, 30]:
            t = f"{hour:02d}:{minute:02d}"
            available = random.random() > 0.3
            slots.append({"id": uid(), "time": t, "available": available, "date": date})
    return {"date": date, "slots": slots, "providerSlug": slug}


@router.post("/api/marketplace/bookings")
async def marketplace_create_booking(request: Request):
    """Create a booking from marketplace"""
    body = await request.json()
    provider_slug = body.get("providerSlug") or body.get("providerId")
    service_name = body.get("serviceName", "Диагностика")
    slot_time = body.get("slotTime")
    slot_date = body.get("slotDate")
    comment = body.get("comment", "")
    address = body.get("address", "")
    source = body.get("source", "marketplace")

    org = await db.organizations.find_one({"slug": provider_slug}) if provider_slug else None
    provider_name = org["name"] if org else "Мастер"

    booking = {
        "id": uid(),
        "providerSlug": provider_slug,
        "providerName": provider_name,
        "serviceName": service_name,
        "slotDate": slot_date or now_utc().strftime("%Y-%m-%d"),
        "slotTime": slot_time or "10:00",
        "comment": comment,
        "address": address,
        "source": source,
        "status": "pending",
        "statusHistory": [{"status": "pending", "at": now_utc().isoformat()}],
        "eta": random.randint(5, 20),
        "priceEstimate": org.get("priceFrom", 500) if org else 500,
        "createdAt": now_utc().isoformat(),
    }
    await db.web_bookings.insert_one(booking)
    booking.pop("_id", None)
    # Emit realtime event
    await ctx.emit.provider_new_request(booking)
    return booking


@router.post("/api/marketplace/provider/location")
async def provider_update_location(request: Request):
    """Provider updates their location during active job"""
    body = await request.json()
    booking_id = body.get("bookingId")
    lat = body.get("lat", 50.4501)
    lng = body.get("lng", 30.5234)
    heading = body.get("heading", 0)
    speed = body.get("speed", 0)
    
    if booking_id:
        eta = max(1, int(random.uniform(3, 15)))
        await db.web_bookings.update_one(
            {"id": booking_id},
            {"$set": {"providerLocation": {"lat": lat, "lng": lng, "heading": heading, "speed": speed}, "eta": eta}}
        )
        await ctx.emit.provider_location(booking_id, lat, lng, heading, speed, eta)
    
    return {"status": "updated", "bookingId": booking_id, "lat": lat, "lng": lng}


@router.post("/api/marketplace/bookings/{booking_id}/simulate-drive")
async def simulate_provider_drive(booking_id: str):
    """Simulate provider driving toward customer for demo - emits 10 location updates"""
    booking = await db.web_bookings.find_one({"id": booking_id})
    if not booking:
        raise HTTPException(404, "Booking not found")
    
    # Provider starts from org location, drives toward customer
    start_lat, start_lng = 50.4501, 30.5234
    end_lat, end_lng = 50.4520, 30.5210
    
    cur = booking.get("providerLocation", {"lat": start_lat, "lng": start_lng})
    cur_lat, cur_lng = cur.get("lat", start_lat), cur.get("lng", start_lng)
    
    # Move 20% closer to customer
    new_lat = cur_lat + (end_lat - cur_lat) * 0.2 + random.uniform(-0.0005, 0.0005)
    new_lng = cur_lng + (end_lng - cur_lng) * 0.2 + random.uniform(-0.0005, 0.0005)
    
    dist = haversine(new_lat, new_lng, end_lat, end_lng)
    eta = max(1, int(dist * 4))
    heading = random.uniform(0, 360)
    speed = random.uniform(20, 50)
    
    await db.web_bookings.update_one(
        {"id": booking_id},
        {"$set": {"providerLocation": {"lat": new_lat, "lng": new_lng, "heading": heading, "speed": speed}, "eta": eta}}
    )
    await ctx.emit.provider_location(booking_id, new_lat, new_lng, heading, speed, eta)
    
    return {"lat": round(new_lat, 6), "lng": round(new_lng, 6), "eta": eta, "distance": round(dist, 2), "heading": round(heading, 1), "speed": round(speed, 1)}


@router.get("/api/marketplace/bookings/{booking_id}")
async def marketplace_get_booking(booking_id: str):
    """Get booking detail with rich provider data and timeline"""
    booking = await db.web_bookings.find_one({"id": booking_id}, {"_id": 0})
    if not booking:
        raise HTTPException(404, "Booking not found")

    # Enrich with provider data
    provider_slug = booking.get("providerSlug")
    provider_data = None
    if provider_slug:
        org = await db.organizations.find_one({"slug": provider_slug}, {"_id": 0, "ownerId": 0, "location": 0})
        if org:
            provider_data = {
                "name": org.get("name", ""),
                "slug": org.get("slug", ""),
                "rating": org.get("ratingAvg", 4.0),
                "reviewsCount": org.get("reviewsCount", 0),
                "badges": org.get("badges", []),
                "whyReasons": org.get("whyReasons", []),
                "address": org.get("address", ""),
                "isOnline": org.get("isOnline", False),
                "workHours": org.get("workHours", ""),
                "type": org.get("type", "sto"),
            }

    # Build timeline from statusHistory
    status = booking.get("status", "pending")
    status_history = booking.get("statusHistory", [])
    timeline_steps = [
        {"key": "pending", "label": "Заявка создана", "icon": "clock"},
        {"key": "confirmed", "label": "Мастер подтвердил", "icon": "check"},
        {"key": "on_route", "label": "Мастер выехал", "icon": "car"},
        {"key": "arrived", "label": "Прибыл на место", "icon": "pin"},
        {"key": "in_progress", "label": "Работа выполняется", "icon": "wrench"},
        {"key": "completed", "label": "Завершено", "icon": "star"},
    ]
    status_order = ["pending", "confirmed", "on_route", "arrived", "in_progress", "completed"]
    current_idx = status_order.index(status) if status in status_order else -1

    history_map = {h["status"]: h.get("at") for h in status_history}
    timeline = []
    for i, step in enumerate(timeline_steps):
        completed = i < current_idx if status != "cancelled" else False
        active = i == current_idx if status != "cancelled" else False
        timeline.append({**step, "completed": completed, "active": active, "at": history_map.get(step["key"])})

    booking["provider"] = provider_data
    booking["timeline"] = timeline
    booking["isCancellable"] = status in ["pending", "confirmed"]
    booking["isReviewable"] = status == "completed"
    return booking


@router.post("/api/marketplace/bookings/{booking_id}/cancel")
async def marketplace_cancel_booking(booking_id: str, request: Request):
    """Cancel a booking"""
    body = await request.json()
    reason = body.get("reason", "")
    booking = await db.web_bookings.find_one({"id": booking_id})
    if not booking:
        raise HTTPException(404, "Booking not found")
    current_status = booking.get("status")
    if current_status not in ["pending", "confirmed"]:
        # P0.b.B — record rejected attempt before raising (forensics).
        try:
            await observe_transition(
                db,
                booking_id=booking_id,
                booking_scope="web_booking",
                action="cancel",
                from_status=current_status,
                to_status=None,
                actor_id="customer",
                actor_role="customer",
                source="marketplace.bookings.cancel",
                source_request_id=request.headers.get("x-request-id"),
                accepted=False,
                meta={"reason": reason, "error": "status_not_cancellable"},
            )
        except Exception:
            pass
        raise HTTPException(400, "Booking cannot be cancelled in current status")
    history_entry = {"status": "cancelled", "at": now_utc().isoformat(), "reason": reason}
    await db.web_bookings.update_one(
        {"id": booking_id},
        {"$set": {"status": "cancelled", "cancelReason": reason, "cancelledAt": now_utc().isoformat()}, "$push": {"statusHistory": history_entry}}
    )
    # P0.b.B — sidecar timeline write AFTER the existing mutation succeeds.
    try:
        await observe_transition(
            db,
            booking_id=booking_id,
            booking_scope="web_booking",
            action="cancel",
            from_status=current_status,
            to_status="cancelled",
            actor_id="customer",
            actor_role="customer",
            source="marketplace.bookings.cancel",
            source_request_id=request.headers.get("x-request-id"),
            accepted=True,
            meta={"reason": reason},
        )
    except Exception:
        pass
    await ctx.emit.booking_status(booking_id, current_status, "cancelled")
    return {"status": "cancelled", "bookingId": booking_id}


@router.post("/api/marketplace/bookings/{booking_id}/review")
async def marketplace_review_booking(booking_id: str, request: Request):
    """Submit a review for a completed booking"""
    body = await request.json()
    rating = body.get("rating", 5)
    comment = body.get("comment", "")
    booking = await db.web_bookings.find_one({"id": booking_id})
    if not booking:
        raise HTTPException(404, "Booking not found")
    # Phase 1B Tier 4 — caller-side org lookup; helper stays pure.
    # Phase 1A frozen_org_mapping didn't match current seed slugs (manual_review
    # for existing 11 orgs); new reviews may inherit None → manual_review = honest.
    org_doc = await db.organizations.find_one(
        {"slug": booking.get("providerSlug", "")}, {"_id": 0, "cluster": 1}
    ) if booking.get("providerSlug") else None
    org_cluster = (org_doc or {}).get("cluster")
    review = {
        "id": uid(), "bookingId": booking_id, "organizationId": booking.get("providerSlug", ""),
        "rating": rating, "text": comment, "authorName": "Клиент",
        "createdAt": now_utc().isoformat(),
    }
    enrich_with_cluster(
        review,
        cluster=org_cluster,
        strategy="org_lookup" if org_cluster else "manual_review",
        source_field="organizationId",
    )
    await db.reviews.insert_one(review)
    review.pop("_id", None)
    # Phase 1B Tier 4 — writer dict IS response payload here; scrub (NO shape change).
    review.pop("cluster", None)
    review.pop("clusterCreateMeta", None)
    await db.web_bookings.update_one({"id": booking_id}, {"$set": {"hasReview": True, "reviewId": review["id"]}})
    return review


@router.post("/api/marketplace/bookings/{booking_id}/simulate-progress")
async def simulate_booking_progress(booking_id: str):
    """Simulate booking progress for demo (advance to next status)"""
    booking = await db.web_bookings.find_one({"id": booking_id})
    if not booking:
        raise HTTPException(404, "Booking not found")
    status_flow = ["pending", "confirmed", "on_route", "arrived", "in_progress", "completed"]
    current = booking.get("status", "pending")
    if current not in status_flow or current == "completed":
        return {"status": current, "message": "No further progress"}
    idx = status_flow.index(current)
    next_status = status_flow[idx + 1]
    history_entry = {"status": next_status, "at": now_utc().isoformat()}
    update_fields = {"status": next_status}
    if next_status == "on_route":
        update_fields["eta"] = random.randint(5, 15)
    await db.web_bookings.update_one(
        {"id": booking_id},
        {"$set": update_fields, "$push": {"statusHistory": history_entry}}
    )
    return {"status": next_status, "bookingId": booking_id}


@router.get("/api/marketplace/provider/inbox")
async def provider_inbox(provider_slug: str = "avtomaster-pro"):
    """Get pending booking requests for provider"""
    pending = await db.web_bookings.find({"status": "pending"}, {"_id": 0}).sort("createdAt", -1).to_list(20)
    org = await db.organizations.find_one({"slug": provider_slug}, {"_id": 0, "location": 0, "ownerId": 0})
    requests = []
    for b in pending:
        created = b.get("createdAt", "")
        # Calculate time left (60s countdown from creation)
        try:
            created_dt = datetime.fromisoformat(created.replace("Z", "+00:00")) if created else now_utc()
            elapsed = (now_utc() - created_dt).total_seconds()
            time_left = max(0, 120 - int(elapsed))
        except Exception:
            time_left = 60
        requests.append({
            "id": b.get("id"), "serviceName": b.get("serviceName", "Услуга"),
            "slotDate": b.get("slotDate"), "slotTime": b.get("slotTime"),
            "comment": b.get("comment", ""), "address": b.get("address", ""),
            "priceEstimate": b.get("priceEstimate", 500), "source": b.get("source", "marketplace"),
            "distance": round(random.uniform(0.5, 5.0), 1), "eta": random.randint(5, 20),
            "timeLeft": time_left, "urgency": "urgent" if time_left < 30 else "normal",
            "isPriority": b.get("isPriorityWave", False),
            "priorityLabel": "🔥 Приоритетная заявка" if b.get("isPriorityWave") else None,
            "customerName": "Клиент", "createdAt": created,
        })
    stats = {
        "totalToday": await db.web_bookings.count_documents({}),
        "accepted": await db.web_bookings.count_documents({"status": {"$nin": ["pending", "cancelled"]}}),
        "missed": 0,
        "earnings": 0,
    }
    # Calculate earnings from completed
    completed = await db.web_bookings.find({"status": "completed"}, {"priceEstimate": 1}).to_list(100)
    stats["earnings"] = sum(c.get("priceEstimate", 0) for c in completed)
    return {"requests": requests, "stats": stats, "provider": org}


@router.post("/api/marketplace/provider/requests/{booking_id}/accept")
async def provider_accept_request(booking_id: str, request: Request):
    """Provider accepts a booking request"""
    booking = await db.web_bookings.find_one({"id": booking_id})
    if not booking:
        raise HTTPException(404, "Booking not found")
    current_status = booking.get("status")
    if current_status != "pending":
        # P0.b.B — record rejected attempt (race / double-accept forensics).
        try:
            await observe_transition(
                db,
                booking_id=booking_id,
                booking_scope="web_booking",
                action="mark_confirmed",
                from_status=current_status,
                to_status=None,
                actor_id=booking.get("providerSlug") or "unknown-provider",
                actor_role="provider",
                source="marketplace.provider.accept",
                source_request_id=request.headers.get("x-request-id"),
                accepted=False,
                meta={"error": "already_handled"},
            )
        except Exception:
            pass
        raise HTTPException(400, "Request already handled")
    history_entry = {"status": "confirmed", "at": now_utc().isoformat()}
    await db.web_bookings.update_one(
        {"id": booking_id},
        {"$set": {"status": "confirmed", "acceptedAt": now_utc().isoformat(), "providerAccepted": True},
         "$push": {"statusHistory": history_entry}}
    )
    # P0.b.B — sidecar timeline write AFTER existing mutation.
    try:
        await observe_transition(
            db,
            booking_id=booking_id,
            booking_scope="web_booking",
            action="mark_confirmed",
            from_status=current_status,
            to_status="confirmed",
            actor_id=booking.get("providerSlug") or "unknown-provider",
            actor_role="provider",
            source="marketplace.provider.accept",
            source_request_id=request.headers.get("x-request-id"),
            accepted=True,
            meta={"acceptedAt": now_utc().isoformat()},
        )
    except Exception:
        pass
    # Sprint 26: track accept + response time
    try:
        from app.performance import record_accepted
        provider_slug = booking.get("providerSlug") or booking.get("organizationSlug") or "avtomaster-pro"
        rt_seconds: Optional[float] = None
        created_at = booking.get("createdAt")
        if created_at:
            try:
                cdt = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
                rt_seconds = max(0.0, (now_utc() - cdt).total_seconds())
            except Exception:
                pass
        await record_accepted(provider_slug, rt_seconds)
    except Exception as e:
        logger.warning(f"performance hook (accept) failed: {e}")
    await ctx.emit.booking_status(booking_id, "pending", "confirmed")
    await emit_realtime_event("provider:request_taken", {"requestId": booking_id})
    return {"status": "confirmed", "bookingId": booking_id}


@router.post("/api/marketplace/provider/requests/{booking_id}/reject")
async def provider_reject_request(booking_id: str, request: Request):
    """Provider rejects/skips a booking request"""
    body = await request.json()
    reason = body.get("reason", "")
    booking = await db.web_bookings.find_one({"id": booking_id})
    if not booking:
        raise HTTPException(404, "Booking not found")
    # Don't change status, just mark as rejected by this provider
    await db.web_bookings.update_one(
        {"id": booking_id},
        {"$push": {"rejectedBy": {"reason": reason, "at": now_utc().isoformat()}}}
    )
    # Sprint 26: track reject
    try:
        from app.performance import record_rejected
        provider_slug = booking.get("providerSlug") or booking.get("organizationSlug") or "avtomaster-pro"
        await record_rejected(provider_slug)
    except Exception as e:
        logger.warning(f"performance hook (reject) failed: {e}")
    return {"status": "rejected", "bookingId": booking_id}


@router.get("/api/marketplace/provider/current-job")
async def provider_current_job(provider_slug: str = "avtomaster-pro"):
    """Get provider's current active job"""
    active_statuses = ["confirmed", "on_route", "arrived", "in_progress"]
    job = await db.web_bookings.find_one(
        {"status": {"$in": active_statuses}, "providerAccepted": True},
        {"_id": 0},
        sort=[("acceptedAt", -1)]
    )
    if not job:
        # Also check for recently completed
        job = await db.web_bookings.find_one(
            {"status": "completed", "providerAccepted": True},
            {"_id": 0},
            sort=[("acceptedAt", -1)]
        )
    if not job:
        return {"hasJob": False, "job": None}
    return {"hasJob": True, "job": job}


@router.post("/api/marketplace/provider/current-job/{booking_id}/action")
async def provider_job_action(booking_id: str, request: Request):
    """Provider performs action on current job (status transition)"""
    body = await request.json()
    action = body.get("action")
    action_map = {
        "depart": "on_route",
        "arrive": "arrived",
        "start": "in_progress",
        "complete": "completed",
    }
    # P0.b.B — observable action mapping to FSM (mirror of action_map keys).
    fsm_action_map = {
        "depart":   "mark_on_route",
        "arrive":   "mark_arrived",
        "start":    "mark_in_progress",
        "complete": "mark_completed",
    }
    new_status = action_map.get(action)
    if not new_status:
        raise HTTPException(400, f"Invalid action: {action}")
    booking = await db.web_bookings.find_one({"id": booking_id})
    if not booking:
        raise HTTPException(404, "Booking not found")
    history_entry = {"status": new_status, "at": now_utc().isoformat()}
    update_fields: dict = {"status": new_status}
    if new_status == "on_route":
        update_fields["eta"] = random.randint(5, 15)
        update_fields["departedAt"] = now_utc().isoformat()
    elif new_status == "arrived":
        update_fields["arrivedAt"] = now_utc().isoformat()
    elif new_status == "in_progress":
        update_fields["startedAt"] = now_utc().isoformat()
    elif new_status == "completed":
        update_fields["completedAt"] = now_utc().isoformat()
    await db.web_bookings.update_one(
        {"id": booking_id},
        {"$set": update_fields, "$push": {"statusHistory": history_entry}}
    )
    old_status = booking.get("status", "pending")
    # P0.b.B — sidecar timeline write AFTER existing mutation.
    try:
        await observe_transition(
            db,
            booking_id=booking_id,
            booking_scope="web_booking",
            action=fsm_action_map.get(action, f"mark_{new_status}"),
            from_status=old_status,
            to_status=new_status,
            actor_id=booking.get("providerSlug") or "unknown-provider",
            actor_role="provider",
            source=f"marketplace.provider.job_action.{action}",
            source_request_id=request.headers.get("x-request-id"),
            accepted=True,
            meta={"eta": update_fields.get("eta")},
        )
    except Exception:
        pass
    # Sprint 26: track completion
    if new_status == "completed":
        try:
            from app.performance import record_completed
            provider_slug = booking.get("providerSlug") or booking.get("organizationSlug") or "avtomaster-pro"
            await record_completed(provider_slug)
        except Exception as e:
            logger.warning(f"performance hook (complete) failed: {e}")
    await ctx.emit.booking_status(booking_id, old_status, new_status, {"eta": update_fields.get("eta")})
    return {"status": new_status, "bookingId": booking_id}


@router.get("/api/marketplace/provider/stats")
async def provider_stats():
    """Get provider dashboard stats"""
    total = await db.web_bookings.count_documents({})
    completed = await db.web_bookings.count_documents({"status": "completed"})
    cancelled = await db.web_bookings.count_documents({"status": "cancelled"})
    pending = await db.web_bookings.count_documents({"status": "pending"})
    active = await db.web_bookings.count_documents({"status": {"$in": ["confirmed", "on_route", "arrived", "in_progress"]}})
    earnings_docs = await db.web_bookings.find({"status": "completed"}, {"priceEstimate": 1}).to_list(100)
    total_earnings = sum(d.get("priceEstimate", 0) for d in earnings_docs)
    return {
        "today": {"requests": total, "accepted": completed + active, "missed": cancelled, "earnings": total_earnings},
        "performance": {"rating": 4.8, "responseTime": 3, "acceptanceRate": 72 if total > 0 else 0},
        "pressure": {"missedRequests": cancelled, "lostRevenue": cancelled * 600, "message": f"Вы пропустили {cancelled} заявок" if cancelled > 0 else ""},
    }


@router.patch("/api/marketplace/bookings/{booking_id}/status")
async def marketplace_update_booking_status(booking_id: str, request: Request):
    """Update booking status"""
    body = await request.json()
    new_status = body.get("status")
    if new_status not in ["pending", "confirmed", "on_route", "arrived", "in_progress", "completed", "cancelled"]:
        raise HTTPException(400, "Invalid status")
    booking_doc = await db.web_bookings.find_one({"id": booking_id})
    history_entry = {"status": new_status, "at": now_utc().isoformat()}
    await db.web_bookings.update_one(
        {"id": booking_id},
        {"$set": {"status": new_status}, "$push": {"statusHistory": history_entry}}
    )
    # Sprint 26: track cancel/complete via this PATCH endpoint as well
    if booking_doc and new_status in ("cancelled", "completed"):
        try:
            from app.performance import record_cancelled, record_completed
            provider_slug = booking_doc.get("providerSlug") or booking_doc.get("organizationSlug") or "avtomaster-pro"
            if new_status == "cancelled":
                await record_cancelled(provider_slug)
            else:
                await record_completed(provider_slug)
        except Exception as e:
            logger.warning(f"performance hook (status patch) failed: {e}")
    booking = await db.web_bookings.find_one({"id": booking_id}, {"_id": 0})
    return booking
