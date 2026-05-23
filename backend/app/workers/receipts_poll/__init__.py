"""app.workers.receipts_poll — Sprint Customer-Notify-3A Phase B receipts poller.

Phase 3.4 C-3: promoted from PR-01 move-only (Archetype A wrapper) to a
true supervised worker driven by `app.core.worker_supervisor`. The
supervisor owns while+sleep+restart envelope; this package owns only
one tick body (`poll_receipts_once`).

Public surface (re-exports):
  • `poll_receipts_once`  — single-pass entrypoint (admin manual-trigger surface)
  • `emit_startup_log`    — one-time startup log (preserves wording)
  • `emit_cancel_log`     — graceful-cancel log (preserves wording)
  • `register`            — lifespan-side registration hook

The legacy `receipts_poll_loop` symbol has been intentionally removed
as part of the C-3 invariant "no legacy path remains active". The
supervisor drives the tick. `app.notifications.receipts` compat shim
preserves the historical import path for `poll_receipts_once`.
"""
from .contracts import (
    CHANNEL,
    PROVIDER,
    EXPO_RECEIPTS_URL,
    RECEIPT_MIN_AGE_SECONDS,
    RECEIPT_MAX_AGE_SECONDS,
    RECEIPT_RECHECK_BACKOFF_SECONDS,
    BATCH_SIZE,
    DEFAULT_INTERVAL_S,
)
from .loop import emit_cancel_log, emit_startup_log, poll_receipts_once
from .registry import register

__all__ = [
    "CHANNEL",
    "PROVIDER",
    "EXPO_RECEIPTS_URL",
    "RECEIPT_MIN_AGE_SECONDS",
    "RECEIPT_MAX_AGE_SECONDS",
    "RECEIPT_RECHECK_BACKOFF_SECONDS",
    "BATCH_SIZE",
    "DEFAULT_INTERVAL_S",
    "poll_receipts_once",
    "emit_startup_log",
    "emit_cancel_log",
    "register",
]
