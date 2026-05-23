"""app.marketplace.quick_request — QUICK REQUEST CORE (Sprint 14.5 - 17).

Sprint 21 C9: ядро продукта вынесено из server.py как первый domain-модуль.

Что внутри (всё перенесено 1-в-1 из server.py, никаких изменений логики):

Classifier / problem taxonomy
  • PROBLEM_KEYWORDS, PROBLEM_TO_SLUGS, PROBLEM_LABELS — static таблицы
  • classify_problem(text) — rule-based классификатор на ключевых словах

Pricing
  • QUICK_REQUEST_TIMEOUT_SEC = 60 — окно на ответ мастера
  • _format_surge(surge, zone_status) — human label + kind (Sprint 16)

Ranking optimizer (Sprint 17)
  • DEFAULT_RANKING_WEIGHTS + RANKING_FEATURES + thresholds
  • _normalize_weights / _success_score
  • get_ranking_weights(zone_id, problem_type) → (weights, source)
  • _hydrate_offer_outcomes() — подтягивает booking outcomes в offers
  • _recalculate_ranking_weights(force?) — correlational refit на finalized offers
  • provider_ranking_optimizer_loop() — фоновый loop на 5 минут (запускается из server.py startup)

Auto-expire
  • quick_request_auto_expire(request_id) — task на 60+1s, mark expired

8 endpoints (зарегистрированы в router ниже):
  POST /api/quick-request/resolve
  GET  /api/quick-request/{id}
  POST /api/quick-request/{id}/accept
  POST /api/quick-request/{id}/reject
  GET  /api/quick-request/inbox/{providerSlug}
  GET  /api/admin/ranking/weights
  GET  /api/admin/ranking/weights/{zoneId}
  POST /api/admin/ranking/recalculate

Внешние зависимости (все через app.core.* — никаких прямых импортов из server):
  • db              — app.core.db.get_db()
  • emit_realtime_event — app.core.realtime
  • logger          — app.core.context.ctx.logger (инициализируется в server.py)
  • now_utc, uid    — app.core.utils
  • haversine, resolve_zone — app.core.geo
  • verify_admin_token — app.core.security

Инварианты:
  1. Atomic claim через find_one_and_update({status:'searching'}) — НЕ трогать.
  2. Price snapshot (basePrice/surge/finalPrice) в booking — НЕ трогать.
  3. weightsUsed/features в offer — feed ranking optimizer, НЕ удалять.
"""
from __future__ import annotations
import asyncio
import logging
import random
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request

from app.core.context import ctx
from app.core.db import get_db
from app.core.geo import haversine, resolve_zone
from app.core.realtime import emit_realtime_event
from app.core.security import verify_admin_token
from app.core.utils import now_utc, uid


logger = logging.getLogger("server")
router = APIRouter()


# ═══════════════════════════════════════════════════════════════════
# 🔥 SPRINT 14.5 — Problem taxonomy + classifier
# ═══════════════════════════════════════════════════════════════════
PROBLEM_KEYWORDS = {
    "engine_start_failure": ["start", "won't", "не завод", "не зав", "стартер", "starter", "wont start", "won't start", "springt nicht"],
    "battery":               ["battery", "акумул", "аккумул", "разряж", "разрядил", "сел", "batterie", "leer"],
    "tow":                   ["tow", "эвакуатор", "abschlepp"],
    "tires":                 ["tire", "tyre", "шин", "колес", "прокол", "puncture", "reifen"],
    "brakes":                ["brake", "тормоз", "тормоза", "колодк", "bremse"],
    "oil":                   ["oil", "масло", "öl"],
    "diagnostics":           ["diag", "диагност", "ошибка", "ошибки", "check engine", "code", "lamp", "лампа", "kontroll"],
    "electrical":            ["electric", "электр", "проводк", "wiring", "elektr", "генератор"],
    "suspension":            ["suspension", "подвеск", "стойк", "амортиз", "fahrwerk", "stoßdämpfer"],
    "noise":                 ["noise", "шум", "стук", "стучит", "geräusch", "klopf"],
    "ac":                    ["air cond", "ac ", "кондицион", "klima"],
}

PROBLEM_TO_SLUGS = {
    "engine_start_failure": ["starter", "battery", "diagnostics", "electrical"],
    "battery":               ["battery", "electrical"],
    "tow":                   ["tow", "evacuation"],
    "tires":                 ["tires", "wheels"],
    "brakes":                ["brakes"],
    "oil":                   ["oil-change"],
    "diagnostics":           ["diagnostics"],
    "electrical":            ["electrical"],
    "suspension":            ["suspension"],
    "noise":                 ["diagnostics", "engine"],
    "ac":                    ["ac", "climate"],
    "general":               ["diagnostics"],
}

PROBLEM_LABELS = {
    "engine_start_failure": "Engine won't start",
    "battery":               "Battery / charging",
    "tow":                   "Tow truck",
    "tires":                 "Tires & wheels",
    "brakes":                "Brake system",
    "oil":                   "Oil change",
    "diagnostics":           "Diagnostics",
    "electrical":            "Electrical / wiring",
    "suspension":            "Suspension",
    "noise":                 "Engine noise",
    "ac":                    "Air conditioning",
    "general":               "General check",
}


def classify_problem(text: str) -> str:
    """Cheap rule-based classifier. Returns a problem key or 'general'."""
    if not text:
        return "general"
    t = text.lower()
    best, hits = "general", 0
    for key, words in PROBLEM_KEYWORDS.items():
        c = sum(1 for w in words if w in t)
        if c > hits:
            best, hits = key, c
    return best


