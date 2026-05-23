"""app.workers.reconciliation_cadence.registry — supervisor registration.

Mirrors `app.workers.receipts_poll.registry`. Same idempotent
register-then-start pattern, same `on_failure max_restarts=5
backoff=5s` policy. Re-registration under hot reload is a no-op
(`supervisor.registered(name)` short-circuits).

P6.C closure: this is the SIXTH supervised worker (after vehicles_refresh,
receipts_poll, exposures_stats, plus the auto-bidding asyncio.create_task
workers that have not yet been promoted).
"""
from __future__ import annotations

import logging

from app.core.worker_supervisor import WorkerSpec, supervisor
from .contracts import DEFAULT_INTERVAL_S
from .loop import (
    emit_cancel_log,
    emit_startup_log,
    run_reconciliation_once,
)

logger = logging.getLogger(__name__)

_WORKER_NAME = "reconciliation_cadence"


def register(app) -> None:
    """Idempotent registration hook. Wired from `app.core.lifespan`."""
    try:
        from app.core.db import get_db
        db = get_db()

        async def _tick() -> None:
            await run_reconciliation_once(db)

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

        # Expose a handle on app.state for parity with receipts_poll.
        # Admin observability surfaces can introspect via
        # `supervisor.status("reconciliation_cadence")` directly; this
        # attribute is a convenience.
        app.state.reconciliation_cadence_task = supervisor.get_task(_WORKER_NAME)

        logger.info(
            f"P6.C reconciliation_cadence worker registered (interval="
            f"{int(DEFAULT_INTERVAL_S)}s)"
        )
    except Exception as e:  # noqa: BLE001
        logger.warning(
            f"P6.C reconciliation_cadence registration failed (non-fatal): {e}"
        )


__all__ = ["register"]
