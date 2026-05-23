"""app.marketplace.clusters — Sprint 33: Cluster System v1.

Transforms the marketplace from a single flow ("auto repair") into an OS
for multiple vertical markets:

    * repair     — ремонт авто (UAH, UA)
    * inspection — осмотр перед покупкой (EUR, DE)
    * selection  — подбор авто (EUR, high-LTV)
    * delivery   — пригон авто (EUR, logistics)

Cluster-awareness touches: quick_request, provider matching, auction
(zone+cluster keyed bids), pricing, retention & push copy.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request

from app.core.db import db
from app.core.utils import now_utc


router = APIRouter(tags=["clusters"])


CLUSTERS: dict[str, dict] = {
    "repair": {
        "id": "repair",
        "title": "Ремонт авто",
        "titleEn": "Auto Repair",
        "icon": "wrench",
        "color": "amber",
        "description": "СТО, диагностика, ремонт",
        "subtitle": "Срочный выезд, диагностика, ремонт",
        "emoji": "🔧",
        "currency": "UAH",
        "region": "UA",
        "providerTypes": ["mechanic", "mobile_mechanic"],
        "auctionEnabled": True,
        "defaultPrice": 600,
        "priceRange": [300, 2000],
        "bidMultiplier": 1.0,
        "entryPoints": ["quick_request", "breakdown", "diagnostics"],
    },
    "inspection": {
        "id": "inspection",
        "title": "Проверка авто",
        "titleEn": "Pre-Purchase Inspection",
        "icon": "search",
        "color": "blue",
        "description": "Осмотр перед покупкой",
        "subtitle": "Осмотр авто перед сделкой",
        "emoji": "🔍",
        "currency": "EUR",
        "region": "DE",
        "providerTypes": ["inspector", "mechanic"],
        "auctionEnabled": True,
        "defaultPrice": 120,
        "priceRange": [80, 200],
        "bidMultiplier": 1.2,  # higher ticket → auction multiplier bumped
        "entryPoints": ["pre_purchase_check"],
    },
    "selection": {
        "id": "selection",
        "title": "Подбор авто",
        "titleEn": "Car Selection",
        "icon": "car",
        "color": "green",
        "description": "Подбор под бюджет",
        "subtitle": "Эксперт найдёт и проверит авто",
        "emoji": "🎯",
        "currency": "EUR",
        "region": "DE",
        "providerTypes": ["buyer", "inspector"],
        "auctionEnabled": True,
        "defaultPrice": 500,
        "priceRange": [300, 1000],
        "bidMultiplier": 1.5,
        "entryPoints": ["car_selection"],
    },
    "delivery": {
        "id": "delivery",
        "title": "Пригон авто",
        "titleEn": "Car Delivery",
        "icon": "truck",
        "color": "purple",
        "description": "Доставка из Европы",
        "subtitle": "Доставка авто из Европы",
        "emoji": "🚛",
        "currency": "EUR",
        "region": "DE",
        "providerTypes": ["transporter"],
        "auctionEnabled": True,
        "defaultPrice": 300,
        "priceRange": [150, 900],
        "bidMultiplier": 1.1,
        "entryPoints": ["delivery", "import"],
    },
}

DEFAULT_CLUSTER = "repair"

# Backward-compat aliases for older request payloads (Sprint 33 spec rename:
# buying → selection, transport → delivery). Maps any legacy id to canonical.
_CLUSTER_ALIASES: dict[str, str] = {
    "buying": "selection",
    "transport": "delivery",
}


def get_cluster(cluster_id: str | None) -> dict:
    """Return cluster dict. Unknown → repair (safe default, no breaking change)."""
    if not cluster_id:
        return CLUSTERS[DEFAULT_CLUSTER]
    canonical = _CLUSTER_ALIASES.get(cluster_id, cluster_id)
    return CLUSTERS.get(canonical, CLUSTERS[DEFAULT_CLUSTER])


def normalize_cluster(cluster_id: str | None) -> str:
    """Return a valid cluster id, defaulting to repair."""
    if not cluster_id:
        return DEFAULT_CLUSTER
    canonical = _CLUSTER_ALIASES.get(cluster_id, cluster_id)
    if canonical in CLUSTERS:
        return canonical
    return DEFAULT_CLUSTER


def cluster_ids() -> list[str]:
    return list(CLUSTERS.keys())


# ─────────────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────────────


@router.get("/api/marketplace/clusters")
async def list_clusters():
    """Public catalogue — Home screen uses this to render cluster blocks."""
    return {
        "clusters": list(CLUSTERS.values()),
        "default": DEFAULT_CLUSTER,
    }


@router.get("/api/marketplace/clusters/{cluster_id}")
async def get_cluster_detail(cluster_id: str):
    canonical = _CLUSTER_ALIASES.get(cluster_id, cluster_id)
    if canonical not in CLUSTERS:
        raise HTTPException(404, f"Unknown cluster: {cluster_id}")
    return CLUSTERS[canonical]


@router.patch("/api/provider/profile/clusters")
async def update_provider_clusters(request: Request):
    """Provider selects specializations & per-cluster profile fields.

    Body:
      { providerSlug, clusters: [str], providerType?, clusterProfile?: {<cluster>: {...}} }

    `clusterProfile` is a free-form per-cluster snapshot used for Sprint 33 C7
    type-specific credentials (TÜV cert for inspection, years of experience for
    selection, insurance # / countries served for delivery, etc.). Only fields
    for clusters present in `clusters` are persisted (others are dropped).
    """
    body = await request.json()
    slug = (body.get("providerSlug") or "").strip()
    clusters_in = body.get("clusters") or []
    cluster_profile_in = body.get("clusterProfile") or {}
    if not slug:
        raise HTTPException(400, "providerSlug required")
    if not isinstance(clusters_in, list):
        raise HTTPException(400, "clusters must be an array")
    if not isinstance(cluster_profile_in, dict):
        raise HTTPException(400, "clusterProfile must be an object")
    # Normalize & dedupe (also resolves aliases)
    clean: list[str] = []
    for c in clusters_in:
        canonical = _CLUSTER_ALIASES.get(c, c)
        if canonical in CLUSTERS and canonical not in clean:
            clean.append(canonical)
    if not clean:
        clean = [DEFAULT_CLUSTER]
    # Sanitize clusterProfile — keep only known clusters that are currently active
    sanitized_profile: dict[str, dict] = {}
    for cluster_id, payload in cluster_profile_in.items():
        canonical = _CLUSTER_ALIASES.get(cluster_id, cluster_id)
        if canonical in clean and isinstance(payload, dict):
            # Cap each value at simple primitives / lists to avoid storing nested structures
            safe = {k: v for k, v in payload.items() if isinstance(v, (str, int, float, bool, list)) or v is None}
            sanitized_profile[canonical] = safe
    update = {
        "clusters": clean,
        "updatedAt": now_utc().isoformat(),
    }
    if sanitized_profile:
        # Merge with existing profile (preserve other clusters' fields)
        update["clusterProfile"] = sanitized_profile
    provider_type = body.get("providerType")
    if provider_type:
        update["providerType"] = provider_type
    r = await db.organizations.update_one({"slug": slug}, {"$set": update})
    if r.matched_count == 0:
        raise HTTPException(404, f"Provider not found: {slug}")
    return {
        "ok": True,
        "providerSlug": slug,
        "clusters": clean,
        "clusterProfile": sanitized_profile or None,
        "providerType": provider_type or None,
    }


@router.get("/api/provider/profile/clusters")
async def get_provider_clusters(providerSlug: str):
    if not providerSlug:
        raise HTTPException(400, "providerSlug required")
    doc = await db.organizations.find_one(
        {"slug": providerSlug},
        {"_id": 0, "clusters": 1, "providerType": 1, "clusterProfile": 1},
    )
    if not doc:
        raise HTTPException(404, "Provider not found")
    return {
        "providerSlug": providerSlug,
        "clusters": doc.get("clusters") or [DEFAULT_CLUSTER],
        "providerType": doc.get("providerType"),
        "clusterProfile": doc.get("clusterProfile") or {},
    }


@router.get("/api/marketplace/active-markets/{slug}")
async def provider_active_markets(slug: str):
    """Sprint 33 C7 — Hub specialization badge data + Sprint 33 C7.4 money lens.

    Returns active markets for a provider with hints to upsell missing clusters
    (e.g., "Add inspection: €120-250 per request"). Augmented with **today's
    revenue per cluster** (provider + total market for FOMO trigger).
    """
    doc = await db.organizations.find_one(
        {"slug": slug},
        {"_id": 0, "clusters": 1, "providerType": 1, "name": 1, "zone": 1, "primaryZone": 1, "address": 1},
    )
    if not doc:
        raise HTTPException(404, "Provider not found")
    active = doc.get("clusters") or [DEFAULT_CLUSTER]
    inactive = [c for c in CLUSTERS if c not in active]

    # ─── C7.4: Provider Money Dashboard data ──────────────────────────────
    # Today window (UTC midnight → now). Aggregate auction_charges to learn
    # what THIS provider earned per cluster + what the WHOLE market earned
    # in the same cluster (FOMO trigger).
    now = datetime.now(timezone.utc)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    # this provider — by cluster
    self_pipe = [
        {"$match": {"providerSlug": slug, "createdAt": {"$gte": day_start}}},
        {"$group": {
            "_id": {"$ifNull": ["$cluster", "repair"]},
            "revenue": {"$sum": "$amountCharged"},
            "leads": {"$sum": 1},
            "currency": {"$first": "$currency"},
        }},
    ]
    self_rows = await db.auction_charges.aggregate(self_pipe).to_list(20)
    self_by_cluster = {r["_id"]: {
        "revenue": int(r.get("revenue", 0) or 0),
        "leads": int(r.get("leads", 0) or 0),
        "currency": r.get("currency"),
    } for r in self_rows}

    # whole market — by cluster (FOMO)
    market_pipe = [
        {"$match": {"createdAt": {"$gte": day_start}}},
        {"$group": {
            "_id": {"$ifNull": ["$cluster", "repair"]},
            "revenue": {"$sum": "$amountCharged"},
            "leads": {"$sum": 1},
            "providers": {"$addToSet": "$providerSlug"},
            "currency": {"$first": "$currency"},
        }},
    ]
    market_rows = await db.auction_charges.aggregate(market_pipe).to_list(20)
    market_by_cluster = {r["_id"]: {
        "revenue": int(r.get("revenue", 0) or 0),
        "leads": int(r.get("leads", 0) or 0),
        "providers": len(r.get("providers", []) or []),
        "currency": r.get("currency"),
    } for r in market_rows}

    def _sym(cur: str | None) -> str:
        return "€" if cur == "EUR" else "₴"

    # Active cluster cards (with self today revenue)
    active_cards = []
    for c in active:
        if c not in CLUSTERS:
            continue
        cfg = CLUSTERS[c]
        s = self_by_cluster.get(c, {})
        m = market_by_cluster.get(c, {})
        active_cards.append({
            "cluster": c,
            "title": cfg["title"],
            "emoji": cfg.get("emoji"),
            "currency": cfg.get("currency"),
            "currencySymbol": _sym(cfg.get("currency")),
            "todayRevenue": int(s.get("revenue", 0) or 0),
            "todayLeads": int(s.get("leads", 0) or 0),
            "marketRevenueToday": int(m.get("revenue", 0) or 0),
            "marketLeadsToday": int(m.get("leads", 0) or 0),
            "marketProvidersToday": int(m.get("providers", 0) or 0),
        })

    # Upsells (missing clusters) — with FOMO market revenue
    upsells: list[dict] = []
    for cid in inactive:
        cfg = CLUSTERS[cid]
        lo, hi = cfg.get("priceRange", [cfg.get("defaultPrice", 0), cfg.get("defaultPrice", 0)])
        sym = _sym(cfg.get("currency"))
        m = market_by_cluster.get(cid, {})
        upsells.append({
            "cluster": cid,
            "title": cfg["title"],
            "emoji": cfg.get("emoji"),
            "currency": cfg.get("currency"),
            "currencySymbol": sym,
            "priceRange": cfg.get("priceRange"),
            "hint": f"{cfg['title']}: {sym}{lo}–{hi} за заявку",
            "marketRevenueToday": int(m.get("revenue", 0) or 0),
            "marketLeadsToday": int(m.get("leads", 0) or 0),
            "marketProvidersToday": int(m.get("providers", 0) or 0),
            "ctaRoute": f"/provider-boost?cluster={cid}",
        })

    # Daily goal — heuristic: 1.5× weekday avg per cluster's mid-priceRange × leads/day target.
    # For first iteration use a flat target by primary currency: €500 if any active cluster
    # is EUR else ₴2000.
    has_eur = any(CLUSTERS[c].get("currency") == "EUR" for c in active if c in CLUSTERS)
    goal_currency = "EUR" if has_eur else "UAH"
    goal_symbol = _sym(goal_currency)
    goal_target = 500 if has_eur else 2000
    goal_earned = sum(card["todayRevenue"] for card in active_cards if (card["currency"] == goal_currency))
    goal_remaining = max(goal_target - goal_earned, 0)
    goal_pct = round(min(goal_earned / goal_target, 1.0) * 100) if goal_target else 0
    # Suggest the cluster where this provider is at 0 BUT market has revenue
    nudge_cluster = None
    for u in upsells:
        if u["marketRevenueToday"] > 0 and u["currency"] == goal_currency:
            nudge_cluster = u
            break

    daily_goal = {
        "currency": goal_currency,
        "currencySymbol": goal_symbol,
        "target": goal_target,
        "earned": int(goal_earned),
        "remaining": int(goal_remaining),
        "percent": goal_pct,
        "nudgeCluster": nudge_cluster["cluster"] if nudge_cluster else None,
        "nudgeCtaLabel": (
            f"Добить через {nudge_cluster['emoji']} {nudge_cluster['title']}"
            if nudge_cluster else None
        ),
        "nudgeCtaRoute": (
            f"/provider-boost?cluster={nudge_cluster['cluster']}"
            if nudge_cluster else None
        ),
    }

    return {
        "providerSlug": slug,
        "providerName": doc.get("name"),
        "active": active_cards,
        "upsells": upsells,
        "providerType": doc.get("providerType"),
        "dailyGoal": daily_goal,
        "asOf": now.isoformat(),
    }
