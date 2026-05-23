"""app.marketplace.auction — Sprint 27 Auction + Sprint 28 Domination/AI-Pricing.

Sprint 27 (existing):
    Live bidding per zone — 1st→2.0, 2nd→1.6, 3rd→1.3 multipliers, charged
    per LEAD when a booking confirms in the zone.

Sprint 28 additions (this revision):
    1. 👑 Domination — providers who hold top-1 in a zone for ≥3 days get
       a +10% bonus multiplier (DOMINATOR badge ≥7 days).
    2. 🧠 AI Pricing — recommended bid based on zone pressure
       (CRITICAL/SURGE → 0.8×topBid, BUSY → 0.6×, BALANCED → max(5, avg)).
    3. 💸 Smart Floor — minBid per zone (dynamic = max(zone_floor, 0.5×avg)).
    4. 🤖 Auto-bidding — provider sets targetRank+maxBid; worker keeps them
       in target rank (raises bid by topBid+1, capped by maxBid+budget).

Collections
-----------
* `provider_bids`     — per-zone bids (Sprint 27)
* `auction_charges`   — per-lead debit ledger (Sprint 27)
* `zone_dominance`    — { zone, providerSlug, since, daysHolding, isActive }
* `auto_bids`         — { providerSlug, zone, targetRank, maxBid, active }
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from typing import Optional

from app.core.db import db
from app.core.security import verify_admin_token
from app.core.utils import now_utc, uid


router = APIRouter(tags=["auction"])
logger = logging.getLogger("auction")

# Auction multipliers by ranked position (0-indexed)
AUCTION_MULTIPLIERS = [2.0, 1.6, 1.3]
DEFAULT_MULTIPLIER = 1.0
MIN_BID = 1
MAX_BID = 1000
MIN_DAILY_BUDGET = 10
MAX_DAILY_BUDGET = 100000

# 💸 Smart floor — base minimum bid per zone (UAH/lead)
ZONE_FLOOR: dict[str, int] = {
    "kyiv-pechersk":   15,
    "kyiv-center":     12,
    "kyiv-podil":      10,
    "kyiv-darnytsia":   8,
    "kyiv-obolon":      5,
    "kyiv-sviatoshyn":  5,
}
DEFAULT_FLOOR = 3

# 👑 Domination thresholds (in DAYS)
DOMINATION_HOT_DAYS = 3       # status "🔥 Hot streak"
DOMINATION_KING_DAYS = 7      # status "👑 DOMINATOR"
DOMINATION_BONUS = 1.1        # +10% multiplier when DOMINATOR


# ── Internal helpers ─────────────────────────────────────────────────────


async def _zone_floor(zone: str) -> int:
    """Smart floor — max(zone_base, 0.5×avg_active_bid) × pressure_mult.

    Sprint 32: when zone is in surge (pressure_multiplier_for_zone > 1.0)
    the floor is multiplied by 1.5× to force weak bidders out.
    """
    base = ZONE_FLOOR.get(zone, DEFAULT_FLOOR)
    bids = await db.provider_bids.find(
        {"zone": zone, "active": True}, {"_id": 0, "bid": 1}
    ).to_list(50)
    if bids:
        avg = sum(float(b.get("bid", 0)) for b in bids) / len(bids)
        base = max(base, int(avg * 0.5))
    # Sprint 32: apply surge pressure multiplier
    try:
        from app.market_playbooks import pressure_multiplier_for_zone
        pm = await pressure_multiplier_for_zone(zone)
        return int(round(base * pm))
    except Exception:
        return base


async def _update_dominance(zone: str, current_top_slug: Optional[str]) -> dict:
    """Track who holds top-1 in the zone and how long.

    Called every time we read standings (cheap upsert). Returns the current
    dominance doc.
    """
    if not zone:
        return {}
    doc = await db.zone_dominance.find_one({"zone": zone}, {"_id": 0})
    now = now_utc()
    if not current_top_slug:
        if doc and doc.get("isActive"):
            await db.zone_dominance.update_one(
                {"zone": zone}, {"$set": {"isActive": False, "endedAt": now.isoformat()}}
            )
        return {"zone": zone, "providerSlug": None, "daysHolding": 0, "isActive": False}
    if not doc or doc.get("providerSlug") != current_top_slug:
        # New leader — reset
        new_doc = {
            "zone": zone,
            "providerSlug": current_top_slug,
            "since": now.isoformat(),
            "daysHolding": 0,
            "isActive": True,
            "previousLeader": (doc or {}).get("providerSlug"),
            "lastCheckedAt": now.isoformat(),
        }
        await db.zone_dominance.update_one(
            {"zone": zone}, {"$set": new_doc}, upsert=True
        )
        return new_doc
    # Same leader — recompute daysHolding from `since`
    try:
        since = datetime.fromisoformat(doc["since"].replace("Z", "+00:00"))
        days = max(0, (now - since).total_seconds() / 86400)
    except Exception:
        days = 0
    update = {"daysHolding": round(days, 2), "lastCheckedAt": now.isoformat(), "isActive": True}
    await db.zone_dominance.update_one({"zone": zone}, {"$set": update})
    return {**doc, **update}


def _dominance_status(days: float) -> Optional[str]:
    if days >= DOMINATION_KING_DAYS:
        return "king"  # 👑 DOMINATOR
    if days >= DOMINATION_HOT_DAYS:
        return "hot"   # 🔥 Hot streak
    return None


async def _active_bids_for_zone(zone: str, cluster: Optional[str] = None) -> list[dict]:
    """Return ALL active bids in a zone (optionally filtered by cluster).
    Sprint 33: cluster-scoped standings — providers compete independently per cluster.
    """
    today_iso = now_utc().replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    q: dict = {"zone": zone, "active": True}
    if cluster:
        # Legacy bids with no cluster field are treated as "repair"
        q["$or"] = [{"cluster": cluster}, {"cluster": {"$exists": False}} if cluster == "repair" else {"cluster": None}] if cluster == "repair" else [{"cluster": cluster}]
    cursor = db.provider_bids.find(q, {"_id": 0})
    rows = await cursor.to_list(200)
    # Filter out budget-exhausted (defensive — set active=False on debit, but daily reset)
    out = []
    for r in rows:
        spent = float(r.get("spent", 0) or 0)
        budget = float(r.get("dailyBudget", 0) or 0)
        # If lastChargedAt < today's start → reset spent (daily roll-over)
        last = r.get("lastChargedAt") or ""
        if last and last < today_iso:
            spent = 0
            r["spent"] = 0
        if spent < budget:
            out.append(r)
    out.sort(key=lambda b: float(b.get("bid", 0) or 0), reverse=True)
    # Track dominance whenever standings are read
    top_slug = out[0].get("providerSlug") if out else None
    try:
        await _update_dominance(zone, top_slug)
    except Exception as exc:
        logger.warning(f"[dominance] update failed for {zone}: {exc}")
    return out


async def compute_auction_multiplier(provider_slug: str, zone: Optional[str], cluster: Optional[str] = None) -> tuple[float, Optional[int]]:
    """Return (multiplier, position_or_None). 0-indexed; multiplier 1.0 if not in top 3.
    Adds DOMINATION bonus (+10%) when provider is the DOMINATOR (≥7 days at top-1).

    Sprint 33 C5: cluster-scoped — leaderboard is computed per (zone, cluster), and
    the final multiplier is amplified by `CLUSTERS[cluster].bidMultiplier`
    (repair=1.0, inspection=1.2, selection=1.5, delivery=1.1).
    """
    if not provider_slug or not zone:
        return DEFAULT_MULTIPLIER, None
    # Sprint 33 C5: cluster-scoped leaderboard
    from app.marketplace.clusters import normalize_cluster, get_cluster
    cluster_id = normalize_cluster(cluster)
    cluster_mult = float(get_cluster(cluster_id).get("bidMultiplier", 1.0) or 1.0)
    bids = await _active_bids_for_zone(zone, cluster=cluster_id)
    for idx, b in enumerate(bids):
        if b.get("providerSlug") == provider_slug:
            mult = AUCTION_MULTIPLIERS[idx] if idx < len(AUCTION_MULTIPLIERS) else DEFAULT_MULTIPLIER
            # 👑 Domination bonus (+10%) only for top-1 holder reaching KING tier
            if idx == 0:
                dom = await db.zone_dominance.find_one({"zone": zone, "cluster": cluster_id}, {"_id": 0}) \
                      or await db.zone_dominance.find_one({"zone": zone}, {"_id": 0}) or {}
                if dom.get("providerSlug") == provider_slug and dom.get("daysHolding", 0) >= DOMINATION_KING_DAYS:
                    mult *= DOMINATION_BONUS
            # Sprint 33 C5: cluster economic multiplier (e.g., selection ×1.5)
            mult *= cluster_mult
            return mult, idx
    return DEFAULT_MULTIPLIER, None


async def charge_lead(provider_slug: str, zone: Optional[str], cluster: Optional[str] = None, booking_id: Optional[str] = None) -> dict:
    """Debit the provider's bid from spent when a lead is awarded in this zone+cluster.

    Idempotency note: caller should invoke once per booking. If bid no longer
    active (paused / out of budget / no bid in zone+cluster) → no-op.

    Sprint 33 C5: scoped to (zone, cluster). Legacy bids without cluster are
    treated as cluster="repair" (auto-migrated by `_active_bids_for_zone`).
    """
    if not provider_slug or not zone:
        return {"charged": 0, "reason": "missing_args"}
    from app.marketplace.clusters import normalize_cluster
    cluster_id = normalize_cluster(cluster)
    # Sprint 33 C5: find bid scoped to (slug, zone, cluster)
    if cluster_id == "repair":
        # Legacy doc compat: docs without cluster are treated as repair
        bid_doc = await db.provider_bids.find_one(
            {"providerSlug": provider_slug, "zone": zone, "active": True,
             "$or": [{"cluster": "repair"}, {"cluster": {"$exists": False}}, {"cluster": None}]},
            {"_id": 0},
        )
    else:
        bid_doc = await db.provider_bids.find_one(
            {"providerSlug": provider_slug, "zone": zone, "cluster": cluster_id, "active": True},
            {"_id": 0},
        )
    if not bid_doc:
        return {"charged": 0, "reason": "no_active_bid", "cluster": cluster_id}

    bid = float(bid_doc.get("bid", 0) or 0)
    if bid <= 0:
        return {"charged": 0, "reason": "zero_bid", "cluster": cluster_id}

    today_iso = now_utc().replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    last = bid_doc.get("lastChargedAt") or ""
    spent = float(bid_doc.get("spent", 0) or 0)
    if last and last < today_iso:
        # daily roll-over
        spent = 0

    new_spent = spent + bid
    daily_budget = float(bid_doc.get("dailyBudget", 0) or 0)
    will_disable = new_spent >= daily_budget

    now = now_utc().isoformat()
    update = {
        "$set": {
            "spent": new_spent,
            "lastChargedAt": now,
            "updatedAt": now,
        },
        "$inc": {"leadsReceived": 1},
    }
    if will_disable:
        update["$set"]["active"] = False
        update["$set"]["disabledReason"] = "budget_exhausted"

    # Update the same doc that was matched above
    update_query = {"providerSlug": provider_slug, "zone": zone}
    if cluster_id != "repair":
        update_query["cluster"] = cluster_id
    await db.provider_bids.update_one(update_query, update)
    # Append-only ledger — Sprint 33 C5: cluster snapshot
    await db.auction_charges.insert_one(
        {
            "id": uid(),
            "providerSlug": provider_slug,
            "zone": zone,
            "cluster": cluster_id,
            "bid": bid,
            "amountCharged": bid,
            "currency": bid_doc.get("currency"),
            "bookingId": booking_id,
            "spentAfter": new_spent,
            "dailyBudget": daily_budget,
            "disabled": will_disable,
            "createdAt": now,
        }
    )
    return {
        "charged": bid,
        "cluster": cluster_id,
        "spent": new_spent,
        "dailyBudget": daily_budget,
        "disabled": will_disable,
        "leadsReceived": int(bid_doc.get("leadsReceived", 0) or 0) + 1,
    }


# ── Endpoints ────────────────────────────────────────────────────────────


@router.post("/api/provider/boost/bid")
async def submit_bid(request: Request):
    """Sprint 27: submit/update bid for a zone.

    Body: { providerSlug, zone, bid, dailyBudget }
    """
    body = await request.json()
    provider_slug = (body.get("providerSlug") or "").strip()
    zone = (body.get("zone") or "").strip()
    # Sprint 33: cluster-scoped bidding (default=repair → legacy compat)
    from app.marketplace.clusters import normalize_cluster
    cluster = normalize_cluster(body.get("cluster"))
    try:
        bid = float(body.get("bid", 0))
        daily_budget = float(body.get("dailyBudget", 0))
    except (TypeError, ValueError):
        raise HTTPException(400, "bid and dailyBudget must be numbers")

    if not provider_slug:
        raise HTTPException(400, "providerSlug is required")
    if not zone:
        raise HTTPException(400, "zone is required")
    if bid < MIN_BID or bid > MAX_BID:
        raise HTTPException(400, f"bid must be in [{MIN_BID}, {MAX_BID}]")
    if daily_budget < MIN_DAILY_BUDGET or daily_budget > MAX_DAILY_BUDGET:
        raise HTTPException(400, f"dailyBudget must be in [{MIN_DAILY_BUDGET}, {MAX_DAILY_BUDGET}]")
    if bid > daily_budget:
        raise HTTPException(400, "bid cannot exceed dailyBudget")

    # 💸 Smart floor — bid cannot go below dynamic zone floor
    floor = await _zone_floor(zone)
    if bid < floor:
        raise HTTPException(400, f"Bid too low for this zone. Minimum: ₴{floor}")

    # Sprint 33 C7 — provider must have this cluster in their profile.
    # Repair is allowed for legacy providers (no `clusters` field == default ["repair"]).
    org = await db.organizations.find_one({"slug": provider_slug}, {"_id": 0, "clusters": 1, "name": 1})
    if not org:
        raise HTTPException(404, f"Provider not found: {provider_slug}")
    org_clusters = org.get("clusters") or ["repair"]
    if cluster not in org_clusters:
        raise HTTPException(
            403,
            f"Provider '{provider_slug}' is not registered in cluster '{cluster}'. "
            f"Active clusters: {org_clusters}. Update profile via PATCH /api/provider/profile/clusters.",
        )

    # Sprint 31: snapshot standings BEFORE update — for outbid detection
    # Sprint 33: cluster-scoped standings — competitors in DIFFERENT cluster are ignored
    bids_before = await _active_bids_for_zone(zone, cluster=cluster)
    rank_before = {b.get("providerSlug"): i for i, b in enumerate(bids_before)}
    bid_before = {b.get("providerSlug"): float(b.get("bid") or 0) for b in bids_before}
    # Sprint 32: snapshot previous leader's daysHolding BEFORE update_dominance resets it
    prev_dom_snapshot = await db.zone_dominance.find_one(
        {"zone": zone}, {"_id": 0, "providerSlug": 1, "daysHolding": 1}
    ) or {}
    prev_days_snapshot = float(prev_dom_snapshot.get("daysHolding", 0) or 0)

    now = now_utc().isoformat()
    # Sprint 33: key = (providerSlug, zone, cluster). Legacy bids without cluster
    # field are treated as cluster="repair" for backward compatibility.
    bid_key = {"providerSlug": provider_slug, "zone": zone, "cluster": cluster}
    legacy_repair_key = {"providerSlug": provider_slug, "zone": zone, "cluster": {"$exists": False}}
    if cluster == "repair":
        existing = await db.provider_bids.find_one(
            {"$or": [bid_key, legacy_repair_key]}, {"_id": 0}
        )
    else:
        existing = await db.provider_bids.find_one(bid_key, {"_id": 0})
    if existing:
        # Normalize legacy doc: set cluster field so future queries match
        await db.provider_bids.update_one(
            {"providerSlug": provider_slug, "zone": zone,
             "cluster": existing.get("cluster", None) if existing.get("cluster") else {"$exists": False}},
            {
                "$set": {
                    "bid": bid,
                    "dailyBudget": daily_budget,
                    "active": True,
                    "cluster": cluster,
                    "disabledReason": None,
                    "updatedAt": now,
                }
            },
        )
        action = "updated"
    else:
        await db.provider_bids.insert_one(
            {
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
                "createdAt": now,
                "updatedAt": now,
            }
        )
        action = "created"

    # Standings after bid update (cluster-scoped)
    bids = await _active_bids_for_zone(zone, cluster=cluster)
    position = next(
        (i for i, b in enumerate(bids) if b.get("providerSlug") == provider_slug), None
    )
    multiplier = (
        AUCTION_MULTIPLIERS[position]
        if position is not None and position < len(AUCTION_MULTIPLIERS)
        else DEFAULT_MULTIPLIER
    )

    # Sprint 31: Outbid detection — anyone whose rank DROPPED or who was the
    # old top and is no longer → fire auction:outbid push.
    # Sprint 32: If rank dropped >= 2 OR was top-1 for >=3 days → fire HEAVIER
    # zone_loss_pressure push instead (still emits outbid as well for in-app banner).
    try:
        from app.push import notify_outbid
        from app.market_playbooks import notify_zone_loss_pressure, RANK_DROP_PRESSURE
        import asyncio as _asyncio
        zone_doc = await db.zones.find_one({"id": zone}, {"_id": 0, "name": 1})
        zone_name = (zone_doc or {}).get("name", zone)
        new_top_bid = float(bids[0].get("bid", 0)) if bids else 0
        # Sprint 33 C8.3 — shared suggested bid = topBid + 1, capped by floor
        suggested_bid_global = max(int(new_top_bid) + 1, floor)
        # Use the BEFORE-update snapshot (prev_days_snapshot) — the live doc has been reset
        prev_days = prev_days_snapshot
        seen: set[str] = set()
        for i, b in enumerate(bids):
            slug = b.get("providerSlug")
            if not slug or slug == provider_slug or slug in seen:
                continue
            seen.add(slug)
            old_rank = rank_before.get(slug)
            if old_rank is None:
                continue
            if i > old_rank:
                rank_drop = i - old_rank
                # Sprint 33 C8.3 — estimate daily loss on EVERY outbid for severity picker.
                # Formula: (mult_before - mult_after) * my_bid * ~3 jobs/day * 30 (monthly horizon,
                # matches Sprint 32 heavy pressure math). Clipped to int.
                mult_before = AUCTION_MULTIPLIERS[old_rank] if old_rank < len(AUCTION_MULTIPLIERS) else DEFAULT_MULTIPLIER
                mult_after = AUCTION_MULTIPLIERS[i] if i < len(AUCTION_MULTIPLIERS) else DEFAULT_MULTIPLIER
                est_loss = int(round(max(0, mult_before - mult_after) * float(b.get("bid", 0)) * 3 * 30))
                # suggestedBid per-provider = max(topBid+1, their_bid+1) so banner CTA always raises
                sb_here = max(suggested_bid_global, int(float(b.get("bid", 0))) + 1)
                # Always emit in-app outbid banner (with severity/loss/suggestedBid payload)
                _asyncio.create_task(notify_outbid(
                    pushed_down_slug=slug,
                    zone=zone,
                    zone_name=zone_name,
                    new_top_bid=new_top_bid,
                    your_bid=float(b.get("bid", 0)),
                    new_rank=i + 1,
                    prev_rank=old_rank + 1,
                    estimated_daily_loss=est_loss,
                    suggested_bid=sb_here,
                ))
                # Heavy zone_loss_pressure if rank dropped >= 2 OR was long-held top-1
                if rank_drop >= RANK_DROP_PRESSURE or (old_rank == 0 and prev_days >= 3):
                    _asyncio.create_task(notify_zone_loss_pressure(
                        pushed_down_slug=slug,
                        zone=zone,
                        zone_name=zone_name,
                        was_rank=old_rank + 1,
                        now_rank=i + 1,
                        days_holding_before=prev_days if old_rank == 0 else 0,
                        estimated_daily_loss=est_loss,
                    ))
    except Exception as _e:
        logger.warning(f"outbid/zone_loss hook failed: {_e}")

    # Sprint 32: recommendedBid hidden suggestion (price control)
    recommended_bid = None
    try:
        top_bid_val = float(bids[0].get("bid", 0)) if bids else 0
        pricing = await _pricing_suggest_data(zone, bids, top_bid_val, floor)
        recommended_bid = pricing.get("recommendedBid")
    except Exception:
        pass

    return {
        "status": "ok",
        "action": action,
        "providerSlug": provider_slug,
        "zone": zone,
        "cluster": cluster,
        "bid": bid,
        "dailyBudget": daily_budget,
        "position": position,
        "multiplier": multiplier,
        "totalBidders": len(bids),
        "topBid": float(bids[0].get("bid", 0)) if bids else 0,
        "recommendedBid": recommended_bid,
        "floor": floor,
    }


@router.get("/api/provider/boost/bid")
async def get_my_bids(providerSlug: str = "avtomaster-pro"):
    """Return the provider's bids across all zones with current position+multiplier."""
    rows = await db.provider_bids.find(
        {"providerSlug": providerSlug}, {"_id": 0}
    ).to_list(50)
    out = []
    for r in rows:
        zone = r.get("zone")
        bids = await _active_bids_for_zone(zone)
        position = next(
            (i for i, b in enumerate(bids) if b.get("providerSlug") == providerSlug),
            None,
        )
        multiplier = (
            AUCTION_MULTIPLIERS[position]
            if position is not None and position < len(AUCTION_MULTIPLIERS)
            else DEFAULT_MULTIPLIER
        )
        out.append(
            {
                **r,
                "position": position,
                "multiplier": multiplier,
                "totalBidders": len(bids),
                "topBid": float(bids[0].get("bid", 0)) if bids else 0,
            }
        )
    return {"providerSlug": providerSlug, "bids": out}


