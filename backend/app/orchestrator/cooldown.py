"""app.orchestrator.cooldown — Sprint 21 C13 / Sprint 24 (Redis migration).

Cooldown tracker shared by orchestrator cycle и actions. Sprint 24:
переехал из in-memory dict в Redis (через app.core.redis_state).
- Multi-worker safe (один cooldown на весь кластер)
- Auto-release через TTL
- Fail-open при недоступности Redis (cooldown=False) — чтобы не блокировать оркестратор

API совместим с предыдущим — теперь функции async.
`orchestrator_cooldowns` оставлен как пустой dict для backcompat импортов.
"""
from __future__ import annotations

from app.core.redis_state import (
    is_in_cooldown as _redis_is_in_cooldown,
    set_cooldown as _redis_set_cooldown,
)


# Backcompat marker — больше не используется как источник истины.
# Реальное состояние живёт в Redis под ключами `cooldown:orch:{zone_id}:{severity}`.
orchestrator_cooldowns: dict = {}


def _key(zone_id: str, severity: str) -> str:
    return f"cooldown:orch:{zone_id}:{severity}"


async def is_in_cooldown(zone_id: str, severity: str, cooldown_seconds: int) -> bool:
    """Check if a zone+severity combo is in cooldown (Redis-backed)."""
    return await _redis_is_in_cooldown(_key(zone_id, severity))


async def set_cooldown(zone_id: str, severity: str, ttl_seconds: int = 300) -> None:
    """Set cooldown for a zone+severity combo (Redis-backed, TTL = ttl_seconds)."""
    await _redis_set_cooldown(_key(zone_id, severity), ttl_seconds)
