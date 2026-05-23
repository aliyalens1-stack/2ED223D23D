"""app.workers.demand_prediction.loop — Sprint 19+20 ML retrain.

PR-03 (Phase 3D) move-only extraction. Previously defined as the
INNER function `_demand_prediction_loop` inside
`app/orchestrator/runner.py:start_all_loops` at lines 42-56.

Behavioral invariants preserved 1:1:
  • 30s warm-up sleep before first train
  • DemandPredictor.train_all_zones() called every iteration
  • Cadence read from DemandPredictor.TRAIN_INTERVAL_S class attr
    (NOT hardcoded — must match the value the C14 ML guard tests
     introspect)
  • Iteration exceptions logged as
    `f"DemandPredictor train cycle error: {e}"` and swallowed
  • Logger name = `"server"` (preserved from previous module-level
    logger of `app.orchestrator.runner` which used
    `logging.getLogger("server")`)

Lazy import of DemandPredictor (Vector 6 preservation):
The DemandPredictor import remains INSIDE the loop body so that
import-time loading of this module does NOT chain-load
`app.ml.predictor` (which triggers Mongo `ml_models` reads via
`load_persisted`). The runner.start_all_loops contract requires
that imports complete BEFORE first await; the original
implementation honored this by deferring `from app.ml.predictor
import DemandPredictor` until inside `start_all_loops`. After
extraction, the same deferral happens — just one level deeper.

Lifecycle dependency (Vector 7):
This worker requires `DemandPredictor.load_persisted()` to have
been called during `lifespan.load_ml_models()` BEFORE `register()`
fires. The 30s warm-up sleep is an additional safety margin that
predates Sprint 21 C15.1 (when load_persisted was moved out of the
loop into lifespan). It is preserved unchanged.
"""
from __future__ import annotations

import asyncio
import logging

# Logger name held identical to the pre-extraction call site
# (`runner.py:23` used `logging.getLogger("server")`). Substring
# matches in any future test or log scrape continue to work.
logger = logging.getLogger("server")


async def demand_prediction_loop() -> None:
    """Sprint 19+20: periodic ML retrain every `TRAIN_INTERVAL_S`.

    C15.1: warm-start (load_persisted) is performed explicitly in
    `lifespan.load_ml_models()` BEFORE this loop starts. No duplicate
    load here.
    """
    # Lazy import (Vector 6): keep `app.ml.predictor` off the module-
    # load path. By the time runner.start_all_loops invokes us, ml is
    # already hydrated by lifespan.load_ml_models() — but the deferred
    # import preserves the original runner doctrine that module-level
    # imports must not pull DB/ml.
    from app.ml.predictor import DemandPredictor

    # warm-up: ждём 30с чтобы db/mongo index был готов (на первом трейне
    # нам нужны собранные zone_snapshots).
    await asyncio.sleep(30)
    while True:
        try:
            await DemandPredictor.train_all_zones()
        except Exception as e:  # noqa: BLE001
            logger.warning(f"DemandPredictor train cycle error: {e}")
        await asyncio.sleep(DemandPredictor.TRAIN_INTERVAL_S)


__all__ = ["demand_prediction_loop"]