@router.delete("/api/provider/boost/bid")
async def pause_bid(providerSlug: str, zone: str):
    """Pause my bid in a zone (sets active=false). Spent NOT reset (carries over)."""
    if not providerSlug or not zone:
        raise HTTPException(400, "providerSlug and zone are required")
    res = await db.provider_bids.update_one(
        {"providerSlug": providerSlug, "zone": zone},
        {
            "$set": {
                "active": False,
                "disabledReason": "user_paused",
                "updatedAt": now_utc().isoformat(),
            }
        },
    )
    if res.matched_count == 0:
        raise HTTPException(404, "bid not found")
    return {"status": "paused", "providerSlug": providerSlug, "zone": zone}


@router.get("/api/zones/{zone_id}/auction")
async def zone_auction(zone_id: str, providerSlug: Optional[str] = None, cluster: Optional[str] = None):
    """Current auction standings for a zone (with dominance + pricing hints).

    Sprint 33 C7.3: cluster-aware — leaderboard is computed per (zone, cluster),
    and response includes the cluster economic multiplier snapshot so the UI
    can show the final `×(position × bidMultiplier)` value per provider.
    """
    from app.marketplace.clusters import normalize_cluster, get_cluster, DEFAULT_CLUSTER
    cluster_id = normalize_cluster(cluster) if cluster else DEFAULT_CLUSTER
    cluster_cfg = get_cluster(cluster_id)
    cluster_mult = float(cluster_cfg.get("bidMultiplier", 1.0) or 1.0)
    bids = await _active_bids_for_zone(zone_id, cluster=cluster_id)
    dom = await db.zone_dominance.find_one({"zone": zone_id, "cluster": cluster_id}, {"_id": 0}) \
          or await db.zone_dominance.find_one({"zone": zone_id}, {"_id": 0}) or {}
    dom_status = _dominance_status(float(dom.get("daysHolding", 0) or 0))
    standings = []
    for i, b in enumerate(bids[:10]):
        slot_mult = AUCTION_MULTIPLIERS[i] if i < len(AUCTION_MULTIPLIERS) else DEFAULT_MULTIPLIER
        # apply DOMINATOR bonus only on rank-1 holder when KING tier
        if i == 0 and dom.get("providerSlug") == b.get("providerSlug") and dom_status == "king":
            slot_mult *= DOMINATION_BONUS
        # Sprint 33 C5/C7.3: apply cluster economic multiplier
        final_mult = slot_mult * cluster_mult
        standings.append({
            "rank": i + 1,
            "providerSlug": b.get("providerSlug"),
            "bid": float(b.get("bid", 0)),
            "multiplier": round(final_mult, 2),
            "leadsReceived": int(b.get("leadsReceived", 0) or 0),
            "isDominator": (i == 0 and dom_status == "king" and dom.get("providerSlug") == b.get("providerSlug")),
        })
    my_position = None
    my_bid = None
    my_multiplier = DEFAULT_MULTIPLIER
    my_is_dominator = False
    if providerSlug:
        for i, b in enumerate(bids):
            if b.get("providerSlug") == providerSlug:
                my_position = i
                my_bid = float(b.get("bid", 0))
                my_multiplier = AUCTION_MULTIPLIERS[i] if i < len(AUCTION_MULTIPLIERS) else DEFAULT_MULTIPLIER
                if i == 0 and dom.get("providerSlug") == providerSlug and dom_status == "king":
                    my_multiplier *= DOMINATION_BONUS
                    my_is_dominator = True
                my_multiplier *= cluster_mult
                break
    top_bid = float(bids[0].get("bid", 0)) if bids else 0
    floor = await _zone_floor(zone_id)
    suggested = max(int(top_bid) + 1, floor)

    # 🧠 AI pricing
    pricing = await _pricing_suggest_data(zone_id, bids, top_bid, floor)

    return {
        "zone": zone_id,
        "cluster": cluster_id,
        "currency": cluster_cfg.get("currency"),
        "clusterBidMultiplier": cluster_mult,
        "totalBidders": len(bids),
        "topBid": top_bid,
        "minBid": floor,
        "suggestedBid": suggested,
        "recommendedBid": pricing["recommendedBid"],
        "minCompetitiveBid": pricing["minCompetitiveBid"],
        "pressure": pricing["pressure"],
        "pricingMessage": pricing["message"],
        "standings": standings,
        "dominance": {
            "providerSlug": dom.get("providerSlug"),
            "daysHolding": round(float(dom.get("daysHolding", 0) or 0), 2),
            "status": dom_status,  # null | "hot" | "king"
            "since": dom.get("since"),
        } if dom.get("providerSlug") else None,
        "you": (
            {
                "providerSlug": providerSlug,
                "position": my_position,
                "rank": (my_position + 1) if my_position is not None else None,
                "bid": my_bid,
                "multiplier": round(my_multiplier, 2),
                "isDominator": my_is_dominator,
            }
            if providerSlug
            else None
        ),
    }


