"""Service Marketplace — admin endpoints.

Endpoints:
  GET    /api/admin/service-requests           — биржа со всеми заявками + фильтры
  GET    /api/admin/service-requests/stats     — агрегированная статистика
  GET    /api/admin/service-requests/{id}      — деталь + все bid'ы
  POST   /api/admin/service-requests/{id}/assign — ручное назначение исполнителя
  POST   /api/admin/service-requests/{id}/status — изменить статус (cancel/dispute/manual)
"""
from __future__ import annotations
import logging
from fastapi import APIRouter, HTTPException, Depends, Query

from app.core.utils import now_utc
from app.core.db import get_db
from app.core.security import verify_admin_token
from .models import AssignBody, UpdateStatusBody, CATEGORY_LIST

router = APIRouter(
    prefix="/api/admin/service-requests",
    tags=["service_marketplace:admin"],
    dependencies=[Depends(verify_admin_token)],
)
logger = logging.getLogger(__name__)


# ── GET /api/admin/service-requests ──────────────────────────────────────
@router.get("")
async def admin_list_requests(
    status: str | None = Query(None, description="open|bidding|assigned|in_progress|completed|cancelled|expired|disputed"),
    category: str | None = Query(None),
    city: str | None = Query(None),
    has_bids: bool | None = Query(None, description="Только заявки с откликами / без откликов"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """Полная биржа для админа: все заявки + фильтры."""
    db = get_db()
    q: dict = {}
    if status:
        q["status"] = status
    if category:
        q["category"] = category
    if city:
        q["city"] = city.lower()
    if has_bids is True:
        q["bidsCount"] = {"$gt": 0}
    elif has_bids is False:
        q["bidsCount"] = 0

    total = await db.service_requests.count_documents(q)
    items = await db.service_requests.find(q, {"_id": 0}).sort("createdAt", -1).skip(offset).limit(limit).to_list(limit)

    return {"requests": items, "total": total, "limit": limit, "offset": offset}


# ── GET /api/admin/service-requests/stats ────────────────────────────────
@router.get("/stats")
async def admin_stats():
    """Сводка по бирже: количество заявок по категориям и статусам + revenue."""
    db = get_db()
    pipeline_by_status = [
        {"$group": {"_id": "$status", "count": {"$sum": 1}}},
    ]
    pipeline_by_category = [
        {"$group": {"_id": "$category", "count": {"$sum": 1}}},
    ]
    pipeline_revenue = [
        # GMV (накопленный объём) — сумма всех accepted bid'ов
        {"$match": {"status": "accepted"}},
        {"$group": {
            "_id": None,
            "gmv": {"$sum": "$price"},
            "acceptedCount": {"$sum": 1},
        }},
    ]

    by_status = {d["_id"]: d["count"] async for d in db.service_requests.aggregate(pipeline_by_status)}
    by_category = {d["_id"]: d["count"] async for d in db.service_requests.aggregate(pipeline_by_category)}
    revenue_doc = await db.service_bids.aggregate(pipeline_revenue).to_list(1)
    gmv = (revenue_doc[0].get("gmv", 0) if revenue_doc else 0)
    accepted_count = (revenue_doc[0].get("acceptedCount", 0) if revenue_doc else 0)

    # Берём средний commission по принятым заявкам
    pipeline_commission = [
        {"$match": {"status": "assigned"}},
        {"$group": {
            "_id": None,
            "avgCommissionPct": {"$avg": "$commissionPct"},
        }},
    ]
    comm_doc = await db.service_requests.aggregate(pipeline_commission).to_list(1)
    avg_commission_pct = comm_doc[0]["avgCommissionPct"] if comm_doc else 0
    platform_revenue = int(gmv * (avg_commission_pct or 12) / 100)

    return {
        "byStatus": by_status,
        "byCategory": by_category,
        "total": sum(by_status.values()),
        "categories": CATEGORY_LIST,
        "gmv": gmv,
        "acceptedBidsCount": accepted_count,
        "avgCommissionPct": round(avg_commission_pct or 0, 1),
        "platformRevenue": platform_revenue,
        "currency": "EUR",
    }


# ── GET /api/admin/service-requests/{id} ─────────────────────────────────
@router.get("/{request_id}")
async def admin_get_request(request_id: str):
    """Полная инфа по заявке + все bid'ы (включая контакты провайдеров)."""
    db = get_db()
    doc = await db.service_requests.find_one({"id": request_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Service request not found")
    bids = await db.service_bids.find({"requestId": request_id}, {"_id": 0}).sort("createdAt", 1).to_list(100)
    return {"request": doc, "bids": bids}


# ── POST /api/admin/service-requests/{id}/assign ─────────────────────────
@router.post("/{request_id}/assign")
async def admin_assign(request_id: str, body: AssignBody):
    """Админ вручную назначает исполнителя (минуя bid-flow).
    Создаёт фейковый bid от имени админа со статусом accepted.
    """
    db = get_db()
    req = await db.service_requests.find_one({"id": request_id}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Request not found")
    if req["status"] in ("completed", "cancelled"):
        raise HTTPException(400, f"Cannot assign: request is {req['status']}")

    from app.core.utils import uid
    now = now_utc().isoformat()
    bid_id = uid()

    org = await db.organizations.find_one(
        {"$or": [{"id": body.providerId}, {"ownerUserId": body.providerId}]},
        {"_id": 0, "name": 1, "ratingAvg": 1, "phone": 1, "email": 1},
    )

    bid_doc = {
        "id": bid_id,
        "requestId": request_id,
        "providerId": body.providerId,
        "providerName": org.get("name") if org else "Manual Assignment",
        "providerRating": org.get("ratingAvg") if org else None,
        "providerPhone": org.get("phone") if org else None,
        "providerEmail": org.get("email") if org else None,
        "price": (req.get("budget") or {}).get("min") or 0,
        "currency": "EUR",
        "message": f"[Admin manual assignment] {body.note or ''}".strip(),
        "etaMinutes": None,
        "status": "accepted",
        "createdAt": now,
        "updatedAt": now,
        "acceptedAt": now,
        "adminAssigned": True,
    }
    await db.service_bids.insert_one(dict(bid_doc))

    await db.service_requests.update_one(
        {"id": request_id},
        {"$set": {
            "status": "assigned",
            "acceptedBidId": bid_id,
            "assignedProviderId": body.providerId,
            "updatedAt": now,
        }, "$inc": {"bidsCount": 1}},
    )
    bid_doc.pop("_id", None)
    logger.info(f"[admin] manually assigned {request_id} → {body.providerId}")
    return {"ok": True, "bid": bid_doc, "status": "assigned"}


# ── POST /api/admin/service-requests/{id}/status ────────────────────────
@router.post("/{request_id}/status")
async def admin_update_status(request_id: str, body: UpdateStatusBody):
    """Админ переводит заявку в любой статус (disputed / cancelled / manual)."""
    db = get_db()
    req = await db.service_requests.find_one({"id": request_id}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Request not found")
    now = now_utc().isoformat()
    await db.service_requests.update_one(
        {"id": request_id},
        {"$set": {
            "status": body.status,
            "updatedAt": now,
            "adminNote": body.note,
        }},
    )
    logger.info(f"[admin] {request_id} status → {body.status} ({body.note or ''})")
    return {"ok": True, "status": body.status}