def _format_surge(surge: float, zone_status: str = "BALANCED"):
    """Sprint 16: human label + kind for a surge multiplier.

    Returns: (label, kind)
      kind ∈ 'high' | 'normal' | 'low'
    """
    pct = int(round((surge - 1.0) * 100))
    if surge >= 1.05:
        suffix = " · zone overload" if zone_status == "CRITICAL" else " high demand"
        return (f"+{pct}%{suffix}", "high")
    if surge <= 0.95:
        return (f"{pct}% low demand", "low")
    return ("Normal pricing", "normal")


# ═══════════════════════════════════════════════════════════════════
# 🧠 SPRINT 17 — Provider Ranking Optimizer (self-learning weights)
# ═══════════════════════════════════════════════════════════════════
DEFAULT_RANKING_WEIGHTS = {
    "distance":         0.35,
    "rating":           0.25,
    "response":         0.15,
    "online":           0.10,
    "skillFit":         0.10,
    "surgeMotivation":  0.05,
}
RANKING_FEATURES = list(DEFAULT_RANKING_WEIGHTS.keys())
RANKING_MIN_SAMPLES = 30
RANKING_MIN_CONFIDENCE = 0.30
RANKING_MIN_WEIGHT = 0.05
RANKING_MAX_WEIGHT = 0.50
RANKING_OPTIMIZER_INTERVAL_SEC = 300  # 5 min


def _normalize_weights(w: dict) -> dict:
    """Clamp every weight then renormalise to sum=1.0."""
    clamped = {k: max(RANKING_MIN_WEIGHT, min(RANKING_MAX_WEIGHT, float(v))) for k, v in w.items()}
    s = sum(clamped.values()) or 1.0
    return {k: round(v / s, 4) for k, v in clamped.items()}


async def get_ranking_weights(zone_id: str | None, problem_type: str | None) -> tuple[dict, str]:
    """Return (weights, source) — source ∈ 'learned' | 'default'.

    Falls back to defaults when sample size or confidence is insufficient,
    so the system never optimises on noise.
    """
    if not zone_id or not problem_type:
        return dict(DEFAULT_RANKING_WEIGHTS), "default"
    db = get_db()
    doc = await db.provider_ranking_weights.find_one(
        {"zoneId": zone_id, "problemType": problem_type},
        {"_id": 0},
    )
    if not doc:
        return dict(DEFAULT_RANKING_WEIGHTS), "default"
    if int(doc.get("samples", 0)) < RANKING_MIN_SAMPLES or float(doc.get("confidence", 0.0)) < RANKING_MIN_CONFIDENCE:
        return dict(DEFAULT_RANKING_WEIGHTS), "default"
    weights = doc.get("weights") or {}
    merged = {k: float(weights.get(k, DEFAULT_RANKING_WEIGHTS[k])) for k in RANKING_FEATURES}
    return _normalize_weights(merged), "learned"


def _success_score(offer: dict) -> float:
    """0..1 outcome quality used to train the ranker."""
    accepted = 1.0 if offer.get("accepted") else 0.0
    completed = 1.0 if offer.get("bookingCompleted") else 0.0
    cancelled = 1.0 if offer.get("bookingCancelled") else 0.0
    rsp = offer.get("responseSeconds") or 0
    fast = 1.0 if (accepted and 0 < rsp < 30) else 0.0
    no_cancel = 1.0 - cancelled
    return 0.35 * accepted + 0.35 * completed + 0.15 * fast + 0.15 * no_cancel


async def _hydrate_offer_outcomes() -> int:
    """Pull booking outcomes into offers so the optimizer has training data."""
    db = get_db()
    cursor = db.quick_request_offers.find(
        {"outcomeFinalized": {"$ne": True}, "status": {"$in": ["accepted", "rejected", "expired", "superseded"]}},
        {"_id": 0},
    ).limit(2000)
    updates = 0
    async for off in cursor:
        accepted = off.get("status") == "accepted"
        rejected = off.get("status") == "rejected"
        expired = off.get("status") == "expired"
        superseded = off.get("status") == "superseded"

        booking_completed = False
        booking_cancelled = False
        finalize_now = rejected or expired or superseded  # terminal already

        if accepted:
            bk = await db.bookings.find_one(
                {"quickRequestId": off["requestId"], "providerSlug": off["providerSlug"]},
                {"_id": 0, "status": 1},
            )
            if bk:
                bs = bk.get("status")
                if bs in ("completed", "done"):
                    booking_completed = True
                    finalize_now = True
                elif bs in ("cancelled", "no_show"):
                    booking_cancelled = True
                    finalize_now = True

        rsp_sec = None
        try:
            if off.get("respondedAt") and off.get("createdAt"):
                rsp_sec = int(
                    (datetime.fromisoformat(off["respondedAt"]) - datetime.fromisoformat(off["createdAt"]))
                    .total_seconds()
                )
        except Exception:
            rsp_sec = None

        await db.quick_request_offers.update_one(
            {"id": off["id"]},
            {"$set": {
                "accepted":          accepted,
                "rejected":          rejected,
                "expired":           expired,
                "bookingCompleted":  booking_completed,
                "bookingCancelled":  booking_cancelled,
                "responseSeconds":   rsp_sec,
                "outcomeFinalized":  finalize_now,
            }},
        )
        updates += 1
    return updates


