"""app.workers.reconciliation_cadence.contracts — cadence constants.

Values are deliberately conservative: a 6-hour cadence produces 4
snapshots per day per pod, which is plenty for divergence-evolution
reconstruction at this stage of the platform's life. If operators want
density, they can still POST manual snapshots — the scheduled worker
is ADDITIVE, not replacement.

Env-overridable (no .env changes required by default):
  RECONCILIATION_CADENCE_SECONDS     default 21600 = 6h
  RECONCILIATION_IDEMPOTENCY_WINDOW  default 19500 = 6h − 8.3min
  RECONCILIATION_MIN_DIVERGENCE_LOG  default 1
"""
from __future__ import annotations

import os


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = int(raw.strip())
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


# Worker cadence — how often the supervisor calls our tick.
# 6h default: enough for evidence-evolution use cases, low enough that
# even a single-pod deployment produces 4 daily evidence rows.
DEFAULT_INTERVAL_S: float = float(_env_int("RECONCILIATION_CADENCE_SECONDS", 6 * 60 * 60))

# Idempotency window — if the most recent scheduled snapshot is younger
# than this, the worker skips the tick. Slightly shorter than the
# cadence so that drift in supervisor timing doesn't accidentally
# debounce two consecutive ticks.
IDEMPOTENCY_WINDOW_S: float = float(
    _env_int("RECONCILIATION_IDEMPOTENCY_WINDOW", int(DEFAULT_INTERVAL_S - 500))
)

# Logging threshold — only emit INFO log when divergenceCount ≥ this.
# Below the threshold the snapshot still persists, but the log line is
# suppressed to avoid noise in low-divergence pods.
MIN_DIVERGENCE_FOR_LOG: int = _env_int("RECONCILIATION_MIN_DIVERGENCE_LOG", 1)

# Synthetic `triggeredBy` for scheduled snapshots. Operators inspecting
# the history can filter on `triggeredBy.actorRole == "system:scheduler"`
# to distinguish human-triggered evidence rows from cadence-triggered ones.
SYSTEM_ACTOR = {
    "actorId":         "worker:reconciliation_cadence",
    "actorRole":       "system:scheduler",
    "sourceRoute":     "worker:reconciliation_cadence/tick",
    "sourceRequestId": None,
    "operatorReason":  None,
}
