"""Async Redis client (singleton) — Sprint 24.

Используется для:
- distributed locks (lock.py)
- cooldowns (cooldown.py)
- rate limiting (rate_limit.py)

ПРИНЦИП: Redis = временное состояние. Mongo = source of truth.
Если Redis недоступен — fallback NO-OP. Система не падает.

⚠ HONEST FAILURE MODE (2026-05-12 Redis-Truthfulness pass):
  Earlier framing was «лучше двойной push один раз, чем downtime». In
  practice, when Redis is unreachable (as observed in the current
  preview environment, every cycle), NO-OP is permanent — not «один
  раз». Single-fire guarantees evaporate for the whole session:
    - orchestrator action cooldown → off
    - pre-engagement zone throttle → off
    - public-endpoint rate limit → off
    - zone lock mutual exclusion → off
  Partial mitigation for the two writers that visibly amplified
  (orchestrator_logs, pre_engagement_events) was added via
  `app.core.dedupe_bucket` — Mongo-side unique-index insert claim.
  Other Redis-dependent surfaces remain fail-open with no secondary
  defense at the code level. See `redis_state.py` docstring for the
  full classification.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional

import redis.asyncio as aioredis

logger = logging.getLogger("server")

REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")

_redis: Optional[aioredis.Redis] = None
_lock = asyncio.Lock()


async def get_redis() -> Optional[aioredis.Redis]:
    """Return shared Redis client, or None if unavailable.

    Best-effort: первая попытка коннекта. При неудаче — None,
    каждый caller-helper обязан это обработать (fallback в NO-OP).
    """
    global _redis
    if _redis is not None:
        return _redis
    async with _lock:
        if _redis is not None:
            return _redis
        try:
            client = aioredis.from_url(
                REDIS_URL,
                encoding="utf-8",
                decode_responses=True,
                socket_connect_timeout=2,
                socket_timeout=2,
            )
            await client.ping()
            _redis = client
            logger.info(f"Redis connected: {REDIS_URL}")
        except Exception as exc:
            logger.warning(f"Redis unavailable ({exc}) — fallback to NO-OP for state ops")
            _redis = None
    return _redis


async def close_redis() -> None:
    global _redis
    if _redis is not None:
        try:
            await _redis.close()
        except Exception:
            pass
        _redis = None