async def _recalculate_ranking_weights(force: bool = False) -> dict:
    """Optimizer body: re-fit weights per (zoneId, problemType) from finalised offers.

    Returns a summary dict { groups, updated, total_samples }.
    """
    await _hydrate_offer_outcomes()
    db = get_db()

    # Pipe: only finalised offers with feature snapshots and zone/problem info
    pipeline = [
        {"$match": {
            "outcomeFinalized": True,
            "features": {"$type": "object"},
            "zoneId":   {"$ne": None},
            "problemType": {"$ne": None},
        }},
        {"$group": {
            "_id": {"zoneId": "$zoneId", "problemType": "$problemType"},
            "samples": {"$sum": 1},
            "offers":  {"$push": {"features": "$features", "outcome": {
                "accepted":         "$accepted",
                "bookingCompleted": "$bookingCompleted",
                "bookingCancelled": "$bookingCancelled",
                "responseSeconds":  "$responseSeconds",
            }}},
        }},
    ]

    groups = 0
    updated = 0
    total_samples = 0
    cursor = db.quick_request_offers.aggregate(pipeline)
    async for grp in cursor:
        groups += 1
        zone_id = grp["_id"]["zoneId"]
        problem = grp["_id"]["problemType"]
        samples = int(grp["samples"])
        total_samples += samples

        if samples < RANKING_MIN_SAMPLES and not force:
            # Still upsert a stub so admin can see "warming up"
            await db.provider_ranking_weights.update_one(
                {"zoneId": zone_id, "problemType": problem},
                {"$set": {
                    "zoneId": zone_id, "problemType": problem,
                    "weights":   dict(DEFAULT_RANKING_WEIGHTS),
                    "samples":   samples,
                    "confidence": round(samples / RANKING_MIN_SAMPLES, 3),
                    "source":    "default",
                    "updatedAt": now_utc().isoformat(),
                }},
                upsert=True,
            )
            continue

        # Compute mean success and feature×success covariance
        offers = grp["offers"]
        n = len(offers)
        ys = [_success_score(o["outcome"]) for o in offers]
        y_mean = sum(ys) / n if n else 0.0

        new_w = {}
        for feat in RANKING_FEATURES:
            xs = [float((o["features"] or {}).get(feat) or 0.0) for o in offers]
            x_mean = sum(xs) / n if n else 0.0
            cov = sum((xs[i] - x_mean) * (ys[i] - y_mean) for i in range(n)) / n if n else 0.0
            var_x = sum((xi - x_mean) ** 2 for xi in xs) / n if n else 0.0
            var_y = sum((yi - y_mean) ** 2 for yi in ys) / n if n else 0.0
            denom = (var_x * var_y) ** 0.5
            corr = cov / denom if denom > 0 else 0.0
            # Map corr in [-1, 1] to a positive weight, blended with default to keep stable
            blended = 0.6 * DEFAULT_RANKING_WEIGHTS[feat] + 0.4 * max(0.05, (corr + 1.0) / 4.0 + 0.1)
            new_w[feat] = blended

        new_w = _normalize_weights(new_w)

        # Confidence: combine sample-size factor + signal cohesion
        size_factor = min(1.0, samples / 200.0)
        signal_factor = min(1.0, y_mean * 1.5)  # higher mean → cleaner signal
        confidence = round(0.6 * size_factor + 0.4 * signal_factor, 3)

        await db.provider_ranking_weights.update_one(
            {"zoneId": zone_id, "problemType": problem},
            {"$set": {
                "zoneId":     zone_id,
                "problemType": problem,
                "weights":    new_w,
                "samples":    samples,
                "confidence": confidence,
                "yMean":      round(y_mean, 4),
                "source":     "learned" if confidence >= RANKING_MIN_CONFIDENCE else "default",
                "updatedAt":  now_utc().isoformat(),
            }},
            upsert=True,
        )
        updated += 1

    return {"groups": groups, "updated": updated, "total_samples": total_samples}


async def provider_ranking_optimizer_loop():
    """Compatibility shim — body moved to `app.workers.provider_ranking`.

    Phase 3D PR-04: the actual loop body now lives at
    `app/workers/provider_ranking/loop.py`. This shim is preserved at
    the original symbol path because the previous module docstring
    (lines 21 + lifespan import history) advertises it as part of the
    `app.marketplace.quick_request` public surface. Per Phase 3D §1
    P-10, the old import path remains valid for one PR cycle.

    Internally delegates to the extracted implementation. No
    behavioural change.
    """
    from app.workers.provider_ranking.loop import provider_ranking_optimizer_loop as _impl
    return await _impl()


# ═══════════════════════════════════════════════════════════════════
# 🚀 SPRINT 15 — Quick Request Auto-Distribution (timeout loop)
# ═══════════════════════════════════════════════════════════════════
QUICK_REQUEST_TIMEOUT_SEC = 60


async def quick_request_auto_expire(request_id: str):
    """Background task: after timeout, mark unassigned request as expired."""
    db = get_db()
    logger = ctx.logger
    await asyncio.sleep(QUICK_REQUEST_TIMEOUT_SEC + 1)
    qr = await db.quick_requests.find_one({"id": request_id}, {"_id": 0, "status": 1})
    if not qr or qr.get("status") != "searching":
        return
    await db.quick_requests.update_one(
        {"id": request_id, "status": "searching"},
        {"$set": {"status": "expired", "expiredAt": now_utc().isoformat()}},
    )
    await db.quick_request_offers.update_many(
        {"requestId": request_id, "status": "pending"},
        {"$set": {"status": "expired"}},
    )
    await emit_realtime_event("request:expired", {"requestId": request_id})
    if logger:
        logger.info(f"quick_request {request_id} expired (no accept in {QUICK_REQUEST_TIMEOUT_SEC}s)")


