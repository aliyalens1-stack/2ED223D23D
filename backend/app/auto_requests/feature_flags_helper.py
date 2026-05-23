"""Phase 3 feature flag helper — Mongo-backed + per-request override.

Schema matches existing `feature_flags` collection (seeded in app/core/seed.py):
  {key, enabled, description, rolloutPct, updatedAt}

Lookup precedence:
  1. per-request override (request_doc['useExposures'])  — tightest scope
  2. Mongo `feature_flags` document                      — global runtime toggle
  3. `default`                                           — hard-coded fallback

The helper keeps a small TTL in-process cache (5s) so that the hot path
(create_request → is_enabled("use_exposures")) doesn't hit Mongo on every call.
This is NOT a distributed cache — Redis is optional in this env.
"""
from __future__ import annotations
import time
from typing import Optional

from app.core.db import get_db
# Phase 1B Tier 4 — pure sync appliesToClusters enrichment for feature_flags bootstrap.
from app.core.cluster_writer import enrich_applies_to_clusters


_CACHE: dict[str, tuple[float, bool]] = {}   # key → (expires_at, value)
_CACHE_TTL_SECONDS = 5.0


async def is_enabled(
    key: str,
    default: bool = False,
    request_doc: Optional[dict] = None,
) -> bool:
    """Return whether `key` is enabled, honoring per-request override + global flag.

    Per-request override uses the `useExposures` → `use_exposures` legacy field
    (both accepted). This is the only field we read from request_doc today;
    extend map below if new flags get per-request overrides.
    """
    # 1. Per-request override (only for keys we explicitly map)
    if request_doc is not None:
        override = _request_override_for_key(key, request_doc)
        if override is not None:
            return override

    # 2. Mongo flag (cached 5s)
    now = time.monotonic()
    cached = _CACHE.get(key)
    if cached and cached[0] > now:
        return cached[1]

    try:
        db = get_db()
        doc = await db.feature_flags.find_one({"key": key}, {"_id": 0, "enabled": 1})
        value = bool(doc["enabled"]) if doc and "enabled" in doc else default
    except Exception:
        value = default

    _CACHE[key] = (now + _CACHE_TTL_SECONDS, value)
    return value


def _request_override_for_key(key: str, request_doc: dict) -> Optional[bool]:
    """Map flag key → field name on request_doc. Returns None if no override set."""
    if key == "use_exposures":
        v = request_doc.get("useExposures")
        if v is None:
            v = request_doc.get("use_exposures")
        if v is None:
            return None
        return bool(v)
    return None


async def ensure_flags_seed(default_use_exposures: bool = True) -> None:
    """Idempotent seed for the flag we need. Doesn't clobber existing values."""
    db = get_db()
    now = time.time()
    doc = await db.feature_flags.find_one({"key": "use_exposures"})
    if not doc:
        flag_doc = {
            "key": "use_exposures",
            "enabled": default_use_exposures,
            "description": "Phase 3 — Soft Marketplace: request → exposures → accept → job",
            "rolloutPct": 100 if default_use_exposures else 0,
            "updatedAt": now,
        }
        # Phase 1B Tier 4 — auto_requests is the inspection domain.
        enrich_applies_to_clusters(flag_doc, clusters=["inspection"])
        await db.feature_flags.insert_one(flag_doc)
    # Config knob for wave size — not a flag, but lives with flags for simplicity.
    cfg = await db.feature_flags.find_one({"key": "exposures_per_request"})
    if not cfg:
        cfg_doc = {
            "key": "exposures_per_request",
            "enabled": True,
            "value": 5,
            "description": "Top-N inspectors exposed per inspection_job wave",
            "rolloutPct": 100,
            "updatedAt": now,
        }
        enrich_applies_to_clusters(cfg_doc, clusters=["inspection"])
        await db.feature_flags.insert_one(cfg_doc)


async def get_config_int(key: str, default: int) -> int:
    """Read an integer config from feature_flags.value (e.g. pool size)."""
    try:
        db = get_db()
        doc = await db.feature_flags.find_one({"key": key}, {"_id": 0, "value": 1})
        if doc and "value" in doc:
            return int(doc["value"])
    except Exception:
        pass
    return default
