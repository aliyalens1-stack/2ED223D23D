"""Sprint 3A — Admin Revenue Dashboard.

Endpoint: GET /api/admin/revenue/dashboard

Метрики:
  - grossRevenue        — сумма paid+released платежей за период
  - pendingEscrow       — сумма paid (но не released) — деньги в эскроу
  - releasedPayouts     — сумма released — что уже передано исполнителям
  - platformCommission  — сумма наших комиссий
  - mrr                 — MRR от подписок (active subscriptions * priceMonthly)
  - activeSubscriptions — количество active по тарифам
  - paymentsByCategory  — выручка по категориям заявок
  - paymentsByCity      — выручка по городам
"""
from __future__ import annotations
import logging
from datetime import timedelta
from fastapi import APIRouter, Depends, Query

from app.core.utils import now_utc
from app.core.db import get_db
from app.core.security import verify_admin_token


logger = logging.getLogger(__name__)
admin_revenue_router = APIRouter(
    prefix="/api/admin/revenue",
    tags=["escrow:admin"],
    dependencies=[Depends(verify_admin_token)],
)


@admin_revenue_router.get("/dashboard")
async def revenue_dashboard(period_days: int = Query(30, ge=1, le=365)):
    """Сводка по escrow + subscriptions за period_days дней."""
    db = get_db()
    now = now_utc()
    period_start_iso = (now - timedelta(days=period_days)).isoformat()

    # 1) GROSS REVENUE — paid + released
    pipeline_gross = [
        {"$match": {"status": {"$in": ["paid", "released"]}, "paidAt": {"$gte": period_start_iso}}},
        {"$group": {
            "_id": None,
            "gross": {"$sum": "$grossAmount"},
            "commission": {"$sum": "$commissionAmount"},
            "payout": {"$sum": "$providerPayout"},
            "count": {"$sum": 1},
        }},
    ]
    gross_data = await db.service_payments.aggregate(pipeline_gross).to_list(1)
    g = gross_data[0] if gross_data else {"gross": 0, "commission": 0, "payout": 0, "count": 0}

    # 2) PENDING ESCROW — paid (не released).
    # ВАЖНО: этот показатель НЕ ограничен period_days, потому что это «состояние»
    # на текущий момент: сколько денег платформа удерживает прямо сейчас. Все
    # остальные метрики ниже — это «оборот» за period_days (paid_at в окне).
    pipeline_escrow = [
        {"$match": {"status": "paid"}},
        {"$group": {"_id": None, "amount": {"$sum": "$grossAmount"}, "count": {"$sum": 1}}},
    ]
    escrow_data = await db.service_payments.aggregate(pipeline_escrow).to_list(1)
    e = escrow_data[0] if escrow_data else {"amount": 0, "count": 0}

    # 3) RELEASED PAYOUTS
    pipeline_released = [
        {"$match": {"status": "released", "releasedAt": {"$gte": period_start_iso}}},
        {"$group": {"_id": None, "amount": {"$sum": "$providerPayout"}, "count": {"$sum": 1}}},
    ]
    rel_data = await db.service_payments.aggregate(pipeline_released).to_list(1)
    r = rel_data[0] if rel_data else {"amount": 0, "count": 0}

    # 4) SUBSCRIPTIONS — MRR + breakdown by plan
    pipeline_subs = [
        {"$match": {"status": "active"}},
        {"$group": {
            "_id": "$plan",
            "count": {"$sum": 1},
            "monthly": {"$sum": "$priceMonthly"},
        }},
    ]
    subs_by_plan = []
    mrr = 0
    total_active = 0
    async for d in db.provider_subscriptions.aggregate(pipeline_subs):
        subs_by_plan.append({"plan": d["_id"], "count": d["count"], "monthly": d["monthly"]})
        mrr += d["monthly"]
        total_active += d["count"]

    # 5) BY CATEGORY (paid+released)
    pipeline_cat = [
        {"$match": {"status": {"$in": ["paid", "released"]}, "paidAt": {"$gte": period_start_iso}}},
        {"$group": {"_id": "$category", "revenue": {"$sum": "$grossAmount"}, "commission": {"$sum": "$commissionAmount"}, "count": {"$sum": 1}}},
        {"$sort": {"revenue": -1}},
    ]
    by_cat = []
    async for d in db.service_payments.aggregate(pipeline_cat):
        by_cat.append({"category": d["_id"], "revenue": d["revenue"], "commission": d["commission"], "count": d["count"]})

    # 6) BY CITY
    pipeline_city = [
        {"$match": {"status": {"$in": ["paid", "released"]}, "paidAt": {"$gte": period_start_iso}}},
        {"$group": {"_id": "$city", "revenue": {"$sum": "$grossAmount"}, "count": {"$sum": 1}}},
        {"$sort": {"revenue": -1}},
        {"$limit": 20},
    ]
    by_city = []
    async for d in db.service_payments.aggregate(pipeline_city):
        by_city.append({"city": d["_id"], "revenue": d["revenue"], "count": d["count"]})

    # 7) FUNNEL — payments by status (last period)
    funnel_pipeline = [
        {"$match": {"createdAt": {"$gte": period_start_iso}}},
        {"$group": {"_id": "$status", "count": {"$sum": 1}, "amount": {"$sum": "$grossAmount"}}},
    ]
    funnel = []
    async for d in db.service_payments.aggregate(funnel_pipeline):
        funnel.append({"status": d["_id"], "count": d["count"], "amount": d["amount"]})

    return {
        "periodDays": period_days,
        "currency": "EUR",
        "grossRevenue": round(g["gross"] or 0, 2),
        "platformCommission": round(g["commission"] or 0, 2),
        "providerPayoutTotal": round(g["payout"] or 0, 2),
        "transactionsCount": g["count"],
        "pendingEscrow": {
            "amount": round(e["amount"] or 0, 2),
            "count": e["count"],
        },
        "releasedPayouts": {
            "amount": round(r["amount"] or 0, 2),
            "count": r["count"],
        },
        "subscriptions": {
            "mrr": round(mrr, 2),
            "arr": round(mrr * 12, 2),
            "activeTotal": total_active,
            "byPlan": subs_by_plan,
        },
        "byCategory": by_cat,
        "byCity": by_city,
        "funnel": funnel,
        "computedAt": now.isoformat(),
    }
