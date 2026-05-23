"""app.workers.exposures_stats — Phase 3 inspector stats recompute worker.

PR-02 (Phase 3D) move-only extraction. Previously defined at
`app/auto_requests/exposures_cron.py:142` as the third of three
sibling loops (`expire_loop` + `batching_loop` + `stats_recompute_loop`).

Per Phase 3C §9 Tier A row 2 + §2.2 caveat, this is the Tier A
carve-out — `stats_recompute_loop` is a pure rollup-overwrite worker
with zero cross-worker writes. The B3 cluster siblings
(`expire_loop`, `batching_loop`) stay in `exposures_cron.py` until
PR-11 ships the B3 cluster extraction.

Public surface (re-exports):
  • `stats_recompute_loop` — long-running asyncio task
  • `register`             — lifespan-side registration hook

This package does NOT re-export the sibling loops (they own their
own ownership boundary).

See ./README.md for the explicit ownership table.
"""
from .contracts import DEFAULT_INTERVAL_S
from .loop import stats_recompute_loop
from .registry import register

__all__ = [
    "DEFAULT_INTERVAL_S",
    "stats_recompute_loop",
    "register",
]
