"""app.push — Sprint 31: Unified push/notification system.

Strategy
--------
1. Try Expo Push API if user has a registered `push_tokens.expoPushToken`
2. Fallback: emit realtime event (in-app banner, already works via `/api/realtime/events` long-poll)

All money-triggered notifications route through here:
    * auction:outbid            — ставку обогнали → "Вернуть 1 место"
    * provider:new_request      — новая заявка рядом → "₴540, забери первым"
    * provider:offline_fomo     — пока офлайн: X заявок · ₴Y
    * provider:earnings_delta   — +₴540, сегодня ₴2068 🔥 +32%
    * booking:status_changed    — для клиента: мастер принял → в пути → работа → готово

Storage
-------
push_tokens: {
    userId|providerSlug, device, expoPushToken, platform, createdAt, updatedAt
}
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException, Request

from app.core.db import db
from app.core.realtime import emit_realtime_event
from app.core.utils import now_utc, uid


router = APIRouter(tags=["push"])
logger = logging.getLogger("push")

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"


# ─────────────────────────────────────────────────────────────────────
# Core send helper — always non-blocking, never raises
# ─────────────────────────────────────────────────────────────────────


async def send_push(
    target: dict,
    event_type: str,
    title: str,
    body: str,
    data: Optional[dict] = None,
) -> dict:
    """Send push OR realtime-emit fallback.

    target: {"userId": "..."} OR {"providerSlug": "..."}
    event_type: e.g. "auction:outbid" (used for in-app banner routing)
    """
    out: dict[str, Any] = {"realtime": False, "push": False}

    # 1. Always emit realtime — in-app banner consumes this
    try:
        payload = {
            **(data or {}),
            "pushTitle": title,
            "pushBody": body,
            "target": target,
        }
        await emit_realtime_event(event_type, payload)
        out["realtime"] = True
    except Exception as e:
        logger.warning(f"push realtime emit failed: {e}")

    # 2. Try Expo Push API if we have a token
    try:
        q: dict = {}
        if target.get("userId"):
            q["userId"] = target["userId"]
        elif target.get("providerSlug"):
            q["providerSlug"] = target["providerSlug"]
        else:
            return out
        tokens = await db.push_tokens.find(q, {"_id": 0, "expoPushToken": 1}).to_list(10)
        if not tokens:
            return out
        messages = [
            {
                "to": t["expoPushToken"],
                "title": title,
                "body": body,
                "sound": "default",
                "priority": "high",
                "data": {"eventType": event_type, **(data or {})},
            }
            for t in tokens if t.get("expoPushToken")
        ]
        if not messages:
            return out
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.post(EXPO_PUSH_URL, json=messages)
            if r.status_code < 300:
                out["push"] = True
                out["pushSent"] = len(messages)
            else:
                out["pushError"] = f"{r.status_code}: {r.text[:120]}"
    except Exception as e:
        logger.warning(f"expo push failed: {e}")
        out["pushError"] = str(e)[:120]
    return out


# ─────────────────────────────────────────────────────────────────────
# Specific triggers (each one is a money-driven nudge)
# ─────────────────────────────────────────────────────────────────────


# ── Sprint 33 C8.3: Outbid Escalation helpers ──────────────────────
# Three severity levels that decide banner colour, push copy, and haptic:
#   soft     — информируем (rank 1→2)
#   pressure — включаем боль ($/day loss, rank ≥ 3 or loss > 200)
#   critical — обнуление (out of top-3 completely)
OUTBID_PRESSURE_RANK = 3        # at or below this rank → pressure tier
OUTBID_PRESSURE_LOSS = 200      # estimated daily loss above which we escalate
OUTBID_CRITICAL_RANK = 4        # >= this (1-based) = out of top-3 → critical


def compute_outbid_severity(new_rank: int, est_loss: int = 0) -> str:
    """Pick severity by rank + estimated daily loss.

    Contract (mirrors C8.3 spec):
      * new_rank > 3                         → "critical"
      * new_rank >= 3 OR est_loss > 200      → "pressure"
      * otherwise                            → "soft"
    """
    r = int(new_rank or 0)
    loss = int(est_loss or 0)
    if r >= OUTBID_CRITICAL_RANK:
        return "critical"
    if r >= OUTBID_PRESSURE_RANK or loss > OUTBID_PRESSURE_LOSS:
        return "pressure"
    return "soft"


def _currency_symbol_for_zone(zone: str) -> str:
    """Heuristic symbol picker — zones starting with `kyiv-` / `odesa-` / `lviv-`
    use UAH (₴), EU-city zones use EUR (€). Safe-default ₴ keeps legacy copy intact.
    """
    z = (zone or "").lower()
    if any(z.startswith(pfx) for pfx in ("berlin-", "munich-", "hamburg-", "frankfurt-", "vienna-", "warsaw-")):
        return "€"
    return "₴"


async def notify_outbid(
    pushed_down_slug: str,
    zone: str,
    zone_name: str,
    new_top_bid: float,
    your_bid: float,
    new_rank: int,
    prev_rank: Optional[int] = None,
    estimated_daily_loss: Optional[int] = None,
    suggested_bid: Optional[int] = None,
) -> dict:
    """Sprint 33 C8.3 — Outbid Escalation.

    Severity ladder:
      * soft     — информируем: "Вас обогнали"
      * pressure — деньги: "Вы теряете €X/день"
      * critical — обнуление: "Вы вне топ-3 → доход остановлен"

    Severity is chosen by `compute_outbid_severity(new_rank, est_loss)`.
    When `prev_rank` is not provided, soft is default. `suggested_bid` is
    the auto-populated bid shown in the banner CTA ("Перебить до €X").
    """
    est_loss = int(estimated_daily_loss or 0)
    severity = compute_outbid_severity(new_rank, est_loss)

    sym = _currency_symbol_for_zone(zone)
    top_i = int(round(new_top_bid))
    your_i = int(round(your_bid))
    # suggestedBid fallback = topBid + 1 (floor-agnostic; UI can enforce zone floor)
    sb = int(suggested_bid) if suggested_bid else max(top_i + 1, your_i + 1)

    if severity == "critical":
        title = "🚨 Вы вне топ-3"
        body = f"Доход остановлен в {zone_name}. Верните позицию — перебейте до {sym}{sb}."
    elif severity == "pressure":
        loss_str = f"~{sym}{est_loss}/день" if est_loss > 0 else f"позиция #{new_rank}"
        title = "⚠️ Вы теряете деньги"
        body = f"Позиция #{new_rank} в {zone_name} · {loss_str}. Перебить до {sym}{sb}."
    else:  # soft
        title = f"Вас обогнали в {zone_name}"
        body = f"Вы теперь #{new_rank}. Лидер: {sym}{top_i} · Ваша: {sym}{your_i}."

    return await send_push(
        target={"providerSlug": pushed_down_slug},
        event_type="auction:outbid",
        title=title,
        body=body,
        data={
            "providerSlug": pushed_down_slug,
            "zone": zone,
            "zoneName": zone_name,
            "newTopBid": float(new_top_bid),
            "yourBid": float(your_bid),
            "rank": int(new_rank),
            "prevRank": int(prev_rank) if prev_rank is not None else None,
            "severity": severity,  # "soft" | "pressure" | "critical"
            "estimatedDailyLoss": est_loss,
            "suggestedBid": sb,
            "currencySymbol": sym,
        },
    )


async def notify_new_request_to_provider(
    provider_slug: str,
    price: int,
    distance_km: float,
    request_id: str,
) -> dict:
    """Fast-money: new lead nearby — be first."""
    title = "⚡ Новая заявка рядом"
    body = f"₴{int(price)} · {round(distance_km, 1)} км — забери первым"
    return await send_push(
        target={"providerSlug": provider_slug},
        event_type="provider:new_request_push",
        title=title,
        body=body,
        data={"price": int(price), "distanceKm": float(distance_km), "requestId": request_id},
    )


async def notify_earnings_delta(
    provider_slug: str,
    amount: int,
    today_total: int,
    trend_str: str,
) -> dict:
    """Dopamine hit: +₴540 → today ₴2068 🔥 +32%."""
    title = f"💰 +₴{int(amount)}"
    body = f"Сегодня уже ₴{int(today_total)}" + (f" · {trend_str}" if trend_str and trend_str != "—" else "")
    return await send_push(
        target={"providerSlug": provider_slug},
        event_type="provider:earnings_delta",
        title=title,
        body=body,
        data={"amount": int(amount), "todayTotal": int(today_total), "trend": trend_str},
    )


async def notify_offline_fomo(
    provider_slug: str,
    missed_requests: int,
    potential_revenue: int,
) -> dict:
    """Weakness exploit: you're losing ₴X while offline."""
    title = "😴 Пока вы офлайн"
    body = f"{missed_requests} заявок · ₴{int(potential_revenue)} потенциально — вернуться онлайн"
    return await send_push(
        target={"providerSlug": provider_slug},
        event_type="provider:offline_fomo",
        title=title,
        body=body,
        data={"missedRequests": int(missed_requests), "potentialRevenue": int(potential_revenue)},
    )


