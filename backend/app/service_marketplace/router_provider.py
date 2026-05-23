"""Service Marketplace — provider endpoints.

Endpoints:
  GET    /api/provider/service-requests           — доступные заявки (по гео + категории)
  POST   /api/provider/service-requests/{id}/bids — отправить ставку
  GET    /api/provider/service-requests/my-bids   — мои ставки
  POST   /api/provider/service-requests/{id}/withdraw — отозвать свою ставку
"""
from __future__ import annotations
import logging
from fastapi import APIRouter, HTTPException, Request, Query

from app.core.utils import now_utc, uid
from app.core.geo import haversine
from app.core.db import get_db
from app.core.security import verify_user_token
from .models import CreateBidBody, BID_PUBLIC_FIELDS, PUBLIC_REQUEST_FIELDS

router = APIRouter(tags=["service_marketplace:provider"])
logger = logging.getLogger(__name__)


def _provider_only(payload: dict) -> str:
    """Только provider_owner / inspector имеют право отправлять bids."""
    role = payload.get("role") or payload.get("kind")
    if role not in ("provider_owner", "inspector", "provider"):
        raise HTTPException(403, "Provider/inspector role required")
    return payload.get("sub") or payload.get("userId")


# ── GET /api/provider/service-requests ───────────────────────────────────
@router.get("/api/provider/service-requests")
async def available_requests(
    request: Request,
    city: str | None = Query(None, description="Фильтр по городу"),
    category: str | None = Query(None, description="Фильтр по категории"),
    lat: float | None = Query(None, description="Гео-фильтр: широта"),
    lng: float | None = Query(None, description="Гео-фильтр: долгота"),
    radius_km: float = Query(50, description="Радиус поиска (км)"),
    limit: int = Query(50, ge=1, le=200),
):
    """Provider видит открытые заявки в своей зоне.

    Логика фильтрации:
      - Только status ∈ {open, bidding}
      - Если указан city → точное совпадение
      - Если указаны lat/lng → дополнительно фильтруем по радиусу (haversine)
      - category — опциональный фильтр
      - Скрываем customerId / customerName / contactPhone
    """
    payload = await verify_user_token(request)
    provider_id = _provider_only(payload)

    db = get_db()
    q: dict = {"status": {"$in": ["open", "bidding"]}}
    if city:
        q["city"] = city.lower()
    if category:
        q["category"] = category

    docs = await db.service_requests.find(q, PUBLIC_REQUEST_FIELDS).sort("createdAt", -1).to_list(limit * 2)

    # Гео-фильтр (если переданы lat/lng) + добавляем distance к каждой заявке
    results = []
    for d in docs:
        if lat is not None and lng is not None and d.get("location"):
            loc = d["location"]
            dist = haversine(lat, lng, loc["lat"], loc["lng"])
            if dist > radius_km:
                continue
            d["distanceKm"] = round(dist, 1)
        results.append(d)
        if len(results) >= limit:
            break

    return {"requests": results, "total": len(results), "providerId": provider_id}


