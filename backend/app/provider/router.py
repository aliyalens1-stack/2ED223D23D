"""app.provider.router — Sprint 21 C16 extraction from server.py.

Все endpoints /api/provider/* перенесены 1-в-1 (без изменения поведения).
Зависимости, которые раньше жили в server.py module scope, теперь берутся
из app.core.* (ctx, db, config, security).
"""
from __future__ import annotations
import random
import logging
import jwt
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Request, Response, HTTPException, Depends
from fastapi.responses import JSONResponse

from app.core.config import NESTJS_URL, JWT_SECRET, JWT_ALGO
from app.core.constants import PRE_ENGAGEMENT_BOOST, PRE_ENGAGEMENT_TTL_MIN
from app.core.context import ctx
from app.core.db import db
from app.core.geo import haversine, resolve_zone
from app.core.realtime import emit_realtime_event
from app.core.security import verify_admin_token
from app.core.utils import now_utc, uid


logger = logging.getLogger("server")

router = APIRouter()

# shim: старый код использует `http_client` как имя. Резолвим в runtime через ctx.
class _HttpClientProxy:
    def __getattr__(self, name):
        return getattr(ctx.http_client, name)

http_client = _HttpClientProxy()


# ── RETENTION: Tier System (moved from server.py C16) ──
TIER_THRESHOLDS = [
    {"tier": "bronze", "label": "Bronze", "emoji": "🥉", "minScore": 0, "priorityBoost": 0, "color": "#CD7F32"},
    {"tier": "silver", "label": "Silver", "emoji": "🥈", "minScore": 50, "priorityBoost": 0.05, "color": "#C0C0C0"},
    {"tier": "gold", "label": "Gold", "emoji": "🥇", "minScore": 100, "priorityBoost": 0.10, "color": "#FFD700"},
    {"tier": "platinum", "label": "Platinum", "emoji": "💎", "minScore": 200, "priorityBoost": 0.15, "color": "#E5E4E2"},
]




# ═══════════════════════════════════════════════
# 📊 PROVIDER PRESSURE & EARNINGS
# ═══════════════════════════════════════════════
@router.get("/api/provider/pressure-summary")
async def provider_pressure_summary(request: Request):
    """Get pressure summary for provider behavior management"""
    # Try to proxy to NestJS first
    try:
        headers = dict(request.headers)
        headers.pop('host', None)
        resp = await http_client.get(f"{NESTJS_URL}/api/provider/pressure-summary", headers=headers, timeout=3.0)
        if resp.status_code < 500:
            rh = dict(resp.headers)
            for k in ['content-length', 'content-encoding', 'transfer-encoding']:
                rh.pop(k, None)
            return Response(content=resp.content, status_code=resp.status_code, headers=rh, media_type='application/json')
    except Exception:
        pass

    # Fallback: generate pressure data from DB
    return {
        "score": random.randint(60, 95),
        "tier": random.choice(["Bronze", "Silver", "Gold", "Platinum"]),
        "today": {
            "accepted": random.randint(3, 12),
            "missed": random.randint(0, 5),
            "avgResponseSeconds": random.randint(30, 300),
            "earnings": random.randint(500, 5000),
        },
        "week": {
            "accepted": random.randint(20, 60),
            "missed": random.randint(2, 15),
            "totalEarnings": random.randint(5000, 30000),
            "surgeEarnings": random.randint(500, 5000),
        },
        "lostRevenue": random.randint(200, 3000),
        "tips": [
            "Отвечайте быстрее — получите больше заказов",
            "В вашем районе высокий спрос — оставайтесь онлайн",
            "Ваш рейтинг растёт — продолжайте в том же духе",
        ],
        "missedRequests": [
            {"service": "Замена масла", "price": random.randint(300, 800), "timeAgo": f"{random.randint(1, 30)} мин назад"},
            {"service": "Диагностика", "price": random.randint(500, 1500), "timeAgo": f"{random.randint(1, 60)} мин назад"},
            {"service": "Тормоза", "price": random.randint(400, 1200), "timeAgo": f"{random.randint(1, 120)} мин назад"},
        ],
    }





@router.get("/api/provider/earnings")
async def provider_earnings(request: Request):
    """Get provider earnings summary"""
    try:
        headers = dict(request.headers)
        headers.pop('host', None)
        resp = await http_client.get(f"{NESTJS_URL}/api/provider/earnings", headers=headers, timeout=3.0)
        if 200 <= resp.status_code < 300:
            rh = dict(resp.headers)
            for k in ['content-length', 'content-encoding', 'transfer-encoding']:
                rh.pop(k, None)
            return Response(content=resp.content, status_code=resp.status_code, headers=rh, media_type='application/json')
    except Exception:
        pass

    # Fallback: return mock earnings data
    return {
        "today": {"total": random.randint(500, 3000), "orders": random.randint(2, 8), "surge": random.randint(0, 500)},
        "week": {"total": random.randint(5000, 20000), "orders": random.randint(15, 50), "surge": random.randint(500, 3000)},
        "month": {"total": random.randint(20000, 80000), "orders": random.randint(60, 200), "surge": random.randint(2000, 10000)},
        "bonuses": [
            {"name": "Быстрый ответ", "amount": 200, "earned": True},
            {"name": "5 заказов подряд", "amount": 500, "earned": False},
            {"name": "Пиковые часы", "amount": 300, "earned": True},
        ],
    }





# ── PRESSURE UX ──
@router.get("/api/provider/pressure")
async def get_provider_pressure(provider_slug: str = "avtomaster-pro"):
    """Get pressure data for provider — missed requests, lost revenue, rank"""
    org = await db.organizations.find_one({"slug": provider_slug}, {"_id": 0})
    if not org:
        raise HTTPException(404, "Provider not found")
    
    has_priority = org.get("hasPriorityAccess", False)
    has_promoted = org.get("isPromoted", False)
    
    # Calculate pressure metrics
    total_requests_today = random.randint(15, 45)
    missed = random.randint(2, 8) if not has_priority else random.randint(0, 2)
    avg_price = random.randint(300, 800)
    lost_revenue = missed * avg_price
    rank_in_zone = random.randint(1, 3) if has_promoted else random.randint(4, 8)
    total_in_zone = 8
    
    # Comparison data
    priority_providers_bookings = random.randint(8, 18)
    normal_providers_bookings = random.randint(3, 8)
    boost_percent = round((priority_providers_bookings / max(normal_providers_bookings, 1) - 1) * 100)
    
    return {
        "missedRequests": missed,
        "lostRevenueEstimate": lost_revenue,
        "totalRequestsToday": total_requests_today,
        "avgRequestPrice": avg_price,
        "rankInZone": rank_in_zone,
        "totalInZone": total_in_zone,
        "hasPriority": has_priority,
        "hasPromoted": has_promoted,
        "comparison": {
            "priorityBookingsAvg": priority_providers_bookings,
            "normalBookingsAvg": normal_providers_bookings,
            "boostPercent": boost_percent,
            "message": f"Мастера с Priority получают на {boost_percent}% больше заказов" if not has_priority else "Вы уже в Priority — отлично!"
        },
        "upsells": [] if (has_priority and has_promoted) else [
            {"type": "priority", "title": "Получать заявки первым", "subtitle": f"Вы пропустили {missed} заявок сегодня", "cta": "Включить Priority", "productCode": "priority_7d", "price": 699} if not has_priority else None,
            {"type": "promoted", "title": "Подняться в выдаче", "subtitle": f"Вы #{rank_in_zone} из {total_in_zone} в зоне", "cta": "Включить Promoted", "productCode": "promoted_7d", "price": 499} if not has_promoted else None,
        ],
    }




