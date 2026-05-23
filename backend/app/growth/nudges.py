"""app.growth.nudges — Sprint 33 C8.2 Smart Nudge Engine.

Tells providers *where* to go earn right now. Score is computed per
(zone, cluster) cell across all active zones × all clusters where the
provider is registered.

Formula
-------
    score = (demand_score * price_level) / (competition * fatigue)

        demand_score   = zone.ratio * zone.surgeMultiplier
        price_level    = cluster.defaultPrice * cluster.bidMultiplier
        competition    = n_active_bidders(zone, cluster) + 1
        fatigue        = 1.5 if provider already has an active bid in
                         (zone, cluster) else 1.0  — de-prioritises cells
                         where the provider already earns so nudge can
                         reveal NEW money, not repeat the current position.

Endpoints
---------
    GET  /api/provider/nudges?providerSlug=...    — single best nudge (+top-3)
    GET  /api/admin/growth/nudges                  — fleet-wide summary
    POST /api/admin/growth/nudges/sweep            — manual push trigger

Sweep loop
----------
    `nudge_sweep()` pushes `provider:smart_nudge` to OFFLINE + low-earning
    providers when the best cell score exceeds NUDGE_PUSH_SCORE_THRESHOLD
    and respects cooldowns (1 push / 4h, daily cap 3) via `nudge_events`.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from app.core.db import db
from app.core.security import verify_admin_token
from app.core.utils import now_utc, uid
from app.marketplace.clusters import CLUSTERS, normalize_cluster, get_cluster
from app.push import send_push, _currency_symbol_for_zone

router = APIRouter(tags=["growth-nudges"])
logger = logging.getLogger("nudges")


# Tunables (env-overridable)
NUDGE_PUSH_SCORE_THRESHOLD = float(os.getenv("NUDGE_PUSH_SCORE_THRESHOLD", "400"))
NUDGE_SWEEP_SECONDS        = int(os.getenv("NUDGE_SWEEP_SECONDS", "900"))  # 15 min
NUDGE_COOLDOWN_HOURS       = int(os.getenv("NUDGE_COOLDOWN_HOURS", "4"))
NUDGE_DAILY_CAP            = int(os.getenv("NUDGE_DAILY_CAP", "3"))
NUDGE_HIGH_DEMAND_RATIO    = 2.0       # ratio ≥ 2 → "high demand"
NUDGE_LOW_COMPETITION_N    = 2         # bidders ≤ 2 → "low competition"


# ── Zone ↔ cluster eligibility (by currency) ────────────────────────
EU_ZONE_PREFIXES = (
    "berlin-", "munich-", "hamburg-", "frankfurt-", "vienna-", "warsaw-",
)
UA_ZONE_PREFIXES = ("kyiv-", "lviv-", "odesa-", "kharkiv-", "dnipro-")


def _zone_currency(zone_id: str) -> str:
    z = (zone_id or "").lower()
    if any(z.startswith(p) for p in EU_ZONE_PREFIXES):
        return "EUR"
    return "UAH"


def _cluster_allowed_in_zone(cluster_id: str, zone_id: str) -> bool:
    cfg = get_cluster(cluster_id)
    return (cfg.get("currency") or "UAH") == _zone_currency(zone_id)


def _reason_tag(demand_ratio: float, bidders: int) -> str:
    if demand_ratio >= NUDGE_HIGH_DEMAND_RATIO and bidders <= NUDGE_LOW_COMPETITION_N:
        return "high_demand_low_competition"
    if demand_ratio >= NUDGE_HIGH_DEMAND_RATIO:
        return "high_demand"
    if bidders <= NUDGE_LOW_COMPETITION_N:
        return "low_competition"
    return "balanced"


def _competition_label(bidders: int) -> str:
    if bidders <= NUDGE_LOW_COMPETITION_N:
        return "low"
    if bidders <= 5:
        return "medium"
    return "high"


def _copy_for(reason: str, zone_name: str, cluster_name: str, revenue_hint: str) -> dict:
    """Return (title, body) copy for push + UI."""
    if reason == "high_demand_low_competition":
        return {
            "title": "🔥 Лёгкие деньги прямо сейчас",
            "body":  f"{zone_name} · {cluster_name} · {revenue_hint}",
            "lead":  "🔥 Сейчас лучшее место для заработка",
        }
    if reason == "high_demand":
        return {
            "title": "🔥 Высокий спрос — ловите поток",
            "body":  f"{zone_name} · {cluster_name} · {revenue_hint}",
            "lead":  "🔥 Высокий спрос прямо сейчас",
        }
    if reason == "low_competition":
        return {
            "title": "😏 Почти никого нет",
            "body":  f"{zone_name} · {cluster_name} · {revenue_hint}",
            "lead":  "😏 Низкая конкуренция — лёгкий вход",
        }
    return {
        "title": "💡 Где сейчас зарабатывать",
        "body":  f"{zone_name} · {cluster_name} · {revenue_hint}",
        "lead":  "💡 Сбалансированный спрос",
    }


# ── Core scorer ──────────────────────────────────────────────────────

async def _bidders_for(zone_id: str, cluster_id: str) -> tuple[int, float]:
    """Return (n_active_bidders, avg_bid) for (zone, cluster)."""
    q: dict = {"zone": zone_id, "active": True}
    if cluster_id == "repair":
        q["$or"] = [{"cluster": "repair"}, {"cluster": {"$exists": False}}, {"cluster": None}]
    else:
        q["cluster"] = cluster_id
    rows = await db.provider_bids.find(q, {"_id": 0, "bid": 1}).to_list(100)
    n = len(rows)
    avg = (sum(float(r.get("bid") or 0) for r in rows) / n) if n else 0.0
    return n, avg


async def _has_active_bid(provider_slug: str, zone_id: str, cluster_id: str) -> bool:
    q: dict = {"providerSlug": provider_slug, "zone": zone_id, "active": True}
    if cluster_id == "repair":
        q["$or"] = [{"cluster": "repair"}, {"cluster": {"$exists": False}}, {"cluster": None}]
    else:
        q["cluster"] = cluster_id
    r = await db.provider_bids.find_one(q, {"_id": 0, "providerSlug": 1})
    return r is not None


async def score_cell(
    zone: dict,
    cluster_id: str,
    provider_slug: Optional[str] = None,
) -> dict:
    """Score a single (zone, cluster) cell for a given provider.

    Returns a dict with `score` and its components. Guaranteed to be
    non-negative; `score == 0` means the cell is ineligible for this cluster.
    """
    zone_id = zone.get("id")
    if not _cluster_allowed_in_zone(cluster_id, zone_id):
        return {"score": 0.0, "ineligible": "currency_mismatch"}

    cfg = get_cluster(cluster_id)
    default_price = float(cfg.get("defaultPrice") or 0)
    bid_mult      = float(cfg.get("bidMultiplier") or 1.0)
    currency      = cfg.get("currency") or "UAH"
    sym           = _currency_symbol_for_zone(zone_id)

    ratio   = float(zone.get("ratio") or 1.0)
    surge   = float(zone.get("surgeMultiplier") or 1.0)
    demand  = max(0.0, ratio * surge)

    price_level = default_price * bid_mult
    bidders, avg_bid = await _bidders_for(zone_id, cluster_id)
    competition = bidders + 1

    fatigue = 1.0
    already_active = False
    if provider_slug:
        already_active = await _has_active_bid(provider_slug, zone_id, cluster_id)
        if already_active:
            fatigue = 1.5

    score = (demand * price_level) / (competition * fatigue)

    # Revenue hint: ~3 jobs/day * price × demand factor, shown as a range
    base = price_level
    lo = int(round(base * max(1.0, demand * 0.5)))
    hi = int(round(base * max(1.5, demand * 1.0)))
    hint = f"{sym}{lo:,}–{sym}{hi:,} сегодня".replace(",", " ")

    reason = _reason_tag(ratio, bidders)

    return {
        "zone": zone_id,
        "zoneName": zone.get("name") or zone_id,
        "cluster": cluster_id,
        "clusterName": cfg.get("name") or cluster_id,
        "currency": currency,
        "currencySymbol": sym,
        "score": round(score, 2),
        "components": {
            "demandRatio": round(ratio, 2),
            "surge": round(surge, 2),
            "demandScore": round(demand, 2),
            "priceLevel": round(price_level, 2),
            "bidders": bidders,
            "avgBid": round(avg_bid, 2),
            "fatigue": fatigue,
            "alreadyActive": already_active,
        },
        "competition": _competition_label(bidders),
        "reason": reason,
        "expectedRevenue": int(round(base * max(1.0, demand * 0.75))),
        "revenueLo": lo,
        "revenueHi": hi,
        "revenueHint": hint,
        "ctaRoute": f"/provider-boost?cluster={cluster_id}&zone={zone_id}",
    }


# ── Best-nudge picker ───────────────────────────────────────────────

async def best_nudges_for_provider(
    provider_slug: str,
    top_n: int = 3,
) -> list[dict]:
    """Enumerate provider's clusters × all active zones, rank by score, return top_n."""
    org = await db.organizations.find_one(
        {"slug": provider_slug},
        {"_id": 0, "clusters": 1},
    )
    clusters: list[str] = (org or {}).get("clusters") or ["repair"]
    clusters = [normalize_cluster(c) for c in clusters if c in CLUSTERS]
    if not clusters:
        clusters = ["repair"]

    zones = await db.zones.find(
        {}, {"_id": 0, "id": 1, "name": 1, "ratio": 1, "surgeMultiplier": 1, "status": 1}
    ).to_list(200)

    cells: list[dict] = []
    for z in zones:
        for c in clusters:
            cell = await score_cell(z, c, provider_slug)
            if cell.get("score", 0) > 0:
                cells.append(cell)
    cells.sort(key=lambda c: c.get("score", 0), reverse=True)
    return cells[:top_n]


