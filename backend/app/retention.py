"""app.retention — Sprint 30: Retention Engine v1.

Three pillars that turn missed/earned/goal into dopamine + FOMO:

    1. MISSED REVENUE — what offline providers lost while idle
    2. EARNINGS TREND — today vs yesterday + "best day" badge
    3. DAILY GOAL    — gamified progress bar, provider sets own or default

Collections
-----------
* `provider_missed_stats`  — rolling counter `{providerSlug, day(YYYY-MM-DD),
                              missedRequests, potentialRevenue, zones[], updatedAt}`
* `provider_daily_goals`   — `{providerSlug, amountUAH, createdAt, updatedAt}`

(Earnings trend is computed on the fly from `bookings` status=completed.)

Hooks
-----
* `quick_request_resolve` → fire-and-forget `track_missed_for_offline_providers(zone, price, slugs_online)`
* Admin retention dashboard via `GET /api/admin/retention` — DAU/WAU + churn.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request

from app.core.db import db
from app.core.security import verify_admin_token
from app.core.utils import now_utc, uid


router = APIRouter(tags=["retention"])
logger = logging.getLogger("retention")

# Default daily goal if provider hasn't set one
DEFAULT_DAILY_GOAL_UAH = 3000
# Missed stats window — how many days back we keep for FOMO
MISSED_WINDOW_DAYS = 7
# Offline threshold — "off >X hours" = candidate for smart re-engagement
OFFLINE_ALERT_HOURS = 24


def _today_key() -> str:
    return now_utc().strftime("%Y-%m-%d")


def _day_key(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d")


# ─────────────────────────────────────────────────────────────────────
# 1. MISSED REVENUE TRACKING
# ─────────────────────────────────────────────────────────────────────


async def track_missed_for_offline_providers(
    zone_id: Optional[str],
    potential_price: int,
    picked_slugs: list,
) -> None:
    """Called from quick_request_resolve after top-3 selection.

    Strategy: for every provider in the same zone that is OFFLINE and NOT
    in the picked top-3, increment their missed counter by 1 request and
    by potential_price UAH for today.

    Fire-and-forget (called via asyncio.create_task).
    """
    try:
        if not zone_id or potential_price <= 0:
            return
        # Find offline providers in this zone
        query: dict = {"status": "active", "isOnline": False}
        # Zone filter: provider has either `zone` field or `location` in zone
        # We match by zone name if the provider defines it
        offline = await db.organizations.find(
            query,
            {"_id": 0, "slug": 1, "zone": 1, "zoneId": 1, "name": 1},
        ).to_list(200)
        if not offline:
            return
        day = _today_key()
        now_iso = now_utc().isoformat()
        for org in offline:
            slug = org.get("slug")
            if not slug or slug in picked_slugs:
                continue
            # Zone match — either by zone/zoneId fields, or (fallback) always count
            # since offline providers should be aware of ANY activity in the city
            org_zone = org.get("zoneId") or org.get("zone")
            if org_zone and zone_id and org_zone != zone_id:
                continue
            await db.provider_missed_stats.update_one(
                {"providerSlug": slug, "day": day},
                {
                    "$inc": {"missedRequests": 1, "potentialRevenue": int(potential_price)},
                    "$addToSet": {"zones": zone_id},
                    "$set": {"updatedAt": now_iso},
                    "$setOnInsert": {"createdAt": now_iso},
                },
                upsert=True,
            )
    except Exception as e:
        logger.warning(f"track_missed failed: {e}")


async def _aggregate_missed(slug: str, days: int = MISSED_WINDOW_DAYS) -> dict:
    """Return rollup over last N days for a slug."""
    cutoff_day = _day_key(now_utc() - timedelta(days=days))
    cursor = db.provider_missed_stats.find(
        {"providerSlug": slug, "day": {"$gte": cutoff_day}},
        {"_id": 0},
    )
    docs = await cursor.to_list(100)
    total_missed = sum(int(d.get("missedRequests", 0) or 0) for d in docs)
    total_potential = sum(int(d.get("potentialRevenue", 0) or 0) for d in docs)
    zones_set: set = set()
    for d in docs:
        for z in (d.get("zones") or []):
            if z:
                zones_set.add(z)
    today_doc = next((d for d in docs if d.get("day") == _today_key()), None)
    avg_ticket = (total_potential // total_missed) if total_missed else 0
    return {
        "providerSlug": slug,
        "windowDays": days,
        "missedRequests": total_missed,
        "potentialRevenue": total_potential,
        "avgTicket": avg_ticket,
        "zones": sorted(list(zones_set)),
        "today": {
            "missedRequests": int((today_doc or {}).get("missedRequests", 0) or 0),
            "potentialRevenue": int((today_doc or {}).get("potentialRevenue", 0) or 0),
        },
    }


# ─────────────────────────────────────────────────────────────────────
# 2. EARNINGS TREND
# ─────────────────────────────────────────────────────────────────────


async def _sum_earnings(slug: str, day_start: datetime, day_end: datetime) -> int:
    """Sum finalPrice (or priceEstimate fallback) of completed bookings in window."""
    cursor = db.bookings.find(
        {
            "providerSlug": slug,
            "status": "completed",
            "completedAt": {
                "$gte": day_start.isoformat(),
                "$lt": day_end.isoformat(),
            },
        },
        {"_id": 0, "finalPrice": 1, "priceEstimate": 1},
    )
    docs = await cursor.to_list(500)
    return sum(int(d.get("finalPrice") or d.get("priceEstimate") or 0) for d in docs)


async def _compute_earnings_trend(slug: str) -> dict:
    now = now_utc()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_end = today_start + timedelta(days=1)
    yday_start = today_start - timedelta(days=1)

    today = await _sum_earnings(slug, today_start, today_end)
    yday = await _sum_earnings(slug, yday_start, today_start)

    # Best day in last 7
    week_ago = today_start - timedelta(days=7)
    # Scan last 7 days one by one (small N, fine)
    daily = []
    for i in range(7):
        d_start = week_ago + timedelta(days=i)
        d_end = d_start + timedelta(days=1)
        amt = await _sum_earnings(slug, d_start, d_end)
        daily.append({"day": _day_key(d_start), "amount": amt})
    best = max(daily, key=lambda x: x["amount"]) if daily else {"amount": 0}

    trend_pct = None
    trend_str = "—"
    if yday > 0:
        delta = (today - yday) / yday
        trend_pct = round(delta * 100, 1)
        sign = "+" if delta >= 0 else ""
        trend_str = f"{sign}{trend_pct}%"
    elif today > 0:
        trend_pct = 100.0
        trend_str = "+∞"

    is_best_day = today > 0 and today >= best["amount"]

    return {
        "today": today,
        "yesterday": yday,
        "trendPct": trend_pct,
        "trend": trend_str,
        "bestDay": is_best_day,
        "week": daily,
    }


# ─────────────────────────────────────────────────────────────────────
# 3. DAILY GOAL
# ─────────────────────────────────────────────────────────────────────


async def _get_daily_goal(slug: str) -> int:
    doc = await db.provider_daily_goals.find_one({"providerSlug": slug}, {"_id": 0})
    if not doc:
        return DEFAULT_DAILY_GOAL_UAH
    return int(doc.get("amountUAH") or DEFAULT_DAILY_GOAL_UAH)


async def _set_daily_goal(slug: str, amount: int) -> dict:
    amount = max(100, min(100_000, int(amount)))
    now_iso = now_utc().isoformat()
    await db.provider_daily_goals.update_one(
        {"providerSlug": slug},
        {
            "$set": {"amountUAH": amount, "updatedAt": now_iso, "providerSlug": slug},
            "$setOnInsert": {"createdAt": now_iso, "id": uid()},
        },
        upsert=True,
    )
    return {"providerSlug": slug, "amountUAH": amount}


# ─────────────────────────────────────────────────────────────────────
# Endpoints — Provider (public, queried by slug)
# ─────────────────────────────────────────────────────────────────────


@router.get("/api/provider/retention/missed")
async def provider_missed(providerSlug: str):
    """Missed revenue FOMO card data. Called from provider dashboard."""
    if not providerSlug:
        raise HTTPException(400, "providerSlug required")
    stats = await _aggregate_missed(providerSlug)
    # Copy message for the UI
    msg_lines = []
    if stats["today"]["missedRequests"] > 0:
        msg_lines.append(f"Сегодня вы пропустили {stats['today']['missedRequests']} заявок — ₴{stats['today']['potentialRevenue']}")
    if stats["missedRequests"] > 0:
        msg_lines.append(f"За {stats['windowDays']} дней потеряно ₴{stats['potentialRevenue']} ({stats['missedRequests']} заявок)")
    stats["fomoMessage"] = " · ".join(msg_lines) or "Пока всё спокойно — онлайн и принимаешь заявки"
    stats["ctaText"] = "Включить и забрать поток" if stats["missedRequests"] > 0 else "Оставаться онлайн"
    return stats


@router.get("/api/provider/retention/earnings")
async def provider_earnings_trend(providerSlug: str):
    """Today vs yesterday + best day dopamine card."""
    if not providerSlug:
        raise HTTPException(400, "providerSlug required")
    return await _compute_earnings_trend(providerSlug)


@router.get("/api/provider/retention/daily-goal")
async def provider_daily_goal(providerSlug: str):
    """Daily goal progress card."""
    if not providerSlug:
        raise HTTPException(400, "providerSlug required")
    goal = await _get_daily_goal(providerSlug)
    trend = await _compute_earnings_trend(providerSlug)
    today = int(trend["today"])
    pct = int(round(100 * today / goal)) if goal else 0
    pct = max(0, min(100, pct))
    remaining = max(0, goal - today)
    return {
        "providerSlug": providerSlug,
        "goalUAH": goal,
        "todayUAH": today,
        "progressPct": pct,
        "remainingUAH": remaining,
        "achieved": today >= goal,
        "ctaText": (
            f"Добить ещё ₴{remaining}" if remaining > 0 else "🏆 Цель достигнута — держи темп!"
        ),
    }


@router.post("/api/provider/retention/daily-goal")
async def set_provider_daily_goal(request: Request):
    """Provider sets their own goal. Body: {providerSlug, amountUAH}."""
    body = await request.json()
    slug = (body.get("providerSlug") or "").strip()
    amount = body.get("amountUAH") or body.get("amount")
    if not slug or amount is None:
        raise HTTPException(400, "providerSlug and amountUAH required")
    try:
        amount = int(amount)
    except Exception:
        raise HTTPException(400, "amountUAH must be int")
    return await _set_daily_goal(slug, amount)


@router.get("/api/provider/retention/hub")
async def provider_retention_hub(providerSlug: str):
    """Aggregated dashboard — missed + earnings + goal in one call."""
    if not providerSlug:
        raise HTTPException(400, "providerSlug required")
    missed = await _aggregate_missed(providerSlug)
    earnings = await _compute_earnings_trend(providerSlug)
    goal = await _get_daily_goal(providerSlug)
    today = int(earnings["today"])
    pct = int(round(100 * today / goal)) if goal else 0
    pct = max(0, min(100, pct))
    return {
        "missed": missed,
        "earnings": earnings,
        "goal": {
            "goalUAH": goal,
            "todayUAH": today,
            "progressPct": pct,
            "remainingUAH": max(0, goal - today),
            "achieved": today >= goal,
        },
    }


# ─────────────────────────────────────────────────────────────────────
# Admin retention dashboard
# ─────────────────────────────────────────────────────────────────────


@router.get("/api/admin/retention", dependencies=[Depends(verify_admin_token)])
async def admin_retention():
    """DAU / WAU / provider & customer retention / churn rate."""
    now = now_utc()
    day1 = now - timedelta(days=1)
    day7 = now - timedelta(days=7)
    day30 = now - timedelta(days=30)

    # DAU = users with any booking or login in last 24h
    # We use bookings.createdAt as the activity signal (customers) + quick_request_offers (providers)
    dau_customers = await db.bookings.distinct(
        "customerUserId",
        {"createdAt": {"$gte": day1.isoformat()}},
    )
    dau_providers = await db.quick_request_offers.distinct(
        "providerSlug",
        {"createdAt": {"$gte": day1.isoformat()}},
    )
    dau = len(set(dau_customers)) + len(set(dau_providers))

    wau_customers = await db.bookings.distinct(
        "customerUserId",
        {"createdAt": {"$gte": day7.isoformat()}},
    )
    wau_providers = await db.quick_request_offers.distinct(
        "providerSlug",
        {"createdAt": {"$gte": day7.isoformat()}},
    )
    wau = len(set(wau_customers)) + len(set(wau_providers))

    # Provider retention: #providers active in last 7d / total
    total_providers = await db.organizations.count_documents({"status": "active"})
    provider_ret = (len(set(wau_providers)) / total_providers) if total_providers else 0

    # Customer retention: returning customers with >=2 bookings in last 30d
    pipeline = [
        {"$match": {"createdAt": {"$gte": day30.isoformat()}}},
        {"$group": {"_id": "$customerUserId", "cnt": {"$sum": 1}}},
    ]
    rows = await db.bookings.aggregate(pipeline).to_list(10000)
    total_30d = len(rows)
    returning_30d = sum(1 for r in rows if int(r.get("cnt", 0)) >= 2)
    customer_ret = (returning_30d / total_30d) if total_30d else 0

    # Churn: providers that went offline >30d ago
    churn_cutoff = day30.isoformat()
    churned = await db.organizations.count_documents({
        "status": "active",
        "isOnline": False,
        "lastSeenAt": {"$lt": churn_cutoff},
    })
    churn_rate = (churned / total_providers) if total_providers else 0

    # Top missed by potential revenue (re-engagement targets)
    top_missed_cursor = db.provider_missed_stats.aggregate([
        {"$match": {"day": {"$gte": _day_key(day7)}}},
        {"$group": {
            "_id": "$providerSlug",
            "missedRequests": {"$sum": "$missedRequests"},
            "potentialRevenue": {"$sum": "$potentialRevenue"},
        }},
        {"$sort": {"potentialRevenue": -1}},
        {"$limit": 10},
    ])
    top_missed = []
    async for row in top_missed_cursor:
        top_missed.append({
            "providerSlug": row["_id"],
            "missedRequests": int(row.get("missedRequests", 0) or 0),
            "potentialRevenue": int(row.get("potentialRevenue", 0) or 0),
        })

    return {
        "dau": dau,
        "wau": wau,
        "dauCustomers": len(set(dau_customers)),
        "dauProviders": len(set(dau_providers)),
        "providerRetention": round(provider_ret, 3),
        "customerRetention": round(customer_ret, 3),
        "churnRate": round(churn_rate, 3),
        "returning30d": returning_30d,
        "totalCustomers30d": total_30d,
        "totalProviders": total_providers,
        "topMissed": top_missed,
    }
