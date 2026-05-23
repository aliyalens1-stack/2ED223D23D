"""Stage 3 — Services + Booking (Uber-like flow).

Модель:
  Request  — заявка клиента (city, serviceKey, description)
  Quote    — ответ СТО с ценой (fake instant: 3 штуки генерятся сразу при POST)
  Booking  — подтверждённый заказ (создаётся при accept quote)

Endpoints:
  POST /api/requests                    — create request + auto-generate 3 quotes
  GET  /api/requests/my                 — requests текущего пользователя
  GET  /api/requests/{id}/quotes        — офферы по заявке
  POST /api/quotes/{id}/accept          — accept → booking + mark request "booked"

Auth: Bearer JWT (optional — guests тоже могут создавать requests для seamless UX,
userId=None помечается как guest request).
"""
from __future__ import annotations
import logging
import random
from datetime import timedelta
from typing import Optional

import jwt
from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.config import JWT_SECRET, JWT_ALGO
from app.core.db import db
from app.core.utils import now_utc, uid

router = APIRouter()
logger = logging.getLogger(__name__)


# ── Service catalog (UI-level, нет отдельной коллекции в БД) ───────────────
# Используется frontend'ом через GET /api/services и при валидации POST /requests.
SERVICES = {
    "repair": {
        "label": {"de": "Reparatur", "en": "Repair", "ru": "Ремонт"},
        "items": [
            {"key": "oil_change", "de": "Ölwechsel",         "en": "Oil change",        "ru": "Замена масла",      "priceFrom": 60},
            {"key": "brakes",     "de": "Bremsen",           "en": "Brakes",            "ru": "Тормоза",           "priceFrom": 120},
            {"key": "engine",     "de": "Motor-Diagnose",    "en": "Engine diagnostics","ru": "Диагностика двигателя","priceFrom": 90},
            {"key": "battery",    "de": "Batterie-Wechsel",  "en": "Battery swap",      "ru": "Замена аккумулятора","priceFrom": 150},
            {"key": "tires",      "de": "Reifenwechsel",     "en": "Tire change",       "ru": "Шиномонтаж",        "priceFrom": 40},
            {"key": "towing",     "de": "Abschleppdienst",   "en": "Towing",            "ru": "Эвакуатор",         "priceFrom": 80},
        ],
    },
    "inspection": {
        "label": {"de": "Inspektion", "en": "Inspection", "ru": "Проверка"},
        "items": [
            {"key": "pre_purchase", "de": "Ankauf-Check",   "en": "Pre-purchase check", "ru": "Проверка перед покупкой", "priceFrom": 149},
            {"key": "diagnostics",  "de": "Fehlerdiagnose", "en": "Diagnostics",        "ru": "Диагностика",             "priceFrom": 50},
        ],
    },
    # UX-2A — Selection cluster (mobile.de scout work).
    # Free-form requests — frontend `/selection/request` posts here with a
    # preset key + free-text. `priceFrom` is a hint only; real provider quotes
    # come back through the standard /api/requests fake-quote generation path.
    "selection": {
        "label": {"de": "Auswahl", "en": "Selection", "ru": "Подбор"},
        "items": [
            {"key": "budget_match",     "de": "Budget-Auswahl",      "en": "Budget match",       "ru": "Подбор под бюджет",      "priceFrom": 300},
            {"key": "market_scout",     "de": "Markt-Scout",         "en": "Market scout",       "ru": "Поиск на рынке",         "priceFrom": 250},
            {"key": "negotiation_help", "de": "Verhandlungshilfe",   "en": "Negotiation help",   "ru": "Помощь с торгом",        "priceFrom": 150},
            {"key": "mobile_de_link",   "de": "mobile.de-Check",     "en": "mobile.de scan",     "ru": "Проверка mobile.de",     "priceFrom": 90},
        ],
    },
    # UX-2A — Delivery cluster (logistics across borders).
    "delivery": {
        "label": {"de": "Lieferung", "en": "Delivery", "ru": "Пригон"},
        "items": [
            {"key": "eu_import",    "de": "EU-Import",         "en": "EU import",       "ru": "Импорт из ЕС",            "priceFrom": 600},
            {"key": "car_pickup",   "de": "Auto-Abholung",     "en": "Car pickup",      "ru": "Забрать авто",            "priceFrom": 250},
            {"key": "customs_help", "de": "Zoll-Hilfe",        "en": "Customs help",    "ru": "Помощь с растаможкой",    "priceFrom": 200},
            {"key": "door_to_door", "de": "Door-to-Door",      "en": "Door-to-door",    "ru": "Доставка до двери",       "priceFrom": 800},
        ],
    },
}

# Flat map для quick lookup
SERVICE_MAP: dict[str, dict] = {
    item["key"]: {**item, "cluster": cluster}
    for cluster, data in SERVICES.items()
    for item in data["items"]
}


# ── Auth helper (soft — guest allowed) ─────────────────────────────────────
def _user_id_from_request(request: Request) -> Optional[str]:
    """Returns userId if valid JWT present, else None (guest)."""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        return None
    try:
        payload = jwt.decode(auth[7:], JWT_SECRET, algorithms=[JWT_ALGO])
        return payload.get("sub")
    except jwt.PyJWTError:
        return None