async def pick_best_nudge(provider_slug: str) -> Optional[dict]:
    top = await best_nudges_for_provider(provider_slug, top_n=1)
    return top[0] if top else None


# ── Push/notify ─────────────────────────────────────────────────────

async def fire_smart_nudge(provider_slug: str, nudge: dict) -> dict:
    """Send `provider:smart_nudge` push + realtime event."""
    copy = _copy_for(nudge.get("reason", "balanced"), nudge.get("zoneName") or "", nudge.get("clusterName") or "", nudge.get("revenueHint") or "")
    return await send_push(
        target={"providerSlug": provider_slug},
        event_type="provider:smart_nudge",
        title=copy["title"],
        body=copy["body"],
        data={
            "providerSlug": provider_slug,
            "zone": nudge.get("zone"),
            "zoneName": nudge.get("zoneName"),
            "cluster": nudge.get("cluster"),
            "clusterName": nudge.get("clusterName"),
            "score": nudge.get("score"),
            "expectedRevenue": nudge.get("expectedRevenue"),
            "revenueLo": nudge.get("revenueLo"),
            "revenueHi": nudge.get("revenueHi"),
            "revenueHint": nudge.get("revenueHint"),
            "competition": nudge.get("competition"),
            "reason": nudge.get("reason"),
            "currencySymbol": nudge.get("currencySymbol"),
            "ctaRoute": nudge.get("ctaRoute"),
            "lead": copy["lead"],
        },
    )