@router.get("/api/provider/tier")
async def get_provider_tier(provider_slug: str = "avtomaster-pro"):
    """Get provider loyalty tier and progress"""
    org = await db.organizations.find_one({"slug": provider_slug}, {"_id": 0})
    if not org:
        raise HTTPException(404, "Provider not found")
    
    rating = org.get("ratingAvg", 4.0)
    bookings = org.get("completedBookingsCount", 0)
    resp_time = org.get("avgResponseTimeMinutes", 15)
    
    score = int(bookings * 0.3 + rating * 20 + max(0, (30 - resp_time)) * 2)
    
    current_tier = TIER_THRESHOLDS[0]
    next_tier = TIER_THRESHOLDS[1] if len(TIER_THRESHOLDS) > 1 else None
    for i, t in enumerate(TIER_THRESHOLDS):
        if score >= t["minScore"]:
            current_tier = t
            next_tier = TIER_THRESHOLDS[i + 1] if i + 1 < len(TIER_THRESHOLDS) else None
    
    progress = 0
    if next_tier:
        range_size = next_tier["minScore"] - current_tier["minScore"]
        progress = min(100, round((score - current_tier["minScore"]) / max(range_size, 1) * 100))
    
    benefits = []
    if current_tier["tier"] == "gold":
        benefits = ["Приоритетный буст +10%", "+28% больше заказов", "Бейдж Gold в профиле"]
    elif current_tier["tier"] == "platinum":
        benefits = ["Авто-Priority доступ", "+45% больше заказов", "Бейдж Platinum", "Приоритетная поддержка"]
    elif current_tier["tier"] == "silver":
        benefits = ["Приоритетный буст +5%", "+15% больше заказов"]
    else:
        benefits = ["Базовый доступ к заявкам"]
    
    return {
        "score": score, "tier": current_tier, "nextTier": next_tier, "progress": progress,
        "benefits": benefits,
        "stats": {"rating": rating, "completedBookings": bookings, "avgResponseTime": resp_time},
        "message": f"Вы {current_tier['emoji']} {current_tier['label']} мастер" + (f" — до {next_tier['label']} осталось {next_tier['minScore'] - score} очков" if next_tier else " — максимальный уровень!"),
    }






# ═══════════════════════════════════════════════
# 🧩 SYSTEM DEPTH: Availability + Performance + Skills + Matching V2
# ═══════════════════════════════════════════════

# Sprint 21 C10: PROBLEM_SKILL_MAP вынесен в app/marketplace/matching.py
# (единственный consumer — zone_aware_matching, он же теперь там живёт).

@router.get("/api/provider/availability")
async def get_provider_availability(provider_slug: str = "avtomaster-pro"):
    avail = await db.provider_availability.find_one({"providerSlug": provider_slug}, {"_id": 0})
    if not avail:
        return {"providerSlug": provider_slug, "weeklySchedule": [], "exceptions": [], "isOnline": False}
    return avail



@router.post("/api/provider/availability")
async def update_provider_availability(request: Request):
    body = await request.json()
    slug = body.get("providerSlug", "avtomaster-pro")
    await db.provider_availability.update_one(
        {"providerSlug": slug},
        {"$set": {"weeklySchedule": body.get("weeklySchedule", []), "exceptions": body.get("exceptions", []), "isOnline": body.get("isOnline", True), "updatedAt": now_utc().isoformat()}},
        upsert=True
    )
    if "isOnline" in body:
        await db.organizations.update_one({"slug": slug}, {"$set": {"isOnline": body["isOnline"]}})
    return {"status": "updated", "providerSlug": slug}



@router.post("/api/provider/availability/override")
async def provider_availability_override(request: Request):
    body = await request.json()
    slug = body.get("providerSlug", "avtomaster-pro")
    exception = {"date": body.get("date"), "isAvailable": body.get("isAvailable", False), "slots": body.get("slots", []), "reason": body.get("reason", "")}
    await db.provider_availability.update_one({"providerSlug": slug}, {"$push": {"exceptions": exception}}, upsert=True)
    return {"status": "exception_added", "providerSlug": slug, "exception": exception}





# ═══════════════════════════════════════════════════════════════════════
# 🔥 SPRINT 18: Pre-Engagement endpoints + 🧠 SPRINT 19: Forecast status
# ═══════════════════════════════════════════════════════════════════════

@router.get("/api/provider/pre-engagement/{slug}")
async def get_provider_pre_engagement(slug: str):
    """
    Список активных pre-engagement событий для зон, в которых работает
    провайдер. Реалтайм идёт через socket `provider:pre_engage`, этот эндпоинт —
    fallback (после рефреша / на холодном старте).
    """
    org = await db.organizations.find_one({"slug": slug}, {"_id": 0, "zoneId": 1, "location": 1})
    if not org:
        return {"events": [], "providerSlug": slug, "zoneId": None}

    zone_id = org.get("zoneId")
    # Если у организации нет zoneId — резолвим по координатам
    if not zone_id and org.get("location", {}).get("coordinates"):
        coords = org["location"]["coordinates"]   # [lng, lat]
        zone = await db.zones.find_one(
            {"polygon": {"$geoIntersects": {"$geometry": {"type": "Point", "coordinates": coords}}}},
            {"_id": 0, "id": 1},
        )
        if zone:
            zone_id = zone.get("id")

    if not zone_id:
        return {"events": [], "providerSlug": slug, "zoneId": None}

    now_iso = now_utc().isoformat()
    events = await db.pre_engagement_events.find(
        {"zoneId": zone_id, "expiresAt": {"$gt": now_utc()}},
        {"_id": 0},
    ).sort("createdAt", -1).limit(5).to_list(5)

    # Конвертим datetime -> ISO для JSON
    for e in events:
        if isinstance(e.get("expiresAt"), datetime):
            e["expiresAt"] = e["expiresAt"].isoformat()

    return {"events": events, "providerSlug": slug, "zoneId": zone_id, "fetchedAt": now_iso}





@router.post("/api/provider/pre-engage")
async def provider_pre_engage(request: Request):
    """
    Провайдер нажал "Go online now" в карточке pre-engagement.
    Поднимаем isOnline=True и ставим preEngagedAt=now (даёт ranking boost +10%
    в течение 15 минут — см. /matching/nearby).
    """
    body = await request.json()
    slug = body.get("providerSlug")
    event_id = body.get("eventId")  # опционально — для аналитики

    if not slug:
        raise HTTPException(status_code=400, detail="providerSlug required")

    org = await db.organizations.find_one({"slug": slug}, {"_id": 0, "name": 1})
    if not org:
        raise HTTPException(status_code=404, detail="provider not found")

    now = now_utc()
    pre_engaged_until = now + timedelta(minutes=PRE_ENGAGEMENT_TTL_MIN)

    await db.organizations.update_one(
        {"slug": slug},
        {"$set": {
            "isOnline": True,
            "preEngagedAt": now.isoformat(),
            "preEngagedUntil": pre_engaged_until.isoformat(),
            "preEngagedFromEventId": event_id,
            "updatedAt": now.isoformat(),
        }},
    )
    await db.provider_availability.update_one(
        {"providerSlug": slug},
        {"$set": {"isOnline": True, "preEngagedAt": now.isoformat(), "updatedAt": now.isoformat()}},
        upsert=True,
    )

    # Аудит
    await db.pre_engagement_acceptances.insert_one({
        "id": uid(),
        "providerSlug": slug,
        "eventId": event_id,
        "acceptedAt": now.isoformat(),
    })

    logger.info(f"PRE-ENGAGEMENT accepted: provider={slug} event={event_id}")

    return {
        "status": "online",
        "providerSlug": slug,
        "preEngagedAt": now.isoformat(),
        "preEngagedUntil": pre_engaged_until.isoformat(),
        "rankingBoost": PRE_ENGAGEMENT_BOOST,
    }





