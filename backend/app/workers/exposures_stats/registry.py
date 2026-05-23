"""app.workers.exposures_stats.registry — lifespan registration hook.

PR-02 (Phase 3D) move-only extraction. Replaces the inline
`asyncio.create_task(stats_recompute_loop(300))` line at
`app/core/lifespan.py:279` (previously bundled with sibling B3
loops).

Move-only invariants preserved:
  • same task storage attribute (`app.state.exposures_stats_task`)
  • same cadence (DEFAULT_INTERVAL_S = 300 — see contracts.py)
  • same worker self-emitted log line:
        "[exposures] stats_recompute_loop started (interval=300s)"
  • non-fatal failure envelope (try/except, warning log)
  • no new realtime, no new metrics, no new state

The function signature `register(app)` mirrors
`app.workers.receipts_poll.registry.register` (Phase 3D copy-structure
discipline; no abstraction until Tier A is complete).
"""
from __future__ import annotations

import asyncio
import logging

from .contracts import DEFAULT_INTERVAL_S
from .loop import stats_recompute_loop

logger = logging.getLogger(__name__)


def register(app) -> None:
    """Register the exposures stats recompute worker on `app`.

    Behaviour-equivalent to the previous inline line in lifespan
    (one of three within the same shared try/except):

        app.state.exposures_stats_task = asyncio.create_task(stats_recompute_loop(300))
    """
    try:
        app.state.exposures_stats_task = asyncio.create_task(
            stats_recompute_loop(DEFAULT_INTERVAL_S)
        )
        logger.info(
            "Phase 3D PR-02: exposures stats worker started (interval=300s)"
        )
    except Exception as e:  # noqa: BLE001
        logger.warning(
            f"Phase 3D PR-02: exposures stats worker failed to start (non-fatal): {e}"
        )


__all__ = ["register"]