async def _can_notify(provider_slug: str) -> bool:
    """Cooldown + daily cap check via `nudge_events` collection."""
    now = now_utc()
    cutoff = (now - _td_hours(NUDGE_COOLDOWN_HOURS)).isoformat()
    last = await db.nudge_events.find_one(
        {"providerSlug": provider_slug, "sentAt": {"$gt": cutoff}},
        {"_id": 0, "sentAt": 1},
    )
    if last:
        return False
    day_key = now.strftime("%Y-%m-%d")
    sent_today = await db.nudge_events.count_documents(
        {"providerSlug": provider_slug, "day": day_key}
    )
    return sent_today < NUDGE_DAILY_CAP


def _td_hours(h: int):
    from datetime import timedelta
    return timedelta(hours=h)


async def nudge_sweep() -> dict:
    """Scan all providers, pick best nudge, push if score >= threshold and
    cooldown is clear. Returns summary counters.
    """
    orgs = await db.organizations.find(
        {"status": "active"},
        {"_id": 0, "slug": 1, "isOnline": 1, "clusters": 1},
    ).to_list(500)

    scanned = len(orgs)
    sent = 0
    skipped_low_score = 0
    skipped_cooldown = 0
    skipped_no_cell = 0

    now = now_utc()
    day = now.strftime("%Y-%m-%d")

    for org in orgs:
        slug = org.get("slug")
        if not slug:
            continue
        best = await pick_best_nudge(slug)
        if not best:
            skipped_no_cell += 1
            continue
        if best.get("score", 0) < NUDGE_PUSH_SCORE_THRESHOLD:
            skipped_low_score += 1
            continue
        if not await _can_notify(slug):
            skipped_cooldown += 1
            continue
        try:
            await fire_smart_nudge(slug, best)
            await db.nudge_events.insert_one({
                "id": uid(),
                "providerSlug": slug,
                "zone": best.get("zone"),
                "cluster": best.get("cluster"),
                "score": best.get("score"),
                "reason": best.get("reason"),
                "expectedRevenue": best.get("expectedRevenue"),
                "day": day,
                "sentAt": now.isoformat(),
            })
            sent += 1
        except Exception as exc:
            logger.warning(f"[nudges] fire failed for {slug}: {exc}")

    return {
        "scanned": scanned,
        "sent": sent,
        "skipped_low_score": skipped_low_score,
        "skipped_cooldown": skipped_cooldown,
        "skipped_no_cell": skipped_no_cell,
        "threshold": NUDGE_PUSH_SCORE_THRESHOLD,
    }


