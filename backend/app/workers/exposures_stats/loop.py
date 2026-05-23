"""app.workers.exposures_stats.loop — Phase 3 inspector stats recompute.

PR-02 (Phase 3D) move-only extraction from
`app/auto_requests/exposures_cron.py:142-150`.

Recompute runs every `interval_s` seconds. The body delegates to
`app.auto_requests.inspector_stats.recompute_inspector_stats`, which
overwrites a cached projection (per-inspector aggregate stats:
ratingAvg, jobsCount, lastJobAt). Per Phase 3C §2 row 14 + §3 row 14,
the rollup is overwrite-only — idempotent by construction.

Crash-safe: any iteration's exception is logged via `logger.exception`
and the loop continues; it never raises into the event loop.

Log line wording (preserved literal):
    [exposures] stats_recompute_loop started (interval=<N>s)
    [exposures] stats_recompute error: <exc>     (on iteration failure)

The logger name (`server`) is preserved from the original module so
the `tests/test_phase3_marketplace.py:426` substring assertion
("stats_recompute_loop started") continues to match without any test
change.
"""
from __future__ import annotations

import asyncio
import logging

# Logger name held identical to the pre-extraction location
# (`exposures_cron.py:24` used `logging.getLogger("server")`). This is
# the one deliberate deviation from `__name__`-based logging — done
# to keep log output byte-identical for downstream assertions.
logger = logging.getLogger("server")


async def stats_recompute_loop(interval_s: int = 300) -> None:
    from app.auto_requests.inspector_stats import recompute_inspector_stats
    logger.info(f"[exposures] stats_recompute_loop started (interval={interval_s}s)")
    while True:
        try:
            await recompute_inspector_stats()
        except Exception as exc:
            logger.exception(f"[exposures] stats_recompute error: {exc}")
        await asyncio.sleep(interval_s)


__all__ = ["stats_recompute_loop"]
