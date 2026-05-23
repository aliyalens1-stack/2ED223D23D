"""Service Marketplace — Geo / Dispatch / Matching layer (Sprint 2).

Endpoints:
  POST /api/provider/location               — обновить GPS + статус online
  GET  /api/provider/location/me            — моя гео-запись
  GET  /api/provider/service-requests/feed  — ТОЛЬКО matched заявки (заменяет /service-requests для production)
  POST /api/provider/service-requests/{id}/quick-bid — fast bid за <10 сек: только price + ETA

  POST /api/admin/dispatch/rematch/{id}     — пересчитать matching для заявки (админ-инструмент)
  GET  /api/admin/dispatch/heatmap          — данные для админ карты (requests + providers)
  GET  /api/notifications/me                — push notifications (in-app, pull-based)
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, HTTPException, Request, Query, Depends
from pydantic import BaseModel, Field, ConfigDict

from app.core.utils import now_utc, uid
from app.core.geo import haversine
from app.core.db import get_db
from app.core.security import verify_user_token, verify_admin_token
from .models import CATEGORY_META

logger = logging.getLogger(__name__)

# Router 1 — provider geo / feed / quick-bid (provider/inspector role required)
provider_geo_router = APIRouter(tags=["service_marketplace:provider_geo"])

# Router 2 — admin dispatch tools
admin_dispatch_router = APIRouter(
    prefix="/api/admin/dispatch",
    tags=["service_marketplace:admin_dispatch"],
    dependencies=[Depends(verify_admin_token)],
)

# Router 3 — generic notifications feed (any authenticated user pulls their inbox)
notifications_router = APIRouter(tags=["service_marketplace:notifications"])


# ── Pydantic models ──────────────────────────────────────────────────────
class LocationUpdateBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)
    city: str | None = Field(None, max_length=64)
    serviceRadiusKm: int | None = Field(25, ge=1, le=200)
    categories: list[str] | None = Field(None, max_length=9)
    isOnline: bool = True
    deviceToken: str | None = Field(None, max_length=512)


class QuickBidBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    price: int = Field(..., ge=1, le=100000)
    etaMinutes: int | None = Field(None, ge=5, le=10080)


def _provider_only(payload: dict) -> str:
    role = payload.get("role") or payload.get("kind")
    if role not in ("provider_owner", "inspector", "provider"):
        raise HTTPException(403, "Provider/inspector role required")
    return payload.get("sub") or payload.get("userId")


# ───────────────────────────────────────────────────────────────────────────
# POST /api/provider/location  — обновить GPS + статус online
# ───────────────────────────────────────────────────────────────────────────
@provider_geo_router.post("/api/provider/location")
async def update_location(body: LocationUpdateBody, request: Request):
    """Provider app шлёт GPS. Создаёт/обновляет запись в provider_locations."""
    payload = await verify_user_token(request)
    provider_id = _provider_only(payload)

    db = get_db()
    now = now_utc().isoformat()
    doc = {
        "providerId": provider_id,
        "lat": body.lat,
        "lng": body.lng,
        "city": (body.city or "").lower() or None,
        "serviceRadiusKm": body.serviceRadiusKm or 25,
        "categories": body.categories or [],
        "isOnline": body.isOnline,
        "lastSeenAt": now,
        "updatedAt": now,
    }
    # deviceTokens мерджим, не перезаписываем
    update: dict = {"$set": doc, "$setOnInsert": {"createdAt": now}}
    if body.deviceToken:
        update["$addToSet"] = {"deviceTokens": body.deviceToken}

    await db.provider_locations.update_one(
        {"providerId": provider_id},
        update,
        upsert=True,
    )

    logger.info(
        f"[dispatch] provider {provider_id} location updated "
        f"({body.lat:.4f}, {body.lng:.4f}) online={body.isOnline} categories={body.categories}"
    )

    return {"ok": True, "providerId": provider_id, "lastSeenAt": now}


# ───────────────────────────────────────────────────────────────────────────
# GET /api/provider/location/me — посмотреть свою гео-запись
# ───────────────────────────────────────────────────────────────────────────
@provider_geo_router.get("/api/provider/location/me")
async def my_location(request: Request):
    payload = await verify_user_token(request)
    provider_id = _provider_only(payload)
    db = get_db()
    doc = await db.provider_locations.find_one({"providerId": provider_id}, {"_id": 0})
    return {"location": doc}


# ───────────────────────────────────────────────────────────────────────────
# Core matching pipeline — вызывается из router_customer.create + admin/rematch
# ───────────────────────────────────────────────────────────────────────────
async def match_providers_for_request(req: dict, db) -> dict:
    """Найти провайдеров под заявку: category match + radius match + online only.

    Возвращает {targetProviders, notifiedProviders, matchingMeta}.
    matchingMeta содержит radiusKm, matchedCount, fallbackUsed.
    """
    category = req.get("category")
    loc = req.get("location") or {}
    lat = loc.get("lat")
    lng = loc.get("lng")
    city = (req.get("city") or "").lower()

    # Базовый фильтр — категория обязательно совпадает (или провайдер без явных категорий = "any")
    q: dict = {
        "isOnline": True,
        "$or": [{"categories": category}, {"categories": {"$size": 0}}, {"categories": None}],
    }

    candidates = await db.provider_locations.find(q, {"_id": 0}).to_list(500)

    matched = []
    radius_km_used = 25
    if lat is not None and lng is not None:
        # Geo-based: по haversine ≤ serviceRadiusKm каждого провайдера
        for p in candidates:
            p_lat = p.get("lat")
            p_lng = p.get("lng")
            if p_lat is None or p_lng is None:
                continue
            dist = haversine(lat, lng, p_lat, p_lng)
            radius = p.get("serviceRadiusKm") or 25
            if dist <= radius:
                p["distanceKm"] = round(dist, 2)
                matched.append(p)
        radius_km_used = max((p.get("serviceRadiusKm") or 25 for p in matched), default=25)
    else:
        # Fallback: по городу
        matched = [p for p in candidates if (p.get("city") or "").lower() == city]
        radius_km_used = 0

    # Сортировка: ближайшие первыми
    matched.sort(key=lambda p: p.get("distanceKm", 9999))

    target_ids = [p["providerId"] for p in matched]
    meta = {
        "radiusKm": radius_km_used,
        "matchedCount": len(target_ids),
        "fallbackUsed": lat is None or lng is None,
        "computedAt": now_utc().isoformat(),
    }

    logger.info(
        f"[dispatch] matched {len(target_ids)} providers for {req.get('id')} "
        f"category={category} city={city} radius={radius_km_used}km"
    )

    return {
        "targetProviders": target_ids,
        "notifiedProviders": [],   # заполнится после fan-out нотификаций
        "matchingMeta": meta,
    }


# ───────────────────────────────────────────────────────────────────────────
# Notifications fan-out (in-app, pull-based — без Firebase)
# ───────────────────────────────────────────────────────────────────────────
async def fanout_new_request_notifications(req: dict, target_ids: list[str], db) -> list[str]:
    """Создаёт notifications для каждого matched провайдера. Возвращает реально
    отправленных.

    UNIFIED: пишем в canonical `notifications` коллекцию (она же — bell-колокольчик).
    Раньше был отдельный `service_notifications` поток — он создавал две
    параллельные системы (см. CLEANUP_NOTIFICATIONS_UNIFICATION.md).
    """
    if not target_ids:
        return []
    from app.notifications.emit import emit_notifications_bulk

    title_emoji = CATEGORY_META.get(req["category"], {}).get("emoji", "🛠")
    title = f"{title_emoji} Новая заявка · {CATEGORY_META.get(req['category'], {}).get('title_ru', req['category'])}"
    budget = req.get("budget") or {}
    budget_str = ""
    if budget.get("min") or budget.get("max"):
        budget_str = f" · €{budget.get('min','?')}{'–' + str(budget['max']) if budget.get('max') else '+'}"
    body_text = f"{req.get('city','').title()}{budget_str}"

    inserted = await emit_notifications_bulk(
        db=db,
        user_ids=target_ids,
        kind="service_request_new",
        title=title,
        body=body_text,
        severity="info",
        metadata={
            "requestId": req["id"],
            "category": req["category"],
            "city": req.get("city"),
            "budget": budget,
        },
        action_url=f"/service-marketplace/{req['id']}",
    )
    logger.info(f"[dispatch] fan-out {inserted} notifications for request {req['id']} → canonical")
    return target_ids


# ───────────────────────────────────────────────────────────────────────────
# GET /api/provider/service-requests/feed — только matched
# ───────────────────────────────────────────────────────────────────────────
@provider_geo_router.get("/api/provider/service-requests/feed")
async def matched_feed(
    request: Request,
    limit: int = Query(50, ge=1, le=200),
):
    """Provider feed: ТОЛЬКО заявки, где он попал в targetProviders.

    Это правильный production endpoint (заменяет /api/provider/service-requests,
    который остаётся для legacy/debug). Bid-flow тот же.
    """
    payload = await verify_user_token(request)
    provider_id = _provider_only(payload)

    db = get_db()
    q = {
        "status": {"$in": ["open", "bidding"]},
        "targetProviders": provider_id,
    }
    docs = await db.service_requests.find(q, {"_id": 0}).sort("createdAt", -1).to_list(limit)

    # Подмешаем distance из provider_locations
    me = await db.provider_locations.find_one({"providerId": provider_id}, {"_id": 0, "lat": 1, "lng": 1})
    if me:
        for d in docs:
            loc = d.get("location") or {}
            if loc.get("lat") is not None and loc.get("lng") is not None:
                d["distanceKm"] = round(haversine(me["lat"], me["lng"], loc["lat"], loc["lng"]), 2)

    # Скрываем приватные поля клиента
    for d in docs:
        d.pop("contactPhone", None)
        d.pop("customerName", None)
        d.pop("customerId", None)
        d.pop("targetProviders", None)
        d.pop("notifiedProviders", None)

    # Подмешаем "myBid" чтобы UI знал есть ли уже ставка
    request_ids = [d["id"] for d in docs]
    my_bids = {}
    if request_ids:
        async for b in db.service_bids.find(
            {"requestId": {"$in": request_ids}, "providerId": provider_id, "status": "submitted"},
            {"_id": 0, "requestId": 1, "id": 1, "price": 1, "etaMinutes": 1, "status": 1},
        ):
            my_bids[b["requestId"]] = b
    for d in docs:
        d["myBid"] = my_bids.get(d["id"])

    return {"requests": docs, "total": len(docs), "providerId": provider_id}


# ───────────────────────────────────────────────────────────────────────────
# POST /api/provider/service-requests/{id}/quick-bid — fast bid <10s
# ───────────────────────────────────────────────────────────────────────────
@provider_geo_router.post("/api/provider/service-requests/{request_id}/quick-bid")
async def quick_bid(request_id: str, body: QuickBidBody, request: Request):
    """Fast bid: только price + ETA, message подставляется автоматически.

    Это сокращённый путь от долгой формы — пара тапов и ставка ушла.
    """
    payload = await verify_user_token(request)
    provider_id = _provider_only(payload)
    provider_name = payload.get("email") or "Provider"

    db = get_db()
    req = await db.service_requests.find_one({"id": request_id}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Request not found")
    if req["status"] not in ("open", "bidding"):
        raise HTTPException(400, f"Cannot bid: status={req['status']}")

    # Минимальный бюджет
    min_b = CATEGORY_META[req["category"]]["min_budget"]
    if body.price < min_b:
        raise HTTPException(400, f"Price below minimum for {req['category']}: €{min_b}")

    now = now_utc().isoformat()
    org = await db.organizations.find_one(
        {"ownerUserId": provider_id},
        {"_id": 0, "name": 1, "ratingAvg": 1, "phone": 1, "email": 1},
    )
    auto_message = (
        f"Готов выполнить за €{body.price}"
        + (f", ETA {body.etaMinutes} мин." if body.etaMinutes else ".")
    )

    # Проверяем существующий active bid
    existing = await db.service_bids.find_one(
        {"requestId": request_id, "providerId": provider_id, "status": "submitted"},
        {"_id": 0},
    )
    if existing:
        await db.service_bids.update_one(
            {"id": existing["id"]},
            {"$set": {
                "price": body.price,
                "etaMinutes": body.etaMinutes,
                "message": auto_message,
                "updatedAt": now,
            }},
        )
        return {"bid": {**existing, "price": body.price, "etaMinutes": body.etaMinutes}, "updated": True}

    bid_id = uid()
    bid_doc = {
        "id": bid_id,
        "requestId": request_id,
        "providerId": provider_id,
        "providerName": org.get("name") if org else provider_name,
        "providerRating": org.get("ratingAvg") if org else None,
        "providerPhone": org.get("phone") if org else None,
        "providerEmail": org.get("email") if org else provider_name,
        "price": body.price,
        "currency": "EUR",
        "message": auto_message,
        "etaMinutes": body.etaMinutes,
        "status": "submitted",
        "createdAt": now,
        "updatedAt": now,
        "quickBid": True,
    }
    await db.service_bids.insert_one(dict(bid_doc))

    new_status = "bidding" if req["status"] == "open" else req["status"]
    await db.service_requests.update_one(
        {"id": request_id},
        {"$set": {"status": new_status, "updatedAt": now}, "$inc": {"bidsCount": 1}},
    )
    bid_doc.pop("_id", None)
    return {"bid": {"id": bid_id, "price": body.price, "etaMinutes": body.etaMinutes, "status": "submitted"}, "created": True}


# ───────────────────────────────────────────────────────────────────────────
# Bid ranking — компонент scoring для customer detail view
# ───────────────────────────────────────────────────────────────────────────
async def _subscription_boost_map(provider_ids: list[str], db) -> dict[str, float]:
    """Sprint 3A — возвращает {providerId: rankBoost} для всех active подписок.

    Boost берётся из SUBSCRIPTION_PLANS.rankBoost (1.05 / 1.15 / 1.30).
    Провайдеры без подписки → 1.0 (нет буста).
    """
    if not provider_ids:
        return {}
    try:
        from app.escrow.models import SUBSCRIPTION_PLANS  # local import to avoid cycle
    except ImportError:
        return {}
    boosts: dict[str, float] = {}
    async for s in db.provider_subscriptions.find(
        {"providerId": {"$in": list(set(provider_ids))}, "status": "active"},
        {"_id": 0, "providerId": 1, "plan": 1},
    ):
        plan = SUBSCRIPTION_PLANS.get(s.get("plan") or "")
        if plan:
            boosts[s["providerId"]] = plan["rankBoost"]
    return boosts


def rank_bids(bids: list[dict], req: dict, max_price_cap: int | None = None, *, subscription_boosts: dict[str, float] | None = None) -> list[dict]:
    """Сортирует bids по композитному score (выше = лучше).

    Веса:
      • distance (если ставка quickBid имеет провайдер-координаты): ↓ лучше
      • response speed: чем быстрее после createdAt заявки — ↑ лучше
      • providerRating: ↑ лучше
      • price competitiveness: ниже = лучше (относительно медианы)
    """
    if not bids:
        return bids

    prices = [b["price"] for b in bids if b.get("price")]
    median_price = sorted(prices)[len(prices) // 2] if prices else 1
    req_ts = datetime.fromisoformat(req["createdAt"].replace("Z", "+00:00")) if req.get("createdAt") else now_utc()

    for b in bids:
        # 1) Price (low good): 1.0 если 0.7*median, 0.5 если median, 0.1 если 2*median
        if b.get("price") and median_price:
            ratio = b["price"] / median_price
            price_score = max(0.0, min(1.0, 1.5 - ratio))
        else:
            price_score = 0.5

        # 2) Rating
        r = b.get("providerRating") or 3.5
        rating_score = min(1.0, max(0.0, (r - 2.5) / 2.5))

        # 3) Response speed (the faster after request created, the better)
        try:
            bid_ts = datetime.fromisoformat(b["createdAt"].replace("Z", "+00:00"))
            delta_sec = max(0, (bid_ts - req_ts).total_seconds())
            # 0 = instant ≈ score 1; 1h = 0.5; 6h = 0.1
            speed_score = max(0.05, 1.0 / (1.0 + delta_sec / 1200))  # 20-минутный полупад
        except Exception:
            speed_score = 0.5

        # 4) ETA (faster ETA → better)
        eta = b.get("etaMinutes")
        eta_score = max(0.0, min(1.0, 1.0 - (eta / 240))) if eta else 0.5

        composite = round(
            price_score * 0.35
            + rating_score * 0.25
            + speed_score * 0.20
            + eta_score * 0.20,
            3,
        )
        # Sprint 3A — subscription boost (multiplicative). Помечаем в breakdown
        # так что в UI можно показать "PRO" badge и понять почему bid выше.
        boost = 1.0
        if subscription_boosts:
            boost = subscription_boosts.get(b.get("providerId"), 1.0)
            if boost > 1.0:
                composite = round(min(1.0, composite * boost), 3)
        b["rankScore"] = composite
        b["subscriptionBoost"] = boost
        b["scoreBreakdown"] = {
            "price": round(price_score, 2),
            "rating": round(rating_score, 2),
            "speed": round(speed_score, 2),
            "eta": round(eta_score, 2),
            "subscriptionBoost": boost,
        }

    # Сначала accepted (если есть), потом по score, в конце rejected/withdrawn
    def _key(b):
        st = b.get("status")
        priority = 0 if st == "accepted" else (1 if st == "submitted" else 2)
        return (priority, -b.get("rankScore", 0))

    return sorted(bids, key=_key)


# ───────────────────────────────────────────────────────────────────────────
# POST /api/admin/dispatch/rematch/{id} — пересчитать матчинг
# ───────────────────────────────────────────────────────────────────────────
@admin_dispatch_router.post("/rematch/{request_id}")
async def admin_rematch(request_id: str):
    """Админ-тул: пересчитать matching для заявки и отправить нотификации новым providers."""
    db = get_db()
    req = await db.service_requests.find_one({"id": request_id}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Request not found")

    matching = await match_providers_for_request(req, db)
    target_ids = matching["targetProviders"]
    # diff: кто ещё не уведомлён
    already_notified = set(req.get("notifiedProviders") or [])
    fresh = [pid for pid in target_ids if pid not in already_notified]
    notified_now = await fanout_new_request_notifications(req, fresh, db)

    await db.service_requests.update_one(
        {"id": request_id},
        {"$set": {
            "targetProviders": target_ids,
            "notifiedProviders": list(already_notified | set(notified_now)),
            "matchingMeta": matching["matchingMeta"],
            "updatedAt": now_utc().isoformat(),
        }},
    )
    return {"ok": True, "matched": len(target_ids), "notifiedFresh": len(notified_now), "matchingMeta": matching["matchingMeta"]}


# ───────────────────────────────────────────────────────────────────────────
# GET /api/admin/dispatch/heatmap — данные для админской карты
# ───────────────────────────────────────────────────────────────────────────
@admin_dispatch_router.get("/heatmap")
async def admin_heatmap(city: str | None = Query(None)):
    """Возвращает: providers + active service requests + top-city aggregates."""
    db = get_db()
    p_q: dict = {"isOnline": True}
    if city:
        p_q["city"] = city.lower()
    providers = await db.provider_locations.find(
        p_q,
        {"_id": 0, "providerId": 1, "lat": 1, "lng": 1, "city": 1, "categories": 1, "serviceRadiusKm": 1},
    ).limit(500).to_list(500)

    r_q: dict = {"status": {"$in": ["open", "bidding", "assigned"]}}
    if city:
        r_q["city"] = city.lower()
    requests_docs = await db.service_requests.find(
        r_q,
        {"_id": 0, "id": 1, "category": 1, "city": 1, "location": 1, "status": 1, "bidsCount": 1, "createdAt": 1, "budget": 1, "urgency": 1},
    ).limit(500).to_list(500)

    # City aggregates
    pipeline = [
        {"$match": {"status": {"$in": ["open", "bidding"]}}},
        {"$group": {"_id": "$city", "openRequests": {"$sum": 1}}},
        {"$sort": {"openRequests": -1}},
        {"$limit": 20},
    ]
    top_cities = []
    async for d in db.service_requests.aggregate(pipeline):
        top_cities.append({"city": d["_id"], "openRequests": d["openRequests"]})

    # Provider coverage by city
    pipeline2 = [
        {"$match": {"isOnline": True}},
        {"$group": {"_id": "$city", "providers": {"$sum": 1}}},
    ]
    coverage = {}
    async for d in db.provider_locations.aggregate(pipeline2):
        coverage[d["_id"] or "unknown"] = d["providers"]

    # gap: cities with requests but no providers
    gaps = []
    for tc in top_cities:
        c = tc["city"]
        provs = coverage.get(c, 0)
        gaps.append({"city": c, "openRequests": tc["openRequests"], "providers": provs, "gap": tc["openRequests"] - provs})

    return {
        "providers": providers,
        "requests": requests_docs,
        "topCities": top_cities,
        "coverage": coverage,
        "gaps": gaps,
        "computedAt": now_utc().isoformat(),
    }


# ───────────────────────────────────────────────────────────────────────────
# GET /api/service-notifications/me — pull-based notifications
# Namespace `/service-notifications/*` чтобы не конфликтовать с app.chat,
# который владеет `/api/notifications/{id}/read`.
# ───────────────────────────────────────────────────────────────────────────
@notifications_router.get("/api/service-notifications/me")
async def my_notifications(
    request: Request,
    limit: int = Query(50, ge=1, le=200),
    unread_only: bool = Query(False),
):
    """In-app notifications для текущего пользователя (provider или customer).

    UNIFIED (Sprint 4 cleanup): этот endpoint теперь — DEPRECATED alias.
    Реально читаем из canonical `notifications` коллекции (та же, что отдаёт
    /api/notifications/since в bell-колокольчике). Фильтруем по domain-prefix
    `kind: service_*` чтобы вернуть только marketplace-related нотификации.
    Mapping для backward-compat: isRead → read.
    """
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    db = get_db()
    q: dict = {"userId": user_id, "kind": {"$regex": "^service_"}}
    if unread_only:
        q["isRead"] = False
    items = await db.notifications.find(q, {"_id": 0}).sort("createdAt", -1).limit(limit).to_list(limit)
    # Backward-compat shape: добавляем поле `read` чтобы старый клиент не сломался
    for it in items:
        it["read"] = it.get("isRead", False)
        if "metadata" in it and "data" not in it:
            it["data"] = it["metadata"]
    unread = await db.notifications.count_documents(
        {"userId": user_id, "kind": {"$regex": "^service_"}, "isRead": False}
    )
    return {"notifications": items, "unread": unread, "_deprecated": "Use /api/notifications/since"}


@notifications_router.post("/api/service-notifications/{notif_id}/read")
async def mark_read(notif_id: str, request: Request):
    """DEPRECATED alias: пишем в canonical `notifications` (isRead=true)."""
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    db = get_db()
    res = await db.notifications.update_one(
        {"id": notif_id, "userId": user_id},
        {"$set": {"isRead": True, "readAt": now_utc().isoformat()}},
    )
    return {"ok": True, "modified": res.modified_count}


# Backward-compat aliases (старый mobile-клиент может ещё ходить на /api/notifications/me).
# Только GET — POST /api/notifications/{id}/read владеет chat (см. app/chat/router.py).
@notifications_router.get("/api/notifications/me")
async def my_notifications_legacy_alias(
    request: Request,
    limit: int = Query(50, ge=1, le=200),
    unread_only: bool = Query(False),
):
    return await my_notifications(request, limit, unread_only)