# ── Sprint 28: AI pricing internals ──────────────────────────────────────


async def _pricing_suggest_data(zone_id: str, bids: list[dict], top_bid: float, floor: int) -> dict:
    """Return recommendedBid/minCompetitiveBid based on zone pressure."""
    zone_doc = await db.zones.find_one({"id": zone_id}, {"_id": 0, "status": 1, "ratio": 1, "surgeMultiplier": 1}) or {}
    status = (zone_doc.get("status") or "BALANCED").upper()
    ratio = float(zone_doc.get("ratio", 1) or 1)

    # pressure label
    if status in ("CRITICAL", "SURGE") or ratio >= 1.5:
        pressure = "high"
    elif status == "BUSY" or ratio >= 1.0:
        pressure = "medium"
    else:
        pressure = "low"

    # bid statistics
    avg_bid = (sum(float(b.get("bid", 0)) for b in bids) / len(bids)) if bids else 0
    third_bid = float(bids[2].get("bid", 0)) if len(bids) >= 3 else 0
    min_competitive = max(floor, int(third_bid + 1))  # to enter top-3

    if pressure == "high":
        recommended = max(floor, int(top_bid * 0.8) + 1, min_competitive)
        msg = f"Высокий спрос. Чтобы зайти в топ-3 — ставьте от ₴{min_competitive}, рекомендуем ₴{recommended}."
    elif pressure == "medium":
        recommended = max(floor, int(top_bid * 0.6), min_competitive) if top_bid else max(floor, int(avg_bid))
        msg = f"Средний спрос. Достаточно ₴{recommended} чтобы быть в топ-3."
    else:
        recommended = max(floor, int(avg_bid) if avg_bid else floor)
        msg = f"Низкий спрос — оптимально ₴{recommended}, далее можно копить бюджет."

    return {
        "recommendedBid": recommended,
        "minCompetitiveBid": min_competitive,
        "pressure": pressure,
        "message": msg,
        "topBid": top_bid,
        "avgBid": round(avg_bid, 2),
        "floor": floor,
    }


