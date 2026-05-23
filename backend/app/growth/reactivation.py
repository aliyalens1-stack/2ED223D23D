"""Sprint 33 C8.1 — Reactivation Engine.

Brings offline providers back online by surfacing missed-revenue / FOMO
push + realtime in-app banner.

Pipeline:
    sweep loop (every REACTIVATION_SWEEP_SECONDS) →
        find offline providers in `provider_missed_stats` today →
        if missed exceeds per-cluster threshold AND no cooldown / cap →
            emit `provider:reactivation` realtime event +
            send_push (Expo if token, else realtime-only) →
            insert `reactivation_events` row with cooldownUntil
    admin endpoint `/api/admin/growth/reactivation` reports today stats.

Anti-spam invariants enforced:
    1. provider must be offline (`organizations.isOnline === false/null`)
    2. no event for same (slug, type) within COOLDOWN_HOURS
    3. missed counters above per-cluster thresholds
    4. daily cap DAILY_CAP per provider
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends

from app.core.db import db
from app.core.security import verify_admin_token
from app.core.utils import now_utc
from app.marketplace.clusters import CLUSTERS, DEFAULT_CLUSTER
from app.push import send_push


logger = logging.getLogger("server")

router = APIRouter(tags=["growth"])

# ─── Tuning ───────────────────────────────────────────────────────────
SWEEP_SECONDS = int(os.environ.get("REACTIVATION_SWEEP_SECONDS", "600"))  # 10 min default
COOLDOWN_HOURS = 3
DAILY_CAP = 3
EVENT_TYPE = "missed_revenue"  # currently single type; reserved for future variants

# Per-cluster thresholds — gate when to fire "you are losing money" message.
REACTIVATION_THRESHOLDS: dict[str, dict[str, int]] = {
    "repair": {"minRequests": 3, "minRevenue": 1500},        # UAH
    "inspection": {"minRequests": 2, "minRevenue": 200},      # EUR
    "selection": {"minRequests": 1, "minRevenue": 500},       # EUR
    "delivery": {"minRequests": 1, "minRevenue": 300},        # EUR
}


def _today_key() -> str:
    return now_utc().strftime("%Y-%m-%d")


def _sym(cluster: str) -> str:
    cfg = CLUSTERS.get(cluster) or CLUSTERS.get(DEFAULT_CLUSTER) or {}
    return "€" if cfg.get("currency") == "EUR" else "₴"


def _primary_cluster(org: dict) -> str:
    clusters = org.get("clusters") or [DEFAULT_CLUSTER]
    return clusters[0] if isinstance(clusters, list) and clusters else DEFAULT_CLUSTER


def _passes_threshold(cluster: str, missed_requests: int, potential_revenue: int) -> bool:
    th = REACTIVATION_THRESHOLDS.get(cluster) or REACTIVATION_THRESHOLDS["repair"]
    return missed_requests >= th["minRequests"] or potential_revenue >= th["minRevenue"]


# ─── Cooldown / cap checks ────────────────────────────────────────────
async def _can_send(provider_slug: str, event_type: str = EVENT_TYPE) -> tuple[bool, str]:
    """Return (allowed, reason). reason is empty when allowed."""
    now = now_utc()
    # Cooldown
    last = await db.reactivation_events.find_one(
        {"providerSlug": provider_slug, "type": event_type},
        sort=[("sentAt", -1)],
        projection={"_id": 0, "cooldownUntil": 1, "sentAt": 1},
    )
    if last:
        cd = last.get("cooldownUntil")
        if cd:
            try:
                cd_dt = datetime.fromisoformat(cd) if isinstance(cd, str) else cd
                if cd_dt.tzinfo is None:
                    cd_dt = cd_dt.replace(tzinfo=timezone.utc)
                if cd_dt > now:
                    return False, "cooldown"
            except Exception:
                pass
    # Daily cap
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    sent_today = await db.reactivation_events.count_documents({
        "providerSlug": provider_slug,
        "sentAt": {"$gte": day_start.isoformat()},
    })
    if sent_today >= DAILY_CAP:
        return False, "daily_cap"
    return True, ""


# ─── Single-provider fire ─────────────────────────────────────────────
async def fire_reactivation(
    provider_slug: str,
    *,
    missed_requests: int,
    potential_revenue: int,
    cluster: str,
    zone: Optional[str] = None,
    bypass_checks: bool = False,
) -> dict:
    """Send reactivation push/realtime for one provider.

    Returns `{sent: bool, reason: str}`. Honours cooldown / daily cap unless
    bypass_checks=True (used by tests / manual admin trigger).
    """
    if not bypass_checks:
        ok, reason = await _can_send(provider_slug)
        if not ok:
            return {"sent": False, "reason": reason}

    sym = _sym(cluster)
    title = "Ты теряешь деньги"
    body_amount = f"{sym}{potential_revenue}"
    if missed_requests > 0:
        body = (
            f"Пока ты офлайн: {missed_requests} заявок"
            + (" · " if potential_revenue else "")
            + (f"~{body_amount}" if potential_revenue else "")
            + ". Вернись онлайн и забери поток."
        )
    else:
        body = f"Пропущено ~{body_amount}. Вернись онлайн и забери поток."

    payload = {
        "providerSlug": provider_slug,
        "cluster": cluster,
        "zone": zone,
        "missedRequests": missed_requests,
        "potentialRevenue": potential_revenue,
        "currencySymbol": sym,
        "ctaRoute": "/",
        "cta": "go_online",
    }

    try:
        await send_push(
            target={"providerSlug": provider_slug},
            event_type="provider:reactivation",
            title=title,
            body=body,
            data=payload,
        )
    except Exception as e:
        logger.warning(f"reactivation send_push failed for {provider_slug}: {e}")
        return {"sent": False, "reason": f"push_error:{e}"}

    now = now_utc()
    cooldown_until = (now + timedelta(hours=COOLDOWN_HOURS)).isoformat()
    await db.reactivation_events.insert_one({
        "providerSlug": provider_slug,
        "type": EVENT_TYPE,
        "missedRequests": missed_requests,
        "potentialRevenue": potential_revenue,
        "cluster": cluster,
        "zone": zone,
        "sentAt": now.isoformat(),
        "cooldownUntil": cooldown_until,
    })
    return {"sent": True, "reason": ""}


# ─── Bulk sweep ───────────────────────────────────────────────────────
async def reactivation_sweep() -> dict:
    """Run one sweep over today's missed stats. Returns counters."""
    day = _today_key()
    rows = await db.provider_missed_stats.find(
        {"day": day},
        {"_id": 0, "providerSlug": 1, "missedRequests": 1, "potentialRevenue": 1, "zones": 1},
    ).to_list(500)

    stats = {"scanned": len(rows), "sent": 0, "skipped_online": 0, "skipped_threshold": 0,
             "skipped_cooldown": 0, "skipped_cap": 0, "errors": 0}

    for r in rows:
        slug = r.get("providerSlug")
        if not slug:
            continue
        missed = int(r.get("missedRequests") or 0)
        potential = int(r.get("potentialRevenue") or 0)

        org = await db.organizations.find_one(
            {"slug": slug},
            {"_id": 0, "isOnline": 1, "clusters": 1},
        )
        if not org:
            continue
        if org.get("isOnline"):
            stats["skipped_online"] += 1
            continue

        cluster = _primary_cluster(org)
        if not _passes_threshold(cluster, missed, potential):
            stats["skipped_threshold"] += 1
            continue

        ok, reason = await _can_send(slug)
        if not ok:
            if reason == "cooldown":
                stats["skipped_cooldown"] += 1
            elif reason == "daily_cap":
                stats["skipped_cap"] += 1
            continue

        zones = r.get("zones") or []
        zone = zones[0] if zones else None
        result = await fire_reactivation(
            slug,
            missed_requests=missed,
            potential_revenue=potential,
            cluster=cluster,
            zone=zone,
            bypass_checks=True,  # we already checked
        )
        if result.get("sent"):
            stats["sent"] += 1
        else:
            stats["errors"] += 1

    if stats["sent"]:
        logger.info(f"C8.1 reactivation sweep: {stats}")
    return stats


