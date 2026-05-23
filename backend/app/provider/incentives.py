"""app.provider.incentives — Boost (paid) + Performance (earned) systems.

Два multiplier'а на ranking score:
    final_score = base_score × boost × performance     (clamp performance to [0.5, 1.2])

В quick_request.py при resolve вызываем `apply_incentives_to_solutions(solutions)`
который IN-PLACE добавляет:
    s["boost"]            : 1.0 / 1.2 / 1.5 / 2.0
    s["performance"]      : 0.5..1.2 (clamped)
    s["boostLevel"]       : 'none' | 'basic' | 'pro' | 'max'
    s["matchScore"]       : original × boost × performance (re-ranked)

Mongo collections:
    provider_entitlements: { providerId, boostLevel, active, expiresAt, createdAt, source }
    provider_metrics:      { providerId, received, accepted, completed, cancelled, rejected,
                             avgResponseTime, lastReceivedAt, lastAcceptedAt, updatedAt }

Anti-abuse penalties (в performance):
    received>20 & accept_rate<0.2  → ×0.7  (игнорит заявки)
    cancelRate>0.3                  → ×0.6  (часто отменяет)
    avgResponseTime>20s             → ×0.8  (медленный)

Endpoints:
    GET  /api/provider/boost/plans          (anonymous)
    GET  /api/provider/boost/me             (provider auth)
    POST /api/provider/boost/purchase       (provider auth) — mock/test-mode purchase
    GET  /api/provider/performance/me       (provider auth)
    GET  /api/provider/incentives/effects/{slug}  (anonymous, debug)
"""
from __future__ import annotations
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request, Depends
from pydantic import BaseModel, Field

from app.core.db import get_db
from app.core.utils import now_utc, uid
from app.system.auth import get_current_user


logger = logging.getLogger("server")
router = APIRouter()


# ─────────────────────────────────────────────────────────────
# 🔥 BOOST (paid)
# ─────────────────────────────────────────────────────────────
BOOST_PLANS = [
    {"level": "none",  "multiplier": 1.0, "label": "Без буста",     "priceUah": 0,    "billingHint": "—",                       "highlight": False},
    {"level": "basic", "multiplier": 1.2, "label": "Базовый",       "priceUah": 299,  "billingHint": "299 ₴ / 7 дней",          "highlight": False},
    {"level": "pro",   "multiplier": 1.5, "label": "PRO",           "priceUah": 699,  "billingHint": "699 ₴ / 7 дней",          "highlight": True},
    {"level": "max",   "multiplier": 2.0, "label": "MAX",           "priceUah": 1499, "billingHint": "1499 ₴ / 7 дней",         "highlight": False},
]
BOOST_MULTIPLIERS = {p["level"]: p["multiplier"] for p in BOOST_PLANS}
BOOST_DEFAULT_DURATION_DAYS = 7


async def get_active_boost(provider_slug: str) -> Dict[str, Any]:
    """Return active entitlement {level, multiplier, expiresAt} or none-default."""
    db = get_db()
    if not provider_slug:
        return {"level": "none", "multiplier": 1.0, "expiresAt": None, "active": False}
    ent = await db.provider_entitlements.find_one({"providerId": provider_slug, "active": True}, {"_id": 0})
    if not ent:
        return {"level": "none", "multiplier": 1.0, "expiresAt": None, "active": False}
    # check expiry
    expires = ent.get("expiresAt")
    if expires:
        try:
            exp_dt = datetime.fromisoformat(expires.replace("Z", "+00:00")) if isinstance(expires, str) else expires
            if exp_dt and exp_dt.tzinfo is None:
                exp_dt = exp_dt.replace(tzinfo=timezone.utc)
            if exp_dt and exp_dt < now_utc():
                # auto-deactivate
                await db.provider_entitlements.update_one(
                    {"providerId": provider_slug}, {"$set": {"active": False}}
                )
                return {"level": "none", "multiplier": 1.0, "expiresAt": None, "active": False}
        except Exception:
            pass
    level = ent.get("boostLevel", "none")
    mult = BOOST_MULTIPLIERS.get(level, 1.0)
    return {"level": level, "multiplier": mult, "expiresAt": expires, "active": True}