@router.get("/api/provider/performance")
async def get_provider_performance(provider_slug: str = "avtomaster-pro"):
    perf = await db.provider_performance.find_one({"providerSlug": provider_slug}, {"_id": 0})
    if not perf:
        return {"providerSlug": provider_slug, "acceptanceRate": 0, "completionRate": 0, "qualityScore": 0}
    return perf



@router.get("/api/provider/skills")
async def get_provider_skills(provider_slug: str = "avtomaster-pro"):
    skills = await db.provider_skills.find({"providerSlug": provider_slug}, {"_id": 0}).to_list(20)
    return {"providerSlug": provider_slug, "skills": skills}



@router.post("/api/provider/skills")
async def update_provider_skills(request: Request):
    body = await request.json()
    slug = body.get("providerSlug", "avtomaster-pro")
    cat = body.get("category")
    await db.provider_skills.update_one(
        {"providerSlug": slug, "category": cat},
        {"$set": {"level": body.get("level", 3), "verified": body.get("verified", False), "updatedAt": now_utc().isoformat()}},
        upsert=True
    )
    return {"status": "updated", "providerSlug": slug, "category": cat}



# Sprint 21 C12B: /api/admin/matching/weights вынесено в app/admin/controls.py

# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)


# ═══════════════════════════════════════════════
# 📍 PHASE B: PROVIDER LOCATION TRACKING
# ═══════════════════════════════════════════════

@router.post("/api/provider/location/update")
async def update_provider_location(request: Request):
    """Update provider's live GPS location"""
    body = await request.json()
    provider_id = body.get("providerId")
    lat = body.get("lat")
    lng = body.get("lng")
    heading = body.get("heading", 0)
    speed = body.get("speed", 0)
    is_online = body.get("isOnline", True)
    
    if not provider_id or lat is None or lng is None:
        raise HTTPException(400, "providerId, lat, lng required")
    
    zone_id = resolve_zone(lat, lng)
    
    await db.provider_locations.update_one(
        {"providerId": provider_id},
        {"$set": {
            "providerId": provider_id,
            "location": {"type": "Point", "coordinates": [lng, lat]},
            "zoneId": zone_id,
            "isOnline": is_online,
            "heading": heading,
            "speed": speed,
            "updatedAt": now_utc().isoformat(),
        }},
        upsert=True
    )
    
    # Sync online status to organization
    await db.organizations.update_one({"slug": provider_id}, {"$set": {"isOnline": is_online}})
    
    # Emit realtime
    await emit_realtime_event("provider:location", {
        "providerId": provider_id, "lat": lat, "lng": lng,
        "zoneId": zone_id, "heading": heading, "speed": speed,
    })
    
    return {"status": "updated", "providerId": provider_id, "zoneId": zone_id}





@router.get("/api/provider/locations/nearby")
async def get_nearby_provider_locations(lat: float = 50.4501, lng: float = 30.5234, radius: float = 5, onlineOnly: bool = True):
    """Get nearby provider locations using 2dsphere index"""
    query = {
        "location": {
            "$near": {
                "$geometry": {"type": "Point", "coordinates": [lng, lat]},
                "$maxDistance": radius * 1000
            }
        }
    }
    if onlineOnly:
        query["isOnline"] = True
    
    providers = await db.provider_locations.find(query, {"_id": 0}).to_list(50)
    for p in providers:
        coords = p.get("location", {}).get("coordinates", [lng, lat])
        p["distance"] = round(haversine(lat, lng, coords[1], coords[0]), 1)
        p["eta"] = max(3, int(p["distance"] * 4))
    
    return {"providers": providers, "total": len(providers), "center": {"lat": lat, "lng": lng}, "radiusKm": radius}





@router.get("/api/provider/locations/zone/{zone_id}")
async def get_zone_provider_locations(zone_id: str, onlineOnly: bool = True):
    """Get all provider locations in a zone"""
    query = {"zoneId": zone_id}
    if onlineOnly:
        query["isOnline"] = True
    providers = await db.provider_locations.find(query, {"_id": 0}).to_list(50)
    return {"providers": providers, "total": len(providers), "zoneId": zone_id}





@router.post("/api/provider/presence")
async def update_provider_presence(request: Request):
    """Update provider online/offline status"""
    body = await request.json()
    provider_id = body.get("providerId")
    is_online = body.get("isOnline", False)
    lat = body.get("lat")
    lng = body.get("lng")
    
    if not provider_id:
        raise HTTPException(400, "providerId required")
    
    update = {"isOnline": is_online, "updatedAt": now_utc().isoformat()}
    if lat is not None and lng is not None:
        update["location"] = {"type": "Point", "coordinates": [lng, lat]}
        update["zoneId"] = resolve_zone(lat, lng)
    
    await db.provider_locations.update_one({"providerId": provider_id}, {"$set": update}, upsert=True)
    await db.organizations.update_one({"slug": provider_id}, {"$set": {"isOnline": is_online}})
    
    await emit_realtime_event("provider:presence", {"providerId": provider_id, "isOnline": is_online})
    
    return {"status": "updated", "providerId": provider_id, "isOnline": is_online}


# ═══════════════════════════════════════════════════════════════
# Online/Offline toggle for Provider Hub header
# ═══════════════════════════════════════════════════════════════
@router.post("/api/provider/status")
async def set_provider_status(request: Request):
    """Toggle provider online/offline for quick-request distribution.

    Body: {"providerSlug": "avtomaster-pro", "isOnline": true|false}

    Side-effects:
      • organizations.isOnline = isOnline
      • organizations.lastOnlineAt / lastOfflineAt updated
      • provider_availability.isOnline = isOnline (для матчинга)
      • emit provider:presence event
    """
    body = await request.json()
    slug = body.get("providerSlug") or body.get("providerId")
    is_online = bool(body.get("isOnline", False))
    if not slug:
        raise HTTPException(400, "providerSlug required")

    now_iso = now_utc().isoformat()
    org_update = {"isOnline": is_online, "updatedAt": now_iso}
    if is_online:
        org_update["lastOnlineAt"] = now_iso
    else:
        org_update["lastOfflineAt"] = now_iso

    res = await db.organizations.update_one({"slug": slug}, {"$set": org_update})
    if res.matched_count == 0:
        raise HTTPException(404, "provider not found")

    # Sync availability collection — quick-request tier matching tоже смотрит сюда
    await db.provider_availability.update_one(
        {"providerSlug": slug},
        {"$set": {"isOnline": is_online, "updatedAt": now_iso}},
        upsert=True,
    )

    await emit_realtime_event(
        "provider:presence",
        {"providerId": slug, "providerSlug": slug, "isOnline": is_online},
    )

    return {
        "status": "ok",
        "providerSlug": slug,
        "isOnline": is_online,
        "lastOnlineAt": org_update.get("lastOnlineAt"),
        "lastOfflineAt": org_update.get("lastOfflineAt"),
    }


