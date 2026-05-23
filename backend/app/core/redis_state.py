"""Distributed lock + cooldown + rate limit on top of Redis — Sprint 24.

Все три helpers безопасны при недоступном Redis, но БЕЗ secondary defense
на уровне этого модуля:

- acquire_lock → True (fail-open). Mutual exclusion across workers is LOST.
- is_in_cooldown → False (fail-open). Cooldown semantics are LOST.
- set_cooldown → no-op (silent skip). Throttle state is never written.
- rate_limit dependency → no-op. Per-IP rate limiting is LOST at this layer.

⚠ TRUTHFULNESS NOTE (2026-05-12 Redis-Truthfulness pass):
  Earlier versions of this docstring claimed «Cooldown в Mongo + idempotency
  в orchestrator-actions всё равно ограничивают дубли». That claim was NOT
  accurate at the code level. There was no Mongo-side cooldown collection,
  and `orchestrator_logs` inserts used `id=uid()` with no unique index — so
  every fire produced a fresh doc and the cooldown evaporated entirely
  when Redis was unreachable.

  Partial Mongo-side insert-dedupe was introduced in
  `app.core.dedupe_bucket.try_claim_bucket(...)`, wired at two callsites:
    - app.orchestrator.cycle  → orchestrator_logs insert
    - app.orchestrator.pre_engagement → pre_engagement_events insert
  That helper restores INSERT-LEVEL single-fire for those two writers
  using a Mongo unique compound index. It is NOT a Redis replacement:
    - it does not protect rate_limit (5 public endpoints still unrated
      at the application layer when Redis is down — only upstream
      ingress/WAF may catch);
    - it does not provide mutual exclusion for `acquire_lock` callers;
    - it only covers the two writers that were observed to amplify in
      runtime logs.

  Everywhere else, the fail-open contract stands AS-IS with no secondary
  defense at the code level. Treat this as the operational truth of the
  current environment, not an architectural failure — it is the
  documented compromise from `redis_client.py`. The job of this pass is
  to keep the docstring honest about it.
"""
from __future__ import annotations

import logging
import time
from typing import Optional

from fastapi import Depends, HTTPException, Request

from app.core.redis_client import get_redis

logger = logging.getLogger("server")


# ────────────────────────────────────────────────────────────────
# Distributed lock (SET key value NX EX ttl)
# ────────────────────────────────────────────────────────────────

async def acquire_lock(key: str, ttl: int = 10) -> bool:
    """Try to acquire lock. Returns True if THIS caller won the race.

    TTL — обязательно (auto-release при падении воркера). Default 10 сек.
    NEVER use ttl > 30 — оркестратор может зависнуть.
    """
    if ttl > 30:
        ttl = 30  # safety clamp
    r = await get_redis()
    if r is None:
        return True  # fail-open — Redis недоступен
    try:
        result = await r.set(key, str(time.time()), nx=True, ex=ttl)
        return bool(result)
    except Exception as exc:
        logger.warning(f"acquire_lock({key}) failed: {exc} — fail-open")
        return True


async def release_lock(key: str) -> None:
    """Manually release lock. ИСПОЛЬЗОВАТЬ ОЧЕНЬ ОСТОРОЖНО.

    Лучше полагаться на TTL. Manual release = риск release чужого lock'а
    при race condition. Этот хелпер оставлен только для tests / explicit cleanup.
    """
    r = await get_redis()
    if r is None:
        return
    try:
        await r.delete(key)
    except Exception:
        pass


# ────────────────────────────────────────────────────────────────
# Cooldown (replaces in-memory dicts pre_engagement_cooldowns / orchestrator_cooldowns)
# ────────────────────────────────────────────────────────────────

async def is_in_cooldown(key: str) -> bool:
    r = await get_redis()
    if r is None:
        return False  # fail-open
    try:
        return bool(await r.exists(key))
    except Exception:
        return False


async def set_cooldown(key: str, ttl: int) -> None:
    r = await get_redis()
    if r is None:
        return
    try:
        await r.set(key, "1", ex=max(1, ttl))
    except Exception as exc:
        logger.warning(f"set_cooldown({key}) failed: {exc}")


async def get_cooldown_ttl(key: str) -> int:
    """Returns TTL in seconds (-1 if no expiry, -2 if not exists)."""
    r = await get_redis()
    if r is None:
        return -2
    try:
        return int(await r.ttl(key))
    except Exception:
        return -2


# ────────────────────────────────────────────────────────────────
# Rate limit (sliding window per IP using INCR + EX)
# ────────────────────────────────────────────────────────────────

DEFAULT_RATE_LIMIT = 60      # requests
DEFAULT_RATE_WINDOW = 60     # seconds


def make_rate_limiter(limit: int = DEFAULT_RATE_LIMIT, window: int = DEFAULT_RATE_WINDOW):
    """Build FastAPI dependency for rate limiting on PUBLIC endpoints.

    Usage:
        rate_limit_public = make_rate_limiter(limit=60, window=60)
        @router.get("/api/zones/live-state")
        async def f(_=Depends(rate_limit_public)):
            ...

    Бакет фиксированного окна: bucket = floor(now / window).
    Lightweight, не идеален при boundary-bursts, но достаточно для DDoS-protection MVP.
    """
    async def _rate_limit(request: Request) -> None:
        r = await get_redis()
        if r is None:
            return  # fail-open
        # IP detection: prefer X-Forwarded-For (behind nginx ingress)
        xff = request.headers.get("x-forwarded-for") or ""
        ip = xff.split(",")[0].strip() if xff else (request.client.host if request.client else "unknown")
        bucket = int(time.time() // window)
        key = f"rl:{ip}:{bucket}"
        try:
            count = await r.incr(key)
            if count == 1:
                await r.expire(key, window + 1)
            if count > limit:
                ttl = await r.ttl(key)
                raise HTTPException(
                    status_code=429,
                    detail=f"Too many requests (max {limit}/{window}s). Retry in {max(ttl, 1)}s",
                )
        except HTTPException:
            raise
        except Exception as exc:
            logger.warning(f"rate_limit exception: {exc} — fail-open")
            return

    return _rate_limit


# Default limiter for public endpoints (60 req/min)
rate_limit_public = make_rate_limiter(limit=60, window=60)
# Stricter for noisy / cheap endpoints if needed
rate_limit_strict = make_rate_limiter(limit=20, window=60)
