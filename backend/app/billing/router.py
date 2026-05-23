"""app.billing.router — Sprint 21 C16 extraction from server.py.

Все endpoints /api/provider/billing/* + /api/experiments/* перенесены 1-в-1 (без изменения поведения).
Зависимости, которые раньше жили в server.py module scope, теперь берутся
из app.core.* (ctx, db, config, security).
"""
from __future__ import annotations
import random
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Request, Response, HTTPException, Depends
from fastapi.responses import JSONResponse

from app.core.config import NESTJS_URL, JWT_SECRET, JWT_ALGO
from app.core.context import ctx
from app.core.db import db
from app.core.geo import currency_for_country
from app.core.security import verify_admin_token
from app.core.utils import now_utc, uid


logger = logging.getLogger("server")

router = APIRouter()

# shim: старый код использует `http_client` как имя. Резолвим в runtime через ctx.
class _HttpClientProxy:
    def __getattr__(self, name):
        return getattr(ctx.http_client, name)

http_client = _HttpClientProxy()


# ── Products catalog (moved from server.py C16) ──
BILLING_PRODUCTS = [
    {"code": "promoted_7d", "name": "Promoted на 7 дней", "price": 499, "currency": "UAH", "durationDays": 7, "featureFlags": {"promoted": True, "priority": False, "vip": False}, "config": {"promotionBoost": 0.15, "promotedLabel": "⭐ Рекомендуем"}, "icon": "⭐", "benefit": "+40% просмотров, +20% заказов"},
    {"code": "priority_7d", "name": "Priority на 7 дней", "price": 699, "currency": "UAH", "durationDays": 7, "featureFlags": {"promoted": False, "priority": True, "vip": False}, "config": {"priorityLevel": 1, "priorityWindowSeconds": 20}, "icon": "🔥", "benefit": "Получаете заявки первыми, +37% заказов"},
    {"code": "vip_7d", "name": "VIP на 7 дней", "price": 999, "currency": "UAH", "durationDays": 7, "featureFlags": {"promoted": True, "priority": True, "vip": True}, "config": {"promotionBoost": 0.20, "promotedLabel": "🏆 VIP", "priorityLevel": 2, "priorityWindowSeconds": 25}, "icon": "🏆", "benefit": "Максимум заказов + Priority + Promoted"},
    {"code": "promoted_30d", "name": "Promoted на 30 дней", "price": 1499, "currency": "UAH", "durationDays": 30, "featureFlags": {"promoted": True, "priority": False, "vip": False}, "config": {"promotionBoost": 0.18, "promotedLabel": "⭐ Рекомендуем"}, "icon": "⭐", "benefit": "+40% просмотров на месяц"},
    {"code": "vip_30d", "name": "VIP на 30 дней", "price": 2999, "currency": "UAH", "durationDays": 30, "featureFlags": {"promoted": True, "priority": True, "vip": True}, "config": {"promotionBoost": 0.22, "promotedLabel": "🏆 VIP", "priorityLevel": 2, "priorityWindowSeconds": 25}, "icon": "🏆", "benefit": "Полный VIP на месяц"},
    # ── Paid Boost (multiplicative ranking boost) — Sprint 25 ──
    {"code": "boost_basic_7d", "name": "Boost Basic 7д", "price": 299, "currency": "UAH", "durationDays": 7, "featureFlags": {"boost": True}, "config": {"boostLevel": "basic", "boostMultiplier": 1.2}, "icon": "⚡", "benefit": "+20% к позиции — больше заявок"},
    {"code": "boost_pro_7d", "name": "Boost PRO 7д", "price": 599, "currency": "UAH", "durationDays": 7, "featureFlags": {"boost": True}, "config": {"boostLevel": "pro", "boostMultiplier": 1.5}, "icon": "🚀", "benefit": "+50% к позиции — поток заказов x1.5"},
    {"code": "boost_max_7d", "name": "Boost MAX 7д", "price": 999, "currency": "UAH", "durationDays": 7, "featureFlags": {"boost": True}, "config": {"boostLevel": "max", "boostMultiplier": 2.0}, "icon": "🔥", "benefit": "x2 к позиции — максимальный поток"},
    # ── Sprint 26: 24h Boost SKUs (быстрая проверка эффекта, низкий вход) ──
    {"code": "boost_basic_24h", "name": "Boost Базовый", "price": 199, "currency": "UAH", "durationDays": 1, "featureFlags": {"boost": True}, "config": {"boostLevel": "basic_24h", "boostMultiplier": 1.3}, "icon": "⚡", "benefit": "×1.3 — больше заявок 24 часа"},
    {"code": "boost_top_24h", "name": "Boost Топ", "price": 399, "currency": "UAH", "durationDays": 1, "featureFlags": {"boost": True}, "config": {"boostLevel": "top_24h", "boostMultiplier": 1.5}, "icon": "🚀", "benefit": "×1.5 — приоритет в выдаче 24 часа"},
    {"code": "boost_max_24h", "name": "Boost Доминация", "price": 699, "currency": "UAH", "durationDays": 1, "featureFlags": {"boost": True}, "config": {"boostLevel": "max_24h", "boostMultiplier": 2.0}, "icon": "🔥", "benefit": "×2 — топ выдачи на 24 часа"},
]



