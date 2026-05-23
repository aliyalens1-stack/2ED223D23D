# `app.workers.provider_ranking` — Ownership Boundary

**Phase 3D PR-04 · Tier A carve-out · runner-coupled move-only extraction**

Source of truth before extraction: `app/marketplace/quick_request.py:360-380`
Source of truth after extraction:   `app/workers/provider_ranking/loop.py:provider_ranking_optimizer_loop`

This package owns exactly one worker: the Sprint 17 self-learning
ranking weights optimizer.

---

## Ownership Table

| Field | Value |
|-------|-------|
| **Worker** | `provider_ranking_optimizer_loop` |
| **Tier** | A (3C §9 Tier A row 4 — overwrite-by-construction on `provider_ranking_weights`) |
| **Reads** | `offers`, `bookings` (via `_recalculate_ranking_weights → _hydrate_offer_outcomes`) — observational |
| **Writes** | `provider_ranking_weights` (upsert per `(zoneId, problemType)` group) — **overwrite-only** |
| **Produces** | Per-(zone, problemType) refit weights `{distance, rating, response, online, skillFit, surgeMotivation}` with `samples` + `confidence` metadata |
| **Consumed by** | `quick_request.get_ranking_weights(zone_id, problem_type)` → returns "learned" weights when `samples ≥ RANKING_MIN_SAMPLES` AND `confidence ≥ RANKING_MIN_CONFIDENCE`, else falls back to `DEFAULT_RANKING_WEIGHTS`. Read at every `quick_request_resolve` call. |
| **Idempotency anchor** | **Overwrite-by-construction.** Each refit fully recomputes from finalised offers within the cadence window; concurrent or replayed cycles converge. No claim-token, no dedupe_bucket. |
| **Cadence** | `RANKING_OPTIMIZER_INTERVAL_SEC` (300s). **Read at runtime** from `app.marketplace.quick_request` — NOT copied into a local constant, because the same constant feeds `get_ranking_weights` defaults documentation and admin endpoints. A local copy would risk drift. |
| **Startup site** | `app/orchestrator/runner.py:start_all_loops()` — lifespan stage 7. Runner owns the task list. |
| **Shutdown semantics** | Task returned by `register()` and appended to runner's `tasks: List[asyncio.Task]`. The loop body has explicit `asyncio.CancelledError` → `break` handler — clean cancellation, no error log on shutdown. This differs from PR-03 (`demand_prediction`) which lets `CancelledError` propagate. Both behaviours are preserved (PR-02 doctrine: "asymmetry = signal"). |
| **Restart guarantee** | Next-tick recovery. Partial refit leaves `provider_ranking_weights` with a mix of fresh-and-stale rows; consumers (`get_ranking_weights`) handle both via `samples/confidence` thresholds. Next cycle (after 300s) fully refits. |
| **Realtime emit** | none |
| **Redis touch** | none |
| **Metrics touch** | none |
| **External I/O** | none (Mongo-only) |
| **OpenAPI surface** | none touched |

---

## Task ownership (runner-coupled)

The runner's `start_all_loops()` returns `List[asyncio.Task]`. This
worker's `register()` returns its task so the caller can append it.

