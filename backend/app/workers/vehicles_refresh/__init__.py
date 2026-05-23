"""app.workers.vehicles_refresh — VMS temporal evolution worker.

Phase 3.4 C-2: promoted from PR-05 move-only (Archetype A wrapper) to a
true supervised worker driven by `app.core.worker_supervisor`. The
supervisor owns the while-loop, sleep, restart envelope, and telemetry;
this package owns only one tick body.

Public surface (re-exports):
  • `vehicles_refresh_tick` — single-tick coroutine (one batch scan)
  • `emit_startup_log`       — one-time startup log (preserves wording)
  • `register`               — lifespan-side registration hook

The previous PR-05 `refresh_loop` symbol has been intentionally removed
as part of the C-2 invariant "no legacy path remains active". Domain
helpers (`refresh_vehicle`, `ensure_refresh_indexes`, `_refresh_verdict`,
etc.), endpoint handlers, env-driven constants, and the FastAPI `router`
all stay in `app.vehicles.refresh`.
"""
from .loop import emit_startup_log, vehicles_refresh_tick
from .registry import register

__all__ = [
    "vehicles_refresh_tick",
    "emit_startup_log",
    "register",
]