async def reactivation_sweep_loop():
    """Forever loop — driven by REACTIVATION_SWEEP_SECONDS env."""
    # warm-up — wait until DB indexes / orchestrator stabilise
    await asyncio.sleep(45)
    while True:
        try:
            await reactivation_sweep()
        except Exception as e:
            logger.warning(f"reactivation sweep error: {e}")
        await asyncio.sleep(SWEEP_SECONDS)


# ─── Admin endpoint ───────────────────────────────────────────────────
@router.get("/api/admin/growth/reactivation", dependencies=[Depends(verify_admin_token)])
async def admin_reactivation_stats():
    """Today: events sent, potential revenue queued for recovery, top offenders."""
    now = now_utc()
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    pipe = [
        {"$match": {"sentAt": {"$gte": day_start.isoformat()}}},
        {"$group": {
            "_id": "$providerSlug",
            "events": {"$sum": 1},
            "potentialRevenue": {"$max": "$potentialRevenue"},
            "missedRequests": {"$max": "$missedRequests"},
            "cluster": {"$first": "$cluster"},
            "lastSentAt": {"$max": "$sentAt"},
        }},
        {"$sort": {"potentialRevenue": -1}},
        {"$limit": 50},
    ]
    rows = await db.reactivation_events.aggregate(pipe).to_list(50)

    sent_today = sum(int(r.get("events", 0) or 0) for r in rows)
    potential_total = sum(int(r.get("potentialRevenue", 0) or 0) for r in rows)

    top_offline = [
        {
            "providerSlug": r["_id"],
            "missedRequests": int(r.get("missedRequests", 0) or 0),
            "potentialRevenue": int(r.get("potentialRevenue", 0) or 0),
            "cluster": r.get("cluster"),
            "events": int(r.get("events", 0) or 0),
            "lastSentAt": r.get("lastSentAt"),
        }
        for r in rows[:10]
    ]

    return {
        "sentToday": sent_today,
        "potentialRevenueRecovered": potential_total,
        "topOffline": top_offline,
        "config": {
            "sweepSeconds": SWEEP_SECONDS,
            "cooldownHours": COOLDOWN_HOURS,
            "dailyCap": DAILY_CAP,
            "thresholds": REACTIVATION_THRESHOLDS,
        },
        "asOf": now.isoformat(),
    }


# ─── Admin: manual trigger (dev / verification) ──────────────────────
@router.post("/api/admin/growth/reactivation/run", dependencies=[Depends(verify_admin_token)])
async def admin_reactivation_run():
    """Force one sweep cycle now and return counters."""
    return await reactivation_sweep()