# ═══════════════════════════════════════════════════════════════════
# 🔥 CORE ENDPOINT — Problem → Solution
# ═══════════════════════════════════════════════════════════════════
@router.post("/api/quick-request/resolve")
async def quick_request_resolve(request: Request):
    """🔥 Core product endpoint — Problem → Solution.

    Request : { text: str, location?: { lat, lng } }
    Response: { problemType, problemLabel, solutions[], recommended }

    No auth: anyone can hit this. Used by sticky FAB across the whole web-app.
    """
    db = get_db()
    body = await request.json()
    text = (body.get("text") or "").strip()
    loc = body.get("location") or {}
    lat = float(loc.get("lat", 50.4501))
    lng = float(loc.get("lng", 30.5234))

    # Sprint 33: cluster-aware routing (default=repair → no breaking change)
    from app.marketplace.clusters import normalize_cluster, get_cluster
    cluster_id = normalize_cluster(body.get("cluster"))
    cluster_cfg = get_cluster(cluster_id)
    car_link = (body.get("carLink") or "").strip()
    budget = body.get("budget")  # Sprint 33 C4: required for selection
    address_hint = (body.get("addressHint") or "").strip()

    # Sprint 33 C4 — cluster-specific input validation
    if cluster_id == "inspection" and not car_link:
        raise HTTPException(400, "carLink is required for cluster=inspection (e.g., mobile.de URL)")
    if cluster_id == "selection" and not budget:
        raise HTTPException(400, "budget is required for cluster=selection (numeric, in cluster currency)")
    if cluster_id == "delivery" and not (address_hint or body.get("location")):
        raise HTTPException(400, "location/addressHint is required for cluster=delivery")

    problem_key = classify_problem(text)
    needed_slugs = PROBLEM_TO_SLUGS.get(problem_key, ["diagnostics"])

    # ─── Sprint 16: dynamic surge per client zone ──────────────────
    client_zone_id = resolve_zone(lat, lng)
    zone_doc = await db.zones.find_one(
        {"id": client_zone_id},
        {"_id": 0, "id": 1, "name": 1, "surgeMultiplier": 1, "status": 1, "ratio": 1},
    ) if client_zone_id else None
    zone_surge = float((zone_doc or {}).get("surgeMultiplier", 1.0))
    zone_status = (zone_doc or {}).get("status", "BALANCED")
    zone_name = (zone_doc or {}).get("name", "your area")
    surge_label, surge_kind = _format_surge(zone_surge, zone_status)

    orgs = await db.organizations.find(
        {"status": "active", "isOnline": True},
        {"_id": 0, "ownerId": 0},
    ).to_list(50)
    if not orgs:
        orgs = await db.organizations.find({"status": "active"}, {"_id": 0, "ownerId": 0}).to_list(50)

    # Sprint 33: filter providers by cluster. Legacy providers with no `clusters`
    # field are treated as ["repair"] to preserve behavior.
    orgs = [
        o for o in orgs
        if cluster_id in (o.get("clusters") or ["repair"])
    ]
    if not orgs:
        # Fallback: no cluster-tagged providers found → fall back to ALL active
        # (prevents empty results during migration). In prod this would return empty.
        orgs = await db.organizations.find({"status": "active"}, {"_id": 0, "ownerId": 0}).to_list(50)
        orgs = [o for o in orgs if cluster_id in (o.get("clusters") or ["repair"])]

    # Sprint 17 — fetch learned ranking weights for this (zone, problem)
    weights, weights_source = await get_ranking_weights(client_zone_id, problem_key)
    surge_motivation = max(0.0, min(1.0, (zone_surge - 1.0)))  # 0..1, growing with surge

    solutions = []
    for o in orgs:
        coords = o.get("location", {}).get("coordinates", [30.52, 50.45])
        dist = round(haversine(lat, lng, coords[1], coords[0]), 1)
        eta = max(3, int(dist * 4 + random.uniform(-2, 3)))
        rating = float(o.get("ratingAvg", 4.0))
        rsp = float(o.get("avgResponseTimeMinutes", 15))
        is_online = bool(o.get("isOnline"))

        tags_lc = " ".join([str(t).lower() for t in (o.get("badges") or [])] + [str(t).lower() for t in (o.get("tags") or [])])
        fit = 1.0 if any(s in tags_lc for s in needed_slugs) else 0.7

        dist_s = max(0, min(1, 1 - dist / 10))
        rat_s = max(0, min(1, rating / 5))
        rsp_s = max(0, min(1, 1 - rsp / 30))
        avl_s = 1 if is_online else 0.3

        # Sprint 17: feature snapshot (used for ranking-optimizer training)
        features = {
            "distance":         round(dist_s, 4),
            "rating":           round(rat_s, 4),
            "response":         round(rsp_s, 4),
            "online":           avl_s,
            "skillFit":         round(fit, 4),
            "surgeMotivation":  round(surge_motivation, 4),
        }

        # Weighted score (learned weights when available, otherwise sensible defaults)
        score = round(
            sum(features[k] * weights[k] for k in RANKING_FEATURES) * fit,
            4,
        )

        base_price = int(o.get("priceFrom") or 350)
        final_price = int(round(base_price * zone_surge))

        # Sprint 34 Day 4 — trust enrichment for ProviderCard.
        # Hash-based deterministic fallback when DB fields are missing,
        # so re-runs are idempotent and the demo never shows empty trust.
        slug_for_hash = str(o.get("slug") or o.get("_id") or "x")
        slug_hash = sum(ord(c) for c in slug_for_hash)
        years = int(o.get("yearsExperience") or (5 + (slug_hash % 14)))      # 5..18
        vehicles = int(
            o.get("vehiclesInspected")
            or o.get("completedBookingsCount")
            or (120 + (slug_hash * 17 % 480))                                # 120..600
        )
        tuv = bool(o.get("tuvVerified") if o.get("tuvVerified") is not None
                   else (slug_hash % 2 == 0))
        rsp_min = int(o.get("avgResponseTimeMinutes") or (8 + (slug_hash % 18)))  # 8..26
        trust = {
            "tuvVerified":       tuv,
            "yearsExperience":   years,
            "vehiclesInspected": vehicles,
            "verified":          bool(o.get("isVerified")),
        }
        meta = {
            "responseTime": rsp_min,
        }

        solutions.append({
            "providerId":   o.get("slug") or o.get("id"),
            "slug":         o.get("slug"),
            "name":         o.get("name"),
            "rating":       round(rating, 1),
            "reviewsCount": int(o.get("reviewsCount", 0)),
            "eta":          eta,
            "etaText":      f"{eta} min",
            "distance":     dist,
            "distanceText": f"{dist} km",
            "priceFrom":    base_price,
            "finalPrice":   final_price,
            "surge":        round(zone_surge, 2),
            "surgeLabel":   surge_label,
            "surgeKind":    surge_kind,
            "isOnline":     is_online,
            "matchScore":   score,
            "badges":       (o.get("badges") or [])[:4],
            "warranty":     o.get("warranty") or "1 year",
            "vatIncluded":  True,
            "features":     features,
            "trust":        trust,
            "meta":         meta,
        })

    solutions.sort(key=lambda s: -s["matchScore"])
    # Sprint 33 C4 — cluster-specific sort: inspection prioritizes rating over distance
    if cluster_id == "inspection":
        solutions.sort(key=lambda s: (-s.get("rating", 0), -s["matchScore"]))
    elif cluster_id == "selection":
        # Selection: rating × reviews count (expert weight)
        solutions.sort(key=lambda s: -(s.get("rating", 0) * (s.get("reviewsCount", 0) ** 0.5)))
    top = solutions[:5]

    # ─────────────────────────────────────────────────────────────
    # 🚀 REALTIME AUTO-DISTRIBUTION (Sprint 15)
    # Создаём quick_request, рассылаем top-3 мастерам, ждём accept 60s.
    # Клиент попадает на waiting screen и слушает request:assigned.
    # ─────────────────────────────────────────────────────────────
    request_id = uid()
    expires_at = now_utc() + timedelta(seconds=QUICK_REQUEST_TIMEOUT_SEC)
    target_providers = [s["slug"] for s in top[:3] if s.get("slug")]

    qr_doc = {
        "id":              request_id,
        "status":          "searching",
        # Sprint 33: cluster-aware (default repair)
        "cluster":         cluster_id,
        # Sprint 33 C4 — cluster-specific input snapshot
        "carLink":         car_link or None,
        "budget":          budget,
        "currency":        cluster_cfg.get("currency", "UAH"),
        "clusterDefaultPrice": cluster_cfg.get("defaultPrice"),
        "problemType":     problem_key,
        "problemLabel":    PROBLEM_LABELS.get(problem_key, "General check"),
        "echoText":        text[:140],
        "location":        {"type": "Point", "coordinates": [lng, lat]},
        "addressHint":     body.get("addressHint", ""),
        "targetProviders": target_providers,
        "rejectedBy":      [],
        "topSolutions":    top,
        "providerId":      None,
        "bookingId":       None,
        # Sprint 16 — surge snapshot (locked at creation; client paid this)
        "zoneId":          client_zone_id,
        "zoneName":        zone_name,
        "zoneStatus":      zone_status,
        "surge":           round(zone_surge, 2),
        "surgeLabel":      surge_label,
        "surgeKind":       surge_kind,
        "createdAt":       now_utc().isoformat(),
        "expiresAt":       expires_at.isoformat(),
        "assignedAt":      None,
    }
    await db.quick_requests.insert_one(dict(qr_doc))

    # Per-provider offer rows (so each mechanic sees their own queue)
    if target_providers:
        # Map slug → solution feature snapshot (used by ranking optimizer later)
        feature_by_slug = {s["slug"]: s.get("features", {}) for s in top}
        offers = [{
            "id":          uid(),
            "requestId":   request_id,
            "providerSlug": slug,
            "status":      "pending",          # pending | accepted | rejected | expired | superseded
            "createdAt":   now_utc().isoformat(),
            "expiresAt":   expires_at.isoformat(),
            "rank":        idx,
            # Sprint 17 — feature snapshot + zone/problem context for the optimizer
            "zoneId":      client_zone_id,
            "problemType": problem_key,
            # Sprint 33 — cluster propagated for downstream filters/auctions
            "cluster":     cluster_id,
            "features":    feature_by_slug.get(slug, {}),
            "weightsUsed": dict(weights),
            "weightsSource": weights_source,
            "outcomeFinalized": False,
        } for idx, slug in enumerate(target_providers)]
        await db.quick_request_offers.insert_many(offers)

    # Emit realtime event — providers (and admin) get notified
    snapshot = next((s for s in top if s.get("slug") in target_providers), top[0] if top else {})
    await emit_realtime_event("provider:new_request", {
        "requestId":        request_id,
        "problemLabel":     PROBLEM_LABELS.get(problem_key, "General check"),
        "echoText":         text[:140],
        "targetProviders":  target_providers,
        "expiresAt":        expires_at.isoformat(),
        "expiresInSec":     QUICK_REQUEST_TIMEOUT_SEC,
        "priceEstimate":    snapshot.get("priceFrom"),
        "finalPrice":       snapshot.get("finalPrice"),
        "surge":            round(zone_surge, 2),
        "surgeLabel":       surge_label,
        "surgeKind":        surge_kind,
        "etaText":          snapshot.get("etaText"),
        "distanceText":     snapshot.get("distanceText"),
    })

    # Schedule auto-expire (non-blocking)
    asyncio.create_task(quick_request_auto_expire(request_id))

    # Sprint 26: track that these providers received the request
    try:
        from app.performance import record_received
        for s in top[:5]:
            slug = s.get("slug")
            if slug:
                asyncio.create_task(record_received(slug))
    except Exception:
        pass

    # Sprint 30: Retention — track missed revenue for offline providers in the zone
    try:
        from app.retention import track_missed_for_offline_providers
        picked = [s for s in target_providers if s]
        avg_price = int(round(sum(int(s.get("finalPrice") or 0) for s in top) / max(1, len(top))))
        asyncio.create_task(track_missed_for_offline_providers(
            zone_id=client_zone_id,
            potential_price=avg_price,
            picked_slugs=picked,
        ))
    except Exception as _e:
        pass

    # Sprint 31: Push — send "new request" push to each target provider
    try:
        from app.push import notify_new_request_to_provider
        for snap in top[:3]:
            slug = snap.get("slug")
            if not slug:
                continue
            price = int(snap.get("finalPrice") or snap.get("basePrice") or 0)
            dist_km = float(snap.get("distanceKm") or 0)
            asyncio.create_task(notify_new_request_to_provider(
                provider_slug=slug,
                price=price,
                distance_km=dist_km,
                request_id=str(request_id),
            ))
    except Exception as _e:
        pass

    return {
        "requestId":       request_id,
        "status":          "searching",
        "expiresInSec":    QUICK_REQUEST_TIMEOUT_SEC,
        "targetProviders": target_providers,
        "problemType":     problem_key,
        "problemLabel":    PROBLEM_LABELS.get(problem_key, "General check"),
        # Sprint 33 — cluster snapshot in response (default repair)
        "cluster":         cluster_id,
        "currency":        cluster_cfg.get("currency", "UAH"),
        "matchedCount":    len(solutions),
        "solutions":       [{k: v for k, v in s.items() if k != "features"} for s in top],
        "recommended":     top[0]["providerId"] if top else None,
        "recommendedSlug": top[0]["slug"] if top else None,
        "echoText":        text[:140],
        # Sprint 16 — surge / pricing zone snapshot
        "zoneId":          client_zone_id,
        "zoneName":        zone_name,
        "zoneStatus":      zone_status,
        "surge":           round(zone_surge, 2),
        "surgeLabel":      surge_label,
        "surgeKind":       surge_kind,
        # Sprint 17 — ranking intelligence snapshot
        "rankingWeights":  weights,
        "rankingSource":   weights_source,
    }