@router.get("/api/provider/status")
async def get_provider_status(providerSlug: str):
    """Read current online/offline state. Used by Provider Hub on mount to
    hydrate the toggle (isOnline persists across reload)."""
    if not providerSlug:
        raise HTTPException(400, "providerSlug required")
    org = await db.organizations.find_one(
        {"slug": providerSlug},
        {"_id": 0, "slug": 1, "isOnline": 1, "lastOnlineAt": 1, "lastOfflineAt": 1, "updatedAt": 1},
    )
    if not org:
        raise HTTPException(404, "provider not found")
    return {
        "providerSlug": org["slug"],
        "isOnline": bool(org.get("isOnline", False)),
        "lastOnlineAt": org.get("lastOnlineAt"),
        "lastOfflineAt": org.get("lastOfflineAt"),
        "updatedAt": org.get("updatedAt"),
    }


# ═══════════════════════════════════════════════════════════════
# 🔥 INBOX PRO — provider operational center
# ═══════════════════════════════════════════════════════════════
NEW_STATUSES        = ["confirmed"]
ACTIVE_STATUSES     = ["on_route", "arrived", "in_progress"]
COMPLETED_STATUSES  = ["completed"]


def _serialize_booking(b: dict) -> dict:
    """Pick UI-friendly fields from a booking doc, drop ObjectId leftovers."""
    return {
        "id":            b.get("id") or b.get("bookingId"),
        "bookingNumber": b.get("bookingNumber"),
        "status":        b.get("status"),
        "problemLabel":  b.get("serviceName") or b.get("problemLabel"),
        "problemText":   b.get("problemText") or b.get("description"),
        "priceEstimate": b.get("priceEstimate") or b.get("finalPrice") or b.get("basePrice"),
        "finalPrice":    b.get("finalPrice"),
        "etaMinutes":    b.get("etaMinutes"),
        "distanceKm":    b.get("distanceKm"),
        "address":       b.get("address"),
        "surge":         b.get("surge"),
        "surgeLabel":    b.get("surgeLabel"),
        "createdAt":     b.get("createdAt"),
        "acceptedAt":    b.get("acceptedAt"),
        "startedAt":     b.get("startedAt"),
        "completedAt":   b.get("completedAt"),
        "quickRequestId": b.get("quickRequestId"),
    }


@router.get("/api/provider/inbox")
async def provider_inbox(providerSlug: str, limit: int = 20):
    """Inbox PRO: 3 buckets — new / active / completed — for the given provider.
    Source: db.bookings (created by quick-request accept flow).
    """
    if not providerSlug:
        raise HTTPException(400, "providerSlug required")

    base_query = {"providerSlug": providerSlug}

    new_docs = await db.bookings.find(
        {**base_query, "status": {"$in": NEW_STATUSES}},
        {"_id": 0},
    ).sort("acceptedAt", -1).limit(limit).to_list(limit)

    active_docs = await db.bookings.find(
        {**base_query, "status": {"$in": ACTIVE_STATUSES}},
        {"_id": 0},
    ).sort("acceptedAt", -1).limit(limit).to_list(limit)

    completed_docs = await db.bookings.find(
        {**base_query, "status": {"$in": COMPLETED_STATUSES}},
        {"_id": 0},
    ).sort("completedAt", -1).limit(limit).to_list(limit)

    earned = sum(int(d.get("finalPrice") or d.get("priceEstimate") or 0) for d in completed_docs)

    return {
        "providerSlug": providerSlug,
        "counts": {
            "new":       len(new_docs),
            "active":    len(active_docs),
            "completed": len(completed_docs),
        },
        "earnedFromCompleted": earned,
        "new":       [_serialize_booking(b) for b in new_docs],
        "active":    [_serialize_booking(b) for b in active_docs],
        "completed": [_serialize_booking(b) for b in completed_docs],
    }


@router.post("/api/provider/booking/{booking_id}/action")
async def provider_booking_action(booking_id: str, request: Request):
    """HTTP wrapper around `apply_booking_transition`.

    Sprint: Provider Dispatch Hardening + Action Idempotency.

    Parses auth + body + Idempotency-Key header, then delegates. The pure
    transition core is exposed as `apply_booking_transition` so internal
    callers (notably `work_items.dispatch_action`) can re-use it without
    HTTP indirection.
    """
    # ─── AUTH ─────────────────────────────────────────────────────
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "Unauthorized")
    try:
        payload = jwt.decode(auth[7:], JWT_SECRET, algorithms=[JWT_ALGO])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")
    caller_user_id = payload.get("sub")
    if not caller_user_id:
        raise HTTPException(401, "Invalid token (no sub)")

    try:
        body = await request.json()
    except Exception:
        body = {}
    action = (body.get("action") or "").strip()

    idem_key = (request.headers.get("idempotency-key") or "").strip() or None

    return await apply_booking_transition(
        booking_id=booking_id,
        action=action,
        caller_user_id=caller_user_id,
        idem_key=idem_key,
        idem_scope="provider_booking_action",
    )


# ─── Transition state machine (single source of truth) ──────────────
_BOOKING_ACTION_MAP = {
    "depart":   "on_route",
    "arrive":   "arrived",
    "start":    "in_progress",
    "complete": "completed",
}
# Allowed predecessor states per target. `confirmed` and `accepted` are
# treated as equivalent entry states (legacy seed uses one, marketplace
# flow the other).
_ALLOWED_FROM_BY_TARGET = {
    "on_route":    ("confirmed", "accepted"),
    "arrived":     ("confirmed", "accepted", "on_route"),
    "in_progress": ("confirmed", "accepted", "on_route", "arrived"),
    "completed":   ("in_progress",),
}