# ── POST /api/provider/service-requests/{id}/bids ────────────────────────
@router.post("/api/provider/service-requests/{request_id}/bids")
async def submit_bid(
    request_id: str,
    body: CreateBidBody,
    request: Request,
):
    """Provider отправляет ставку на заявку. Один provider — один bid на заявку
    (повторный POST обновляет существующий bid в статусе submitted).
    """
    payload = await verify_user_token(request)
    provider_id = _provider_only(payload)
    provider_name = payload.get("email") or "Provider"

    db = get_db()
    req = await db.service_requests.find_one({"id": request_id}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Service request not found")
    if req["status"] not in ("open", "bidding"):
        raise HTTPException(400, f"Cannot bid: request is {req['status']}")

    # Минимальный бюджет
    from .models import CATEGORY_META
    min_b = CATEGORY_META[req["category"]]["min_budget"]
    if body.price < min_b:
        raise HTTPException(400, f"Price below minimum for {req['category']}: €{min_b}")

    now = now_utc().isoformat()
    # Существующий bid от этого провайдера?
    existing = await db.service_bids.find_one(
        {"requestId": request_id, "providerId": provider_id, "status": "submitted"},
        {"_id": 0},
    )

    # Получаем рейтинг и контакты провайдера из organizations / users (best-effort)
    org = await db.organizations.find_one(
        {"ownerUserId": provider_id},
        {"_id": 0, "name": 1, "ratingAvg": 1, "phone": 1, "email": 1},
    )

    if existing:
        # Обновляем существующий bid
        await db.service_bids.update_one(
            {"id": existing["id"]},
            {"$set": {
                "price": body.price,
                "currency": body.currency,
                "message": body.message.strip(),
                "etaMinutes": body.etaMinutes,
                "updatedAt": now,
            }},
        )
        bid = await db.service_bids.find_one({"id": existing["id"]}, {"_id": 0})
        logger.info(f"[service_marketplace] provider {provider_id} updated bid on {request_id}")
        return {"bid": bid, "updated": True}

    bid_id = uid()
    bid_doc = {
        "id": bid_id,
        "requestId": request_id,
        "providerId": provider_id,
        "providerName": org.get("name") if org else provider_name,
        "providerRating": org.get("ratingAvg") if org else None,
        "providerPhone": org.get("phone") if org else None,   # скрыто до accept
        "providerEmail": org.get("email") if org else provider_name,  # скрыто до accept
        "price": body.price,
        "currency": body.currency,
        "message": body.message.strip(),
        "etaMinutes": body.etaMinutes,
        "status": "submitted",
        "createdAt": now,
        "updatedAt": now,
        "acceptedAt": None,
    }
    await db.service_bids.insert_one(dict(bid_doc))
    bid_doc.pop("_id", None)

    # Обновляем счётчик и статус на заявке
    new_status = "bidding" if req["status"] == "open" else req["status"]
    await db.service_requests.update_one(
        {"id": request_id},
        {"$set": {"status": new_status, "updatedAt": now},
         "$inc": {"bidsCount": 1}},
    )

    logger.info(
        f"[service_marketplace] provider {provider_id} bid €{body.price} on {request_id} "
        f"(category={req['category']})"
    )

    # Возвращаем public-projection (без контактов провайдера)
    public_bid = {k: bid_doc[k] for k in BID_PUBLIC_FIELDS if k != "_id" and k in bid_doc}
    return {"bid": public_bid, "requestStatus": new_status, "created": True}


# ── GET /api/provider/service-requests/my-bids ───────────────────────────
@router.get("/api/provider/service-requests/my-bids")
async def my_bids(request: Request):
    """Все ставки текущего провайдера + краткая инфа по заявкам."""
    payload = await verify_user_token(request)
    provider_id = _provider_only(payload)

    db = get_db()
    bids = await db.service_bids.find(
        {"providerId": provider_id},
        {"_id": 0},
    ).sort("createdAt", -1).to_list(100)

    # Подмешиваем заявки
    request_ids = list({b["requestId"] for b in bids})
    reqs = {}
    if request_ids:
        async for r in db.service_requests.find(
            {"id": {"$in": request_ids}},
            PUBLIC_REQUEST_FIELDS,
        ):
            reqs[r["id"]] = r

    enriched = []
    for b in bids:
        b["request"] = reqs.get(b["requestId"])
        enriched.append(b)

    return {"bids": enriched, "total": len(enriched)}


# ── POST /api/provider/service-requests/{id}/withdraw ────────────────────
@router.post("/api/provider/service-requests/{request_id}/withdraw")
async def withdraw_bid(request_id: str, request: Request):
    """Provider отзывает свою ставку (если ещё не accepted)."""
    payload = await verify_user_token(request)
    provider_id = _provider_only(payload)

    db = get_db()
    bid = await db.service_bids.find_one(
        {"requestId": request_id, "providerId": provider_id, "status": "submitted"},
        {"_id": 0},
    )
    if not bid:
        raise HTTPException(404, "Active bid not found")

    now = now_utc().isoformat()
    await db.service_bids.update_one(
        {"id": bid["id"]},
        {"$set": {"status": "withdrawn", "updatedAt": now}},
    )
    await db.service_requests.update_one(
        {"id": request_id},
        {"$inc": {"bidsCount": -1}, "$set": {"updatedAt": now}},
    )
    return {"ok": True, "status": "withdrawn"}
