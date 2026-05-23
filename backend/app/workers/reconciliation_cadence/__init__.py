"""app.workers.reconciliation_cadence — P6.C scheduled snapshot worker.

Doctrine reference: `memory/P6_1_provider_surface_triage_inventory_2026_05_22.md`
§4 — *cadence persistence*.

P5 closure declared current state as **human-triggered persistence**:
an operator must `POST /api/admin/reconciliation/report` for a snapshot
to exist. P6.C closes that asymmetry by adding a **platform-triggered
evidence cadence** — the worker writes a `reconciliation_snapshots`
row at fixed intervals regardless of operator presence.

This is NOT automation. The worker does not decide anything, does not
remediate anything, does not act on the divergence it observes. It only
produces evidence rows that an operator can later inspect.

Pattern mirror: `app.workers.receipts_poll` (PR-01 Phase 3D), which was
the SECOND supervised worker after vehicles_refresh. This is the SIXTH.

Public surface (mirrors receipts_poll):
  • `run_reconciliation_once`  — single-pass entrypoint
  • `emit_startup_log`         — one-time startup log
  • `emit_cancel_log`          — graceful-cancel log
  • `register`                 — lifespan-side registration hook
• `DEFAULT_INTERVAL_S`        — cadence constant
  • `IDEMPOTENCY_WINDOW_S`     — cooldown before next snapshot
"""
from .contracts import (
    DEFAULT_INTERVAL_S,
    IDEMPOTENCY_WINDOW_S,
    MIN_DIVERGENCE_FOR_LOG,
    SYSTEM_ACTOR,
)
from .loop import (
    emit_cancel_log,
    emit_startup_log,
    run_reconciliation_once,
)
from .registry import register

__all__ = [
    "DEFAULT_INTERVAL_S",
    "IDEMPOTENCY_WINDOW_S",
    "MIN_DIVERGENCE_FOR_LOG",
    "SYSTEM_ACTOR",
    "emit_cancel_log",
    "emit_startup_log",
    "run_reconciliation_once",
    "register",
]
