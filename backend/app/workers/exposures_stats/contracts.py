"""app.workers.exposures_stats.contracts — cadence constant.

PR-02 (Phase 3D) move-only extraction. The numeric value (300s)
matches the literal `interval_s: int = 300` default at the previous
location (`exposures_cron.py:142`) AND the literal `300` passed at the
previous registration site (`lifespan.py:279`). No retuning.
"""
from __future__ import annotations

# ── Worker loop cadence
# Previously hard-coded at the lifespan call site as
# `stats_recompute_loop(300)`. Move-only: same numeric value lifted
# to a named constant so the registry hook can reference it without
# changing call semantics. Integer-typed (matches previous signature).
DEFAULT_INTERVAL_S: int = 300