@router.get("/api/provider/billing/products")
async def get_billing_products(country: Optional[str] = None, providerSlug: Optional[str] = None):
    """Return billing products priced in the provider's country currency.

    Resolution:
    1) Explicit `country` query param (ISO-2: DE/AT/LV/LT/EE/BY/UA) — highest priority.
    2) `providerSlug` → org.country → currency.
    3) Default: UAH (legacy behaviour).

    Prices in `BILLING_PRODUCTS` are denominated in UAH. We rebase them
    using `_BILLING_FX` (UAH→target) when target currency != UAH.
    """
    target_currency = "UAH"

    if country:
        target_currency = currency_for_country(country)
    elif providerSlug:
        org = await db.organizations.find_one(
            {"slug": providerSlug}, {"_id": 0, "country": 1, "city": 1}
        )
        if org:
            target_currency = currency_for_country(org.get("country"))

    if target_currency == "UAH":
        return {"products": BILLING_PRODUCTS, "currency": "UAH"}

    fx = _BILLING_FX.get(target_currency, 1.0)
    rebased = []
    for p in BILLING_PRODUCTS:
        new_price = round(p["price"] * fx, 2) if fx < 1 else int(p["price"] * fx)
        rebased.append({**p, "price": new_price, "currency": target_currency})
    return {"products": rebased, "currency": target_currency}


# FX table: UAH → target currency. Approximate, not for accounting — these
# are display prices. Real FX comes from Stripe/PayPal at checkout time.
# Source: typical 2026 mid-market rates, rounded for stable display.
_BILLING_FX: dict[str, float] = {
    "EUR": 0.023,   # 1 UAH ≈ 0.023 EUR
    "BYN": 0.077,   # 1 UAH ≈ 0.077 BYN
    "USD": 0.025,
    "UAH": 1.0,
}



@router.get("/api/provider/billing/status")
async def get_billing_status(provider_slug: str = "avtomaster-pro"):
    """Get current monetization status of provider"""
    org = await db.organizations.find_one({"slug": provider_slug}, {"_id": 0, "slug": 1, "name": 1, "isPromoted": 1, "promotionBoost": 1, "promotedLabel": 1, "hasPriorityAccess": 1, "priorityLevel": 1})
    ent = await db.provider_entitlements.find_one({"providerSlug": provider_slug}, {"_id": 0})
    purchases = await db.provider_purchases.find({"providerSlug": provider_slug}, {"_id": 0}).sort("createdAt", -1).to_list(10)
    return {"provider": org, "entitlement": ent, "purchases": purchases, "activePlans": [p for p in purchases if p.get("status") == "paid" and p.get("endsAt", "") > now_utc().isoformat()]}