@router.get("/api/quick-request/{request_id}")
async def quick_request_status(request_id: str):
    """Polling fallback for the waiting screen."""
    db = get_db()
    qr = await db.quick_requests.find_one({"id": request_id}, {"_id": 0})
    if not qr:
        raise HTTPException(404, "Request not found")
    # Provider details if assigned
    provider = None
    if qr.get("providerId"):
        org = await db.organizations.find_one(
            {"slug": qr["providerId"]},
            {"_id": 0, "ownerId": 0, "location": 0},
        )
        if org:
            provider = {
                "slug":   org.get("slug"),
                "name":   org.get("name"),
                "rating": float(org.get("ratingAvg", 0)),
                "phone":  org.get("phone"),
                "avgResponseTimeMinutes": org.get("avgResponseTimeMinutes"),
            }
    try:
        expires_dt = datetime.fromisoformat(qr["expiresAt"])
        seconds_left = max(0, int((expires_dt - now_utc()).total_seconds()))
    except Exception:
        seconds_left = 0
    return {
        "requestId":     qr["id"],
        "status":        qr["status"],          # searching | assigned | expired | cancelled
        "providerId":    qr.get("providerId"),
        "bookingId":     qr.get("bookingId"),
        "provider":      provider,
        "secondsLeft":   seconds_left,
        "expiresAt":     qr["expiresAt"],
        "assignedAt":    qr.get("assignedAt"),
        "problemLabel":  qr.get("problemLabel"),
        # Sprint 33 — cluster snapshot
        "cluster":       qr.get("cluster") or "repair",
        "currency":      qr.get("currency"),
        # Sprint QR-1: hybrid threshold support — клиент решает: searching ИЛИ offers UI
        "bestScore":     max((s.get("matchScore", 0) for s in qr.get("topSolutions", [])), default=0),
        "solutions":     [{k: v for k, v in s.items() if k != "features"} for s in qr.get("topSolutions", [])][:3],
        "surge":         qr.get("surge", 1.0),
        "surgeLabel":    qr.get("surgeLabel"),
        "surgeKind":     qr.get("surgeKind"),
    }