async def notify_customer_booking_status(
    user_id: str,
    booking_id: str,
    new_status: str,
) -> dict:
    """Customer lifecycle — accepted / en_route / in_progress / completed."""
    title_map = {
        "accepted":    ("🚗 Мастер принял заказ", "Скоро выезжает"),
        "confirmed":   ("🚗 Мастер принял заказ", "Скоро выезжает"),
        "en_route":    ("🚶 В пути", "Мастер уже едет к вам"),
        "in_progress": ("🔧 Работа началась", "Держим вас в курсе"),
        "completed":   ("✅ Готово", "Оцените мастера"),
        "cancelled":   ("❌ Заказ отменён", "Попробуйте снова"),
    }
    title, body = title_map.get(new_status, (f"Статус: {new_status}", ""))
    return await send_push(
        target={"userId": user_id},
        event_type="booking:lifecycle_push",
        title=title,
        body=body,
        data={"bookingId": booking_id, "status": new_status},
    )


# ─────────────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────────────


@router.post("/api/push/register")
async def register_push_token(request: Request):
    """Client registers Expo push token.

    Body: { userId?, providerSlug?, expoPushToken, platform?, device? }
    """
    body = await request.json()
    token = (body.get("expoPushToken") or "").strip()
    if not token:
        raise HTTPException(400, "expoPushToken required")
    user_id = body.get("userId")
    slug = body.get("providerSlug")
    if not user_id and not slug:
        raise HTTPException(400, "userId or providerSlug required")

    key = {"expoPushToken": token}
    now = now_utc().isoformat()
    doc = {
        "expoPushToken": token,
        "userId": user_id,
        "providerSlug": slug,
        "platform": body.get("platform") or "unknown",
        "device": body.get("device") or "",
        "updatedAt": now,
    }
    await db.push_tokens.update_one(
        key,
        {"$set": doc, "$setOnInsert": {"id": uid(), "createdAt": now}},
        upsert=True,
    )
    return {"ok": True, "registered": True}