async def apply_booking_transition(
    *,
    booking_id: str,
    action: str,
    caller_user_id: str,
    idem_key: Optional[str] = None,
    idem_scope: str = "provider_booking_action",
) -> dict:
    """Apply a status transition to a booking with full hardening.

    Hardening contract:
      - **Ownership**: `booking.providerSlug` MUST match an organization
        owned (or managed) by `caller_user_id`. Otherwise 403.
      - **Atomic transition guard**: `find_one_and_update` filters on the
        current status — two concurrent callers cannot both succeed.
      - **Diagnostics**:
            400 — unknown action verb / malformed body
            403 — booking exists but caller is not its provider
            404 — booking does not exist
            409 — invalid state transition (incl. losing the race)
      - **Same-state replay** is observationally silent: idempotent return
        without re-firing realtime, performance, referral or push hooks.
      - **Idempotency-Key** (optional): (key, scope) → cached envelope.
        Same key with a different (user, booking, action) tuple → 409.
    """
    new_status = _BOOKING_ACTION_MAP.get(action)
    if not new_status:
        raise HTTPException(400, f"Invalid action: {action!r}")
    allowed_from = _ALLOWED_FROM_BY_TARGET[new_status]

    # ─── IDEMPOTENCY-KEY (early cache hit) ────────────────────────
    if idem_key:
        cached = await db.idempotency_keys.find_one(
            {"key": idem_key, "scope": idem_scope},
            {"_id": 0, "response": 1, "userId": 1, "bookingId": 1, "action": 1},
        )
        if cached:
            if (
                cached.get("userId") != caller_user_id
                or cached.get("bookingId") != booking_id
                or cached.get("action") != action
            ):
                raise HTTPException(409, "Idempotency-Key reuse mismatch")
            return cached["response"]

    # ─── OWNERSHIP ────────────────────────────────────────────────
    booking = await db.bookings.find_one({"id": booking_id}, {"_id": 0})
    if not booking:
        raise HTTPException(404, "Booking not found")

    booking_slug = (booking.get("providerSlug") or "").strip()
    if not booking_slug:
        raise HTTPException(409, "Booking has no provider assigned")

    owned_slugs = await _resolve_caller_provider_slugs(caller_user_id)
    if booking_slug not in owned_slugs:
        # Don't leak whether the booking exists vs. doesn't belong: 403 in both.
        raise HTTPException(403, "Not your booking")

    current_status = (booking.get("status") or "").strip()

    # ─── SAME-STATE REPLAY (observationally silent) ───────────────
    if current_status == new_status:
        envelope = {
            "ok": True,
            "bookingId": booking_id,
            "from": current_status,
            "to": new_status,
            "earnedNow": 0,
            "replayed": True,
        }
        await _store_idempotency(idem_key, idem_scope, caller_user_id, booking_id, action, envelope)
        return envelope

    # ─── INVALID TRANSITION ───────────────────────────────────────
    if current_status not in allowed_from:
        raise HTTPException(
            409,
            f"Invalid transition: {current_status!r} → {new_status!r} "
            f"(allowed from: {sorted(allowed_from)})",
        )

    # ─── ATOMIC TRANSITION ────────────────────────────────────────
    now_iso = now_utc().isoformat()
    update_fields: dict = {"status": new_status, "updatedAt": now_iso}
    if new_status == "on_route":
        update_fields["departedAt"] = now_iso
    elif new_status == "arrived":
        update_fields["arrivedAt"] = now_iso
    elif new_status == "in_progress":
        update_fields["startedAt"] = now_iso
    elif new_status == "completed":
        update_fields["completedAt"] = now_iso
    history_entry = {"status": new_status, "at": now_iso}

    updated = await db.bookings.find_one_and_update(
        {
            "id": booking_id,
            "providerSlug": booking_slug,
            "status": {"$in": list(allowed_from)},
        },
        {"$set": update_fields, "$push": {"statusHistory": history_entry}},
        projection={"_id": 0},
        return_document=True,  # AFTER
    )
    if updated is None:
        fresh = await db.bookings.find_one(
            {"id": booking_id, "providerSlug": booking_slug},
            {"_id": 0, "status": 1},
        )
        fresh_status = (fresh or {}).get("status", "") if fresh else ""
        if fresh_status == new_status:
            envelope = {
                "ok": True,
                "bookingId": booking_id,
                "from": new_status,
                "to": new_status,
                "earnedNow": 0,
                "replayed": True,
            }
            await _store_idempotency(idem_key, idem_scope, caller_user_id, booking_id, action, envelope)
            return envelope
        raise HTTPException(
            409,
            f"Concurrent state change: now {fresh_status!r}, expected one of {sorted(allowed_from)}",
        )

    old_status = current_status

    # ─── SIDE EFFECTS — ONLY ON REAL TRANSITION ───────────────────
    earned_now = 0
    if new_status == "completed":
        earned_now = int(booking.get("finalPrice") or booking.get("priceEstimate") or 0)
        try:
            from app.performance import record_completed
            await record_completed(booking_slug)
        except Exception as e:
            logger.warning(f"performance hook (complete) failed: {e}")

        try:
            from app.referrals import complete_customer_referral, complete_provider_referral
            customer_user_id = booking.get("customerUserId") or booking.get("userId")
            if customer_user_id:
                prior_completes = await db.bookings.count_documents({
                    "$or": [{"customerUserId": customer_user_id}, {"userId": customer_user_id}],
                    "status": "completed",
                    "id": {"$ne": booking_id},
                })
                if prior_completes == 0:
                    await complete_customer_referral(customer_user_id)
            await complete_provider_referral(booking_slug)
        except Exception as e:
            logger.warning(f"referral hook failed: {e}")

    await emit_realtime_event("booking:status_changed", {
        "bookingId": booking_id, "from": old_status, "to": new_status,
    })
    await emit_realtime_event("provider:job_updated", {
        "bookingId": booking_id, "providerSlug": booking_slug,
        "from": old_status, "to": new_status,
    })

    try:
        from app.push import notify_customer_booking_status, notify_earnings_delta
        from app.retention import _compute_earnings_trend
        import asyncio as _asyncio
        customer_uid = booking.get("customerUserId") or booking.get("userId")
        if customer_uid and new_status in {"accepted", "confirmed", "en_route", "in_progress", "completed", "cancelled"}:
            _asyncio.create_task(notify_customer_booking_status(
                user_id=str(customer_uid), booking_id=booking_id, new_status=new_status,
            ))
        if new_status == "completed" and earned_now > 0:
            async def _dopamine():
                trend = await _compute_earnings_trend(booking_slug)
                await notify_earnings_delta(
                    provider_slug=booking_slug,
                    amount=earned_now,
                    today_total=int(trend.get("today", 0)),
                    trend_str=trend.get("trend") or "",
                )
            _asyncio.create_task(_dopamine())
    except Exception as _e:
        logger.warning(f"push hooks failed: {_e}")

    envelope = {
        "ok": True,
        "bookingId": booking_id,
        "from": old_status,
        "to": new_status,
        "earnedNow": earned_now,
        "replayed": False,
    }
    await _store_idempotency(idem_key, idem_scope, caller_user_id, booking_id, action, envelope)
    return envelope


async def _resolve_caller_provider_slugs(user_id: str) -> set[str]:
    """Return the set of organization slugs the caller can act as.

    Two ownership rails: `organizations.ownerId == user_id` and
    `organizations.managerIds` containing `user_id`. Admins do NOT silently
    inherit provider rights here — admin booking actions belong to a
    different endpoint with explicit `actorType=admin` semantics.
    """
    slugs: set[str] = set()
    cursor = db.organizations.find(
        {"$or": [{"ownerId": user_id}, {"managerIds": user_id}]},
        {"_id": 0, "slug": 1},
    )
    async for org in cursor:
        slug = (org.get("slug") or "").strip()
        if slug:
            slugs.add(slug)
    return slugs


async def _store_idempotency(
    key: Optional[str],
    scope: str,
    user_id: str,
    booking_id: str,
    action: str,
    response: dict,
) -> None:
    """Best-effort cache write. A failure here MUST NOT crash the request:
    the real state mutation already happened and the client got its 2xx;
    a cache miss on retry is graceful degradation, not data loss.
    """
    if not key:
        return
    try:
        await db.idempotency_keys.update_one(
            {"key": key, "scope": scope},
            {"$setOnInsert": {
                "key": key,
                "scope": scope,
                "userId": user_id,
                "bookingId": booking_id,
                "action": action,
                "response": response,
                "createdAt": now_utc(),
            }},
            upsert=True,
        )
    except Exception as e:
        logger.warning(f"idempotency cache write failed: {e}")


# ═══════════════════════════════════════════════════════════════
# 🔥 PHASE D: PROVIDER INTELLIGENCE ENGINE
# ═══════════════════════════════════════════════════════════════

