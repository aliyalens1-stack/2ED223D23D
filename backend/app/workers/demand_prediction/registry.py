"""app.workers.demand_prediction.registry — runner-side registration hook.

PR-03 (Phase 3D) move-only extraction. Replaces lines 70-71 of
`app/orchestrator/runner.py` (the `tasks.append(asyncio.create_task(
_demand_prediction_loop(), name="demand_prediction"))` + immediate
log call).

═══════════════════════════════════════════════════════════════════════
SIGNATURE DIVERGENCE FROM PR-01 / PR-02
═══════════════════════════════════════════════════════════════════════

PR-01 (`receipts_poll`) and PR-02 (`exposures_stats`) used:

    def register(app) -> None:
        app.state.X_task = asyncio.create_task(...)

That signature suited lifespan-coupled workers, where the FastAPI
`app` is the natural owner of the task handle (for shutdown drain
and admin diagnostics).

This worker is runner-coupled: it is launched by
`app.orchestrator.runner.start_all_loops()`, which maintains its OWN
`tasks: List[asyncio.Task]` for C15.1 shutdown cancellation, and
emits a final summary log `"{len(tasks)} background loops launched"`.

Therefore the signature is:

    def register() -> asyncio.Task:
        ...
        return asyncio.create_task(...)

so the runner can do `tasks.append(register())` and keep its task
list / summary count invariant.

This is the FIRST structural divergence across PR-01..PR-03. It is
forced by Vector 1 (runner owns the task list); it is NOT a generic
abstraction or "improvement". The two signatures will continue to
co-exist; we do NOT collapse them into a base class until at least
PR-05 confirms whether further patterns emerge (per user direction:
"copy structure first, abstract later if repetition survives contact
with reality").
═══════════════════════════════════════════════════════════════════════

Move-only invariants preserved:
  • same task name attribute: `name="demand_prediction"`
  • same log line wording (worker name reference unchanged):
        "C15.1 runner: Sprint 19+20 Demand Prediction Engine started (5min retrain)"
  • emitted from the SAME `"server"` logger (not `__name__`-based)
  • DemandPredictor lazy-import preserved (inside loop body)
  • 30s warm-up sleep preserved
  • cadence still pulled from `DemandPredictor.TRAIN_INTERVAL_S`
"""
from __future__ import annotations

import asyncio
import logging

from .loop import demand_prediction_loop

# Logger held identical to the pre-extraction `runner.py:23`
# `logging.getLogger("server")` so the start log line attribution
# stays under the same logger name. This is the same choice made in
# PR-02 (exposures_stats) for the same reason.
logger = logging.getLogger("server")


def register() -> asyncio.Task:
    """Create and return the demand prediction worker task.

    Caller (`app.orchestrator.runner.start_all_loops`) is responsible
    for appending the returned task to its `tasks: List[asyncio.Task]`
    so the C15.1 shutdown cancellation contract continues to hold.
    """
    task = asyncio.create_task(demand_prediction_loop(), name="demand_prediction")
    logger.info(
        "C15.1 runner: Sprint 19+20 Demand Prediction Engine started (5min retrain)"
    )
    return task


__all__ = ["register"]
