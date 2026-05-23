"""app.orchestrator.pre_engagement — Sprint 18 proactive supply trigger.

Sprint 21 C11: trigger_pre_engagement + локальные константы и shared state
(pre_engagement_cooldowns) вынесены 1-в-1 из server.py.

Sprint 21 C14: добавлен entry-guard против NaN/Inf/негативных pressure/predicted,
чтобы orchestrator не создавал pre-engagement на невалидных сигналах, даже
если где-то вверх по стэку guard пропустил мусор.

Sprint 24: cooldown переехал из in-memory dict в Redis (multi-worker safe).

Phase 1B (2026-05-12): pre_engagement_events get cluster auto-tag from the
zone dict passed by caller (pure, no DB lookup inside this module).
"""
from __future__ import annotations
import logging
import math
from datetime import datetime, timedelta

from app.core.cluster_writer import enrich_with_cluster
from app.core.constants import PRE_ENGAGEMENT_BOOST, PRE_ENGAGEMENT_TTL_MIN
from app.core.context import ctx
from app.core.db import db, get_db
from app.core.dedupe_bucket import try_claim_bucket
from app.core.realtime import emit_realtime_event
from app.core.redis_state import is_in_cooldown, set_cooldown
from app.core.utils import now_utc, uid

logger = logging.getLogger("server")


# ── Sprint 21 C11: pre-engagement thresholds ──
# Sprint 24: backcompat empty dict — реальное состояние в Redis.
pre_engagement_cooldowns: dict = {}
PRE_ENGAGEMENT_COOLDOWN_S: int = 300
PRE_ENGAGEMENT_PRESSURE_THRESHOLD: float = 1.2


def _cooldown_key(zone_id: str) -> str:
    return f"cooldown:preengage:{zone_id}"


def _is_sane(value, *, allow_zero: bool = True) -> bool:
    """Finite, не-отрицательный (и не-нулевой если allow_zero=False) float."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return False
    if not math.isfinite(v):
        return False
    if v < 0:
        return False
    if not allow_zero and v == 0:
        return False
    return True


async def trigger_pre_engagement(zone: dict, pressure: float, predicted: float, supply: int,
                                 p10: float = None, p90: float = None):
    """Создать pre-engagement event + emit realtime + cooldown.

    Sprint 20: принимаем p10/p90 (prediction interval) и сохраняем их в event,
    чтобы UI/админка могли показать неопределённость прогноза.

    Sprint 21 C14: Guard — если pressure/predicted невалидны (NaN/Inf/<0) или
    supply невалиден — тихо выходим с warning и НЕ создаём event.

    Sprint 24: cooldown через Redis (atomic SET NX EX). Multi-worker safe.
    """
    zone_id = zone.get("id") or zone.get("_id")

    # ── Sprint 21 C14: entry-guard ──
    if not _is_sane(pressure, allow_zero=False):
        logger.warning(
            f"trigger_pre_engagement: skipped for zone={zone_id} — invalid pressure={pressure!r}"
        )
        return None
    if not _is_sane(predicted):
        logger.warning(
            f"trigger_pre_engagement: skipped for zone={zone_id} — invalid predicted={predicted!r}"
        )
        return None
    try:
        supply_int = int(supply)
    except (TypeError, ValueError):
        supply_int = 0
    if supply_int <= 0:
        logger.warning(
            f"trigger_pre_engagement: skipped for zone={zone_id} — invalid supply={supply!r}"
        )
        return None

    # p10/p90 — опциональные; если заданы, тоже проверяем, иначе сбрасываем в None
    if p10 is not None and not _is_sane(p10):
        p10 = None
    if p90 is not None and not _is_sane(p90):
        p90 = None

    now = now_utc()

    # ── Sprint 24: cooldown через Redis (atomic, multi-worker safe) ──
    cd_key = _cooldown_key(zone_id)
    if await is_in_cooldown(cd_key):
        return None

    # ── Redis-Truthfulness pass (2026-05-12): Mongo-side insert dedupe ──
    # Если Redis недоступен — `is_in_cooldown` молча возвращает False, и без
    # этого guard pre-engagement сработал бы каждые 10s (это видно в логах
    # preview окружения для zone=hamburg-altona / berlin-neukolln). Bucket
    # claim переживает Redis NO-OP: даёт single-fire per zone per
    # PRE_ENGAGEMENT_COOLDOWN_S через unique index в `dedupe_buckets`.
    if not await try_claim_bucket(
        scope="pre_engage", key=zone_id, window_seconds=PRE_ENGAGEMENT_COOLDOWN_S
    ):
        return None

    pct = max(10, int((pressure - 1.0) * 100))
    expected_requests = int(round(predicted))

    event = {
        "id": uid(),
        "zoneId": zone_id,
        "zoneName": zone.get("name", zone_id),
        "pressure": round(pressure, 2),
        "predictedDemand": predicted,
        "predictedP10": p10,
        "predictedP90": p90,
        "currentSupply": supply,
        "expectedRequests": expected_requests,
        "potentialEarningsPct": pct,
        "recommendedAction": "go_online",
        "createdAt": now.isoformat(),
        "expiresAt": now + timedelta(minutes=PRE_ENGAGEMENT_TTL_MIN),
    }
    # Phase 1B — cluster auto-tag (pure, zone in scope from caller).
    enrich_with_cluster(event, cluster=zone.get("cluster"),
                        strategy="zone_lookup", source_field="zoneId")
    await db.pre_engagement_events.insert_one(event)
    # Set cooldown ATOMICALLY (Redis). TTL=300s = 5 min.
    await set_cooldown(cd_key, ttl=PRE_ENGAGEMENT_COOLDOWN_S)

    # Emit realtime — клиент-провайдер слушает provider:pre_engage
    payload = {**event, "expiresAt": event["expiresAt"].isoformat()}
    await emit_realtime_event("provider:pre_engage", payload)

    logger.info(
        f"PRE-ENGAGEMENT triggered: zone={zone_id} pressure={pressure:.2f} "
        f"predicted={predicted:.1f} supply={supply} earnings_pct=+{pct}%"
    )
    return event