@router.post("/api/provider/billing/checkout")
async def provider_billing_checkout(request: Request):
    """Create a billing checkout (simulated payment for now)"""
    body = await request.json()
    product_code = body.get("productCode")
    provider_slug = body.get("providerSlug", "avtomaster-pro")
    
    product = next((p for p in BILLING_PRODUCTS if p["code"] == product_code), None)
    if not product:
        raise HTTPException(400, "Product not found")
    
    now = now_utc()
    ends_at = now + timedelta(days=product["durationDays"])
    
    purchase = {
        "id": uid(), "providerSlug": provider_slug, "productCode": product_code,
        "productName": product["name"], "amount": product["price"], "currency": product["currency"],
        "status": "paid", "durationDays": product["durationDays"],
        "startsAt": now.isoformat(), "endsAt": ends_at.isoformat(),
        "paidAt": now.isoformat(), "createdAt": now.isoformat(),
        "featureFlags": product["featureFlags"], "config": product["config"],
    }
    await db.provider_purchases.insert_one(purchase)
    purchase.pop("_id", None)
    
    # ── ENTITLEMENT ENGINE: activate features ──
    config = product["config"]
    flags = product["featureFlags"]
    update = {"updatedAt": now.isoformat()}
    org_update = {}
    
    if flags.get("promoted"):
        update["promotedActive"] = True
        update["promotedBoost"] = config.get("promotionBoost", 0.15)
        update["promotedLabel"] = config.get("promotedLabel", "⭐ Рекомендуем")
        update["promotedEndsAt"] = ends_at.isoformat()
        org_update["isPromoted"] = True
        org_update["promotionBoost"] = config.get("promotionBoost", 0.15)
        org_update["promotedLabel"] = config.get("promotedLabel")
    
    if flags.get("priority"):
        update["priorityActive"] = True
        update["priorityLevel"] = config.get("priorityLevel", 1)
        update["priorityWindowSeconds"] = config.get("priorityWindowSeconds", 20)
        update["priorityEndsAt"] = ends_at.isoformat()
        org_update["hasPriorityAccess"] = True
        org_update["priorityLevel"] = config.get("priorityLevel", 1)
        org_update["priorityWindowSeconds"] = config.get("priorityWindowSeconds", 20)
    
    if flags.get("vip"):
        update["vipActive"] = True
        org_update["promotionPlan"] = "vip"

    # ── Sprint 25: Paid Boost (multiplicative ranking) ──
    if flags.get("boost"):
        boost_level = config.get("boostLevel", "basic")
        boost_mult = max(1.0, min(2.0, float(config.get("boostMultiplier", 1.0))))
        update["boostActive"] = True
        update["boostLevel"] = boost_level
        update["boostMultiplier"] = boost_mult
        update["boostEndsAt"] = ends_at.isoformat()
        org_update["boostLevel"] = boost_level
        org_update["boostMultiplier"] = boost_mult
        org_update["boostEndsAt"] = ends_at.isoformat()
        # analytics
        await db.boost_events.insert_one({
            "id": uid(), "type": "boost_purchased", "providerSlug": provider_slug,
            "level": boost_level, "multiplier": boost_mult, "amount": product["price"],
            "endsAt": ends_at.isoformat(), "createdAt": now.isoformat(),
        })

    await db.provider_entitlements.update_one({"providerSlug": provider_slug}, {"$set": {**update, "providerSlug": provider_slug}}, upsert=True)
    if org_update:
        await db.organizations.update_one({"slug": provider_slug}, {"$set": org_update})
    
    return {"purchase": purchase, "status": "activated", "endsAt": ends_at.isoformat()}



@router.get("/api/provider/billing/purchases")
async def get_billing_purchases(provider_slug: str = "avtomaster-pro"):
    """Get purchase history"""
    purchases = await db.provider_purchases.find({"providerSlug": provider_slug}, {"_id": 0}).sort("createdAt", -1).to_list(20)
    return {"purchases": purchases}


# ── Sprint 25: Paid Boost convenience endpoints ──
BOOST_LEVEL_TO_CODE = {
    # 7-day SKUs
    "basic": "boost_basic_7d",
    "pro": "boost_pro_7d",
    "max": "boost_max_7d",
    # 24-hour SKUs (Sprint 26)
    "basic_24h": "boost_basic_24h",
    "top_24h":   "boost_top_24h",
    "max_24h":   "boost_max_24h",
}


@router.get("/api/billing/boost/products")
async def get_boost_products():
    """Return only Paid Boost products (subset of BILLING_PRODUCTS)."""
    boosts = [p for p in BILLING_PRODUCTS if p.get("featureFlags", {}).get("boost")]
    return {"products": boosts}


