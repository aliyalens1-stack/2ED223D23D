"""app.core.dedupe_bucket — Mongo-side bucket dedupe (Redis-Truthfulness pass).

Purpose (narrowly scoped):
  Provide a single primitive that atomically claims a `(scope, key,
  time-bucket)` triple, so a caller can decide whether THIS attempt is the
  first one within `window_seconds` for that key.

Why this exists:
  Redis cooldown (`app.core.redis_state.is_in_cooldown / set_cooldown`)
  fails open when Redis is unreachable — semantics evaporate. The
  orchestrator and pre-engagement code were relying on that cooldown to
  avoid duplicate `orchestrator_logs` / `pre_engagement_events` inserts;
  with Redis down those duplicates DO happen (visible in runtime logs).

  This helper restores the *insert-side* single-fire guarantee for the
  small number of writers that need it, using ONLY Mongo. It does NOT
  replace Redis. It does NOT provide mutual-exclusion guarantees across
  the whole orchestrator cycle — only insert-level dedupe.

Properties:
  - Pure additive surface: one new collection `dedupe_buckets`, one
    unique compound index, one TTL index. Delete the collection →
    revert to previous behavior, no callers crash.
  - No reader contracts touched.
  - No payment / cluster / topology / parity surface touched.
  - Time bucket is fixed-window: `floor(now / window_seconds)`. Two
    calls inside the same window collide; calls in adjacent windows do
    not. This is the same dedupe semantics that the Redis cooldown was
    providing — see `redis_state.is_in_cooldown`.
  - Atomic claim is the Mongo unique-index DuplicateKeyError on insert.

Failure modes (intentionally fail-OPEN, same posture as Redis helpers):
  - Index creation failure → log warning, return True (don't block work).
  - Unexpected insert exception → log warning, return True.
  Only `DuplicateKeyError` returns False. We never lose the duplicate
  detection silently; we only lose it when Mongo itself is misbehaving.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone

from pymongo.errors import DuplicateKeyError

from app.core.db import db

logger = logging.getLogger("server")

# Lazy one-shot index creation. We avoid hard-wiring this into startup so
# the helper stays self-contained (no `ensure_indexes` call required at
# bootstrap). The flag protects from repeated `create_index` round-trips.
_indexes_ready: bool = False


async def _ensure_indexes() -> None:
    global _indexes_ready
    if _indexes_ready:
        return
    try:
        # Atomic claim: unique on the (scope, key, bucket) triple. Two
        # callers racing on the same triple → only one succeeds.
        await db.dedupe_buckets.create_index(
            [("scope", 1), ("key", 1), ("bucket", 1)],
            unique=True,
            name="dedupe_bucket_compound_unique",
        )
        # Auto-cleanup: Mongo deletes the doc when `expiresAt` passes.
        # We size `expiresAt` slightly larger than the window to make sure
        # the next bucket starts cleanly (no leftover docs).
        await db.dedupe_buckets.create_index(
            "expiresAt",
            expireAfterSeconds=0,
            name="dedupe_bucket_ttl",
        )
        _indexes_ready = True
    except Exception as exc:  # pragma: no cover — defensive
        logger.warning(f"dedupe_bucket: index creation failed: {exc} — fail-open")


async def try_claim_bucket(scope: str, key: str, window_seconds: int) -> bool:
    """Atomically claim `(scope, key, time-bucket)` for `window_seconds`.

    Returns:
        True  — this caller won the claim (first in the bucket).
        False — duplicate; another caller already claimed this bucket.

    Fail-open contract:
        Any unexpected error (index failure, network blip) returns True
        and logs a warning. Only a real DuplicateKeyError yields False.
        Rationale: same posture as the existing Redis helpers — better a
        rare duplicate than blocking the orchestrator on a Mongo hiccup.
    """
    await _ensure_indexes()
    window = max(1, int(window_seconds))
    bucket = int(time.time() // window)
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=window + 30)
    try:
        await db.dedupe_buckets.insert_one(
            {
                "scope": scope,
                "key": key,
                "bucket": bucket,
                "expiresAt": expires_at,
            }
        )
        return True
    except DuplicateKeyError:
        return False
    except Exception as exc:  # pragma: no cover — defensive
        logger.warning(f"dedupe_bucket.try_claim_bucket({scope},{key}): {exc} — fail-open")
        return True


__all__ = ["try_claim_bucket"]
