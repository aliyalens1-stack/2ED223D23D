"""Service Marketplace — customer endpoints.

Endpoints:
  POST   /api/service-requests              — создать заявку
  GET    /api/service-requests/me            — мои заявки
  GET    /api/service-requests/{id}          — детали + bids
  POST   /api/service-requests/{id}/accept-bid  — принять отклик
  POST   /api/service-requests/{id}/cancel   — отменить
  GET    /api/service-requests/categories    — каталог категорий (публично)
"""
from __future__ import annotations
import logging
from datetime import timedelta
from fastapi import APIRouter, HTTPException, Request, Depends

from app.core.utils import now_utc, uid
from app.core.db import get_db
from app.core.security import verify_user_token
from .models import (
    CreateRequestBody, CATEGORY_META, CATEGORY_LIST,
    PUBLIC_REQUEST_FIELDS, OWNER_REQUEST_FIELDS, BID_PUBLIC_FIELDS,
)

router = APIRouter(tags=["service_marketplace:customer"])
logger = logging.getLogger(__name__)

# Заявка живёт 72 часа без откликов, после этого → expired.
REQUEST_TTL_HOURS = 72


# ── GET /api/service-requests/categories ──────────────────────────────────
@router.get("/api/service-requests/categories")
async def list_categories():
    """Публичный каталог 9 категорий услуг + минимальные бюджеты."""
    cats = []
    for key in CATEGORY_LIST:
        meta = CATEGORY_META[key]
        cats.append({
            "key": key,
            "titleRu": meta["title_ru"],
            "titleEn": meta["title_en"],
            "titleDe": meta.get("title_de") or meta["title_en"],
            "emoji": meta["emoji"],
            "minBudget": meta["min_budget"],
            "currency": "EUR",
        })
    return {"categories": cats, "total": len(cats)}


# ── POST /api/service-requests ────────────────────────────────────────────
@router.post("/api/service-requests")
async def create_service_request(
    body: CreateRequestBody,
    request: Request,
):
    """Создать заявку. Авторизация опциональна (поддерживаем гостей).

    Если в Authorization есть валидный Bearer-токен — привязываем к user_id,
    иначе создаём анонимную заявку с `customerId=None` и сохранённым
    `contactPhone` (если передан). Анонимные заявки тоже попадают в биржу,
    но клиент не сможет их увидеть в `/me`, пока не залогинится с тем же
    телефоном/email.
    """
    db = get_db()

    # Опциональная авторизация
    customer_id: str | None = None
    customer_name: str | None = None
    auth = request.headers.get("authorization", "")
    if auth.startswith("Bearer "):
        try:
            payload = await verify_user_token(request)
            customer_id = payload.get("sub") or payload.get("userId")
            customer_name = payload.get("email")
        except HTTPException:
            customer_id = None  # игнорируем — гость

    # Валидация категории — Pydantic уже проверил, что в enum.
    meta = CATEGORY_META[body.category]

    # Если бюджет указан, но min ниже порога — поднимаем до минимума.
    budget = None
    if body.budget:
        budget = body.budget.model_dump()
        if budget.get("min") and budget["min"] < meta["min_budget"]:
            budget["min"] = meta["min_budget"]

    req_id = uid()
    now = now_utc()
    expires_at = now + timedelta(hours=REQUEST_TTL_HOURS)

    doc = {
        "id": req_id,
        "customerId": customer_id,
        "customerName": customer_name,
        "category": body.category,
        "title": (body.title or meta["title_ru"]).strip(),
        "description": body.description.strip(),
        "city": body.city.lower(),
        "location": body.location.model_dump() if body.location else None,
        "urgency": body.urgency,
        "budget": budget,
        "photos": body.photos or [],
        "contactPhone": body.contactPhone,  # хранится скрыто
        "status": "open",
        "bidsCount": 0,
        "acceptedBidId": None,
        "assignedProviderId": None,
        # Гибридная монетизация — фиксируем на момент создания
        "commissionPct": meta["default_commission_pct"],
        "leadFee": meta.get("default_lead_fee", 0),
        "createdAt": now.isoformat(),
        "updatedAt": now.isoformat(),
        "expiresAt": expires_at.isoformat(),
    }
    await db.service_requests.insert_one(dict(doc))
    doc.pop("_id", None)

    logger.info(
        f"[service_marketplace] created request {req_id} category={body.category} "
        f"city={body.city} customer={customer_id or 'guest'}"
    )

    # ── Sprint 2 — Auto-dispatch: matching + notifications ────────────
    try:
        from .router_geo import match_providers_for_request, fanout_new_request_notifications
        matching = await match_providers_for_request(doc, db)
        target_ids = matching["targetProviders"]
        notified_ids = await fanout_new_request_notifications(doc, target_ids, db)
        await db.service_requests.update_one(
            {"id": req_id},
            {"$set": {
                "targetProviders": target_ids,
                "notifiedProviders": notified_ids,
                "matchingMeta": matching["matchingMeta"],
            }},
        )
        doc["targetProviders"] = target_ids
        doc["notifiedProviders"] = notified_ids
        doc["matchingMeta"] = matching["matchingMeta"]
    except Exception as e:
        # Не валим create если matching упал — заявка должна быть создана
        logger.warning(f"[service_marketplace] matching failed for {req_id}: {e}")

    # Возвращаем owner-view (с contactPhone), потому что это его заявка.
    return {
        "request": {k: doc.get(k) for k in OWNER_REQUEST_FIELDS if k != "_id" and OWNER_REQUEST_FIELDS[k] == 1},
        "matching": doc.get("matchingMeta"),
        "status": "open",
        "message": "Заявка опубликована в бирже. Исполнители получат уведомление.",
    }