@router.get("/api/zones/{zone_id}/pricing-suggest")
async def zone_pricing_suggest(zone_id: str):
    """🧠 AI pricing: tells the provider exactly what to bid."""
    bids = await _active_bids_for_zone(zone_id)
    top_bid = float(bids[0].get("bid", 0)) if bids else 0
    floor = await _zone_floor(zone_id)
    data = await _pricing_suggest_data(zone_id, bids, top_bid, floor)
    return {"zone": zone_id, **data}


# ── Sprint 28: Auto-bidding ──────────────────────────────────────────────


@router.post("/api/provider/boost/auto-bid")
async def submit_auto_bid(request: Request):
    """Sprint 28: enable auto-bidding for a (provider, zone).

    Body: { providerSlug, zone, targetRank (1..3), maxBid, dailyBudget }
    """
    body = await request.json()
    provider_slug = (body.get("providerSlug") or "").strip()
    zone = (body.get("zone") or "").strip()
    target_rank = int(body.get("targetRank", 3) or 3)
    try:
        max_bid = float(body.get("maxBid", 0))
        daily_budget = float(body.get("dailyBudget", 0))
    except (TypeError, ValueError):
        raise HTTPException(400, "maxBid and dailyBudget must be numbers")

    if not provider_slug or not zone:
        raise HTTPException(400, "providerSlug and zone are required")
    if target_rank < 1 or target_rank > 3:
        raise HTTPException(400, "targetRank must be 1..3")
    floor = await _zone_floor(zone)
    if max_bid < floor or max_bid > MAX_BID:
        raise HTTPException(400, f"maxBid must be in [{floor}, {MAX_BID}]")
    if daily_budget < MIN_DAILY_BUDGET or daily_budget > MAX_DAILY_BUDGET:
        raise HTTPException(400, f"dailyBudget must be in [{MIN_DAILY_BUDGET}, {MAX_DAILY_BUDGET}]")
    if max_bid > daily_budget:
        raise HTTPException(400, "maxBid cannot exceed dailyBudget")

    now = now_utc().isoformat()
    await db.auto_bids.update_one(
        {"providerSlug": provider_slug, "zone": zone},
        {
            "$set": {
                "providerSlug": provider_slug,
                "zone": zone,
                "targetRank": target_rank,
                "maxBid": max_bid,
                "dailyBudget": daily_budget,
                "active": True,
                "updatedAt": now,
            },
            "$setOnInsert": {"id": uid(), "createdAt": now},
        },
        upsert=True,
    )
    # Run one tick immediately so the user sees instant effect
    try:
        result = await _autobid_tick_for(provider_slug, zone)
    except Exception as exc:
        logger.warning(f"[autobid] immediate tick failed: {exc}")
        result = {}
    return {"status": "enabled", "providerSlug": provider_slug, "zone": zone, "targetRank": target_rank, "maxBid": max_bid, "dailyBudget": daily_budget, "tick": result}