@router.get("/api/provider/intelligence")
async def get_provider_intelligence(request: Request):
    """Full provider intelligence summary"""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "Unauthorized")
    try:
        payload = jwt.decode(auth[7:], JWT_SECRET, algorithms=["HS256"])
        uid_val = payload.get("sub")
    except Exception:
        raise HTTPException(401, "Invalid token")
    
    user = await db.users.find_one({"_id": __import__('bson').ObjectId(uid_val)}, {"_id": 0, "email": 1, "role": 1})
    
    # Find org owned by this user or use first active
    org = await db.organizations.find_one({"ownerId": uid_val, "status": "active"}, {"_id": 0})
    if not org:
        org = await db.organizations.find_one({"status": "active"}, {"_id": 0})
    
    slug = org.get("slug", "avtomaster-pro") if org else "avtomaster-pro"
    
    # Performance data
    perf = await db.provider_performance.find_one({"providerSlug": slug}, {"_id": 0}) or {}
    skills = await db.provider_skills.find({"providerSlug": slug}, {"_id": 0}).to_list(10)
    avail = await db.provider_availability.find_one({"providerSlug": slug}, {"_id": 0}) or {}
    
    # Calculate scores
    accept_rate = perf.get("acceptanceRate", 75)
    completion_rate = perf.get("completionRate", 85)
    response_time = perf.get("avgResponseTime", 15)
    quality = perf.get("qualityScore", 70)
    cancel_rate = perf.get("cancelRate", 5)
    repeat_rate = perf.get("repeatCustomerRate", 20)
    total_jobs = perf.get("totalJobs", 50)
    
    speed_score = round(max(0, min(100, (1 - response_time / 120) * 100)), 1)
    perf_score = round(accept_rate * 0.25 + completion_rate * 0.25 + speed_score * 0.20 + quality * 0.20 + repeat_rate * 0.10, 1)
    trust_score = round(quality * 0.5 + completion_rate * 0.3 + (100 - cancel_rate) * 0.2, 1)
    
    rating = org.get("ratingAvg", 4.5) if org else 4.5
    
    # Tier
    if perf_score >= 85: tier = "platinum"
    elif perf_score >= 70: tier = "gold"
    elif perf_score >= 50: tier = "silver"
    else: tier = "bronze"
    
    # Lost revenue estimate
    missed = random.randint(2, 8)
    avg_request_val = org.get("priceFrom", 500) if org else 500
    lost_revenue = missed * avg_request_val
    
    # Strongest/weakest skills
    strong = [s["category"] for s in skills if s.get("level", 0) >= 4]
    weak = [s["category"] for s in skills if s.get("level", 0) <= 2]
    
    profile = {
        "providerId": slug,
        "providerName": org.get("name", slug) if org else slug,
        "performanceScore": perf_score,
        "trustScore": trust_score,
        "speedScore": speed_score,
        "qualityScore": quality,
        "monetizationScore": round(random.uniform(40, 90), 1),
        "avgResponseTime": response_time,
        "acceptanceRate": accept_rate,
        "completionRate": completion_rate,
        "cancelRate": cancel_rate,
        "repeatCustomerRate": repeat_rate,
        "totalJobs": total_jobs,
        "totalRevenue": total_jobs * avg_request_val,
        "lostRevenueEstimate": lost_revenue,
        "strongestSkills": strong,
        "weakestSkills": weak,
        "currentTier": tier,
        "rating": rating,
        "reviewsCount": org.get("reviewsCount", 0) if org else 0,
        "visibilityState": org.get("visibilityState", "normal") if org else "normal",
        "isOnline": org.get("isOnline", False) if org else False,
    }
    
    # Pressure
    zone_loc = await db.provider_locations.find_one({"providerId": slug}, {"_id": 0})
    zone_id = zone_loc.get("zoneId", "kyiv-center") if zone_loc else "kyiv-center"
    zone = await db.zones.find_one({"id": zone_id}, {"_id": 0})
    
    pressure = {
        "missedRequests": missed,
        "lostRevenueEstimate": lost_revenue,
        "avgAcceptDelaySeconds": response_time * 60,
        "rankInZone": random.randint(1, 8),
        "providersAhead": random.randint(0, 5),
        "zoneStatus": zone.get("status", "BALANCED") if zone else "BALANCED",
        "zoneSurge": zone.get("surgeMultiplier", 1) if zone else 1,
    }
    
    # Opportunities
    opportunities = []
    if zone and zone.get("status") in ("SURGE", "CRITICAL"):
        opportunities.append({
            "type": "high_demand_now", "priority": 95,
            "title": f"🔥 {zone.get('name', 'Зона')}: высокий спрос",
            "subtitle": f"Ratio {zone.get('ratio', '?')} • Surge x{zone.get('surgeMultiplier', 1)}",
            "actionText": "Выйти онлайн",
        })
    
    if not org or not org.get("isOnline"):
        opportunities.append({
            "type": "go_online", "priority": 90,
            "title": "Выйдите онлайн",
            "subtitle": "Сейчас есть заявки в вашем районе",
            "actionText": "Включить",
        })
    
    if accept_rate < 70:
        opportunities.append({
            "type": "improve_acceptance", "priority": 70,
            "title": "Повысьте acceptance rate",
            "subtitle": f"Сейчас {accept_rate}% — рекомендуем 80%+",
            "actionText": "Подробнее",
        })
    
    if response_time > 10:
        opportunities.append({
            "type": "improve_response", "priority": 65,
            "title": "Отвечайте быстрее",
            "subtitle": f"Ваш ответ: {response_time} мин • Топ: 5 мин",
            "actionText": "Советы",
        })
    
    opportunities.append({
        "type": "buy_priority", "priority": 50,
        "title": "Включите Priority",
        "subtitle": f"Получайте на {random.randint(25, 45)}% больше заказов",
        "actionText": "Подключить",
    })
    
    opportunities.sort(key=lambda x: -x["priority"])
    
    return {"profile": profile, "pressure": pressure, "opportunities": opportunities[:5]}





@router.get("/api/provider/intelligence/earnings")
async def provider_intelligence_earnings(request: Request):
    """Provider earnings intelligence"""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "Unauthorized")
    try:
        jwt.decode(auth[7:], JWT_SECRET, algorithms=["HS256"])
    except Exception:
        raise HTTPException(401, "Invalid token")
    
    return {
        "today": random.randint(500, 3000),
        "week": random.randint(5000, 20000),
        "month": random.randint(20000, 60000),
        "avgPerJob": random.randint(300, 800),
        "missedRevenue": random.randint(200, 2000),
        "bestDay": random.choice(["Пн", "Вт", "Ср", "Чт", "Пт"]),
        "bestTime": random.choice(["09:00-12:00", "14:00-17:00", "18:00-21:00"]),
        "trend": round(random.uniform(-10, 25), 1),
    }