async def get_boosts_bulk(slugs: List[str]) -> Dict[str, Dict[str, Any]]:
    """Bulk fetch active boosts for many providers (used in resolve)."""
    db = get_db()
    if not slugs:
        return {}
    docs = await db.provider_entitlements.find(
        {"providerId": {"$in": slugs}, "active": True}, {"_id": 0}
    ).to_list(len(slugs))
    out: Dict[str, Dict[str, Any]] = {}
    now = now_utc()
    for d in docs:
        slug = d.get("providerId")
        expires = d.get("expiresAt")
        active = True
        if expires:
            try:
                exp_dt = datetime.fromisoformat(expires.replace("Z", "+00:00")) if isinstance(expires, str) else expires
                if exp_dt and exp_dt.tzinfo is None:
                    exp_dt = exp_dt.replace(tzinfo=timezone.utc)
                if exp_dt and exp_dt < now:
                    active = False
            except Exception:
                pass
        if active and slug:
            level = d.get("boostLevel", "none")
            out[slug] = {
                "level": level,
                "multiplier": BOOST_MULTIPLIERS.get(level, 1.0),
                "expiresAt": expires,
            }
    return out


# ─────────────────────────────────────────────────────────────
# 📊 PERFORMANCE (earned)
# ─────────────────────────────────────────────────────────────
PERF_CLAMP_MIN = 0.5
PERF_CLAMP_MAX = 1.2


def _response_score(t_seconds: float) -> float:
    """0..1 score for avg response time."""
    if t_seconds <= 5:    return 1.0
    if t_seconds <= 10:   return 0.8
    if t_seconds <= 20:   return 0.5
    return 0.2


def _compute_perf_score(m: Dict[str, Any]) -> Dict[str, Any]:
    """Return computed metrics + clamped multiplier from raw counters."""
    received = int(m.get("received", 0) or 0)
    accepted = int(m.get("accepted", 0) or 0)
    completed = int(m.get("completed", 0) or 0)
    cancelled = int(m.get("cancelled", 0) or 0)
    avg_rt = float(m.get("avgResponseTime", 10) or 10)

    if received <= 0:
        # Newcomer policy: neutral 1.0 for first 5 заявок
        return {
            "acceptanceRate": 0.0,
            "completionRate": 0.0,
            "cancelRate":     0.0,
            "avgResponseTime": avg_rt,
            "score": 1.0,
            "rawScore": 1.0,
            "isNewcomer": True,
        }

    accept_rate = accepted / received if received else 0.0
    completion_rate = (completed / accepted) if accepted else 0.0
    cancel_rate = (cancelled / accepted) if accepted else 0.0
    rsp = _response_score(avg_rt)

    raw = (
        accept_rate * 0.4 +
        completion_rate * 0.3 +
        (1.0 - cancel_rate) * 0.2 +
        rsp * 0.1
    )

    # raw is roughly 0..1; map to multiplier roughly 0.5..1.2:
    #   raw=0.0  → 0.5
    #   raw=0.5  → 0.85
    #   raw=1.0  → 1.2
    score = PERF_CLAMP_MIN + (PERF_CLAMP_MAX - PERF_CLAMP_MIN) * max(0.0, min(1.0, raw))

    # Anti-abuse penalties
    if received > 20 and accept_rate < 0.2:
        score *= 0.7  # игнор заявок
    if cancel_rate > 0.3:
        score *= 0.6  # частые отмены
    if avg_rt > 20:
        score *= 0.8  # медленный

    score = max(PERF_CLAMP_MIN, min(PERF_CLAMP_MAX, score))

    return {
        "acceptanceRate":  round(accept_rate, 3),
        "completionRate":  round(completion_rate, 3),
        "cancelRate":      round(cancel_rate, 3),
        "avgResponseTime": round(avg_rt, 1),
        "score":           round(score, 3),
        "rawScore":        round(raw, 3),
        "isNewcomer":      received <= 5,
    }


async def get_performance(provider_slug: str) -> Dict[str, Any]:
    db = get_db()
    if not provider_slug:
        return _compute_perf_score({})
    m = await db.provider_metrics.find_one({"providerId": provider_slug}, {"_id": 0}) or {}
    return _compute_perf_score(m)


async def get_performances_bulk(slugs: List[str]) -> Dict[str, Dict[str, Any]]:
    db = get_db()
    if not slugs:
        return {}
    docs = await db.provider_metrics.find({"providerId": {"$in": slugs}}, {"_id": 0}).to_list(len(slugs))
    by_id = {d.get("providerId"): d for d in docs if d.get("providerId")}
    out = {}
    for s in slugs:
        out[s] = _compute_perf_score(by_id.get(s, {}))
    return out


