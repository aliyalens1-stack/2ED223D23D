"""Sprint 3 Step 3 — Reputation Engine HTTP surface.

Endpoints:
    Inspector
        GET  /api/inspector/reputation
        GET  /api/inspector/reputation/history
    Admin
        GET  /api/admin/reputation                  (top / risky lists)
        POST /api/admin/reputation/recompute/{userId}

The inspector endpoint auto-computes on first read if the snapshot is
missing — so a freshly-registered inspector sees a neutral profile
immediately, not a 404.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.db import get_db
from app.core.security import verify_admin_token
# P6.B.3 — Attribution wiring.
from app.core.attribution import (
    AttributionContext,
    get_attribution_context,
    record_admin_mutation,
)
from app.auto_requests.auth import get_user_id_required
from app.reputation.engine import (
    HARD_FLOOR_TIER_MAX,
    SUB_METRIC_KEYS,
    TIER_BRONZE_MAX,
    recompute_reputation,
)


router = APIRouter()


# Risky cutoff = first score that is NOT bronze. Inspector is risky if
# below this OR hardFloor=true. Single source of truth in engine.py.
_RISKY_SCORE_CUTOFF = TIER_BRONZE_MAX + 1


# ─────────────────────────────────────────────────────────────────────
# Coaching copy — operational, not gamification. Pure mapping rules.
# Visible to the inspector so they can act on improving the score.
# ─────────────────────────────────────────────────────────────────────

COACH_THRESHOLD = 70  # below this, the sub-metric is flagged as "hurts"
COACH_PRAISE = 85     # at or above this, the sub-metric is "helps"

COACH_BAD = {
    "inspectionQuality":      "Отчёты часто возвращают на доработку. Перепроверяй критичные секции до отправки.",
    "evidenceCompleteness":   "В черновиках помечается недостающее доказательство — добавляй фото/видео по чек-листу.",
    "customerAcceptance":     "Клиенты редко принимают отчёт с первого раза. Убедись, что вывод по машине однозначный.",
    "disputeRate":            "Открытых споров слишком много — разбирайся с проблемными кейсами вручную.",
    "aiAlignment":            "Слишком часто переопределяешь AI-черновик. Если AI ошибается — фиксируй с обоснованием.",
    "responseDiscipline":     "Часть принятых заданий не доводится до конца: опоздания, no-show, отмена в процессе.",
    "verificationScore":      "Документы профиля не полностью подтверждены админом. Догрузи и переправь.",
}
COACH_GOOD = {
    "inspectionQuality":      "Отчёты стабильно проходят QA.",
    "evidenceCompleteness":   "Доказательная база в отчётах полная.",
    "customerAcceptance":     "Клиенты принимают отчёт быстро и без вопросов.",
    "disputeRate":            "Споров почти нет — клиенты доверяют выводам.",
    "aiAlignment":            "Работаешь с AI согласованно — мало переопределений.",
    "responseDiscipline":     "Принятые задания доводишь до конца, без срывов.",
    "verificationScore":      "Профиль полностью подтверждён.",
}


def _coaching(snapshot: Dict[str, Any]) -> Dict[str, List[Dict[str, str]]]:
    """Return {'hurts': [...], 'helps': [...]} — both lists explainable."""
    hurts: List[Dict[str, str]] = []
    helps: List[Dict[str, str]] = []
    for key in SUB_METRIC_KEYS:
        v = int(snapshot.get(key, 0))
        if v < COACH_THRESHOLD:
            hurts.append({"metric": key, "value": v, "message": COACH_BAD[key]})
        elif v >= COACH_PRAISE:
            helps.append({"metric": key, "value": v, "message": COACH_GOOD[key]})
    if snapshot.get("hardFloor"):
        hurts.insert(0, {
            "metric": "hardFloor",
            "value": 0,
            "message": f"Активен hard floor ({snapshot.get('hardFloorReason') or 'open dispute'}) — рейтинг ограничен {HARD_FLOOR_TIER_MAX}.",
        })
    return {"hurts": hurts, "helps": helps}


async def _load_snapshot(db, user_id: str) -> Optional[Dict[str, Any]]:
    u = await db.users.find_one({"_id": user_id}, {"reputation": 1, "_id": 0})
    if u and isinstance(u.get("reputation"), dict):
        return u["reputation"]
    return None


# ─────────────────────────────────────────────────────────────────────
# Inspector
# ─────────────────────────────────────────────────────────────────────

@router.get("/api/inspector/reputation")
async def get_my_reputation(uid: str = Depends(get_user_id_required)) -> Dict[str, Any]:
    db = get_db()
    snapshot = await _load_snapshot(db, uid)
    if not snapshot:
        # Lazy first compute — no 404 for fresh inspectors.
        snapshot = await recompute_reputation(uid) or {}
    return {"reputation": snapshot, "coaching": _coaching(snapshot or {})}


@router.get("/api/inspector/reputation/history")
async def get_my_reputation_history(
    limit: int = Query(50, ge=1, le=200),
    uid: str = Depends(get_user_id_required),
) -> Dict[str, Any]:
    db = get_db()
    cursor = (
        db.reputation_snapshots
        .find({"userId": uid}, {"_id": 0})
        .sort("computedAt", -1)
        .limit(limit)
    )
    items = await cursor.to_list(length=limit)
    return {"items": items, "count": len(items)}


# ─────────────────────────────────────────────────────────────────────
# Admin
# ─────────────────────────────────────────────────────────────────────

@router.get("/api/admin/reputation")
async def admin_reputation_overview(
    top_limit: int = Query(10, ge=1, le=50),
    risky_limit: int = Query(10, ge=1, le=50),
    _: dict = Depends(verify_admin_token),
) -> Dict[str, Any]:
    """Top inspectors + risky inspectors + flagged (hard-floor) list."""
    db = get_db()
    # Top by score desc.
    top_cursor = (
        db.users
        .find(
            {"reputation": {"$exists": True}},
            {"_id": 1, "name": 1, "email": 1, "reputation": 1},
        )
        .sort("reputation.score", -1)
        .limit(top_limit)
    )
    top = []
    async for u in top_cursor:
        u["userId"] = u.pop("_id")
        top.append(u)

    # Risky = score < TIER_BRONZE_MAX+1 (i.e. still bronze) OR hardFloor=True.
    risky_cursor = (
        db.users
        .find(
            {"$or": [
                {"reputation.score": {"$lt": _RISKY_SCORE_CUTOFF}},
                {"reputation.hardFloor": True},
            ]},
            {"_id": 1, "name": 1, "email": 1, "reputation": 1},
        )
        .sort("reputation.score", 1)
        .limit(risky_limit)
    )
    risky = []
    async for u in risky_cursor:
        u["userId"] = u.pop("_id")
        risky.append(u)

    # Counts per tier.
    tier_counts: Dict[str, int] = {}
    for t in ("bronze", "silver", "gold", "platinum"):
        tier_counts[t] = await db.users.count_documents({"reputation.tier": t})

    flagged_total = await db.users.count_documents({"reputation.hardFloor": True})

    return {
        "top": top,
        "risky": risky,
        "tierCounts": tier_counts,
        "flaggedTotal": flagged_total,
    }


@router.post("/api/admin/reputation/recompute/{user_id}")
async def admin_force_recompute(
    user_id: str,
    _: dict = Depends(verify_admin_token),
    ctx_attr: AttributionContext = Depends(get_attribution_context),
) -> Dict[str, Any]:
    db = get_db()
    target = await db.users.find_one(
        {"_id": user_id},
        {"_id": 1, "role": 1, "accountKind": 1},
    )
    if not target:
        raise HTTPException(404, "User not found")
    # Reputation only applies to inspectors. Refuse to pollute customer /
    # admin / system rows. Accept both legacy `role` and new `accountKind`.
    role = (target.get("role") or "").lower()
    kind = (target.get("accountKind") or "").lower()
    if role != "inspector" and kind != "inspector":
        raise HTTPException(400, "Reputation only applies to inspector accounts")
    snapshot = await recompute_reputation(user_id)
    if snapshot is None:
        raise HTTPException(500, "Recompute failed")
    # P6.B.3 — Attribution.
    try:
        await record_admin_mutation(
            db, ctx_attr,
            action="reputation.recompute",
            domain="user",
            entity_id=str(user_id),
            extra={"role": role or kind},
        )
    except Exception as _attr_e:
        import logging as _lg
        _lg.getLogger(__name__).warning(f"[reputation] attribution reputation.recompute failed: {_attr_e}")
    return {"ok": True, "reputation": snapshot}


__all__ = ["router"]