@router.delete("/api/provider/boost/auto-bid")
async def disable_auto_bid(providerSlug: str, zone: str):
    if not providerSlug or not zone:
        raise HTTPException(400, "providerSlug and zone are required")
    res = await db.auto_bids.update_one(
        {"providerSlug": providerSlug, "zone": zone},
        {"$set": {"active": False, "updatedAt": now_utc().isoformat()}},
    )
    if res.matched_count == 0:
        raise HTTPException(404, "auto-bid not found")
    return {"status": "disabled", "providerSlug": providerSlug, "zone": zone}


@router.get("/api/provider/boost/auto-bid")
async def my_auto_bids(providerSlug: str = "avtomaster-pro"):
    rows = await db.auto_bids.find({"providerSlug": providerSlug}, {"_id": 0}).to_list(50)
    return {"providerSlug": providerSlug, "autoBids": rows}


async def _autobid_tick_for(provider_slug: str, zone: str) -> dict:
    """Single-zone autobid tick — keep provider at targetRank if maxBid allows."""
    auto = await db.auto_bids.find_one({"providerSlug": provider_slug, "zone": zone, "active": True}, {"_id": 0})
    if not auto:
        return {"action": "no_auto_bid"}
    target_rank = int(auto.get("targetRank", 3) or 3)
    max_bid = float(auto.get("maxBid", 0) or 0)
    daily_budget = float(auto.get("dailyBudget", 0) or 0)

    bids = await _active_bids_for_zone(zone)
    # Determine the bid we need to be at to hit targetRank
    others = [float(b.get("bid", 0)) for b in bids if b.get("providerSlug") != provider_slug]
    others.sort(reverse=True)

    if target_rank == 1:
        threshold = (others[0] + 1) if others else MIN_BID
    elif target_rank == 2:
        threshold = (others[0] + 1) if others else MIN_BID
    else:  # 3
        threshold = (others[1] + 1) if len(others) >= 2 else (others[0] + 1 if others else MIN_BID)

    floor = await _zone_floor(zone)
    threshold = max(threshold, floor)

    if threshold > max_bid:
        # Can't keep up — pause the actual bid (keeps auto-bid setting on)
        await db.provider_bids.update_one(
            {"providerSlug": provider_slug, "zone": zone},
            {"$set": {"active": False, "disabledReason": "autobid_outbid", "updatedAt": now_utc().isoformat()}},
        )
        return {"action": "outbid", "neededBid": threshold, "maxBid": max_bid}

    # Upsert / update active bid to threshold
    existing = await db.provider_bids.find_one({"providerSlug": provider_slug, "zone": zone}, {"_id": 0})
    now = now_utc().isoformat()
    if existing:
        await db.provider_bids.update_one(
            {"providerSlug": provider_slug, "zone": zone},
            {"$set": {"bid": threshold, "dailyBudget": daily_budget, "active": True, "disabledReason": None, "updatedAt": now}},
        )
    else:
        await db.provider_bids.insert_one({
            "id": uid(), "providerSlug": provider_slug, "zone": zone,
            "bid": threshold, "dailyBudget": daily_budget, "spent": 0,
            "active": True, "leadsReceived": 0, "lastChargedAt": None,
            "createdAt": now, "updatedAt": now,
        })
    return {"action": "raised", "newBid": threshold, "targetRank": target_rank, "maxBid": max_bid}