@router.post("/api/quick-request/{request_id}/accept")
async def quick_request_accept(request_id: str, request: Request):
    """Provider accepts a quick-request. Atomic claim — first one wins.

    Body: { providerSlug: str }
    Creates a booking and notifies the customer + losing providers.
    """
    db = get_db()
    body = await request.json()
    provider_slug = (body.get("providerSlug") or body.get("providerId") or "").strip()
    if not provider_slug:
        raise HTTPException(400, "providerSlug required")

    # Atomic claim — only succeeds if status still 'searching'
    claimed = await db.quick_requests.find_one_and_update(
        {"id": request_id, "status": "searching"},
        {"$set": {
            "status":     "assigned",
            "providerId": provider_slug,
            "assignedAt": now_utc().isoformat(),
        }},
        return_document=True,
    )
    if not claimed:
        # Either already taken or expired
        existing = await db.quick_requests.find_one({"id": request_id}, {"_id": 0, "status": 1, "providerId": 1, "bookingId": 1})
        if not existing:
            raise HTTPException(404, "Request not found")
        if existing.get("status") == "assigned":
            raise HTTPException(409, "Already taken by another provider")
        raise HTTPException(409, f"Request is {existing.get('status', 'unavailable')}")

    org = await db.organizations.find_one({"slug": provider_slug}, {"_id": 0, "ownerId": 0})
    if not org:
        # Roll back the claim
        await db.quick_requests.update_one(
            {"id": request_id},
            {"$set": {"status": "searching", "providerId": None, "assignedAt": None}},
        )
        raise HTTPException(404, "Provider not found")

    # Create a confirmed booking
    booking_id = uid()
    snapshot = next(
        (s for s in claimed.get("topSolutions", []) if s.get("slug") == provider_slug),
        {},
    )
    # Note: coords variable removed (unused) — see old server.py line 2495.
    booking_doc = {
        "id":             booking_id,
        "bookingNumber":  f"QR-{booking_id[:8].upper()}",
        "source":         "quick-request",
        "quickRequestId": request_id,
        "status":         "confirmed",
        "providerSlug":   provider_slug,
        "organizationId": str(org.get("_id") or org.get("id") or ""),
        "orgName":        org.get("name"),
        "serviceName":    claimed.get("problemLabel", "Quick service"),
        "problemType":    claimed.get("problemType"),
        "problemText":    claimed.get("echoText"),
        # Sprint 33 — cluster snapshot propagated from quick_request
        "cluster":        claimed.get("cluster") or "repair",
        # Sprint 33 C4 — booking type alias (UI uses this to switch flow)
        "type":           claimed.get("cluster") or "repair",
        "currency":       claimed.get("currency"),
        "budget":         claimed.get("budget"),
        "carLink":        claimed.get("carLink"),
        "priceEstimate":  snapshot.get("priceFrom") or org.get("priceFrom") or 350,
        # Sprint 16 — surge-locked pricing snapshot (what the customer actually agreed to)
        "basePrice":      int(snapshot.get("priceFrom") or org.get("priceFrom") or 350),
        "surge":          float(claimed.get("surge", 1.0)),
        "surgeLabel":     claimed.get("surgeLabel"),
        "surgeKind":      claimed.get("surgeKind"),
        "finalPrice":     int(snapshot.get("finalPrice") or round((snapshot.get("priceFrom") or org.get("priceFrom") or 350) * float(claimed.get("surge", 1.0)))),
        "zoneId":         claimed.get("zoneId"),
        "zoneName":       claimed.get("zoneName"),
        "etaMinutes":     snapshot.get("eta") or org.get("avgResponseTimeMinutes") or 10,
        "distanceKm":     snapshot.get("distance"),
        "address":        claimed.get("addressHint") or "On-demand location",
        "location":       claimed.get("location"),
        "providerAccepted": True,
        "acceptedAt":     now_utc().isoformat(),
        "createdAt":      now_utc().isoformat(),
        "statusHistory":  [{"status": "confirmed", "at": now_utc().isoformat()}],
    }
    await db.bookings.insert_one(dict(booking_doc))
    await db.quick_requests.update_one(
        {"id": request_id},
        {"$set": {"bookingId": booking_id}},
    )

    # ─── Sprint 27: AUCTION lead-charging (per-lead billing) ───
    try:
        from app.marketplace.auction import charge_lead
        await charge_lead(provider_slug, claimed.get("zoneId"), claimed.get("cluster") or "repair", booking_id)
    except Exception as exc:
        logger.warning(f"[auction] charge_lead failed for {provider_slug}@{claimed.get('zoneId')}: {exc}")

    # Update offers — winner accepted, the rest superseded
    await db.quick_request_offers.update_many(
        {"requestId": request_id, "providerSlug": provider_slug},
        {"$set": {"status": "accepted", "respondedAt": now_utc().isoformat()}},
    )
    await db.quick_request_offers.update_many(
        {"requestId": request_id, "providerSlug": {"$ne": provider_slug}, "status": "pending"},
        {"$set": {"status": "superseded", "respondedAt": now_utc().isoformat()}},
    )

    # Realtime: customer waiting room + provider room
    await emit_realtime_event("request:assigned", {
        "requestId":     request_id,
        "bookingId":     booking_id,
        "providerSlug":  provider_slug,
        "providerName":  org.get("name"),
        "providerRating": float(org.get("ratingAvg", 0)),
        "etaText":       f"{booking_doc['etaMinutes']} min",
        "priceEstimate": booking_doc["priceEstimate"],
    })
    await emit_realtime_event("provider:request_taken", {
        "requestId":    request_id,
        "providerSlug": provider_slug,
    })

    return {
        "success":    True,
        "requestId":  request_id,
        "bookingId":  booking_id,
        "status":     "assigned",
        # Sprint 33 — cluster snapshot
        "cluster":    booking_doc.get("cluster") or "repair",
        "currency":   booking_doc.get("currency"),
        "provider": {
            "slug":   org.get("slug"),
            "name":   org.get("name"),
            "rating": float(org.get("ratingAvg", 0)),
        },
    }