@router.delete("/api/push/register")
async def unregister_push_token(expoPushToken: str):
    """Unregister token (logout / opt-out)."""
    if not expoPushToken:
        raise HTTPException(400, "expoPushToken required")
    r = await db.push_tokens.delete_many({"expoPushToken": expoPushToken})
    return {"ok": True, "deleted": r.deleted_count}


@router.post("/api/push/test")
async def send_test_push(request: Request):
    """Admin/dev endpoint — trigger a test push to a user/provider."""
    body = await request.json()
    target: dict = {}
    if body.get("userId"):
        target["userId"] = body["userId"]
    if body.get("providerSlug"):
        target["providerSlug"] = body["providerSlug"]
    if not target:
        raise HTTPException(400, "userId or providerSlug required")
    return await send_push(
        target=target,
        event_type=body.get("eventType", "notification"),
        title=body.get("title", "Test push"),
        body=body.get("body", "Hello from Auto Search"),
        data=body.get("data") or {},
    )


# ─────────────────────────────────────────────────────────────────────
# Offline FOMO sweep — called from orchestrator loop (cheap)
# ─────────────────────────────────────────────────────────────────────


async def sweep_offline_fomo(min_missed: int = 3) -> int:
    """Scan provider_missed_stats for today and push to offline providers
    who missed >= min_missed requests. Dedup via `lastOfflineFomoAt` field.

    Returns count of pushes sent.
    """
    from datetime import timedelta as _td
    today_key = now_utc().strftime("%Y-%m-%d")
    rolling_cutoff = (now_utc() - _td(hours=6)).isoformat()
    rows = await db.provider_missed_stats.find(
        {"day": today_key, "missedRequests": {"$gte": min_missed}},
        {"_id": 0},
    ).to_list(200)
    sent = 0
    for r in rows:
        slug = r.get("providerSlug")
        if not slug:
            continue
        org = await db.organizations.find_one(
            {"slug": slug},
            {"_id": 0, "isOnline": 1, "lastOfflineFomoAt": 1},
        )
        if not org or org.get("isOnline"):
            continue
        last = org.get("lastOfflineFomoAt")
        if last and last > rolling_cutoff:
            continue  # recently notified — skip
        await notify_offline_fomo(
            provider_slug=slug,
            missed_requests=int(r.get("missedRequests") or 0),
            potential_revenue=int(r.get("potentialRevenue") or 0),
        )
        await db.organizations.update_one(
            {"slug": slug},
            {"$set": {"lastOfflineFomoAt": now_utc().isoformat()}},
        )
        sent += 1
    return sent