@router.post("/api/billing/boost/purchase")
async def purchase_boost(request: Request):
    """Purchase a Paid Boost. Body: {providerSlug, level: 'basic'|'pro'|'max'}.

    Reuses provider_billing_checkout flow internally so entitlement+org+analytics
    stay consistent. Idempotent via Stripe webhook in prod; here we simulate paid.
    """
    body = await request.json()
    level = (body.get("level") or "").lower()
    provider_slug = body.get("providerSlug", "avtomaster-pro")
    code = BOOST_LEVEL_TO_CODE.get(level)
    if not code:
        raise HTTPException(400, "Invalid boost level (basic|pro|max)")

    # Delegate to existing checkout (1-в-1 та же активация)
    from starlette.requests import Request as _Req
    forwarded = {"productCode": code, "providerSlug": provider_slug}

    # Manual replay of provider_billing_checkout body using product directly:
    product = next((p for p in BILLING_PRODUCTS if p["code"] == code), None)
    if not product:
        raise HTTPException(500, "Boost product missing")

    now = now_utc()
    ends_at = now + timedelta(days=product["durationDays"])
    purchase = {
        "id": uid(), "providerSlug": provider_slug, "productCode": code,
        "productName": product["name"], "amount": product["price"], "currency": product["currency"],
        "status": "paid", "durationDays": product["durationDays"],
        "startsAt": now.isoformat(), "endsAt": ends_at.isoformat(),
        "paidAt": now.isoformat(), "createdAt": now.isoformat(),
        "featureFlags": product["featureFlags"], "config": product["config"],
    }
    await db.provider_purchases.insert_one(purchase)
    purchase.pop("_id", None)

    boost_mult = max(1.0, min(2.0, float(product["config"]["boostMultiplier"])))
    await db.provider_entitlements.update_one(
        {"providerSlug": provider_slug},
        {"$set": {
            "providerSlug": provider_slug,
            "boostActive": True,
            "boostLevel": level,
            "boostMultiplier": boost_mult,
            "boostEndsAt": ends_at.isoformat(),
            "updatedAt": now.isoformat(),
        }},
        upsert=True,
    )
    await db.organizations.update_one(
        {"slug": provider_slug},
        {"$set": {"boostLevel": level, "boostMultiplier": boost_mult, "boostEndsAt": ends_at.isoformat()}},
    )
    await db.boost_events.insert_one({
        "id": uid(), "type": "boost_purchased", "providerSlug": provider_slug,
        "level": level, "multiplier": boost_mult, "amount": product["price"],
        "endsAt": ends_at.isoformat(), "createdAt": now.isoformat(),
    })
    return {"status": "activated", "purchase": purchase, "boostLevel": level, "boostMultiplier": boost_mult, "endsAt": ends_at.isoformat()}


@router.get("/api/billing/boost/status")
async def boost_status(providerSlug: str = "avtomaster-pro"):
    """Current boost state for a provider (level / multiplier / expiry)."""
    ent = await db.provider_entitlements.find_one({"providerSlug": providerSlug}, {"_id": 0}) or {}
    now_iso = now_utc().isoformat()
    active = bool(ent.get("boostActive")) and (ent.get("boostEndsAt", "") or "") > now_iso
    return {
        "providerSlug": providerSlug,
        "active": active,
        "level": ent.get("boostLevel") if active else None,
        "multiplier": float(ent.get("boostMultiplier", 1.0)) if active else 1.0,
        "endsAt": ent.get("boostEndsAt") if active else None,
    }


# ── Sprint 26: alias endpoint matching SPRINT spec exactly ──
@router.post("/api/provider/boost/buy")
async def provider_boost_buy(request: Request):
    """Sprint 26 alias: same effect as POST /api/billing/boost/purchase.

    Body: {"providerSlug": "...", "plan": "basic_24h"|"top_24h"|"max_24h"|"basic"|"pro"|"max"}
    """
    body = await request.json()
    plan = (body.get("plan") or body.get("level") or "").lower()
    provider_slug = body.get("providerSlug", "avtomaster-pro")
    code = BOOST_LEVEL_TO_CODE.get(plan)
    if not code:
        raise HTTPException(400, f"Invalid plan '{plan}'. Allowed: {list(BOOST_LEVEL_TO_CODE.keys())}")

    product = next((p for p in BILLING_PRODUCTS if p["code"] == code), None)
    if not product:
        raise HTTPException(500, "Boost product missing")

    now = now_utc()
    ends_at = now + timedelta(days=product["durationDays"])
    boost_mult = max(1.0, min(2.0, float(product["config"]["boostMultiplier"])))
    boost_level = product["config"].get("boostLevel", plan)

    purchase = {
        "id": uid(), "providerSlug": provider_slug, "productCode": code,
        "productName": product["name"], "amount": product["price"], "currency": product["currency"],
        "status": "paid", "durationDays": product["durationDays"],
        "startsAt": now.isoformat(), "endsAt": ends_at.isoformat(),
        "paidAt": now.isoformat(), "createdAt": now.isoformat(),
        "featureFlags": product["featureFlags"], "config": product["config"],
    }
    await db.provider_purchases.insert_one(purchase)
    purchase.pop("_id", None)

    # boost-specific collection (Sprint 26 spec)
    await db.provider_boosts.insert_one({
        "id": uid(),
        "providerSlug": provider_slug,
        "plan": plan,
        "boostLevel": boost_level,
        "multiplier": boost_mult,
        "amount": product["price"],
        "currency": product["currency"],
        "active": True,
        "startsAt": now.isoformat(),
        "expiresAt": ends_at.isoformat(),
        "createdAt": now.isoformat(),
    })

    # entitlement + organization (kept in sync with /api/billing/boost/purchase)
    await db.provider_entitlements.update_one(
        {"providerSlug": provider_slug},
        {"$set": {
            "providerSlug": provider_slug,
            "boostActive": True,
            "boostLevel": boost_level,
            "boostMultiplier": boost_mult,
            "boostEndsAt": ends_at.isoformat(),
            "updatedAt": now.isoformat(),
        }},
        upsert=True,
    )
    await db.organizations.update_one(
        {"slug": provider_slug},
        {"$set": {"boostLevel": boost_level, "boostMultiplier": boost_mult, "boostEndsAt": ends_at.isoformat()}},
    )
    await db.boost_events.insert_one({
        "id": uid(), "type": "boost_purchased", "providerSlug": provider_slug,
        "level": boost_level, "multiplier": boost_mult, "amount": product["price"],
        "endsAt": ends_at.isoformat(), "createdAt": now.isoformat(),
    })

    return {
        "status": "activated",
        "providerSlug": provider_slug,
        "plan": plan,
        "boostLevel": boost_level,
        "multiplier": boost_mult,
        "amount": product["price"],
        "currency": product["currency"],
        "expiresAt": ends_at.isoformat(),
        "purchase": purchase,
    }