async def autobid_worker_loop(interval_seconds: int = 15):
    """Background loop: runs every `interval_seconds` and reconciles all active auto-bids."""
    logger.info(f"[autobid] worker started (interval={interval_seconds}s)")
    while True:
        try:
            actives = await db.auto_bids.find({"active": True}, {"_id": 0}).to_list(500)
            for ab in actives:
                try:
                    await _autobid_tick_for(ab.get("providerSlug"), ab.get("zone"))
                except Exception as exc:
                    logger.warning(f"[autobid] tick error {ab.get('providerSlug')}@{ab.get('zone')}: {exc}")
        except Exception as exc:
            logger.warning(f"[autobid] loop error: {exc}")
        await asyncio.sleep(interval_seconds)


# ── Sprint 28: Admin domination dashboard ────────────────────────────────


@router.get("/api/admin/zones/dominance", dependencies=[Depends(verify_admin_token)])
async def admin_zones_dominance():
    """Per-zone leader + days holding + auction revenue."""
    rows = await db.zone_dominance.find({}, {"_id": 0}).to_list(50)
    # Pull revenue per zone for the same window
    rev_pipe = [
        {"$group": {"_id": "$zone", "revenue": {"$sum": "$amountCharged"}, "leads": {"$sum": 1}}},
    ]
    rev_rows = await db.auction_charges.aggregate(rev_pipe).to_list(50)
    rev_by_zone = {r["_id"]: r for r in rev_rows}

    out = {}
    for r in rows:
        zone = r.get("zone")
        days = float(r.get("daysHolding", 0) or 0)
        out[zone] = {
            "leader": r.get("providerSlug"),
            "since": r.get("since"),
            "daysHolding": round(days, 2),
            "status": _dominance_status(days),
            "isActive": bool(r.get("isActive")),
            "revenue": int(rev_by_zone.get(zone, {}).get("revenue", 0) or 0),
            "leads": int(rev_by_zone.get(zone, {}).get("leads", 0) or 0),
        }
    # Include zones with revenue but no dominance row yet
    for z, rv in rev_by_zone.items():
        if z not in out:
            out[z] = {
                "leader": None,
                "since": None,
                "daysHolding": 0,
                "status": None,
                "isActive": False,
                "revenue": int(rv.get("revenue", 0) or 0),
                "leads": int(rv.get("leads", 0) or 0),
            }
    return {"zones": out}


