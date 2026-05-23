"""app.orchestrator.runner — C15.1 централизованный запуск фоновых loops.

Одна точка входа для всех background tasks. Вызывается из `app/core/lifespan.py`
после `init_db()` + `load_ml_models()` — т.е. когда `ctx.db` гарантированно
готов и ML-модели гидратированы. До этого loops стартовать нельзя: они
делают `await db.X.find(...)` в первом же тике.

Порядок не важен (все loops независимы), но фиксируем логический:
  1) zone_state_engine           — Phase B demand/supply state (10s)
  2) orchestrator_engine_loop_v2 — Phase E+G actions cycle (10s)
  3) feedback_processor_loop     — Phase G feedback drain (15s)
  4) strategy_optimizer_loop     — Phase H weight optimizer (5min)
  5) provider_ranking_optimizer  — Sprint 17 (5min)
  6) _demand_prediction_loop     — Sprint 19+20 ML retrain (5min)

Возвращает список созданных task-ов (для shutdown cancellation, если понадобится).
"""
from __future__ import annotations
import asyncio
import logging
from typing import List

logger = logging.getLogger("server")


def start_all_loops() -> List[asyncio.Task]:
    """Запустить все фоновые loops. Должен вызываться ПОСЛЕ init_db()+load_ml_models()."""
    # Lazy import: все эти модули тянут за собой DB / ml, которые уже готовы к моменту
    # вызова. Импортируем здесь, а не на module-top — чтобы `app.orchestrator.runner`
    # оставался лёгким и не грузил БД при импорте.
    from app.orchestrator.cycle import (
        zone_state_engine,
        orchestrator_engine_loop_v2,
    )
    from app.orchestrator.feedback import (
        feedback_processor_loop,
        strategy_optimizer_loop,
    )
    # Phase 3D PR-03: `_demand_prediction_loop` extracted to
    # `app.workers.demand_prediction`. `DemandPredictor` import removed
    # here — it now lives lazily inside the extracted loop body, which
    # preserves the original "module-load triggers no DB/ml" invariant.
    # Phase 3D PR-04: `provider_ranking_optimizer_loop` extracted to
    # `app.workers.provider_ranking`. Its import is removed here too;
    # the registry hook lazy-chains down to the loop body which
    # lazy-imports from `quick_request` only at first tick.

    tasks: List[asyncio.Task] = []
    tasks.append(asyncio.create_task(zone_state_engine(), name="zone_state_engine"))
    logger.info("C15.1 runner: Phase B Zone State Engine started (10s cycle)")

    tasks.append(asyncio.create_task(orchestrator_engine_loop_v2(), name="orchestrator_engine"))
    tasks.append(asyncio.create_task(feedback_processor_loop(), name="feedback_processor"))
    tasks.append(asyncio.create_task(strategy_optimizer_loop(), name="strategy_optimizer"))
    logger.info("C15.1 runner: Phase E+G orchestrator/feedback/optimizer started")

    # Phase 3D PR-04: provider_ranking_optimizer_loop extracted to
    # `app.workers.provider_ranking`. Archetype B (runner-coupled),
    # second confirmed instance. `register()` returns the task so
    # runner's tasks list / `len(tasks)` summary stays invariant.
    from app.workers.provider_ranking import register as _register_provider_ranking
    tasks.append(_register_provider_ranking())

    # Phase 3D PR-03: demand prediction loop registered via worker
    # package. `register()` returns the asyncio.Task so the runner's
    # task list (used for C15.1 shutdown cancellation) stays intact.
    # The start log line and worker name (`"demand_prediction"`) are
    # emitted from inside `register()` with the same wording.
    from app.workers.demand_prediction import register as _register_demand_prediction
    tasks.append(_register_demand_prediction())

    # Sprint 33 C8.1 — Reactivation Engine sweep
    from app.growth.reactivation import reactivation_sweep_loop, SWEEP_SECONDS
    tasks.append(asyncio.create_task(reactivation_sweep_loop(), name="reactivation_sweep"))
    logger.info(f"C8.1 runner: Reactivation Engine started ({SWEEP_SECONDS}s cycle)")

    # Sprint 33 C8.2 — Smart Nudge Engine sweep (tells providers where to earn)
    from app.growth.nudges import nudge_sweep_loop, NUDGE_SWEEP_SECONDS
    tasks.append(asyncio.create_task(nudge_sweep_loop(), name="nudge_sweep"))
    logger.info(f"C8.2 runner: Smart Nudge Engine started ({NUDGE_SWEEP_SECONDS}s cycle)")

    # Sprint 33 C8.4 — Auto-money worker (subscription-grade autobidder)
    from app.growth.auto_money import auto_money_worker_loop, AUTO_MONEY_TICK_SECONDS
    tasks.append(asyncio.create_task(auto_money_worker_loop(), name="auto_money_worker"))
    logger.info(f"C8.4 runner: Auto-money worker started ({AUTO_MONEY_TICK_SECONDS}s cycle)")

    logger.info(f"C15.1 runner: {len(tasks)} background loops launched")
    return tasks