# ── GET /api/service-requests/me ─────────────────────────────────────────
@router.get("/api/service-requests/me")
async def my_service_requests(request: Request):
    """Мои заявки (требует авторизации)."""
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    db = get_db()
    items = await db.service_requests.find(
        {"customerId": user_id},
        OWNER_REQUEST_FIELDS,
    ).sort("createdAt", -1).to_list(100)
    return {"requests": items, "total": len(items)}


# ── GET /api/service-requests/{id} ───────────────────────────────────────
@router.get("/api/service-requests/{request_id}")
async def get_service_request(request_id: str, request: Request):
    """Детали заявки + список откликов.

    Доступ:
    - Владелец заявки: видит всё (свой contactPhone, все bid'ы)
    - Гость / другой пользователь: видит публичные поля заявки + bid'ы БЕЗ
      провайдер-контактов
    """
    db = get_db()
    doc = await db.service_requests.find_one({"id": request_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Service request not found")

    # Определяем кто смотрит
    is_owner = False
    viewer_id: str | None = None
    auth = request.headers.get("authorization", "")
    if auth.startswith("Bearer "):
        try:
            payload = await verify_user_token(request)
            viewer_id = payload.get("sub") or payload.get("userId")
            is_owner = (viewer_id == doc.get("customerId"))
        except HTTPException:
            pass

    # Скрываем приватные поля от не-владельцев
    if not is_owner:
        doc.pop("contactPhone", None)
        doc.pop("customerName", None)
        doc.pop("customerId", None)

    # Список bid'ов
    bids = await db.service_bids.find(
        {"requestId": request_id},
        BID_PUBLIC_FIELDS,
    ).sort("createdAt", 1).to_list(50)

    # Ranking: считаем композитный score чтобы UI мог подсветить лучший
    try:
        from .router_geo import rank_bids, _subscription_boost_map
        # Sprint 3A — subscription boost для bid'ов с подписанными провайдерами
        provider_ids = [b.get("providerId") for b in bids if b.get("providerId")]
        boosts = await _subscription_boost_map(provider_ids, db)
        bids = rank_bids(bids, doc, subscription_boosts=boosts)
    except Exception as e:
        logger.warning(f"[service_marketplace] ranking failed for {request_id}: {e}")

    # Sprint 3A — подгружаем payment, если есть, чтобы UI мог показать checkout
    payment = None
    if doc.get("paymentId"):
        payment = await db.service_payments.find_one({"id": doc["paymentId"]}, {"_id": 0})
        # Скрываем gateway-секреты для не-владельца
        if payment and not is_owner:
            payment = {k: payment.get(k) for k in ("id", "status", "grossAmount", "currency")}

    return {"request": doc, "bids": bids, "isOwner": is_owner, "payment": payment}


# ── POST /api/service-requests/{id}/accept-bid ───────────────────────────
@router.post("/api/service-requests/{request_id}/accept-bid")
async def accept_bid(
    request_id: str,
    body: dict,
    request: Request,
):
    """Sprint 3A — клиент принимает bid → создаётся payment + checkoutUrl.

    Новый flow (escrow):
      - выбранный bid → status: 'accepted'
      - остальные bid'ы → status: 'rejected'
      - assignedProviderId фиксируется в заявке
      - **создаётся service_payment** запись (pending) с расчётом комиссии
      - **создаётся checkout-сессия** у gateway (mock или Stripe)
      - заявка → status: 'awaiting_payment'
      - **provider контакты НЕ открываются**, пока не пришла оплата

    Возвращает {request, bid, payment, checkoutUrl} — фронт редиректит на checkoutUrl.
    """
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    bid_id = body.get("bidId")
    if not bid_id:
        raise HTTPException(400, "bidId is required")

    db = get_db()
    req = await db.service_requests.find_one({"id": request_id}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Request not found")
    if req.get("customerId") != user_id:
        raise HTTPException(403, "Only owner can accept bids")
    if req.get("status") not in ("open", "bidding"):
        raise HTTPException(400, f"Cannot accept bid: request is {req.get('status')}")

    bid = await db.service_bids.find_one({"id": bid_id, "requestId": request_id}, {"_id": 0})
    if not bid:
        raise HTTPException(404, "Bid not found for this request")

    now = now_utc().isoformat()

    # 1) Bids: accepted + rejected (остальные)
    await db.service_bids.update_one(
        {"id": bid_id},
        {"$set": {"status": "accepted", "acceptedAt": now}},
    )
    await db.service_bids.update_many(
        {"requestId": request_id, "id": {"$ne": bid_id}, "status": "submitted"},
        {"$set": {"status": "rejected", "updatedAt": now}},
    )

    # 2) Sprint 3A — создаём service_payment + checkout
    from app.escrow.router_payments import create_payment_for_bid
    from app.escrow.gateway import get_gateway
    payment_doc = await create_payment_for_bid(request_doc=req, bid_doc=bid, db=db)
    gateway = get_gateway()
    session = gateway.create_checkout_session(
        payment_id=payment_doc["id"],
        amount_cents=int(payment_doc["grossAmount"] * 100),
        currency=payment_doc["currency"],
        description=f"Service request {request_id}",
        metadata={
            "paymentId": payment_doc["id"],
            "requestId": request_id,
            "bidId": bid_id,
        },
    )
    await db.service_payments.update_one(
        {"id": payment_doc["id"]},
        {"$set": {
            "stripeSessionId": session["sessionId"],
            "stripePaymentIntentId": session["paymentIntentId"],
            "stripeCheckoutUrl": session["checkoutUrl"],
            "updatedAt": now_utc().isoformat(),
        }},
    )
    payment_doc.update({
        "stripeSessionId": session["sessionId"],
        "stripePaymentIntentId": session["paymentIntentId"],
        "stripeCheckoutUrl": session["checkoutUrl"],
    })

    # 3) Заявка → awaiting_payment (escrow)
    await db.service_requests.update_one(
        {"id": request_id},
        {"$set": {
            "status": "awaiting_payment",
            "acceptedBidId": bid_id,
            "assignedProviderId": bid["providerId"],
            "paymentId": payment_doc["id"],
            "updatedAt": now,
        }},
    )

    logger.info(
        f"[service_marketplace] {request_id} → awaiting_payment "
        f"(provider={bid['providerId']}, payment={payment_doc['id']}, gross=€{payment_doc['grossAmount']})"
    )

    # Sprint 4 — timeline events: bid_accepted + provider_matched
    try:
        from app.service_chat.timeline import append_event
        await append_event(request_id=request_id, kind="provider_matched",
                           actor_role="system", meta={"providerId": bid["providerId"]}, db=db)
        await append_event(request_id=request_id, kind="bid_accepted",
                           actor_role="customer", actor_id=user_id,
                           meta={"bidId": bid_id, "providerId": bid["providerId"], "price": bid.get("price")},
                           db=db)
    except Exception as e:
        logger.warning(f"[service_marketplace] timeline events failed: {e}")

    # ВАЖНО: до оплаты контакты провайдера НЕ открываем — public-проекция bid'а.
    bid_public = {k: v for k, v in bid.items() if k not in ("providerPhone", "providerEmail")}
    return {
        "ok": True,
        "request": {
            **req,
            "status": "awaiting_payment",
            "acceptedBidId": bid_id,
            "assignedProviderId": bid["providerId"],
            "paymentId": payment_doc["id"],
        },
        "bid": {**bid_public, "status": "accepted"},
        "payment": payment_doc,
        "checkoutUrl": session["checkoutUrl"],
        "message": "Bid принят. Перейдите к оплате — после оплаты контакты исполнителя откроются.",
    }


# ── POST /api/service-requests/{id}/complete (Sprint 3A) ─────────────────
@router.post("/api/service-requests/{request_id}/complete")
async def complete_request(request_id: str, request: Request):
    """Клиент подтверждает выполнение работы (или провайдер отмечает done).

    После этого статус заявки → 'completed', что разрешает release escrow.
    """
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    role = payload.get("role") or payload.get("kind")
    db = get_db()
    req = await db.service_requests.find_one({"id": request_id}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Request not found")
    is_owner = req.get("customerId") == user_id
    is_provider = req.get("assignedProviderId") == user_id
    is_admin = role == "admin"
    if not (is_owner or is_provider or is_admin):
        raise HTTPException(403, "Only owner, assigned provider or admin can complete")
    if req.get("status") not in ("paid", "in_progress"):
        raise HTTPException(400, f"Cannot complete: status={req.get('status')}")
    now = now_utc().isoformat()
    await db.service_requests.update_one(
        {"id": request_id},
        {"$set": {"status": "completed", "completedAt": now, "completedBy": user_id, "updatedAt": now}},
    )
    # Sprint 4 — timeline event
    try:
        from app.service_chat.timeline import append_event
        await append_event(request_id=request_id, kind="work_completed",
                           actor_role=("customer" if is_owner else "provider" if is_provider else "admin"),
                           actor_id=user_id, db=db)
        if is_owner:
            await append_event(request_id=request_id, kind="release_confirmed",
                               actor_role="customer", actor_id=user_id, db=db)
    except Exception as e:
        logger.warning(f"[service_marketplace] complete timeline failed: {e}")
    return {"ok": True, "status": "completed", "completedAt": now}


# ── POST /api/service-requests/{id}/cancel ───────────────────────────────
@router.post("/api/service-requests/{request_id}/cancel")
async def cancel_request(
    request_id: str,
    request: Request,
):
    """Клиент отменяет свою заявку."""
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    db = get_db()
    req = await db.service_requests.find_one({"id": request_id}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Request not found")
    if req.get("customerId") != user_id:
        raise HTTPException(403, "Only owner can cancel")
    if req.get("status") in ("completed", "cancelled"):
        raise HTTPException(400, f"Already {req['status']}")

    now = now_utc().isoformat()
    await db.service_requests.update_one(
        {"id": request_id},
        {"$set": {"status": "cancelled", "updatedAt": now}},
    )
    await db.service_bids.update_many(
        {"requestId": request_id, "status": "submitted"},
        {"$set": {"status": "expired", "updatedAt": now}},
    )
    return {"ok": True, "status": "cancelled"}
