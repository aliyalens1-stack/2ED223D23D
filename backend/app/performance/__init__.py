"""Sprint 26 — Provider Performance System.

Tracks 4 key metrics (acceptance rate, response time, completion rate,
cancellation rate) per provider and computes a multiplier ∈ [0.5, 1.2]
applied AFTER paid boost in the ranking pipeline.

Formula:
    score = acceptanceRate * 0.4
          + completionRate * 0.3
          + (1 - cancelRate) * 0.2
          + responseScore(avgResponseTime) * 0.1

Anti-abuse:
    - received > 20 AND accepted/received < 0.2  → score *= 0.7
    - cancelRate > 0.3                            → score *= 0.6
    - avgResponseTime > 20s                       → score *= 0.8

Final ranking:
    final = base * boost_multiplier * performance_score   (clamped 0.5..1.2)
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Header
from motor.motor_asyncio import AsyncIOMotorDatabase  # type: ignore

router = APIRouter(tags=["performance"])

# ── Module-level handles set by server.py on startup ───────────────────────
db: Optional[AsyncIOMotorDatabase] = None
_verify_admin = None
_verify_user = None


def init(database, verify_admin_token, verify_user_token=None):
    global db, _verify_admin, _verify_user
    db = database
    _verify_admin = verify_admin_token
    _verify_user = verify_user_token


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ────────────────────────────────────────────────────────────────────────────
# Recording helpers — call these from booking flow handlers
# ────────────────────────────────────────────────────────────────────────────
async def record_received(provider_slug: str) -> None:
    if not provider_slug or db is None:
        return
    await db.provider_metrics.update_one(
        {"providerSlug": provider_slug},
        {"$inc": {"received": 1}, "$set": {"updatedAt": _now().isoformat()}},
        upsert=True,
    )
    await _track("provider_received", provider_slug)


async def record_accepted(provider_slug: str, response_seconds: Optional[float] = None) -> None:
    if not provider_slug or db is None:
        return
    update: dict = {"$inc": {"accepted": 1}, "$set": {"lastAcceptedAt": _now().isoformat(), "updatedAt": _now().isoformat()}}
    await db.provider_metrics.update_one({"providerSlug": provider_slug}, update, upsert=True)
    if response_seconds is not None and response_seconds >= 0:
        # EMA smoothing: new = 0.8 * old + 0.2 * sample
        existing = await db.provider_metrics.find_one({"providerSlug": provider_slug}, {"avgResponseTime": 1})
        old = float((existing or {}).get("avgResponseTime") or response_seconds)
        smoothed = round(old * 0.8 + response_seconds * 0.2, 2)
        await db.provider_metrics.update_one(
            {"providerSlug": provider_slug},
            {"$set": {"avgResponseTime": smoothed}},
        )
    await _track("provider_accept", provider_slug, {"responseSeconds": response_seconds})


async def record_rejected(provider_slug: str) -> None:
    if not provider_slug or db is None:
        return
    await db.provider_metrics.update_one(
        {"providerSlug": provider_slug},
        {"$inc": {"rejected": 1}, "$set": {"updatedAt": _now().isoformat()}},
        upsert=True,
    )
    await _track("provider_reject", provider_slug)


async def record_cancelled(provider_slug: str) -> None:
    if not provider_slug or db is None:
        return
    await db.provider_metrics.update_one(
        {"providerSlug": provider_slug},
        {"$inc": {"cancelled": 1}, "$set": {"updatedAt": _now().isoformat()}},
        upsert=True,
    )
    await _track("provider_cancel", provider_slug)


async def record_completed(provider_slug: str) -> None:
    if not provider_slug or db is None:
        return
    await db.provider_metrics.update_one(
        {"providerSlug": provider_slug},
        {"$inc": {"completed": 1}, "$set": {"updatedAt": _now().isoformat()}},
        upsert=True,
    )
    await _track("provider_complete", provider_slug)


async def _track(event_type: str, provider_slug: str, extra: Optional[dict] = None) -> None:
    if db is None:
        return
    doc = {
        "type": event_type,
        "providerSlug": provider_slug,
        "createdAt": _now().isoformat(),
    }
    if extra:
        doc.update({k: v for k, v in extra.items() if v is not None})
    try:
        await db.performance_events.insert_one(doc)
    except Exception:
        pass


# ────────────────────────────────────────────────────────────────────────────
# Score computation
# ────────────────────────────────────────────────────────────────────────────
def _response_score(avg_seconds: float) -> float:
    if avg_seconds <= 5:
        return 1.0
    if avg_seconds <= 10:
        return 0.8
    if avg_seconds <= 20:
        return 0.5
    return 0.2


def compute_score_from_doc(doc: dict) -> dict:
    """Pure function — given metrics dict, return rich score object."""
    received = int(doc.get("received") or 0)
    accepted = int(doc.get("accepted") or 0)
    cancelled = int(doc.get("cancelled") or 0)
    completed = int(doc.get("completed") or 0)
    avg_rt = float(doc.get("avgResponseTime") or 0.0)

    acceptance_rate = (accepted / received) if received > 0 else 0.0
    completion_rate = (completed / accepted) if accepted > 0 else 0.0
    cancel_rate = (cancelled / accepted) if accepted > 0 else 0.0
    rs = _response_score(avg_rt) if avg_rt > 0 else 0.5

    raw = (
        acceptance_rate * 0.4
        + completion_rate * 0.3
        + (1 - cancel_rate) * 0.2
        + rs * 0.1
    )

    # Anti-abuse penalties
    penalties = []
    if received > 20 and acceptance_rate < 0.2:
        raw *= 0.7
        penalties.append("low_acceptance")
    if cancel_rate > 0.3:
        raw *= 0.6
        penalties.append("high_cancellation")
    if avg_rt > 20:
        raw *= 0.8
        penalties.append("slow_response")

    # New providers (no data) → truly neutral 1.0 (no boost, no penalty)
    if received == 0 and accepted == 0:
        return {
            "score": 1.0,
            "multiplier": 1.0,
            "metrics": {
                "received": 0, "accepted": 0, "cancelled": 0, "completed": 0,
                "acceptanceRate": 0.0, "completionRate": 0.0, "cancelRate": 0.0,
                "avgResponseTime": 0.0, "responseScore": 0.0,
            },
            "penalties": [],
        }

    # Clamp into ranking-safe band [0.5, 1.2]
    # raw is roughly 0..1; shift by +0.5 so neutral=1.0, top→1.2
    multiplier = max(0.5, min(1.2, raw + 0.5))

    return {
        "score": round(raw, 3),
        "multiplier": round(multiplier, 3),
        "metrics": {
            "received": received,
            "accepted": accepted,
            "cancelled": cancelled,
            "completed": completed,
            "acceptanceRate": round(acceptance_rate, 3),
            "completionRate": round(completion_rate, 3),
            "cancelRate": round(cancel_rate, 3),
            "avgResponseTime": round(avg_rt, 2),
            "responseScore": round(rs, 2),
        },
        "penalties": penalties,
    }


async def get_performance_multiplier(provider_slug: str) -> float:
    """Fast lookup used by ranking. Returns multiplier ∈ [0.5, 1.2]."""
    if not provider_slug or db is None:
        return 1.0
    doc = await db.provider_metrics.find_one({"providerSlug": provider_slug}, {"_id": 0})
    if not doc:
        return 1.0
    return float(compute_score_from_doc(doc)["multiplier"])


# ────────────────────────────────────────────────────────────────────────────
# REST endpoints
# ────────────────────────────────────────────────────────────────────────────
@router.get("/api/provider/performance/me")
async def my_performance(providerSlug: str = "avtomaster-pro"):
    """Provider self-view of performance metrics + coaching tips."""
    doc = await db.provider_metrics.find_one({"providerSlug": providerSlug}, {"_id": 0}) or {"providerSlug": providerSlug}
    out = compute_score_from_doc(doc)
    out["providerSlug"] = providerSlug

    tips: list[str] = []
    m = out["metrics"]
    if m["acceptanceRate"] < 0.5 and m["received"] > 5:
        tips.append("⚡ Принимайте больше заявок — это самый быстрый путь в топ")
    if m["avgResponseTime"] > 10:
        tips.append("⏱ Отвечайте за 5 секунд — поток заявок вырастет на 30%")
    if m["cancelRate"] > 0.15:
        tips.append("🚫 Не отменяйте принятые заявки — это сильно снижает рейтинг")
    if m["completionRate"] < 0.8 and m["accepted"] > 5:
        tips.append("✅ Доводите работу до завершения — это +ранг")
    if not tips:
        tips.append("🔥 Отличные показатели — продолжайте в том же духе")

    out["tips"] = tips
    out["headline"] = "Ваш рейтинг влияет на поток заказов"
    return out


@router.get("/api/provider/performance/explain")
async def explain_my_ranking(
    providerSlug: Optional[str] = None,
    authorization: Optional[str] = Header(None, alias="Authorization"),
):
    """Sprint 27 — Explainability. Why am I at position #N?

    Возвращает разложение score по факторам + actionable tips с CTA.
    Никаких "формул" — только impact и что делать.

    Auth:
        - Provider JWT (resolves own slug from organizations) — primary path.
        - Admin JWT может передать ?providerSlug=... (для отладки/админа).
        - Без JWT → 401.
    """
    if db is None:
        raise HTTPException(500, "DB not initialised")

    # ── Resolve slug via provider/admin JWT (DoD: без provider JWT → 401) ──
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Authorization required")
    token = authorization.split(" ", 1)[1].strip()
    try:
        from app.core.config import JWT_SECRET, JWT_ALGO
        import jwt as _jwt
        payload = _jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except Exception:
        raise HTTPException(401, "Invalid token")

    role = payload.get("role")
    kind = payload.get("kind")
    user_id = payload.get("sub")

    resolved_slug: Optional[str] = None
    # Sprint 1D.3: admin override now reads `kind` (active account, set by 1C
    # `issue_account_jwt`), not raw legacy `role`. Same source of truth as
    # `require_admin()` in identity_runtime — single semantic for all admin gates.
    if kind == "admin" and providerSlug:
        # Admin override — debug любого провайдера
        resolved_slug = providerSlug
    elif role in ("provider_owner", "provider", "provider_manager"):
        # Resolve slug из organizations.ownerId/managers
        org = await db.organizations.find_one(
            {"$or": [{"ownerId": user_id}, {"managers": user_id}]},
            {"_id": 0, "slug": 1},
        )
        if not org or not org.get("slug"):
            raise HTTPException(403, "no provider profile linked to user")
        resolved_slug = org["slug"]
    else:
        raise HTTPException(403, "provider role required")

    providerSlug = resolved_slug

    org = await db.organizations.find_one({"slug": providerSlug}, {"_id": 0}) or {}
    metrics_doc = await db.provider_metrics.find_one({"providerSlug": providerSlug}, {"_id": 0}) or {}
    perf = compute_score_from_doc(metrics_doc)
    perf_mult = perf["multiplier"]

    # Boost factors
    boost_mult = 1.0
    boost_level = None
    b_ends = org.get("boostEndsAt")
    if b_ends:
        try:
            b_dt = datetime.fromisoformat(b_ends.replace('Z', '+00:00'))
            if b_dt > _now():
                boost_mult = max(1.0, min(2.0, float(org.get("boostMultiplier", 1.0))))
                boost_level = org.get("boostLevel")
        except Exception:
            pass

    base_score = float(org.get("ratingAvg", 0)) / 5.0  # 0..1 from rating proxy
    rating = float(org.get("ratingAvg", 0))
    distance_factor = 1.0  # filled when explain в контексте конкретной заявки; здесь — зональный

    # Zone factor (если у провайдера есть текущая zone в org doc)
    zone_id = org.get("zoneId")
    zone_factor = 1.0
    if zone_id:
        try:
            zone = await db.zones.find_one({"id": zone_id}, {"_id": 0}) or {}
            zone_factor = max(1.0, float(zone.get("surgeMultiplier", 1.0)))
        except Exception:
            pass

    final = (base_score + 0.1 * (zone_factor - 1.0)) * boost_mult * perf_mult

    # ── Factor cards (impact = насколько повышает финальный score) ─────────
    factors: list = [
        {
            "key": "rating",
            "label": f"Ваш рейтинг {rating:.1f}/5.0",
            "impact": round(base_score, 3),
            "tone": "good" if rating >= 4.5 else "neutral",
            "value": rating,
        },
        {
            "key": "performance",
            "label": f"Performance — {tier_label(perf_mult)}",
            "impact": round(perf_mult, 3),
            "tone": "good" if perf_mult >= 1.1 else "bad" if perf_mult < 0.9 else "neutral",
            "value": perf_mult,
            "subtitle": f"acc {int(perf['metrics']['acceptanceRate']*100)}% · cancel {int(perf['metrics']['cancelRate']*100)}% · ответ {perf['metrics']['avgResponseTime']:.0f}с" if perf["metrics"]["received"] > 0 else "Нет данных — выполните 5+ заявок",
        },
        {
            "key": "boost",
            "label": f"Boost — {(boost_level or 'Выкл').upper()}",
            "impact": round(boost_mult, 3),
            "tone": "good" if boost_mult > 1.0 else "neutral",
            "value": boost_mult,
            "subtitle": f"x{boost_mult:.2f} к позиции" if boost_mult > 1.0 else "Включите Boost для роста",
        },
        {
            "key": "zone",
            "label": f"Спрос в зоне" + (f" ({org.get('zoneName') or zone_id})" if zone_id else ""),
            "impact": round(zone_factor, 3),
            "tone": "good" if zone_factor > 1.2 else "neutral",
            "value": zone_factor,
            "subtitle": f"x{zone_factor:.2f} surge" if zone_factor > 1.0 else "Базовый спрос",
        },
    ]

    # ── Action tips (С CTA — где деньги) ───────────────────────────────────
    tips: list = []
    m = perf["metrics"]

    if boost_mult == 1.0:
        tips.append({
            "type": "money",
            "text": "Включите Boost → +30–50% заявок сегодня",
            "cta": "Включить Boost",
            "ctaRoute": "/provider-boost",
        })
    if m["acceptanceRate"] < 0.85 and m["received"] > 5:
        gap = max(0, int((0.9 - m["acceptanceRate"]) * 100))
        tips.append({
            "type": "critical",
            "text": f"Поднимите принятие до 90% (+{gap}%) → +15% заявок",
            "cta": "Открыть входящие",
            "ctaRoute": "/provider/dashboard",
        })
    if m["cancelRate"] > 0.3:
        tips.append({
            "type": "danger",
            "text": "Снижайте отмены — вы теряете позиции в выдаче",
        })
    if m["avgResponseTime"] > 20:
        tips.append({
            "type": "warning",
            "text": "Отвечайте быстрее (<10с) → выше в выдаче",
        })
    if m["completionRate"] < 0.8 and m["accepted"] > 5:
        tips.append({
            "type": "warning",
            "text": "Завершайте принятые работы — это держит вас в топе",
        })
    if not tips:
        tips.append({
            "type": "good",
            "text": "🔥 У вас всё отлично — вы в топе выдачи",
        })

    # ── Headline (что показать сверху) ─────────────────────────────────────
    if perf_mult >= 1.15 and boost_mult > 1.0:
        headline = "Вы доминируете в топе"
        subline = "Boost + высокий performance — заявки идут к вам"
    elif boost_mult > 1.0:
        headline = "Вы в активном Boost"
        subline = "Поддерживайте performance, чтобы Boost работал на максимум"
    elif perf_mult >= 1.1:
        headline = "Сильный performance"
        subline = "Включите Boost — закрепите позицию в топе"
    elif perf_mult < 0.9:
        headline = "Вас обходят"
        subline = "Performance низкий — исправьте метрики ниже"
    else:
        headline = "Стабильно в середине"
        subline = "Boost или быстрый ответ выведут вас в топ"

    return {
        "providerSlug": providerSlug,
        "finalScore": round(final, 3),
        "headline": headline,
        "subline": subline,
        "factors": factors,
        "tips": tips,
        "rawMetrics": perf["metrics"],
        "boost": {"level": boost_level, "multiplier": boost_mult, "endsAt": org.get("boostEndsAt")},
        "performance": {"multiplier": perf_mult, "score": perf["score"]},
    }


def tier_label(mult: float) -> str:
    if mult >= 1.15:
        return "TOP"
    if mult >= 1.0:
        return "хороший"
    if mult >= 0.8:
        return "средний"
    return "низкий"


@router.get("/api/admin/performance/leaderboard")
async def leaderboard():
    """Top providers by performance score (admin)."""
    if db is None:
        raise HTTPException(500, "DB not initialised")
    docs = await db.provider_metrics.find({}, {"_id": 0}).to_list(500)
    rows = []
    for d in docs:
        s = compute_score_from_doc(d)
        rows.append({
            "providerSlug": d.get("providerSlug"),
            "score": s["score"],
            "multiplier": s["multiplier"],
            "metrics": s["metrics"],
            "penalties": s["penalties"],
        })
    rows.sort(key=lambda r: r["multiplier"], reverse=True)
    return {"total": len(rows), "rows": rows}


@router.get("/api/provider/performance/preview")
async def performance_preview(providerSlug: str = "avtomaster-pro"):
    """Compact metrics for dashboard hub (no auth — uses query param)."""
    doc = await db.provider_metrics.find_one({"providerSlug": providerSlug}, {"_id": 0}) or {}
    s = compute_score_from_doc(doc)
    return {
        "multiplier": s["multiplier"],
        "score": s["score"],
        "metrics": s["metrics"],
    }
