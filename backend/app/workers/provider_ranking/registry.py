"""app.workers.provider_ranking.registry — runner-side registration hook.

PR-04 (Phase 3D) move-only extraction. Replaces lines L67-L68 of
`app/orchestrator/runner.py` (post-PR-03 numbering):

    tasks.append(asyncio.create_task(provider_ranking_optimizer_loop(),
                                     name="provider_ranking_optimizer"))
    logger.info("C15.1 runner: Sprint 17 Provider Ranking Optimizer started (5min cycle)")

═══════════════════════════════════════════════════════════════════════
SIGNATURE: Archetype B (runner-owned) — second instance
═══════════════════════════════════════════════════════════════════════

PR-03 (`demand_prediction`) established the runner-owned signature:

    def register() -> asyncio.Task

PR-04 confirms the pattern for a SECOND runner-coupled worker. Both
runner-coupled extractions:
  • Return `asyncio.Task` so the runner's `tasks: List[asyncio.Task]`
    invariant + `"{len(tasks)} background loops launched"` summary
    log stay correct.
  • Take ZERO parameters (no `app` reference, no DB handle — the
    loop body resolves its own dependencies via lazy import).
  • Emit the original startup log line from inside `register()` so
    log attribution stays under the same logger name (`"server"`).

Two confirmed instances do NOT yet justify a base class. Per user
direction at PR-03 ratification: "copy structure first, abstract
later if repetition survives contact with reality." PR-05 (refresh,
lifespan-coupled — Archetype A) will give us the FIRST direct
contrast against PR-01/PR-02 in this taxonomy. The earliest a base
class could be considered is post-PR-05 retrospective.
═══════════════════════════════════════════════════════════════════════

Move-only invariants preserved:
  • same task name attribute: `name="provider_ranking_optimizer"`
  • same log line wording on startup:
      "C15.1 runner: Sprint 17 Provider Ranking Optimizer started (5min cycle)"
  • emitted from the `"server"` logger (matches PR-03 choice for the
    same reason — preserves attribution under the existing logger)
"""
from __future__ import annotations

import asyncio
import logging

from .loop import provider_ranking_optimizer_loop

logger = logging.getLogger("server")


def register() -> asyncio.Task:
    """Create and return the provider ranking optimizer task.

    Caller (`app.orchestrator.runner.start_all_loops`) is responsible
    for appending the returned task to its `tasks: List[asyncio.Task]`.
    """
    task = asyncio.create_task(
        provider_ranking_optimizer_loop(),
        name="provider_ranking_optimizer",
    )
    logger.info(
        "C15.1 runner: Sprint 17 Provider Ranking Optimizer started (5min cycle)"
    )
    return task


__all__ = ["register"]
