"""app.growth.auto_money — Sprint 33 C8.4 Auto-money mode.

Subscription-grade autobidder: provider flips the switch, system keeps
them at targetRank in the N best (zone, cluster) cells according to
Smart Nudge scores. Stops spending when dailyBudget is hit.

Mongo
-----
    auto_money: {
        providerSlug, enabled, targetRank, maxBid, dailyBudget,
        clusters (filter, optional), zones (filter, optional),
        strategy ("conservative"|"balanced"|"aggressive"),
        day, spent, leadsReceived, lastTickAt, disableReason,
        createdAt, updatedAt
    }

Worker loop
-----------
Every `AUTO_MONEY_TICK_SECONDS` (default 15s) scans active configs and
for each one:
    1. rolls over daily `spent` if `day` < today
    2. picks top-N cells via `best_nudges_for_provider(slug, top_n=N)`
       (filtered by configured clusters / zones)
    3. for each cell computes `bid = max(topBid+1, floor+1)` capped by
       `maxBid` and remaining budget
    4. upserts into `provider_bids` (same shape as submit_bid) so all
       existing auction machinery (charge_lead / multipliers / outbid
       emission) works automatically
    5. disables itself if budget fully exhausted

Strategy knobs
--------------
    conservative → top 1 cell, bid = topBid+1 (only when floor permits)
    balanced     → top 2 cells, bid = topBid+1
    aggressive   → top 3 cells, bid = max(topBid+2, ceil(1.05*topBid))

Safety
------
* Hard: bid never exceeds maxBid, daily spent never exceeds dailyBudget.
* Hard: only clusters where provider.clusters contains the target.
* Hard: bid ≥ zone floor (enforced by submit_bid path).
"""
from __future__ import annotations

import asyncio
import logging
import math
import os
from typing import Optional

from fastapi import APIRouter, HTTPException, Request

from app.core.db import db
from app.core.utils import now_utc, uid
from app.marketplace.auction import _zone_floor, MIN_BID, MAX_BID, MIN_DAILY_BUDGET
from app.marketplace.clusters import normalize_cluster, CLUSTERS
from app.growth.nudges import best_nudges_for_provider

router = APIRouter(tags=["growth-auto-money"])
logger = logging.getLogger("auto_money")


AUTO_MONEY_TICK_SECONDS = int(os.getenv("AUTO_MONEY_TICK_SECONDS", "15"))
DEFAULT_TARGET_RANK = 3
ALLOWED_STRATEGIES = {"conservative", "balanced", "aggressive"}

STRATEGY_TOP_N     = {"conservative": 1, "balanced": 2, "aggressive": 3}
STRATEGY_BID_BUMP  = {"conservative": 1, "balanced": 1, "aggressive": 2}  # +N above topBid
STRATEGY_BID_MULT  = {"conservative": 1.0, "balanced": 1.0, "aggressive": 1.05}


# ── helpers ─────────────────────────────────────────────────────────


async def _today_key() -> str:
    return now_utc().strftime("%Y-%m-%d")


async def _provider_active_clusters(slug: str) -> list[str]:
    org = await db.organizations.find_one({"slug": slug}, {"_id": 0, "clusters": 1})
    clusters = (org or {}).get("clusters") or ["repair"]
    return [normalize_cluster(c) for c in clusters if c in CLUSTERS] or ["repair"]