# ─────────────────────────────────────────────────────────────
# 🎯 Apply both multipliers to ranking solutions (called in resolve)
# ─────────────────────────────────────────────────────────────
async def apply_incentives_to_solutions(solutions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """In-place adjustment of matchScore + add boost/performance fields. Returns sorted list."""
    if not solutions:
        return solutions
    slugs = [s.get("slug") for s in solutions if s.get("slug")]
    boosts = await get_boosts_bulk(slugs)
    perfs = await get_performances_bulk(slugs)

    for s in solutions:
        slug = s.get("slug")
        boost_info = boosts.get(slug, {"level": "none", "multiplier": 1.0})
        perf_info = perfs.get(slug, _compute_perf_score({}))
        boost_mult = float(boost_info["multiplier"])
        perf_mult = float(perf_info["score"])
        original = float(s.get("matchScore", 0))
        s["originalScore"] = round(original, 4)
        s["boost"] = boost_mult
        s["boostLevel"] = boost_info["level"]
        s["performance"] = perf_mult
        s["performanceMetrics"] = perf_info
        s["matchScore"] = round(original * boost_mult * perf_mult, 4)
        # Customer-facing badge: don't expose "paid". Use "Рекомендуем" / "Лучшее предложение"
        if boost_info["level"] in ("pro", "max"):
            s["recommended"] = True
        if perf_mult >= 1.1:
            s["topPerformer"] = True

    solutions.sort(key=lambda x: -x["matchScore"])
    return solutions


# ─────────────────────────────────────────────────────────────
# 🔄 Metrics increments (called from quick_request.py + bookings)
# ─────────────────────────────────────────────────────────────
async def metrics_inc_received(provider_slug: str) -> None:
    db = get_db()
    if not provider_slug: return
    await db.provider_metrics.update_one(
        {"providerId": provider_slug},
        {"$inc": {"received": 1}, "$set": {"lastReceivedAt": now_utc().isoformat(), "updatedAt": now_utc().isoformat()}},
        upsert=True,
    )


async def metrics_inc_accepted(provider_slug: str, response_time_seconds: Optional[float] = None) -> None:
    db = get_db()
    if not provider_slug: return
    update: Dict[str, Any] = {
        "$inc": {"accepted": 1},
        "$set": {"lastAcceptedAt": now_utc().isoformat(), "updatedAt": now_utc().isoformat()},
    }
    await db.provider_metrics.update_one({"providerId": provider_slug}, update, upsert=True)
    # EWMA для avgResponseTime (отдельным апдейтом, чтобы прочитать old value)
    if response_time_seconds is not None and response_time_seconds >= 0:
        doc = await db.provider_metrics.find_one({"providerId": provider_slug}, {"_id": 0, "avgResponseTime": 1})
        old = float((doc or {}).get("avgResponseTime", response_time_seconds) or response_time_seconds)
        new_avg = round(old * 0.8 + response_time_seconds * 0.2, 1)
        await db.provider_metrics.update_one(
            {"providerId": provider_slug},
            {"$set": {"avgResponseTime": new_avg}},
        )


async def metrics_inc_rejected(provider_slug: str) -> None:
    db = get_db()
    if not provider_slug: return
    await db.provider_metrics.update_one(
        {"providerId": provider_slug},
        {"$inc": {"rejected": 1}, "$set": {"updatedAt": now_utc().isoformat()}},
        upsert=True,
    )


async def metrics_inc_completed(provider_slug: str) -> None:
    db = get_db()
    if not provider_slug: return
    await db.provider_metrics.update_one(
        {"providerId": provider_slug},
        {"$inc": {"completed": 1}, "$set": {"updatedAt": now_utc().isoformat()}},
        upsert=True,
    )


async def metrics_inc_cancelled(provider_slug: str) -> None:
    db = get_db()
    if not provider_slug: return
    await db.provider_metrics.update_one(
        {"providerId": provider_slug},
        {"$inc": {"cancelled": 1}, "$set": {"updatedAt": now_utc().isoformat()}},
        upsert=True,
    )


# ─────────────────────────────────────────────────────────────
# 🌐 Endpoints
# ─────────────────────────────────────────────────────────────
class PurchaseBoostBody(BaseModel):
    level: str = Field(..., description="basic | pro | max")
    paymentMethod: Optional[str] = Field("test", description="test | stripe")


@router.get("/api/provider/boost/plans")
async def get_boost_plans():
    """Public: list available plans for UI."""
    return {"plans": BOOST_PLANS, "durationDays": BOOST_DEFAULT_DURATION_DAYS}


async def _resolve_provider_slug_for_user(user: Dict[str, Any]) -> Optional[str]:
    db = get_db()
    user_id = user.get("id") or user.get("_id")
    org = await db.organizations.find_one(
        {"$or": [{"ownerId": user_id}, {"managers": user_id}]},
        {"_id": 0, "slug": 1},
    )
    return (org or {}).get("slug")


@router.get("/api/provider/boost/me")
async def get_my_boost(current_user: Dict[str, Any] = Depends(get_current_user)):
    slug = await _resolve_provider_slug_for_user(current_user)
    if not slug:
        return {"slug": None, "boost": {"level": "none", "multiplier": 1.0, "active": False}}
    boost = await get_active_boost(slug)
    return {"slug": slug, "boost": boost}


@router.post("/api/provider/boost/purchase")
async def purchase_boost(
    body: PurchaseBoostBody,
    request: Request,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """Mock-grade purchase: активирует entitlement на 7 дней.
    В live mode тут бы был Stripe checkout.create_session → callback → entitlement.
    Сейчас (test-mode) сразу включаем для preview.
    """
    db = get_db()
    if body.level not in ("basic", "pro", "max"):
        raise HTTPException(400, "invalid level")
    slug = await _resolve_provider_slug_for_user(current_user)
    if not slug:
        raise HTTPException(403, "no provider profile")

    plan = next((p for p in BOOST_PLANS if p["level"] == body.level), None)
    if not plan:
        raise HTTPException(400, "unknown plan")

    expires_at = now_utc() + timedelta(days=BOOST_DEFAULT_DURATION_DAYS)
    payment_id = f"test_{uid()}"
    await db.provider_entitlements.update_one(
        {"providerId": slug},
        {
            "$set": {
                "providerId":  slug,
                "boostLevel":  body.level,
                "multiplier":  plan["multiplier"],
                "active":      True,
                "expiresAt":   expires_at.isoformat(),
                "updatedAt":   now_utc().isoformat(),
                "source":      body.paymentMethod or "test",
                "paymentId":   payment_id,
                "priceUah":    plan["priceUah"],
            },
            "$setOnInsert": {"createdAt": now_utc().isoformat()},
        },
        upsert=True,
    )

    # fire telemetry (best-effort)
    try:
        await db.events.insert_one({
            "id":        uid(),
            "type":      "boost_purchased",
            "userId":    str(current_user.get("id") or current_user.get("_id") or ""),
            "payload":   {"slug": slug, "level": body.level, "priceUah": plan["priceUah"], "source": body.paymentMethod},
            "ip":        (request.headers.get("x-forwarded-for", request.client.host if request.client else "")).split(",")[0].strip()[:64],
            "ts":        now_utc().isoformat(),
        })
    except Exception:
        pass

    return {
        "ok": True,
        "slug": slug,
        "boostLevel": body.level,
        "multiplier": plan["multiplier"],
        "expiresAt": expires_at.isoformat(),
        "paymentId": payment_id,
        "message": f'Boost "{plan["label"]}" активирован на {BOOST_DEFAULT_DURATION_DAYS} дней',
    }


@router.get("/api/provider/performance/me")
async def get_my_performance(current_user: Dict[str, Any] = Depends(get_current_user)):
    slug = await _resolve_provider_slug_for_user(current_user)
    if not slug:
        return {"slug": None, "performance": _compute_perf_score({})}
    perf = await get_performance(slug)
    boost = await get_active_boost(slug)
    db = get_db()
    raw = await db.provider_metrics.find_one({"providerId": slug}, {"_id": 0}) or {}
    return {
        "slug":        slug,
        "performance": perf,
        "boost":       boost,
        "raw":         {
            "received":  int(raw.get("received", 0) or 0),
            "accepted":  int(raw.get("accepted", 0) or 0),
            "completed": int(raw.get("completed", 0) or 0),
            "cancelled": int(raw.get("cancelled", 0) or 0),
            "rejected":  int(raw.get("rejected", 0) or 0),
        },
    }


@router.get("/api/provider/incentives/effects/{slug}")
async def debug_incentive_effects(slug: str):
    """Debug/admin endpoint: показывает текущие boost+performance для слага."""
    return {
        "slug":        slug,
        "boost":       await get_active_boost(slug),
        "performance": await get_performance(slug),
    }
