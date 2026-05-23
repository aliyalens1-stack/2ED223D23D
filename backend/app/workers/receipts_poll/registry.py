"""app.workers.receipts_poll.registry — lifespan-side registration hook.

Phase 3.4 C-3: this hook now drives the central `worker_supervisor` instead
of raw `asyncio.create_task`. The PR-01 Archetype A move-only wrapper
has been promoted to a true supervised worker. This is the SECOND
supervised worker (after vehicles_refresh / C-2), confirming that the
supervisor surface generalises beyond a single migration.

═══════════════════════════════════════════════════════════════════════
PROMOTION SIGNATURE (C-3)
═══════════════════════════════════════════════════════════════════════

Before (PR-01, Archetype A move-only):

    app.state.cnotify_receipts_task = asyncio.create_task(
        receipts_poll_loop(_get_db(), DEFAULT_INTERVAL_S)
    )
    logger.info("Customer-Notify-3A Phase B: receipts poll loop started (interval=180s)")

After (C-3, supervised):

    db = get_db()
    async def _tick():
        await poll_receipts_once(db)
    supervisor.register(WorkerSpec(
        name="receipts_poll",
        tick=_tick,
        interval_seconds=DEFAULT_INTERVAL_S,
        restart_policy="on_failure",
        max_restarts=5,
        backoff_seconds=5.0,
        on_start=emit_startup_log,
        on_cancel=emit_cancel_log,
    ))
    supervisor.start("receipts_poll")
    app.state.cnotify_receipts_task = supervisor.get_task("receipts_poll")  # compat
    logger.info("Customer-Notify-3A Phase B: receipts poll loop started (interval=180s)")  # preserved verbatim

Preserved invariants:
  • Lifespan-side wrapping log: "Customer-Notify-3A Phase B: receipts poll loop started (interval=180s)"
  • Worker-side startup log:     "cnotify receipts loop started (interval=180s)"  (now via on_start)
  • Worker-side cancel  log:     "cnotify receipts loop cancelled"                (now via on_cancel)
  • `app.state.cnotify_receipts_task` attribute (now points to supervisor-owned task)
  • Per-tick try/except inside `poll_receipts_once` (function-level) preserved as-is.

Promoted semantics (NEW in C-3):
  • restart_policy = on_failure (max_restarts=5, backoff=5s)
  • active_instances <= 1 invariant enforced by supervisor
  • per-tick telemetry available via `supervisor.status("receipts_poll")`
  • graceful shutdown via `supervisor.stop_all()` in lifespan shutdown phase
  • duplicate register('receipts_poll') raises ValueError (hard error)

Tick-level exception handling note:
The original `receipts_poll_loop` swallowed iteration errors with
`except Exception as e: logger.warning(...)`. `poll_receipts_once` itself
ALSO already swallows per-row errors internally. After C-3, the
outermost iteration try/except is GONE (it lived in the deleted loop
body). The supervisor's restart_policy now handles iteration-level
exceptions: any exception propagated out of `poll_receipts_once` will
trigger a counted restart with bounded backoff. In practice
`poll_receipts_once` is engineered to never raise (transport failures
return {}), so the restart_policy is a defensive net only.
"""
from __future__ import annotations

import logging

from app.core.worker_supervisor import WorkerSpec, supervisor
from .contracts import DEFAULT_INTERVAL_S
from .loop import emit_cancel_log, emit_startup_log, poll_receipts_once

logger = logging.getLogger(__name__)

_WORKER_NAME = "receipts_poll"


def register(app) -> None:
    """Register `receipts_poll` under the supervisor and start it.

    Behaviour-compatible with the legacy hook:
      • Same end-state task ownership: task lives in the supervisor.
      • Same lifespan-side wrapping log line.
      • Same `app.state.cnotify_receipts_task` attribute (now a read-only
        handle to the supervisor-owned task).
      • Same worker-side startup AND cancel log lines, via `on_start` /
        `on_cancel` hooks.
    """
    try:
        from app.core.db import get_db
        db = get_db()

        async def _tick() -> None:
            # Wrapper that erases the `db` argument so the supervisor can
            # call a zero-arg awaitable. `db` is the module-level Motor
            # client captured at registration time — identical to the
            # legacy `receipts_poll_loop(get_db(), ...)` capture.
            await poll_receipts_once(db)

        # Idempotent across hot reloads (uvicorn --reload). If supervisor
        # already holds a spec under this name we skip re-register to avoid
        # the duplicate-register hard error.
        if not supervisor.registered(_WORKER_NAME):
            supervisor.register(WorkerSpec(
                name=_WORKER_NAME,
                tick=_tick,
                interval_seconds=DEFAULT_INTERVAL_S,
                restart_policy="on_failure",
                max_restarts=5,
                backoff_seconds=5.0,
                on_start=emit_startup_log,
                on_cancel=emit_cancel_log,
            ))

        supervisor.start(_WORKER_NAME)

        # Compat surface — preserve `app.state.cnotify_receipts_task`.
        app.state.cnotify_receipts_task = supervisor.get_task(_WORKER_NAME)

        logger.info(
            "Customer-Notify-3A Phase B: receipts poll loop started (interval=180s)"
        )
    except Exception as e:  # noqa: BLE001
        logger.warning(
            f"Customer-Notify-3A Phase B: receipts loop failed to start (non-fatal): {e}"
        )


__all__ = ["register"]
