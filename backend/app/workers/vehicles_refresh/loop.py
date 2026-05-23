"""app.workers.vehicles_refresh.loop — VMS temporal evolution worker.

Phase 3.4 C-2: promoted from PR-05 move-only (Archetype A wrapper) to a
supervised worker driven by `app.core.worker_supervisor`. The supervisor
owns while+sleep+restart envelope; this module owns only one tick body.

Behavioral invariants preserved 1:1:
  • Cadence: `REFRESH_TICK_SECONDS` (env-driven, default 60s) — supplied
    to the supervisor at registration time.
  • Batch size: `REFRESH_BATCH` (env-driven, default 5) — read inside the
    tick body via lazy import.
  • Cooldown: `REFRESH_COOLDOWN_HOURS` (env-driven, default 6h).
  • Per-vehicle fetcher: `refresh_vehicle(vid)` — stays in
    `app.vehicles.refresh` (also called by `manual_refresh` endpoint).
  • Logger name: `"vehicles.refresh"` (preserved literally).
  • Log line wording (preserved verbatim):
        "vehicle refresh loop started (tick=Ns, batch=N)"   (emit_startup_log)
        "vehicle refresh: scanning N vehicles"               (tick body)
        "vehicle refresh {vid} failed (non-fatal): {e}"      (tick body)
        "vehicle refresh loop tick failed (non-fatal): {e}"  (tick body)
  • Non-fatal exception swallowing at TWO levels (per-vehicle AND
    per-tick). The original behaviour was: ALL tick-level exceptions
    swallowed → loop never crashes → supervisor restart_policy lies
    dormant for this worker. This preservation is intentional. The
    supervisor's restart_policy is verified separately (synthetic tick
    in tests). For this worker the policy is a defensive net for
    truly catastrophic asyncio-level failures only.

External I/O preservation (V-EXT-3):
This module does NO direct external I/O. External fetches happen inside
`refresh_vehicle(vid)` (which calls `parse_listing(...)`). All I/O
semantics, retry policy, timeout, and error categorisation remain in
`app.vehicles.refresh` and are NOT moved.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

# Logger name preserved literally — see "Hard invariants" in README.md.
logger = logging.getLogger("vehicles.refresh")


async def vehicles_refresh_tick() -> None:
    """Single tick of the VMS refresh worker. One batch scan.

    Supervisor owns the while-loop and sleep; this function owns one
    iteration. Exception semantics preserved verbatim from the original
    `refresh_loop` body — both per-vehicle AND per-tick try/except are
    in-place. Nothing propagates to the supervisor under normal failure
    modes (DB blip, per-vehicle parse error).
    """
    # Lazy imports (V4 + V6): `app.vehicles.refresh` is a heavy module
    # (FastAPI router with 3 endpoints, ~544 LOC). Importing at module-top
    # would force the entire VMS surface onto this module's load path.
    from app.core.db import db
    from app.vehicles.refresh import (
        refresh_vehicle,
        REFRESH_BATCH,
        REFRESH_COOLDOWN_HOURS,
    )

    try:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=REFRESH_COOLDOWN_HOURS)
        cur = db.vehicles.find(
            {
                "listing_url": {"$exists": True, "$ne": None},
                "$or": [
                    {"lastRefreshAt": {"$exists": False}},
                    {"lastRefreshAt": None},
                    {"lastRefreshAt": {"$lt": cutoff}},
                ],
            },
            {"_id": 0, "id": 1},
        ).sort("lastRefreshAt", 1).limit(REFRESH_BATCH)
        ids = [d["id"] async for d in cur if d.get("id")]
        if ids:
            logger.info(f"vehicle refresh: scanning {len(ids)} vehicles")
            for vid in ids:
                try:
                    await refresh_vehicle(vid)
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"vehicle refresh {vid} failed (non-fatal): {e}")
    except Exception as e:  # noqa: BLE001
        # Original behaviour: swallow at tick level, never propagate.
        logger.warning(f"vehicle refresh loop tick failed (non-fatal): {e}")


def emit_startup_log() -> None:
    """One-time startup log emission. Called by supervisor before first tick.

    Preserves the exact wording the original `refresh_loop` emitted on
    first entry: "vehicle refresh loop started (tick=Ns, batch=N)".
    """
    from app.vehicles.refresh import REFRESH_TICK_SECONDS, REFRESH_BATCH
    logger.info(
        f"vehicle refresh loop started (tick={REFRESH_TICK_SECONDS}s, "
        f"batch={REFRESH_BATCH})"
    )


# Backward-compat note: the previous `refresh_loop` symbol (PR-05) is
# intentionally NOT preserved here. Grep across the codebase confirms zero
# callers — the lifespan now drives `vehicles_refresh_tick` through the
# supervisor, and no test or fixture imports the legacy symbol. Keeping
# a dead shim would contradict the C-2 invariant "no legacy path remains
# active". If a future external consumer needs a single-shot run, they can
# call `vehicles_refresh_tick()` directly.


__all__ = ["vehicles_refresh_tick", "emit_startup_log"]