@router.get("/api/admin/billing/boost/analytics")
async def boost_analytics(_=Depends(verify_admin_token)):
    """Aggregate boost revenue + conversion for admin dashboard."""
    events = await db.boost_events.find({}, {"_id": 0}).sort("createdAt", -1).to_list(500)
    revenue = sum(e.get("amount", 0) for e in events if e.get("type") == "boost_purchased")
    by_level: dict = {}
    for e in events:
        if e.get("type") != "boost_purchased":
            continue
        lvl = e.get("level", "unknown")
        slot = by_level.setdefault(lvl, {"count": 0, "revenue": 0})
        slot["count"] += 1
        slot["revenue"] += e.get("amount", 0)
    won = sum(1 for e in events if e.get("type") == "boost_won_request")
    applied = sum(1 for e in events if e.get("type") == "boost_applied")
    active_count = await db.provider_entitlements.count_documents({"boostActive": True})
    return {
        "totals": {"revenue": revenue, "purchases": sum(s["count"] for s in by_level.values()), "activeProviders": active_count},
        "byLevel": by_level,
        "engagement": {"applied": applied, "won": won, "winRate": round(won / max(applied, 1) * 100, 1)},
        "recent": events[:20],
    }





# ── A/B TESTING ──
@router.get("/api/experiments/active")
async def get_active_experiments():
    """Get active A/B experiments"""
    experiments = await db.experiments.find({"isActive": True}, {"_id": 0}).to_list(20)
    if not experiments:
        experiments = [
            {"id": "exp_promoted_label", "name": "Promoted Label Test", "isActive": True, "variants": [
                {"name": "A", "config": {"label": "⭐ Рекомендуем"}, "trafficPercent": 50},
                {"name": "B", "config": {"label": "🔥 Топ выбор"}, "trafficPercent": 50},
            ]},
            {"id": "exp_cta_text", "name": "CTA Text Test", "isActive": True, "variants": [
                {"name": "A", "config": {"text": "Быстрый запрос"}, "trafficPercent": 50},
                {"name": "B", "config": {"text": "Найти мастера за 10 сек"}, "trafficPercent": 50},
            ]},
            {"id": "exp_priority_inbox", "name": "Priority Inbox Text", "isActive": True, "variants": [
                {"name": "A", "config": {"text": "🔥 Приоритетная заявка"}, "trafficPercent": 50},
                {"name": "B", "config": {"text": "⚡ Вы получили раньше всех"}, "trafficPercent": 50},
            ]},
        ]
    return {"experiments": experiments}



@router.post("/api/experiments")
async def create_experiment(request: Request, _=Depends(verify_admin_token)):
    """Create A/B experiment"""
    body = await request.json()
    exp = {"id": uid(), **body, "isActive": True, "createdAt": now_utc().isoformat()}
    await db.experiments.insert_one(exp)
    exp.pop("_id", None)
    return exp



@router.post("/api/experiments/{exp_id}/toggle")
async def toggle_experiment(exp_id: str, _=Depends(verify_admin_token)):
    """Toggle experiment on/off"""
    exp = await db.experiments.find_one({"id": exp_id})
    if not exp:
        raise HTTPException(404, "Experiment not found")
    new_state = not exp.get("isActive", True)
    await db.experiments.update_one({"id": exp_id}, {"$set": {"isActive": new_state}})
    return {"id": exp_id, "isActive": new_state}