async def _upsert_bid(
    provider_slug: str,
    zone: str,
    cluster: str,
    bid: float,
    daily_budget: float,
) -> dict:
    """Write the computed bid into `provider_bids` (upsert). Mirrors shape
    used by manual submit_bid so downstream auction code (multiplier,
    charge_lead, outbid emission) works unchanged.
    """
    now = now_utc().isoformat()
    key = {"providerSlug": provider_slug, "zone": zone, "cluster": cluster}
    legacy_key = {
        "providerSlug": provider_slug,
        "zone": zone,
        "cluster": {"$exists": False},
    }
    existing = (
        await db.provider_bids.find_one({"$or": [key, legacy_key]}, {"_id": 0})
        if cluster == "repair"
        else await db.provider_bids.find_one(key, {"_id": 0})
    )
    if existing:
        await db.provider_bids.update_one(
            {"providerSlug": provider_slug, "zone": zone,
             "cluster": existing.get("cluster") or {"$exists": False}},
            {"$set": {
                "bid": bid,
                "dailyBudget": daily_budget,
                "cluster": cluster,
                "active": True,
                "disabledReason": None,
                "source": "auto_money",
                "updatedAt": now,
            }},
        )
        return {"action": "updated", "bid": bid}
    await db.provider_bids.insert_one({
        "id": uid(),
        "providerSlug": provider_slug,
        "zone": zone,
        "cluster": cluster,
        "bid": bid,
        "dailyBudget": daily_budget,
        "spent": 0,
        "active": True,
        "leadsReceived": 0,
        "lastChargedAt": None,
        "source": "auto_money",
        "createdAt": now,
        "updatedAt": now,
    })
    return {"action": "created", "bid": bid}


async def _pause_all_bids_for(provider_slug: str, reason: str = "auto_money_off") -> int:
    """Pause every `source=auto_money` bid for this provider."""
    now = now_utc().isoformat()
    res = await db.provider_bids.update_many(
        {"providerSlug": provider_slug, "source": "auto_money", "active": True},
        {"$set": {"active": False, "disabledReason": reason, "updatedAt": now}},
    )
    return res.modified_count


# ── core tick ───────────────────────────────────────────────────────


async def auto_money_tick(cfg: dict) -> dict:
    """Single-provider reconciliation tick."""
    slug = cfg.get("providerSlug")
    if not slug or not cfg.get("enabled"):
        return {"slug": slug, "skipped": "disabled"}

    target_rank  = int(cfg.get("targetRank") or DEFAULT_TARGET_RANK)
    max_bid      = float(cfg.get("maxBid") or 0)
    daily_budget = float(cfg.get("dailyBudget") or 0)
    strategy     = (cfg.get("strategy") or "balanced").lower()
    if strategy not in ALLOWED_STRATEGIES:
        strategy = "balanced"

    # Daily roll-over
    today = now_utc().strftime("%Y-%m-%d")
    spent = float(cfg.get("spent") or 0)
    if cfg.get("day") != today:
        spent = 0
        await db.auto_money.update_one(
            {"providerSlug": slug},
            {"$set": {"day": today, "spent": 0}},
        )

    remaining_budget = max(0.0, daily_budget - spent)
    if remaining_budget <= 0:
        await db.auto_money.update_one(
            {"providerSlug": slug},
            {"$set": {
                "enabled": False,
                "disableReason": "daily_budget_exhausted",
                "updatedAt": now_utc().isoformat(),
            }},
        )
        await _pause_all_bids_for(slug, reason="auto_money_budget_exhausted")
        return {"slug": slug, "disabled": "daily_budget_exhausted"}

    top_n = STRATEGY_TOP_N[strategy]
    cells = await best_nudges_for_provider(slug, top_n=top_n * 3)  # fetch extra — then filter
    # Filter by optional cluster / zone restrictions
    cluster_filter = set(cfg.get("clusters") or [])
    zone_filter    = set(cfg.get("zones") or [])
    filtered: list[dict] = []
    for c in cells:
        if cluster_filter and c.get("cluster") not in cluster_filter:
            continue
        if zone_filter and c.get("zone") not in zone_filter:
            continue
        filtered.append(c)
        if len(filtered) >= top_n:
            break

    if not filtered:
        return {"slug": slug, "skipped": "no_cells"}

    updates: list[dict] = []
    running_spent = spent
    for cell in filtered:
        zone = cell["zone"]
        cluster = cell["cluster"]
        bidders = int(cell.get("components", {}).get("bidders") or 0)
        # Fetch current topBid fresh to stay correct with realtime competitors
        top = 0.0
        if bidders > 0:
            bid_docs = await db.provider_bids.find(
                {"zone": zone, "active": True,
                 "$or": [{"cluster": cluster}, {"cluster": {"$exists": False}}] if cluster == "repair"
                       else [{"cluster": cluster}]},
                {"_id": 0, "bid": 1, "providerSlug": 1},
            ).to_list(20)
            others = [float(b.get("bid") or 0) for b in bid_docs if b.get("providerSlug") != slug]
            others.sort(reverse=True)
            # bid needed to hit targetRank
            idx = min(target_rank, len(others)) - 1  # 0-based index of rival to beat
            if idx >= 0 and idx < len(others):
                top = others[idx]
            elif others:
                top = others[0]

        floor = await _zone_floor(zone)
        bump = STRATEGY_BID_BUMP[strategy]
        mult = STRATEGY_BID_MULT[strategy]
        want_bid = max(floor, int(math.ceil(top * mult)) + bump, MIN_BID)

        if want_bid > max_bid:
            updates.append({"zone": zone, "cluster": cluster, "skipped": "exceeds_max_bid",
                            "wantBid": want_bid, "maxBid": max_bid})
            continue
        # Cap by remaining budget — don't place a bid that alone is more than budget left.
        if want_bid > remaining_budget:
            updates.append({"zone": zone, "cluster": cluster, "skipped": "exceeds_remaining_budget"})
            continue

        up = await _upsert_bid(slug, zone, cluster, float(want_bid), daily_budget)
        # bookkeeping: attribute an expected-spend slot (actual debit happens via charge_lead)
        running_spent += want_bid
        updates.append({
            "zone": zone, "cluster": cluster,
            "bid": want_bid, "topBid": top, "floor": floor,
            "action": up.get("action"),
        })
        if running_spent >= daily_budget:
            break

    # Persist counters
    await db.auto_money.update_one(
        {"providerSlug": slug},
        {"$set": {
            "day": today,
            "spent": running_spent,
            "lastTickAt": now_utc().isoformat(),
            "lastUpdates": updates,
            "updatedAt": now_utc().isoformat(),
        }},
    )
    return {"slug": slug, "updates": updates, "spent": running_spent, "budget": daily_budget}