def _user_id_required(request: Request) -> str:
    uid_ = _user_id_from_request(request)
    if not uid_:
        raise HTTPException(401, "Authentication required")
    return uid_


# ── Pydantic models ────────────────────────────────────────────────────────
class CreateRequestBody(BaseModel):
    serviceKey: str = Field(..., min_length=1)
    city: str = Field(..., min_length=1)
    description: Optional[str] = Field("", max_length=500)
    # P4.1 — Vehicle linkage. Optional. When the customer creates a
    # service request from their garage page, the surface passes the
    # selected vehicle's id here so the resulting request → quote →
    # booking chain can be queried by vehicle later. Legacy/anonymous
    # flows leave this None and behave exactly as before.
    vehicleId: Optional[str] = Field(default=None, max_length=64)


# ── Services catalog endpoint (used by frontend) ──────────────────────────
@router.get("/api/services")
async def list_services():
    """Return flat service catalog grouped by cluster."""
    return {"clusters": SERVICES}


# ── POST /api/requests ─────────────────────────────────────────────────────
@router.post("/api/requests")
async def create_request(body: CreateRequestBody, request: Request):
    """Create a customer request AND immediately generate 3 fake quotes
    from the top-ranked providers in the given city.

    Returns: { requestId, status, quotes: [3] }
    """
    service = SERVICE_MAP.get(body.serviceKey)
    if not service:
        raise HTTPException(400, f"Unknown serviceKey: {body.serviceKey}")

    user_id = _user_id_from_request(request)  # optional — guests allowed

    # Extended provider fields for snapshot
    providers = await db.organizations.find(
        {"status": "active", "city": body.city},
        {"_id": 0, "slug": 1, "name": 1, "ratingAvg": 1, "reviewsCount": 1,
         "bookingsCount": 1, "avgResponseTimeMinutes": 1, "isVerified": 1,
         "type": 1, "yearsExperience": 1, "tuvVerified": 1, "yearFounded": 1},
    ).to_list(20)

    if not providers:
        raise HTTPException(404, f"No providers available in {body.city}")

    providers.sort(
        key=lambda p: (p.get("ratingAvg", 0) * 20) + min(p.get("bookingsCount", 0), 200),
        reverse=True,
    )
    top3 = providers[:3]

    # 2. Create request
    req_id = uid()
    req_doc = {
        "id": req_id,
        "userId": user_id,
        # P4.1 — Vehicle linkage. None for anonymous / non-garage flows.
        "vehicleId": body.vehicleId,
        "city": body.city,
        "serviceKey": body.serviceKey,
        "serviceCluster": service["cluster"],
        "description": (body.description or "").strip(),
        "status": "offers",  # offers immediately since fake quotes are generated synchronously
        "createdAt": now_utc().isoformat(),
    }
    await db.customer_requests.insert_one(dict(req_doc))
    req_doc.pop("_id", None)

    # 3. Generate 3 fake quotes with realistic pricing + provider snapshot
    base_price = service["priceFrom"]
    now = now_utc()
    expires_at = (now + timedelta(minutes=10)).isoformat()
    quotes = []
    # Price multipliers: top provider slightly pricier (trust premium), 3rd cheapest
    variants = [(1.25, 8), (1.05, 15), (0.92, 25)]
    for i, p in enumerate(top3):
        multiplier, response_min = variants[i]
        # basePrice + 0-30% uniform jitter, then apply tier multiplier
        jitter = 1 + (random.random() * 0.30)  # 1.00 .. 1.30
        price_from = max(base_price, int(base_price * multiplier * jitter / 1.15))
        # Cap within sane range: [basePrice, basePrice * 2]
        price_from = min(price_from, base_price * 2)

        years_exp = p.get("yearsExperience")
        if years_exp is None and p.get("yearFounded"):
            years_exp = max(1, now.year - int(p["yearFounded"]))
        if years_exp is None:
            years_exp = random.randint(3, 15)

        provider_snapshot = {
            "name": p.get("name", "Provider"),
            "slug": p["slug"],
            "rating": round(p.get("ratingAvg", 4.5), 1),
            "reviews": p.get("reviewsCount", 0),
            "tuvVerified": bool(p.get("tuvVerified") or p.get("isVerified")),
            "yearsExperience": years_exp,
            "type": p.get("type", "workshop"),
        }
        q = {
            "id": uid(),
            "requestId": req_id,
            "vehicleId": body.vehicleId,  # P4.1 — denormalised from parent request
            "providerSlug": p["slug"],
            "provider": provider_snapshot,
            "priceFrom": price_from,
            "currency": "EUR",
            "estimatedTimeMinutes": response_min,
            "responseTime": f"{response_min} min",
            "message": f"{service['de']} — ab €{price_from}, wir können heute übernehmen.",
            "status": "pending",
            "expiresAt": expires_at,
            "createdAt": now.isoformat(),
        }
        await db.request_quotes.insert_one(dict(q))
        q.pop("_id", None)
        quotes.append(q)

    logger.info(f"Request {req_id} created ({body.serviceKey}/{body.city}) → {len(quotes)} quotes")

    return {
        "requestId": req_id,
        "request": req_doc,
        "quotes": quotes,
        "status": "offers",
    }


