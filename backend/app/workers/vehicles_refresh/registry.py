"""app.workers.vehicles_refresh.registry — lifespan-side registration hook.

Phase 3.4 C-2: this hook now drives the central `worker_supervisor` instead
of raw `asyncio.create_task`. The PR-05 move-only Archetype A wrapper has
been promoted to a true supervised worker.

═══════════════════════════════════════════════════════════════════════
PROMOTION SIGNATURE (C-2)
═══════════════════════════════════════════════════════════════════════

Before (PR-05, Archetype A move-only):

    app.state.refresh_task = asyncio.create_task(refresh_loop())
    logger.info("VMS: refresh worker started (temporal evolution)")

After (C-2, supervised):

    supervisor.register(WorkerSpec(
        name="vehicles_refresh",
        tick=vehicles_refresh_tick,
        interval_seconds=REFRESH_TICK_SECONDS,
        restart_policy="on_failure",
        max_restarts=5,
        backoff_seconds=5.0,
        on_start=emit_startup_log,
    ))
    supervisor.start("vehicles_refresh")
    app.state.refresh_task = supervisor.get_task("vehicles_refresh")  # compat
    logger.info("VMS: refresh worker started (temporal evolution)")   # preserved verbatim

Preserved invariants:
  • Lifespan-side wrapping log line: "VMS: refresh worker started (temporal evolution)"
  • `app.state.refresh_task` attribute name (now points to supervisor-owned task)
  • Worker-emitted startup log line: "vehicle refresh loop started (tick=Ns, batch=N)"
    (now fired via `on_start` callback before first tick)
  • `ensure_refresh_indexes()` continues to be called from lifespan
    BEFORE this hook fires — index ensure stays adjacent to its co-located
    domain endpoint readers.
  • All worker-side log line wordings (scan progress, per-vehicle failure,
    per-tick failure) preserved verbatim in `loop.vehicles_refresh_tick`.

Promoted semantics (NEW in C-2):
  • restart_policy = on_failure (max_restarts=5, backoff_seconds=5)
  • active_instances <= 1 invariant enforced by supervisor (hard runtime check)
  • per-tick telemetry available via `supervisor.status("vehicles_refresh")`
  • graceful shutdown via `supervisor.stop_all()` in lifespan shutdown phase
  • duplicate register('vehicles_refresh') raises ValueError (hard error)

Archetype A wrappers for siblings (receipts_poll, exposures_stats) remain
move-only. Subsequent supervisor migrations happen one-at-a-time in
later phases.
"""
from __future__ import annotations

import logging

from app.core.worker_supervisor import WorkerSpec, supervisor
from .loop import emit_startup_log, vehicles_refresh_tick

logger = logging.getLogger(__name__)

_WORKER_NAME = "vehicles_refresh"


def register(app) -> None:
    """Register `vehicles_refresh` under the supervisor and start it.

    Behaviour-compatible with the legacy hook:
      • Same end-state task ownership: task lives in the supervisor.
      • Same wrapping log line at lifespan-side.
      • Same `app.state.refresh_task` attribute (now a read-only handle
        to the supervisor-owned task).
      • `ensure_refresh_indexes()` continues to be called from lifespan,
        BEFORE this hook fires.
    """
    try:
        from app.vehicles.refresh import REFRESH_TICK_SECONDS

        # Registration is idempotent across hot reloads: if already
        # registered (e.g. uvicorn --reload re-fires lifespan in the
        # same process), do NOT re-register — that would trip the
        # duplicate-register hard error. Stop the previous instance
        # first so the active_instances<=1 invariant holds on start().
        if not supervisor.registered(_WORKER_NAME):
            supervisor.register(WorkerSpec(
                name=_WORKER_NAME,
                tick=vehicles_refresh_tick,
                interval_seconds=float(REFRESH_TICK_SECONDS),
                restart_policy="on_failure",
                max_restarts=5,
                backoff_seconds=5.0,
                on_start=emit_startup_log,
            ))

        supervisor.start(_WORKER_NAME)

        # Compat surface — preserve `app.state.refresh_task` attribute.
        app.state.refresh_task = supervisor.get_task(_WORKER_NAME)

        logger.info("VMS: refresh worker started (temporal evolution)")
    except Exception as e:  # noqa: BLE001
        logger.warning(f"VMS: refresh worker failed to start (non-fatal): {e}")


__all__ = ["register"]