@router.get("/api/provider/intelligence/demand")
async def provider_intelligence_demand(request: Request):
    """Demand intelligence for provider's zone"""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "Unauthorized")
    try:
        jwt.decode(auth[7:], JWT_SECRET, algorithms=["HS256"])
    except Exception:
        raise HTTPException(401, "Invalid token")
    
    zones = await db.zones.find({}, {"_id": 0}).to_list(10)
    current_zone = zones[0] if zones else {"id": "unknown", "name": "Unknown", "status": "BALANCED", "ratio": 1, "surgeMultiplier": 1, "avgEta": 10}
    
    # Find best zone
    best_zone = max(zones, key=lambda z: z.get("ratio", 0)) if zones else current_zone
    
    return {
        "currentZone": {"id": current_zone["id"], "name": current_zone.get("name"), "status": current_zone.get("status"), "ratio": current_zone.get("ratio")},
        "demandLevel": current_zone.get("status", "BALANCED"),
        "avgEta": current_zone.get("avgEta", 10),
        "activeRequests": current_zone.get("demandScore", 5),
        "onlineProviders": current_zone.get("supplyScore", 3),
        "surge": current_zone.get("surgeMultiplier", 1),
        "recommendedZone": {
            "zoneId": best_zone["id"], "name": best_zone.get("name"),
            "reason": f"Ratio {best_zone.get('ratio')} — больше спроса",
            "potentialGain": f"+{random.randint(15, 45)}%",
        } if best_zone["id"] != current_zone["id"] else None,
        "allZones": [{"id": z["id"], "name": z.get("name"), "status": z.get("status"), "ratio": z.get("ratio"), "surge": z.get("surgeMultiplier", 1)} for z in zones],
    }





@router.get("/api/provider/intelligence/performance")
async def provider_intelligence_performance(request: Request):
    """Detailed performance breakdown"""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "Unauthorized")
    try:
        jwt.decode(auth[7:], JWT_SECRET, algorithms=["HS256"])
    except Exception:
        raise HTTPException(401, "Invalid token")
    
    perf = await db.provider_performance.find_one({}, {"_id": 0}) or {}
    
    issues = []
    if perf.get("avgResponseTime", 15) > 10:
        issues.append({"type": "slow_response", "message": "Медленный ответ на заявки", "severity": "medium"})
    if perf.get("acceptanceRate", 75) < 70:
        issues.append({"type": "low_acceptance", "message": "Низкий acceptance rate", "severity": "high"})
    if perf.get("cancelRate", 5) > 8:
        issues.append({"type": "high_cancel", "message": "Высокий процент отмен", "severity": "high"})
    
    return {
        "acceptanceRate": perf.get("acceptanceRate", 75),
        "avgResponseTime": perf.get("avgResponseTime", 15),
        "completionRate": perf.get("completionRate", 85),
        "cancelRate": perf.get("cancelRate", 5),
        "qualityScore": perf.get("qualityScore", 70),
        "latenessScore": perf.get("latenessScore", 8),
        "repeatCustomerRate": perf.get("repeatCustomerRate", 20),
        "totalJobs": perf.get("totalJobs", 50),
        "issues": issues,
        "improvementTips": [
            "Отвечайте в течение 5 минут — это увеличивает конверсию на 40%",
            "Принимайте заявки в пиковые часы — это улучшает ranking",
            "Собирайте отзывы — каждый отзыв повышает доверие",
        ],
    }





@router.get("/api/provider/intelligence/lost-revenue")
async def provider_intelligence_lost_revenue(request: Request):
    """Lost revenue analysis"""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "Unauthorized")
    try:
        jwt.decode(auth[7:], JWT_SECRET, algorithms=["HS256"])
    except Exception:
        raise HTTPException(401, "Invalid token")
    
    missed_today = random.randint(1, 5)
    missed_week = random.randint(5, 20)
    avg_val = random.randint(400, 800)
    
    return {
        "today": {"missed": missed_today, "lostRevenue": missed_today * avg_val, "avgRequestValue": avg_val},
        "week": {"missed": missed_week, "lostRevenue": missed_week * avg_val},
        "month": {"missed": missed_week * 4, "lostRevenue": missed_week * 4 * avg_val},
        "reasons": [
            {"reason": "Медленный ответ", "count": random.randint(2, 8), "lostAmount": random.randint(500, 3000)},
            {"reason": "Не онлайн", "count": random.randint(1, 5), "lostAmount": random.randint(300, 2000)},
            {"reason": "Пропущены priority заявки", "count": random.randint(0, 3), "lostAmount": random.randint(200, 1500)},
        ],
        "recommendation": "Включите Priority и отвечайте быстрее — вы можете заработать на 35% больше",
    }





@router.get("/api/provider/intelligence/opportunities")
async def provider_intelligence_opportunities(request: Request):
    """Provider opportunity signals"""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "Unauthorized")
    try:
        jwt.decode(auth[7:], JWT_SECRET, algorithms=["HS256"])
    except Exception:
        raise HTTPException(401, "Invalid token")
    
    zones = await db.zones.find({}, {"_id": 0}).to_list(10)
    opps = []
    
    for z in zones:
        if z.get("status") in ("SURGE", "CRITICAL"):
            opps.append({
                "type": "high_demand_now", "zoneId": z["id"],
                "title": f"🔥 {z.get('name')}: высокий спрос",
                "subtitle": f"Ratio {z.get('ratio')} • {z.get('demandScore', 0)} заявок",
                "actionText": "Перейти в зону", "priority": 90 + (z.get("ratio", 1) * 5),
            })
    
    opps.append({
        "type": "buy_priority", "zoneId": None,
        "title": "Включите Priority Access",
        "subtitle": f"+{random.randint(25, 45)}% заказов • видимость x2",
        "actionText": "Подключить", "priority": 50,
    })
    
    opps.sort(key=lambda x: -x["priority"])
    return {"opportunities": opps[:5], "total": len(opps)}





@router.post("/api/provider/behavior/track")
async def track_provider_behavior(request: Request):
    """Track provider behavior event"""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "Unauthorized")
    try:
        payload = jwt.decode(auth[7:], JWT_SECRET, algorithms=["HS256"])
        uid_val = payload.get("sub")
    except Exception:
        raise HTTPException(401, "Invalid token")
    
    body = await request.json()
    event = {
        "providerId": uid_val,
        "type": body.get("type", "unknown"),
        "zoneId": body.get("zoneId"),
        "requestId": body.get("requestId"),
        "metadata": body.get("metadata"),
        "timestamp": now_utc().isoformat(),
    }
    await db.provider_behavior_events.insert_one(event)
    event.pop("_id", None)
    return {"status": "tracked", "event": event}






# ═══════════════════════════════════════════════════════════════════════
# 🧭 PROVIDER WORKBENCH v1 — work-items projection
#
# Doctrine: Workbench is NOT a workflow engine. These endpoints are a
# read-only projector + a thin verb-translator that re-uses the existing
# transition handlers (`provider_booking_action`, inspector `transition_status`,
# `quick_request_accept/reject`). No new collections, no new lifecycle.
#
# See:
#   - /app/memory/PRD.md  (doctrine)
#   - /app/shared/domain/contracts/provider-work-item.ts  (wire shape)
#   - /app/backend/app/provider/work_items.py            (projector)
# ═══════════════════════════════════════════════════════════════════════
from app.core.identity_runtime import decode_and_resolve, IdentityContext  # noqa: E402
from app.provider import work_items as wi_proj  # noqa: E402


async def _resolve_provider_slug(ctx: IdentityContext) -> Optional[str]:
    """Find the org slug owned by the authenticated user, if any.

    The booking world keys by `providerSlug`. Returns None for inspector-only
    accounts that don't own an organization — projection still works for
    inspection_jobs side.
    """
    org = await db.organizations.find_one(
        {"ownerId": ctx.user_id, "status": "active"},
        {"_id": 0, "slug": 1},
    )
    if org and org.get("slug"):
        return org["slug"]
    # Fallback: if account.organizationId is set, look up by id.
    if ctx.account.organizationId:
        org = await db.organizations.find_one(
            {"_id": ctx.account.organizationId},
            {"_id": 0, "slug": 1},
        )
        if org and org.get("slug"):
            return org["slug"]
    return None