# ── GET /api/requests/my ───────────────────────────────────────────────────
@router.get("/api/requests/my")
async def my_requests(request: Request):
    """List all requests for the current authenticated user."""
    user_id = _user_id_required(request)
    items = await db.customer_requests.find(
        {"userId": user_id}, {"_id": 0}
    ).sort("createdAt", -1).to_list(50)
    return {"requests": items, "total": len(items)}


# ── GET /api/requests/{id}/quotes ──────────────────────────────────────────
@router.get("/api/requests/{request_id}/quotes")
async def request_quotes(request_id: str):
    """Fetch all quotes for a request."""
    req = await db.customer_requests.find_one({"id": request_id}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Request not found")
    quotes = await db.request_quotes.find(
        {"requestId": request_id}, {"_id": 0}
    ).sort("priceFrom", 1).to_list(10)
    return {"request": req, "quotes": quotes}


# ── Booking helper (shared with payments module) ──────────────────────────
async def accept_quote_and_create_booking(quote_id: str, user_id: Optional[str] = None) -> dict:
    """Atomic accept: create booking, mark quote accepted, siblings rejected,
    request booked. Idempotent: if request already booked, returns existing
    booking without re-running side effects.

    Raises HTTPException on: unknown quote, expired quote, non-pending quote.
    """
    quote = await db.request_quotes.find_one({"id": quote_id}, {"_id": 0})
    if not quote:
        raise HTTPException(404, "Quote not found")
    # Check expiration
    exp = quote.get("expiresAt")
    if exp and exp < now_utc().isoformat():
        await db.request_quotes.update_one(
            {"id": quote_id}, {"$set": {"status": "expired"}}
        )
        raise HTTPException(410, "Quote expired")

    req = await db.customer_requests.find_one({"id": quote["requestId"]}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Parent request not found")

    # Idempotency: if already booked, return existing booking (webhook retry safe)
    if req.get("status") == "booked":
        existing = await db.customer_bookings.find_one(
            {"requestId": req["id"]}, {"_id": 0}
        )
        if existing:
            return existing
        # shouldn't happen, but fall through to create if missing

    if quote["status"] != "pending":
        raise HTTPException(409, f"Quote is already {quote['status']}")

    booking_id = uid()
    provider = quote.get("provider") or {}
    booking = {
        "id": booking_id,
        "requestId": quote["requestId"],
        # P4.1 — denormalised from the parent quote (which inherited it
        # from the request). None for legacy/anonymous flows.
        "vehicleId": quote.get("vehicleId"),
        "quoteId": quote_id,
        "userId": user_id if user_id is not None else req.get("userId"),
        "providerSlug": quote["providerSlug"],
        "provider": provider,
        "serviceKey": req["serviceKey"],
        "city": req["city"],
        "finalPrice": quote["priceFrom"],
        "currency": quote["currency"],
        "estimatedTimeMinutes": quote["estimatedTimeMinutes"],
        "responseTime": quote.get("responseTime"),
        "status": "confirmed",
        "scheduledAt": None,
        "createdAt": now_utc().isoformat(),
    }
    await db.customer_bookings.insert_one(dict(booking))
    booking.pop("_id", None)

    await db.request_quotes.update_one(
        {"id": quote_id}, {"$set": {"status": "accepted", "acceptedAt": now_utc().isoformat()}}
    )
    await db.request_quotes.update_many(
        {"requestId": quote["requestId"], "id": {"$ne": quote_id}},
        {"$set": {"status": "rejected"}},
    )
    await db.customer_requests.update_one(
        {"id": quote["requestId"]},
        {"$set": {"status": "booked", "bookedAt": now_utc().isoformat(), "bookingId": booking_id}},
    )
    logger.info(f"Quote {quote_id} accepted → booking {booking_id}")
    return booking


# ── POST /api/quotes/{id}/accept ───────────────────────────────────────────
@router.post("/api/quotes/{quote_id}/accept")
async def accept_quote(quote_id: str, request: Request):
    """Accept a quote → create booking, mark request 'booked',
    mark accepted quote 'accepted', others 'rejected'.

    NOTE (Stage 4): this endpoint stays enabled for dev/testing but production flow
    goes through /api/payments/create-checkout which calls the same helper after
    payment_status='paid' is confirmed.
    """
    # Double-check request not booked for accurate 409 at API layer
    quote_check = await db.request_quotes.find_one({"id": quote_id}, {"_id": 0})
    if quote_check:
        req_check = await db.customer_requests.find_one(
            {"id": quote_check["requestId"]}, {"_id": 0}
        )
        if req_check and req_check.get("status") == "booked":
            raise HTTPException(409, "Request already booked")

    user_id = _user_id_from_request(request)
    booking = await accept_quote_and_create_booking(quote_id, user_id=user_id)
    return {"booking": booking, "status": "confirmed"}