@router.get("/api/admin/revenue/by-zone", dependencies=[Depends(verify_admin_token)])
async def admin_revenue_by_zone():
    """Aggregate auction revenue per zone (admin only)."""
    pipeline = [
        {
            "$group": {
                "_id": "$zone",
                "revenue": {"$sum": "$amountCharged"},
                "leads": {"$sum": 1},
                "uniqueProviders": {"$addToSet": "$providerSlug"},
            }
        },
        {"$sort": {"revenue": -1}},
    ]
    rows = await db.auction_charges.aggregate(pipeline).to_list(50)
    out = []
    total_revenue = 0
    total_leads = 0
    for r in rows:
        rev = int(r.get("revenue", 0) or 0)
        out.append(
            {
                "zone": r["_id"],
                "revenue": rev,
                "leads": int(r.get("leads", 0) or 0),
                "uniqueProviders": len(r.get("uniqueProviders", []) or []),
                "avgBidPerLead": (rev / max(int(r.get("leads", 1) or 1), 1)),
            }
        )
        total_revenue += rev
        total_leads += int(r.get("leads", 0) or 0)
    return {
        "totals": {"revenue": total_revenue, "leads": total_leads, "zones": len(out)},
        "zones": out,
    }



@router.get("/api/admin/revenue/by-zone-cluster", dependencies=[Depends(verify_admin_token)])
async def admin_revenue_by_zone_cluster():
    """Sprint 33 C5: Aggregate auction revenue per (zone, cluster) — admin only.

    Returns nested map: {zone: {cluster: {revenue, leads, currency, providers}}}.
    Reveals which markets actually monetise (e.g., inspection in Berlin Mitte vs
    repair in Kyiv Pechersk).
    """
    pipeline = [
        {
            "$group": {
                "_id": {
                    "zone": "$zone",
                    "cluster": {"$ifNull": ["$cluster", "repair"]},
                },
                "revenue": {"$sum": "$amountCharged"},
                "leads": {"$sum": 1},
                "uniqueProviders": {"$addToSet": "$providerSlug"},
                "currency": {"$first": "$currency"},
            }
        },
        {"$sort": {"revenue": -1}},
    ]
    rows = await db.auction_charges.aggregate(pipeline).to_list(200)
    nested: dict = {}
    totals_by_cluster: dict = {}
    grand_revenue = 0
    grand_leads = 0
    for r in rows:
        zone = r["_id"]["zone"]
        cluster = r["_id"]["cluster"]
        rev = int(r.get("revenue", 0) or 0)
        leads = int(r.get("leads", 0) or 0)
        nested.setdefault(zone, {})[cluster] = {
            "revenue": rev,
            "leads": leads,
            "uniqueProviders": len(r.get("uniqueProviders", []) or []),
            "currency": r.get("currency"),
            "avgBidPerLead": (rev / max(leads, 1)),
        }
        totals_by_cluster.setdefault(cluster, {"revenue": 0, "leads": 0})
        totals_by_cluster[cluster]["revenue"] += rev
        totals_by_cluster[cluster]["leads"] += leads
        grand_revenue += rev
        grand_leads += leads
    return {
        "totals": {
            "revenue": grand_revenue,
            "leads": grand_leads,
            "zones": len(nested),
            "byCluster": totals_by_cluster,
        },
        "byZoneCluster": nested,
    }