# ── B.2 — Persona Narrative Experiment ──────────────────────────────────
#
# Read-only narration of the implicit identity that backs each
# Workbench / Earnings response. NOT a new contract, NOT an identity
# endpoint, NOT account abstraction — just exposing on existing
# responses what the projector already knows so the provider can SEE
# which "self" the screen is showing data for.
#
# See /app/memory/provider_identity_topology.md §5 — the silent regions
# (Workbench + Earnings) gain a narrative layer; nothing else changes.
async def _build_viewer_persona(ctx: IdentityContext) -> dict:
    """Project the currently-implicit viewer persona for narration.

    Pure read; uses only `ctx` + the same `organizations` query the slug
    resolver already performs. Returns a stable shape:

      { displayName, kind, organizationName?, slug? }

    `organizationName` and `slug` are present iff the provider owns or is
    member of an active organization (legacy directory). When absent, the
    UI narrates only `displayName + kind` — which is the honest answer for
    an inspector-only account that doesn't own a workshop.
    """
    org_doc = await db.organizations.find_one(
        {"ownerId": ctx.user_id, "status": "active"},
        {"_id": 0, "slug": 1, "name": 1},
    )
    if not org_doc and ctx.account.organizationId:
        org_doc = await db.organizations.find_one(
            {"_id": ctx.account.organizationId},
            {"_id": 0, "slug": 1, "name": 1},
        )
    return {
        "displayName":       ctx.account.displayName,
        "kind":              ctx.account.kind,           # e.g. 'inspector'
        "organizationName":  (org_doc or {}).get("name"),
        "slug":              (org_doc or {}).get("slug"),
    }



@router.get("/api/provider/work-items")
async def get_provider_work_items(
    ctx: IdentityContext = Depends(decode_and_resolve),  # noqa: B008
):
    """Provider-facing projection over bookings + inspection jobs + QR offers.

    Returns `ProviderWorkItemsResponse` (see TS contract). Sorted by attention
    priority (needs_response → blocked → in_progress → ... → completed).
    """
    slug = await _resolve_provider_slug(ctx)
    items = await wi_proj.project_all_for_provider(
        viewer_user_id=ctx.user_id,
        viewer_provider_slug=slug,
    )
    # B.2 — narrate the implicit viewer persona on the same response.
    viewer = await _build_viewer_persona(ctx)
    return {"items": items, "viewer": viewer}


@router.post("/api/provider/work-items/{item_id}/action")
async def post_provider_work_item_action(
    item_id: str,
    request: Request,
    ctx: IdentityContext = Depends(decode_and_resolve),  # noqa: B008
):
    """Translate a provider-perception verb into the underlying transition.

    Body: `{ "verb": "accept"|"reject"|"depart"|"arrive"|"start"|"complete" }`

    Re-uses existing transition handlers. `submit_report` is intentionally
    routed through the legacy inspector form — UI navigates instead of
    POSTing here (see projector docstring).

    On success, emits `provider:work_item:updated` with the fresh projection
    so all WS-connected provider sessions converge without refetch.
    """
    body = await request.json()
    verb = (body.get("verb") or "").strip()
    if not verb:
        raise HTTPException(400, "verb required")

    # Sprint: Provider Dispatch Hardening + Action Idempotency.
    # Optional client-supplied retry key (`wb_${itemId}_${verb}_${epochMinute}`).
    idem_key = (request.headers.get("idempotency-key") or "").strip() or None

    slug = await _resolve_provider_slug(ctx)

    try:
        result = await wi_proj.dispatch_action(
            item_id=item_id,
            verb=verb,
            viewer_user_id=ctx.user_id,
            viewer_provider_slug=slug,
            idem_key=idem_key,
        )
    except wi_proj.WorkItemActionError as exc:
        raise HTTPException(exc.status, exc.message)

    # Realtime convergence: emit the projected outcome (or removal hint).
    # UI replaces by id; on `removed=True` it drops the item.
    payload = {"itemId": item_id, **result}
    if slug:
        payload["providerSlug"] = slug
    try:
        await emit_realtime_event("provider:work_item:updated", payload)
    except Exception as exc:
        logger.warning(f"work_item WS emit failed: {exc}")

    return result




# ═══════════════════════════════════════════════════════════════════════
# 💶 PROVIDER EARNINGS Phase 3.1 — provider-facing money projection
#
# Doctrine: "What does provider believe about money?"
#   work completed ≠ client paid ≠ provider earned ≠ provider paid out
#
# Phase 3.1 is read-only and derivational. NO new collection, NO mutation,
# NO Stripe/webhook/payout logic. The projector lives in
# `app/provider/earnings.py`.
#
# Refs:
#   - /app/memory/PRD.md (Phase 3.1 doctrine)
#   - /app/shared/domain/contracts/provider-earnings-item.ts (wire shape)
# ═══════════════════════════════════════════════════════════════════════
from app.provider import earnings as earn_proj  # noqa: E402


@router.get("/api/provider/earnings/items")
async def get_provider_earnings_items(
    request: Request,
    ctx: IdentityContext = Depends(decode_and_resolve),  # noqa: B008
):
    """Provider-facing earnings projection: items + summary.

    Query params (optional):
      - from:   ISO datetime (default: 90 days ago)
      - to:     ISO datetime (default: now)
      - state:  comma-separated state filter (applied AFTER summary aggregation,
                so summary always reflects the FULL window — not the slice).

    Returns ProviderEarningsItemsResponse: { items, summary }.
    """
    qp = request.query_params
    from_iso = qp.get("from") or None
    to_iso = qp.get("to") or None
    state_param = (qp.get("state") or "").strip()
    states_filter = None
    if state_param:
        candidates = {s.strip() for s in state_param.split(",") if s.strip()}
        valid = candidates & set(earn_proj.ALL_STATES)
        states_filter = valid or None

    slug = await _resolve_provider_slug(ctx)
    result = await earn_proj.project_earnings_for_provider(
        viewer_user_id=ctx.user_id,
        viewer_provider_slug=slug,
        from_iso=from_iso,
        to_iso=to_iso,
        states_filter=states_filter,
    )
    # B.2 — narrate the implicit viewer persona on the same response.
    result["viewer"] = await _build_viewer_persona(ctx)
    return result


@router.get("/api/provider/earnings/summary")
async def get_provider_earnings_summary(
    request: Request,
    ctx: IdentityContext = Depends(decode_and_resolve),  # noqa: B008
):
    """Just the summary (per-currency, per-state buckets).

    Useful for the workbench KPI strip without paying for the full items
    payload. Same window semantics as `/items`.
    """
    qp = request.query_params
    from_iso = qp.get("from") or None
    to_iso = qp.get("to") or None

    slug = await _resolve_provider_slug(ctx)
    result = await earn_proj.project_earnings_for_provider(
        viewer_user_id=ctx.user_id,
        viewer_provider_slug=slug,
        from_iso=from_iso,
        to_iso=to_iso,
    )
    return {
        "summary":         result["summary"],
        "lastRefreshedAt": now_utc().isoformat(),
    }