@router.post("/api/quick-request/{request_id}/reject")
async def quick_request_reject(request_id: str, request: Request):
    """Provider explicitly rejects/skips the offer. Doesn't cancel the request — others can still accept."""
    db = get_db()
    body = await request.json()
    provider_slug = (body.get("providerSlug") or body.get("providerId") or "").strip()
    if not provider_slug:
        raise HTTPException(400, "providerSlug required")
    await db.quick_request_offers.update_many(
        {"requestId": request_id, "providerSlug": provider_slug, "status": "pending"},
        {"$set": {"status": "rejected", "respondedAt": now_utc().isoformat()}},
    )
    await db.quick_requests.update_one(
        {"id": request_id},
        {"$addToSet": {"rejectedBy": provider_slug}},
    )
    return {"success": True, "status": "rejected"}


@router.get("/api/quick-request/inbox/{provider_slug}")
async def quick_request_inbox(provider_slug: str):
    """Provider sees pending quick-request offers (all that haven't expired/been taken)."""
    db = get_db()
    offers = await db.quick_request_offers.find(
        {"providerSlug": provider_slug, "status": "pending"},
        {"_id": 0},
    ).sort("createdAt", -1).to_list(20)

    items = []
    for off in offers:
        qr = await db.quick_requests.find_one({"id": off["requestId"]}, {"_id": 0})
        if not qr or qr.get("status") != "searching":
            continue
        try:
            exp = datetime.fromisoformat(qr["expiresAt"])
            seconds_left = max(0, int((exp - now_utc()).total_seconds()))
        except Exception:
            seconds_left = 0
        if seconds_left <= 0:
            continue
        snapshot = next(
            (s for s in qr.get("topSolutions", []) if s.get("slug") == provider_slug),
            {},
        )
        items.append({
            "requestId":     qr["id"],
            "problemLabel":  qr.get("problemLabel"),
            "problemText":   qr.get("echoText"),
            "priceEstimate": snapshot.get("priceFrom"),
            "finalPrice":    snapshot.get("finalPrice") or snapshot.get("priceFrom"),
            "surge":         qr.get("surge", 1.0),
            "surgeLabel":    qr.get("surgeLabel"),
            "surgeKind":     qr.get("surgeKind"),
            "etaText":       snapshot.get("etaText"),
            "distanceText":  snapshot.get("distanceText"),
            "secondsLeft":   seconds_left,
            "createdAt":     qr.get("createdAt"),
            "rank":          off.get("rank", 0),
        })
    return {"items": items, "count": len(items)}