| Aspect | Value |
|--------|-------|
| Task name | `"provider_ranking_optimizer"` (set on `asyncio.create_task(...)`) |
| Task storage | runner-local `tasks` list — NOT `app.state.X` |
| Task handle reachable by | runner shutdown logic only |
| Task count contribution | exactly 1 (preserves runner's `len(tasks) == 9` summary log) |

## Shutdown collector

| Aspect | Value |
|--------|-------|
| Collector | runner's `tasks: List[asyncio.Task]` |
| Cancellation trigger | Python interpreter shutdown OR explicit `task.cancel()` (no current caller) |
| Cancellation handling | explicit `except asyncio.CancelledError: break` — clean exit, no warning log |
| Pending refit on cancel | dropped silently; next process boot refits within first cycle |
| Drain protocol | none (no current need; `provider_ranking_weights` is overwrite-only, no in-flight writes need draining) |

## Lazy import rationale (Vector 6)

The loop body lazy-imports two symbols from `app.marketplace.quick_request`:
  1. `_recalculate_ranking_weights` — private helper that performs
     the actual refit. Shared with admin endpoint
     `POST /api/admin/ranking/recalculate` (which calls it with
     `force=True`). Underscore prefix preserved per P-2 ("no semantic
     changes"); not renamed to public.
  2. `RANKING_OPTIMIZER_INTERVAL_SEC` — module-level cadence
     constant. Same module also defines `RANKING_MIN_SAMPLES`,
     `RANKING_MIN_CONFIDENCE`, `RANKING_MIN_WEIGHT`,
     `RANKING_MAX_WEIGHT`, `DEFAULT_RANKING_WEIGHTS`,
     `RANKING_FEATURES` — none of which the worker reads, but all
     of which depend on living together with their consumers.

**Why lazy and not top-of-module:**
`quick_request.py` is ~1054 LOC including a FastAPI router with 8
endpoints. Importing it at module top of `loop.py` would force the
entire marketplace surface (FastAPI decorators, route registration,
side-effecting class instantiations) onto the worker module-load
path. The original `runner.py:39` already used lazy import for the
same reason. After extraction, the 2-level lazy chain (runner →
register → loop body) preserves the "module-load triggers nothing
heavy" invariant.

## Single writer owner

`provider_ranking_optimizer_loop` is the sole writer to
`provider_ranking_weights`. Cross-checked against
PHASE_3C_WORKER_REGISTRY_AND_GLOBALS.md §2 row 6 and §9 Tier A row 4.

The admin endpoint `POST /api/admin/ranking/recalculate` (with
`force=True`) ALSO triggers `_recalculate_ranking_weights` — but
that's the SAME function the worker calls. There is no concurrent
write hazard because:
  • Admin recalc and worker tick produce overwrite-equivalent output
  • If they race, last writer wins; both outputs converge to the
    same weights given the same input data.

## Hard invariants (do not regress)

1. **Overwrite-only writes** — full recompute per `(zoneId, problemType)`; no incremental delta.
2. **Cadence from upstream module** — `RANKING_OPTIMIZER_INTERVAL_SEC` lazy-imported from `quick_request` at runtime.
3. **`asyncio.CancelledError` clean break** — preserved (PR-04 behaviour, NOT PR-03 propagation).
4. **Sleep-then-work order** — `await asyncio.sleep(...)` BEFORE first `_recalculate_ranking_weights()` call. No first-tick burst.
5. **Logger = `ctx.logger`** — preserved. NOT `__name__`-based, NOT `"server"` (unlike PR-02/PR-03). The `ctx.logger` capture happens once at loop start; per the original convention used by quick_request handlers.
6. **`_recalculate_ranking_weights` import path** — `from app.marketplace.quick_request import _recalculate_ranking_weights` (underscore prefix preserved).
7. **Conditional log emission** — `if summary["updated"] and logger:` — refit-with-zero-changes is silent. Preserved.
8. **No realtime, no Redis, no metrics** — observational over Mongo only.

## Registration

Registered exactly once at runner startup via:

```python
from app.workers.provider_ranking import register as _register_provider_ranking
tasks.append(_register_provider_ranking())
```

(Called from `app/orchestrator/runner.py:start_all_loops`.)

## Public surface (re-exports from package root)

| Symbol | Purpose |
|--------|---------|
| `provider_ranking_optimizer_loop()` | Long-running task body |
| `register()` | Runner registration hook; returns `asyncio.Task` |

## Anti-scope (NOT in this package — intentionally)

- ❌ `_recalculate_ranking_weights` (domain helper; lives in `quick_request.py`; shared with admin endpoint)
- ❌ `_hydrate_offer_outcomes` (domain helper; called by `_recalculate_ranking_weights`)
- ❌ `_normalize_weights`, `_success_score` (pure helpers used by `get_ranking_weights` and ranker)
- ❌ `get_ranking_weights` (READ-side surface used at every `quick_request_resolve`)
- ❌ `DEFAULT_RANKING_WEIGHTS`, `RANKING_FEATURES`, `RANKING_MIN_*`, `RANKING_MAX_WEIGHT`, `RANKING_OPTIMIZER_INTERVAL_SEC` (module-level scoring constants shared with handlers)
- ❌ Admin handlers `admin_ranking_weights_all`, `admin_ranking_weights_zone`, `admin_ranking_recalculate`
- ❌ Generic worker base class / abstract registry (still copy-structure phase per user direction)

## Sibling references

- Domain helpers and constants: `app/marketplace/quick_request.py:143-380`
- Read-side consumer: `app/marketplace/quick_request.py:get_ranking_weights` (called at line 479 in `quick_request_resolve`)
- Admin manual-trigger: `POST /api/admin/ranking/recalculate` (`quick_request.py:1050`)
- Test surface: `backend/tests/test_quick_request_sprint17.py` (asserts `DEFAULT_RANKING_WEIGHTS` shape, NOT the loop)
- Phase 3D contract: `/app/memory/PHASE_3D_EXTRACTION_SEQUENCE.md` §3.2 PR-04

## Discovered couplings (PR-04 pre-check, before move)

| Vector | Finding |
|--------|---------|
| **V1 Task list collector** | Same as PR-03: runner owns `List[asyncio.Task]`. **Archetype B reuse.** |
| **V2 Shared try/except** | NO. |
| **V3 Shared log summary** | NO at start-line level. Final `"{len(tasks)} background loops launched"` count preserved. |
| **V4 Shared imports w/ ordering** | YES. Runner doctrine + cross-module helper import. 2-level lazy chain preserved. |
| **V5 Test assertions on logger/name** | NONE. `test_quick_request_sprint17.py` tests `DEFAULT_RANKING_WEIGHTS` value only; no log assertion, no loop import. |
| **V6 Lazy import reason** | YES. `quick_request.py` is 1054 LOC including FastAPI router. Lazy import inside loop body essential. |
| **V7 Hidden singleton/cache ownership** | **DEEP CHECK done per user direction:** all `RANKING_*` constants are module-level immutables (not mutable singletons). `_recalculate_ranking_weights` is the only shared helper — lives in `quick_request.py`, NOT extracted. No caches discovered. No strategy tables outside `DEFAULT_RANKING_WEIGHTS`. No implicit ordering assumptions: cadence stands alone (5min), no dependency on demand_prediction's `TRAIN_INTERVAL_S` cycle. |

## Archetype B confirmation (second instance)

This is the SECOND runner-coupled extraction after PR-03
(`demand_prediction`). The two structural similarities:

| Trait | PR-03 demand_prediction | PR-04 provider_ranking | Match? |
|-------|-------------------------|------------------------|--------|
| `register()` signature | `() -> asyncio.Task` | `() -> asyncio.Task` | ✅ |
| Task storage | runner-local list | runner-local list | ✅ |
| Lazy import depth | 2 levels (runner → register → loop body) | 2 levels (runner → register → loop body) | ✅ |
| Heavy upstream module | `app.ml.predictor` (predictor + Mongo) | `app.marketplace.quick_request` (FastAPI router) | ✅ both heavy |
| `contracts.py` present | ❌ (cadence in class attr) | ❌ (cadence in upstream module) | ✅ both rely on upstream-resident cadence |
| Logger name | `"server"` (matches runner) | `ctx.logger` (matches quick_request) | ⚠️ divergent, intentional per-worker preservation |
| `asyncio.CancelledError` handling | propagates | `break` cleanly | ⚠️ divergent, original behaviour preserved |

**Verdict:** Archetype B (runner-owned) confirmed on signature +
task storage + lazy import discipline. Per-worker behavioural
specifics (logger choice, cancel handling) remain divergent
intentionally — they are SIGNAL, not noise. PR-05 will provide
the contrasting Archetype A datapoint.