async def auto_money_worker_loop(interval_seconds: int = AUTO_MONEY_TICK_SECONDS) -> None:
    logger.info(f"[auto_money] worker started (interval={interval_seconds}s)")
    while True:
        try:
            configs = await db.auto_money.find({"enabled": True}, {"_id": 0}).to_list(500)
            for cfg in configs:
                try:
                    await auto_money_tick(cfg)
                except Exception as exc:
                    logger.warning(f"[auto_money] tick error for {cfg.get('providerSlug')}: {exc}")
        except Exception as exc:
            logger.warning(f"[auto_money] loop error: {exc}")
        await asyncio.sleep(interval_seconds)


# ── endpoints ───────────────────────────────────────────────────────


def _validate_payload(body: dict) -> dict:
    slug = (body.get("providerSlug") or "").strip()
    if not slug:
        raise HTTPException(400, "providerSlug required")
    try:
        target_rank  = int(body.get("targetRank") or DEFAULT_TARGET_RANK)
        max_bid      = float(body.get("maxBid") or 0)
        daily_budget = float(body.get("dailyBudget") or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "targetRank / maxBid / dailyBudget must be numeric")
    if target_rank < 1 or target_rank > 3:
        raise HTTPException(400, "targetRank must be 1..3")
    if max_bid < MIN_BID or max_bid > MAX_BID:
        raise HTTPException(400, f"maxBid must be in [{MIN_BID}, {MAX_BID}]")
    if daily_budget < MIN_DAILY_BUDGET:
        raise HTTPException(400, f"dailyBudget must be >= {MIN_DAILY_BUDGET}")
    if max_bid > daily_budget:
        raise HTTPException(400, "maxBid cannot exceed dailyBudget")
    strategy = (body.get("strategy") or "balanced").lower()
    if strategy not in ALLOWED_STRATEGIES:
        raise HTTPException(400, f"strategy must be one of {sorted(ALLOWED_STRATEGIES)}")
    clusters = body.get("clusters") or None
    zones = body.get("zones") or None
    if clusters is not None and not isinstance(clusters, list):
        raise HTTPException(400, "clusters must be a list")
    if zones is not None and not isinstance(zones, list):
        raise HTTPException(400, "zones must be a list")
    return {
        "providerSlug": slug,
        "targetRank": target_rank,
        "maxBid": max_bid,
        "dailyBudget": daily_budget,
        "strategy": strategy,
        "clusters": [normalize_cluster(c) for c in clusters] if clusters else None,
        "zones": [str(z).strip() for z in zones] if zones else None,
    }