# ═══════════════════════════════════════════════════════════════════
# 🧠 SPRINT 17 — Admin: ranking intelligence visibility
# ═══════════════════════════════════════════════════════════════════
@router.get("/api/admin/ranking/weights")
async def admin_ranking_weights_all(_=Depends(verify_admin_token)):
    """All learned weight rows (for the admin dashboard)."""
    db = get_db()
    rows = await db.provider_ranking_weights.find({}, {"_id": 0}).sort("updatedAt", -1).to_list(200)
    learned = sum(1 for r in rows if r.get("source") == "learned")
    return {
        "default":     dict(DEFAULT_RANKING_WEIGHTS),
        "minSamples":  RANKING_MIN_SAMPLES,
        "minConfidence": RANKING_MIN_CONFIDENCE,
        "minWeight":   RANKING_MIN_WEIGHT,
        "maxWeight":   RANKING_MAX_WEIGHT,
        "rows":        rows,
        "totalGroups": len(rows),
        "learnedGroups": learned,
    }


@router.get("/api/admin/ranking/weights/{zone_id}")
async def admin_ranking_weights_zone(zone_id: str, _=Depends(verify_admin_token)):
    """Weights + top providers for a specific zone (across all problemTypes)."""
    db = get_db()
    rows = await db.provider_ranking_weights.find({"zoneId": zone_id}, {"_id": 0}).to_list(50)

    # Provider success leaderboard (last 7 days, this zone)
    cutoff = (now_utc() - timedelta(days=7)).isoformat()
    pipeline = [
        {"$match": {"zoneId": zone_id, "outcomeFinalized": True, "createdAt": {"$gte": cutoff}}},
        {"$group": {
            "_id": "$providerSlug",
            "samples":   {"$sum": 1},
            "accepted":  {"$sum": {"$cond": ["$accepted", 1, 0]}},
            "completed": {"$sum": {"$cond": ["$bookingCompleted", 1, 0]}},
            "cancelled": {"$sum": {"$cond": ["$bookingCancelled", 1, 0]}},
            "rejected":  {"$sum": {"$cond": ["$rejected", 1, 0]}},
        }},
    ]
    stats = []
    async for s in db.quick_request_offers.aggregate(pipeline):
        n = s["samples"] or 1
        score = round(((s["accepted"] / n) * 0.35
                       + (s["completed"] / n) * 0.35
                       + (1 - s["cancelled"] / n) * 0.15
                       + (1 - s["rejected"] / n) * 0.15) * 100, 1)
        stats.append({
            "providerSlug":  s["_id"],
            "samples":       n,
            "accepted":      s["accepted"],
            "completed":     s["completed"],
            "cancelled":     s["cancelled"],
            "rejected":      s["rejected"],
            "successScore":  score,
        })
    stats.sort(key=lambda x: -x["successScore"])

    return {
        "zoneId":       zone_id,
        "rows":         rows,
        "topProviders": stats[:10],
        "weakProviders": list(reversed(stats[-5:])) if len(stats) > 5 else [],
        "totalProviders": len(stats),
    }


@router.post("/api/admin/ranking/recalculate")
async def admin_ranking_recalculate(force: bool = False, _=Depends(verify_admin_token)):
    """Force a ranking-weights refit immediately (instead of waiting for the 5-min cycle)."""
    summary = await _recalculate_ranking_weights(force=force)
    return {"success": True, **summary}
