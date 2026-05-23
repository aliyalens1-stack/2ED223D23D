"""app.workers.demand_prediction — Sprint 19+20 ML retrain worker.

PR-03 (Phase 3D) move-only extraction. Previously defined as an INNER
async function inside `app/orchestrator/runner.py:start_all_loops` at
lines 42-56. Since the function was a closure with NO external
importers, no shim is required.

Per Phase 3C §9 Tier A row 3 + 3D §3.2 PR-03, this is a Tier A
carve-out: overwrite-by-construction (`ml_models` collection — see
`DemandPredictor.persist`), zero inter-worker coupling.

This is the FIRST runner-coupled worker extraction. The registration
hook signature diverges from PR-01/PR-02 (`register(app) -> None`):
here it is `register() -> asyncio.Task`, because the runner owns the
task list (see ./README.md "Coupling rationale").

Public surface (re-exports):
  • `demand_prediction_loop` — long-running task body (was the inner
                               closure named `_demand_prediction_loop`;
                               renamed without the underscore prefix
                               since it is now a public module export.
                               Logger output and behavior unchanged.)
  • `register`               — runner-side registration hook

See ./README.md for the explicit ownership table.
"""
from .loop import demand_prediction_loop
from .registry import register

__all__ = [
    "demand_prediction_loop",
    "register",
]