async def nudge_sweep_loop(interval_seconds: int = NUDGE_SWEEP_SECONDS) -> None:
    logger.info(f"[nudges] sweep loop started (interval={interval_seconds}s, threshold={NUDGE_PUSH_SCORE_THRESHOLD})")
    while True:
        try:
            res = await nudge_sweep()
            if res.get("sent", 0) > 0:
                logger.info(f"[nudges] sweep sent={res['sent']} scanned={res['scanned']}")
        except Exception as exc:
            logger.warning(f"[nudges] sweep loop error: {exc}")
        await asyncio.sleep(interval_seconds)


# ── Endpoints ────────────────────────────────────────────────────────

@router.get("/api/provider/nudges")
async def api_provider_nudges(providerSlug: str, limit: int = 3):
    if not providerSlug:
        raise HTTPException(400, "providerSlug required")
    top = await best_nudges_for_provider(providerSlug, top_n=max(1, min(10, limit)))
    best = top[0] if top else None
    if best:
        copy = _copy_for(
            best.get("reason", "balanced"),
            best.get("zoneName") or "",
            best.get("clusterName") or "",
            best.get("revenueHint") or "",
        )
        best = {**best, **copy}
    return {
        "providerSlug": providerSlug,
        "best": best,
        "top": top,
        "threshold": NUDGE_PUSH_SCORE_THRESHOLD,
        "asOf": now_utc().isoformat(),
    }


@router.get(
    "/api/admin/growth/nudges",
    dependencies=[Depends(verify_admin_token)],
)
async def api_admin_nudges():
    """Fleet summary: sent today, top offline targets, threshold config."""
    day = now_utc().strftime("%Y-%m-%d")
    sent_today = await db.nudge_events.count_documents({"day": day})
    recent = await db.nudge_events.find(
        {"day": day}, {"_id": 0}
    ).sort("sentAt", -1).to_list(50)
    return {
        "asOf": now_utc().isoformat(),
        "threshold": NUDGE_PUSH_SCORE_THRESHOLD,
        "cooldownHours": NUDGE_COOLDOWN_HOURS,
        "dailyCap": NUDGE_DAILY_CAP,
        "sweepInterval": NUDGE_SWEEP_SECONDS,
        "sentToday": sent_today,
        "recent": recent,
    }


@router.post(
    "/api/admin/growth/nudges/sweep",
    dependencies=[Depends(verify_admin_token)],
)
async def api_admin_nudges_sweep():
    return await nudge_sweep()