@router.post("/api/provider/auto-money/enable")
async def enable_auto_money(request: Request):
    body = await request.json()
    cfg = _validate_payload(body)
    slug = cfg["providerSlug"]
    # Require provider exists + clusters match
    org = await db.organizations.find_one({"slug": slug}, {"_id": 0, "clusters": 1})
    if not org:
        raise HTTPException(404, f"Provider not found: {slug}")
    allowed_clusters = set(await _provider_active_clusters(slug))
    if cfg["clusters"]:
        bad = [c for c in cfg["clusters"] if c not in allowed_clusters]
        if bad:
            raise HTTPException(
                403,
                f"Clusters not registered on provider: {bad}. Allowed: {sorted(allowed_clusters)}",
            )
    now = now_utc().isoformat()
    today = now_utc().strftime("%Y-%m-%d")
    await db.auto_money.update_one(
        {"providerSlug": slug},
        {
            "$set": {
                **cfg,
                "enabled": True,
                "disableReason": None,
                "day": today,
                "updatedAt": now,
            },
            "$setOnInsert": {"id": uid(), "createdAt": now, "spent": 0, "leadsReceived": 0},
        },
        upsert=True,
    )
    # Run one tick immediately so the user sees bids placed
    try:
        cfg_doc = await db.auto_money.find_one({"providerSlug": slug}, {"_id": 0})
        tick = await auto_money_tick(cfg_doc or {})
    except Exception as exc:
        logger.warning(f"[auto_money] immediate tick failed: {exc}")
        tick = {"error": str(exc)[:120]}
    return {"status": "enabled", "config": cfg, "tick": tick}


@router.post("/api/provider/auto-money/disable")
async def disable_auto_money(request: Request):
    body = await request.json()
    slug = (body.get("providerSlug") or "").strip()
    if not slug:
        raise HTTPException(400, "providerSlug required")
    res = await db.auto_money.update_one(
        {"providerSlug": slug},
        {"$set": {"enabled": False, "disableReason": "user_disabled",
                  "updatedAt": now_utc().isoformat()}},
    )
    paused = await _pause_all_bids_for(slug, reason="auto_money_off")
    return {"status": "disabled", "matched": res.matched_count, "pausedBids": paused}


@router.get("/api/provider/auto-money/status")
async def auto_money_status(providerSlug: str):
    if not providerSlug:
        raise HTTPException(400, "providerSlug required")
    cfg = await db.auto_money.find_one({"providerSlug": providerSlug}, {"_id": 0})
    if not cfg:
        return {"providerSlug": providerSlug, "enabled": False}
    # Pull current bids placed by auto_money for live stats
    bids = await db.provider_bids.find(
        {"providerSlug": providerSlug, "source": "auto_money", "active": True},
        {"_id": 0},
    ).to_list(50)
    leads = sum(int(b.get("leadsReceived") or 0) for b in bids)
    return {**cfg, "activeBids": bids, "todayLeads": leads}


@router.get("/api/admin/growth/auto-money")
async def admin_auto_money_overview():
    rows = await db.auto_money.find({}, {"_id": 0}).to_list(500)
    enabled = sum(1 for r in rows if r.get("enabled"))
    total_spent_today = 0.0
    today = now_utc().strftime("%Y-%m-%d")
    for r in rows:
        if r.get("day") == today:
            total_spent_today += float(r.get("spent") or 0)
    return {
        "total": len(rows),
        "enabled": enabled,
        "spentToday": round(total_spent_today, 2),
        "tickInterval": AUTO_MONEY_TICK_SECONDS,
        "rows": rows,
    }
