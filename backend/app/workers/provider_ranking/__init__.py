"""app.workers.provider_ranking — Sprint 17 self-learning ranking weights.

PR-04 (Phase 3D) move-only extraction. Previously defined as
module-level `provider_ranking_optimizer_loop` at
`app/marketplace/quick_request.py:360-380`.

Archetype B (runner-owned) — confirmed second instance of the
runner-coupled signature first established in PR-03. See ./README.md
"Archetype B confirmation" for the pattern check.

Public surface (re-exports):
  • `provider_ranking_optimizer_loop` — long-running task body
  • `register`                        — runner-side registration hook

Helpers (`_recalculate_ranking_weights`, `_normalize_weights`,
`get_ranking_weights`, etc.) and module-level scoring constants
(`DEFAULT_RANKING_WEIGHTS`, `RANKING_OPTIMIZER_INTERVAL_SEC`, …)
deliberately STAY in `app.marketplace.quick_request` — they are
shared with quick-request handlers and admin endpoints. See
./README.md "Anti-scope" for the full retention list.
"""
from .loop import provider_ranking_optimizer_loop
from .registry import register

__all__ = [
    "provider_ranking_optimizer_loop",
    "register",
]
