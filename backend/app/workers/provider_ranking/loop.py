"""app.workers.provider_ranking.loop — Sprint 17 ranking optimizer.

PR-04 (Phase 3D) move-only extraction from
`app/marketplace/quick_request.py:360-380`. The function body is
copied verbatim. The two cross-module references that previously
resolved at module-load time inside `quick_request` —
  • `_recalculate_ranking_weights` (private domain helper)
  • `RANKING_OPTIMIZER_INTERVAL_SEC` (module-level cadence constant)
— are now imported LAZILY inside the loop body, mirroring the
PR-03 DemandPredictor pattern.

Behavioral invariants preserved 1:1:
  • Cadence: `RANKING_OPTIMIZER_INTERVAL_SEC` (300s) — read from
    `quick_request` so a future cadence change in one place doesn't
    drift here.
  • Logger source: `ctx.logger` (NOT `__name__`, NOT `"server"`).
    The original loop captures `logger = ctx.logger` at the start
    of every entry into the function; that pattern is preserved.
    Why this divergence from PR-02 / PR-03: this worker was authored
    against the `ctx.logger` convention used by quick-request
    handlers, and preserving log attribution means readers grep'ing
    the marketplace surface continue to see "Ranking optimizer:
    refit ..." under the same logger.
  • Sleep-then-work order: the original sleeps FIRST, then computes.
    Preserved (no first-tick burst).
  • `asyncio.CancelledError` handling: explicit `break` (different
    from PR-03 which lets cancellation propagate). Preserved.
  • Log line wording on each refit:
        "Ranking optimizer: refit {updated}/{groups} groups on {total_samples} samples"

Lazy import preservation (Vector 6):
The original quick_request.py is ~1054 LOC including a FastAPI
router with 8 endpoints. Importing it at module top of `loop.py`
would force the entire marketplace surface onto the worker module-
load path. The lazy import inside the loop body keeps the original
"runner stays light" doctrine valid.
"""
from __future__ import annotations

import asyncio


async def provider_ranking_optimizer_loop():
    """Background loop. Re-fits weights every `RANKING_OPTIMIZER_INTERVAL_SEC`.

    Запускается из `runner.start_all_loops` через `register()` hook
    (см. ./registry.py). Ранее запускался из `server.py startup_with_feedback()`,
    затем перенесён в runner C15.1, теперь — extracted worker package.
    """
    # Lazy imports (Vector 4 + V6): keep `app.marketplace.quick_request`
    # off the module-load path of this worker. By the time the runner
    # invokes us, quick_request is already loaded (its router is mounted
    # earlier in startup), but the deferral preserves the discipline.
    from app.core.context import ctx
    from app.marketplace.quick_request import (
        _recalculate_ranking_weights,
        RANKING_OPTIMIZER_INTERVAL_SEC,
    )

    logger = ctx.logger
    while True:
        try:
            await asyncio.sleep(RANKING_OPTIMIZER_INTERVAL_SEC)
            summary = await _recalculate_ranking_weights()
            if summary["updated"] and logger:
                logger.info(
                    f"Ranking optimizer: refit {summary['updated']}/{summary['groups']} groups "
                    f"on {summary['total_samples']} samples"
                )
        except asyncio.CancelledError:
            break
        except Exception as e:
            if logger:
                logger.warning(f"Ranking optimizer error: {e}")


__all__ = ["provider_ranking_optimizer_loop"]
