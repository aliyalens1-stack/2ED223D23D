"""app.market_playbooks — Sprint 32: Marketplace Domination Strategy.

Renamed from `app.domination` (Sprint 21 final cleanup). Public API path
`/api/admin/domination` is kept stable for backwards compatibility with
admin SPA and external dashboards — only the Python module location changed.

Not about "fair market" — about CONTROLLED market:
    * 1-2 masters per zone
    * others pay more or leave
    * prices always tick up (via pressure multipliers + suggestions)
    * FOMO kills weak bidders
    * dominators get locked-in privileges after 14d

This module provides:
    1. `notify_zone_loss_pressure()`  — PUSH when a provider drops >= 2 ranks
    2. `pressure_multiplier()`        — surge-aware minimum bid multiplier
    3. `is_locked_dominator()`        — 14d+ lock-in flag (priority tie-break in matching)
    4. `admin_domination_dashboard()` — city-level control panel
    5. `zone_advisor()`               — competitor fatigue ("don't fight here, try X")
    6. aggressive auto-bid mode flag

Collections used
----------------
* `zone_dominance` — already exists (auction.py writes)
* `provider_bids`  — already exists
* `zones`          — surge/status/ratio
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request

from app.core.db import db
from app.core.security import verify_admin_token
from app.core.utils import now_utc


router = APIRouter(tags=["domination"])
logger = logging.getLogger("domination")


# Thresholds
ZONE_LOCK_IN_DAYS = 14        # 🔒 Locked-in dominator (priority tie-break)
RANK_DROP_PRESSURE = 2        # drop >= 2 ranks → "you're losing the zone" push
SURGE_PRESSURE_THRESHOLD = 1.3  # surge ≥ 1.3× → floor multiplied
SURGE_PRESSURE_MULTIPLIER = 1.5  # high-demand → minBid × 1.5
HARD_ZONE_THRESHOLD = 30      # top-3 avg ≥ ₴30 → "difficult zone" flag


# ─────────────────────────────────────────────────────────────────────
# 1. Zone loss pressure (psychological killer)
# ─────────────────────────────────────────────────────────────────────


async def notify_zone_loss_pressure(
    pushed_down_slug: str,
    zone: str,
    zone_name: str,
    was_rank: int,
    now_rank: int,
    days_holding_before: float,
    estimated_daily_loss: int,
) -> None:
    """Fire when provider rank dropped >= 2 OR lost long-held top-1 slot.

    More severe than regular outbid — tells them HOW MUCH they're losing daily.
    """
    try:
        from app.push import send_push
        days_txt = f"{int(round(days_holding_before))} дней" if days_holding_before >= 1 else "несколько часов"
        title = f"⚠️ Вы теряете {zone_name}"
        body = (
            f"Были #{was_rank} {days_txt} → теперь #{now_rank}. "
            f"Потеря: ~₴{estimated_daily_loss}/день. Вернуть позицию →"
        )
        await send_push(
            target={"providerSlug": pushed_down_slug},
            event_type="auction:zone_loss",
            title=title,
            body=body,
            data={
                "zone": zone,
                "zoneName": zone_name,
                "wasRank": was_rank,
                "nowRank": now_rank,
                "daysHoldingBefore": round(days_holding_before, 1),
                "estimatedDailyLossUAH": int(estimated_daily_loss),
            },
        )
    except Exception as e:
        logger.warning(f"zone_loss push failed: {e}")


# ─────────────────────────────────────────────────────────────────────
# 2. Price control — pressure multiplier on zone floor
# ─────────────────────────────────────────────────────────────────────


async def pressure_multiplier_for_zone(zone_id: str) -> float:
    """Return a multiplier applied to base zone floor when demand is hot.

    Reads `zones.surgeMultiplier` and bumps floor to make weak bids impossible.
    """
    z = await db.zones.find_one({"id": zone_id}, {"_id": 0, "surgeMultiplier": 1, "status": 1})
    if not z:
        return 1.0
    surge = float(z.get("surgeMultiplier", 1.0) or 1.0)
    if surge >= SURGE_PRESSURE_THRESHOLD:
        return SURGE_PRESSURE_MULTIPLIER
    return 1.0


# ─────────────────────────────────────────────────────────────────────
# 3. Zone lock-in (14d holder → priority tie-break in matching)
# ─────────────────────────────────────────────────────────────────────


async def is_locked_dominator(provider_slug: str, zone: str) -> bool:
    """True if this provider has held top-1 in this zone for ≥ 14 days."""
    if not provider_slug or not zone:
        return False
    dom = await db.zone_dominance.find_one(
        {"zone": zone, "providerSlug": provider_slug, "isActive": True},
        {"_id": 0, "daysHolding": 1},
    )
    if not dom:
        return False
    return float(dom.get("daysHolding", 0) or 0) >= ZONE_LOCK_IN_DAYS


async def compute_dominator_tie_break_bonus(provider_slug: str, zone: str) -> float:
    """Return additive priority boost used in matching ranking.

    0.0 = no bonus, 0.1 = dominator (7+d), 0.2 = locked (14+d).
    """
    if not provider_slug or not zone:
        return 0.0
    dom = await db.zone_dominance.find_one(
        {"zone": zone, "providerSlug": provider_slug, "isActive": True},
        {"_id": 0, "daysHolding": 1},
    )
    if not dom:
        return 0.0
    d = float(dom.get("daysHolding", 0) or 0)
    if d >= ZONE_LOCK_IN_DAYS:
        return 0.2
    if d >= 7:
        return 0.1
    return 0.0


# ─────────────────────────────────────────────────────────────────────
# 4. Competitor fatigue — suggest easier zones
# ─────────────────────────────────────────────────────────────────────


async def _zone_difficulty(zone_id: str) -> dict:
    """Return {topBids, avg, isHard, freeSlot} for a zone."""
    bids = await db.provider_bids.find(
        {"zone": zone_id, "active": True}, {"_id": 0, "bid": 1},
    ).sort("bid", -1).to_list(10)
    top3 = [float(b.get("bid") or 0) for b in bids[:3]]
    avg = round(sum(top3) / max(1, len(top3)), 1) if top3 else 0
    is_hard = avg >= HARD_ZONE_THRESHOLD
    free_slot = len(bids) < 3  # fewer than 3 active → free podium slot available
    return {"topBids": top3, "avg": avg, "isHard": is_hard, "freeSlot": free_slot, "bidders": len(bids)}


@router.get("/api/provider/boost/zone-advisor")
async def zone_advisor(providerSlug: str):
    """Competitor-fatigue advisor.

    For each zone, returns difficulty and recommendation.
    If provider is already competing in hard zones → suggest easier ones.
    """
    if not providerSlug:
        raise HTTPException(400, "providerSlug required")

    all_zones = await db.zones.find({}, {"_id": 0, "id": 1, "name": 1, "surgeMultiplier": 1}).to_list(50)
    if not all_zones:
        return {"zones": [], "recommendations": []}

    my_bids = await db.provider_bids.find(
        {"providerSlug": providerSlug, "active": True}, {"_id": 0, "zone": 1, "bid": 1},
    ).to_list(50)
    my_zone_set = {b["zone"] for b in my_bids}

    zones_out: list[dict] = []
    for z in all_zones:
        zid = z["id"]
        diff = await _zone_difficulty(zid)
        zones_out.append({
            "zone": zid,
            "zoneName": z.get("name", zid),
            "surge": round(float(z.get("surgeMultiplier", 1.0) or 1.0), 2),
            "topBids": diff["topBids"],
            "avgTop3": diff["avg"],
            "isHard": diff["isHard"],
            "freeSlot": diff["freeSlot"],
            "bidders": diff["bidders"],
            "imCompeting": zid in my_zone_set,
        })

    # Recommendations: suggest zones with freeSlot + not hard + not already competing
    recs = [
        {
            "zone": z["zone"],
            "zoneName": z["zoneName"],
            "reason": "🏁 свободный слот в топ-3" if z["freeSlot"] else "📉 низкая конкуренция",
            "estimatedEntryBidUAH": max(3, int(max([0] + z["topBids"]) + 1)) if z["topBids"] else 5,
        }
        for z in zones_out
        if (z["freeSlot"] or not z["isHard"]) and not z["imCompeting"]
    ][:5]

    # Fatigue warnings — if I'm in a hard zone with low rank
    warnings = []
    for b in my_bids:
        zid = b["zone"]
        z = next((x for x in zones_out if x["zone"] == zid), None)
        if not z or not z["isHard"]:
            continue
        top = z["topBids"]
        my_bid = float(b.get("bid") or 0)
        if top and my_bid < top[0]:
            warnings.append({
                "zone": zid,
                "zoneName": z["zoneName"],
                "message": f"😓 Сложная зона. Топ-3: ₴{int(top[0])} / ₴{int(top[1]) if len(top)>1 else '-'} / ₴{int(top[2]) if len(top)>2 else '-'}. Рекомендуем перейти в свободные зоны.",
                "topBids": top,
                "yourBid": my_bid,
            })

    return {
        "zones": zones_out,
        "recommendations": recs,
        "fatigueWarnings": warnings,
    }


# ─────────────────────────────────────────────────────────────────────
# 5. Admin domination dashboard — city-level control panel
# ─────────────────────────────────────────────────────────────────────


@router.get("/api/admin/domination", dependencies=[Depends(verify_admin_token)])
async def admin_domination_dashboard():
    """Full zone-by-zone marketplace status for operator control."""
    zones = await db.zones.find({}, {"_id": 0, "id": 1, "name": 1, "surgeMultiplier": 1, "status": 1}).to_list(50)
    out = []
    for z in zones:
        zid = z["id"]
        # Leader
        dom = await db.zone_dominance.find_one({"zone": zid, "isActive": True}, {"_id": 0}) or {}
        days = float(dom.get("daysHolding", 0) or 0)
        # All active bids
        bids = await db.provider_bids.find(
            {"zone": zid, "active": True},
            {"_id": 0, "providerSlug": 1, "bid": 1},
        ).sort("bid", -1).to_list(50)
        top_bids = [{"providerSlug": b.get("providerSlug"), "bid": float(b.get("bid") or 0)} for b in bids[:5]]
        # Revenue last 7 days (auction_charges)
        from datetime import timedelta
        cutoff = (now_utc() - timedelta(days=7)).isoformat()
        chg = await db.auction_charges.aggregate([
            {"$match": {"zone": zid, "createdAt": {"$gte": cutoff}}},
            {"$group": {"_id": None, "revenue": {"$sum": "$amount"}}},
        ]).to_list(1)
        revenue_7d = int((chg[0].get("revenue") if chg else 0) or 0)

        if not top_bids:
            competition = "empty"
        elif len(top_bids) >= 3 and top_bids[2]["bid"] >= HARD_ZONE_THRESHOLD * 0.7:
            competition = "high"
        elif len(top_bids) >= 2:
            competition = "medium"
        else:
            competition = "low"

        out.append({
            "zone": zid,
            "zoneName": z.get("name", zid),
            "surge": round(float(z.get("surgeMultiplier", 1.0) or 1.0), 2),
            "status": z.get("status"),
            "leader": dom.get("providerSlug"),
            "daysHolding": round(days, 1),
            "dominationLevel": (
                "🔒 locked" if days >= ZONE_LOCK_IN_DAYS
                else "👑 dominator" if days >= 7
                else "🔥 hot" if days >= 3
                else "—"
            ),
            "topBids": top_bids,
            "bidders": len(bids),
            "competition": competition,
            "revenue7dUAH": revenue_7d,
        })

    # City-level KPIs
    total_revenue = sum(z["revenue7dUAH"] for z in out)
    dominated = sum(1 for z in out if z["leader"] and z["daysHolding"] >= 7)
    locked = sum(1 for z in out if z["daysHolding"] >= ZONE_LOCK_IN_DAYS)
    empty = sum(1 for z in out if z["competition"] == "empty")

    return {
        "zones": out,
        "kpi": {
            "totalRevenue7dUAH": total_revenue,
            "totalZones": len(out),
            "dominatedZones": dominated,
            "lockedZones": locked,
            "emptyZones": empty,
            "avgBidders": round(sum(z["bidders"] for z in out) / max(1, len(out)), 1),
        },
    }


# ─────────────────────────────────────────────────────────────────────
# 6. Aggressive auto-bid flag (toggle on existing auto_bids)
# ─────────────────────────────────────────────────────────────────────


@router.post("/api/provider/boost/auto-bid/aggressive")
async def set_aggressive_mode(request: Request):
    """Body: { providerSlug, zone, aggressive: bool }.

    Marks an existing auto-bid entry as aggressive — causes the autobid
    worker (and reaction path in submit_bid) to bid topBid+2 instead of +1
    and react on every outbid regardless of tick interval.
    """
    body = await request.json()
    slug = (body.get("providerSlug") or "").strip()
    zone = (body.get("zone") or "").strip()
    aggressive = bool(body.get("aggressive", True))
    if not slug or not zone:
        raise HTTPException(400, "providerSlug and zone required")
    r = await db.auto_bids.update_one(
        {"providerSlug": slug, "zone": zone},
        {"$set": {"aggressive": aggressive, "updatedAt": now_utc().isoformat()}},
    )
    if r.matched_count == 0:
        raise HTTPException(404, "auto-bid not found — create it first via POST /api/provider/boost/auto-bid")
    return {"ok": True, "providerSlug": slug, "zone": zone, "aggressive": aggressive}
