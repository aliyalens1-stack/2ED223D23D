# `app.workers.demand_prediction` — Ownership Boundary

**Phase 3D PR-03 · Tier A carve-out · runner-coupled move-only extraction**

Source of truth before extraction: `app/orchestrator/runner.py:42-56` (inner closure)
Source of truth after extraction:   `app/workers/demand_prediction/loop.py:demand_prediction_loop`

This package owns exactly one worker: the Sprint 19+20 ML retrain
loop for `DemandPredictor`.

---

## Ownership Table

| Field | Value |
|-------|-------|
| **Worker** | `demand_prediction_loop` (was inner closure `_demand_prediction_loop`) |
| **Tier** | A (3C §9 Tier A row 3 — overwrite-by-construction on `ml_models`) |
| **Reads** | `zone_snapshots` (via `DemandPredictor.train_all_zones`) — observational |
| **Writes** | `ml_models` collection (upsert per zone via `DemandPredictor.persist`) — **overwrite-only** |
| **Produces** | Per-zone trained demand models + metadata (residualStd, trainedAt, sampleCount, etc.) cached in `DemandPredictor.models` / `.metadata` class dicts |
| **Consumed by** | `DemandPredictor.predict` / `predict_with_interval` — called by orchestrator engine, ranking optimizer, admin forecast surface (`app/admin/forecast.py`) |
| **Idempotency anchor** | **Overwrite-by-construction.** Each train cycle fully retrains from `zone_snapshots`; concurrent or replayed cycles converge. No claim-token, no dedupe_bucket. |
| **Cadence** | `DemandPredictor.TRAIN_INTERVAL_S` class attribute (currently 300s). **Read at runtime** — NOT hardcoded as a module constant, because admin forecast surface introspects the class attribute (`app/admin/forecast.py:55`) and a contracts.py copy would drift. |
| **Startup site** | `app/orchestrator/runner.py:start_all_loops()` — lifespan stage 7 (`init_db → load_ml_models → bootstrap_side_effects → start_all_loops`). Runner manages the task list for C15.1 shutdown cancellation. |
| **Shutdown semantics** | Task returned by `register()` and appended to `runner.start_all_loops()`'s `tasks: List[asyncio.Task]`. On process exit, Python interpreter shutdown cancels the task. Mid-train cancellation is safe because `DemandPredictor.train_all_zones` writes per-zone and partial completion leaves `ml_models` in a consistent (mix-of-fresh-and-stale) state — next cycle fully retrains. |
| **Restart guarantee** | Next-tick recovery. A partial retrain leaves `ml_models` partially fresh; next cycle (after 30s warm-up + 300s sleep) fully retrains all zones. |
| **Realtime emit** | none |
| **Redis touch** | none |
| **Metrics touch** | none |
| **External I/O** | none (Mongo-only — `ml_models`, `zone_snapshots`) |
| **OpenAPI surface** | none touched |

---

## Coupling rationale — runner vs lifespan

The registration site is `app.orchestrator.runner.start_all_loops`,
**not** lifespan directly. This is a deliberate preservation of the
Sprint 21 C15.1 doctrine: "one entry point for all background tasks".
Migrating registration to lifespan would split the runner.

Consequence: the `register()` hook in this package has a different
signature from PR-01 / PR-02:

| PR | Signature | Reason |
|----|-----------|--------|
| PR-01 receipts_poll | `register(app) -> None` | lifespan-coupled; task stored at `app.state.cnotify_receipts_task` |
| PR-02 exposures_stats | `register(app) -> None` | lifespan-coupled; task stored at `app.state.exposures_stats_task` |
| **PR-03 demand_prediction** | **`register() -> asyncio.Task`** | runner-coupled; runner owns the task list |

This divergence is **structural, not preferential**. The two
signatures will continue to co-exist. Per user direction at the
PR-03 kick-off (2026-02-17): "copy structure first, abstract later
if repetition survives contact with reality." No base class will be
introduced until at least PR-05 has shipped and we can observe
whether the runner-coupled pattern repeats (PR-04 provider_ranking
will tell us).

---

## Lazy import preservation (Vector 6)

The `from app.ml.predictor import DemandPredictor` import remains
INSIDE the loop body (`loop.py`'s `demand_prediction_loop`), not at
module top. Rationale (preserved from original `runner.py:28-30`
doctrine):

> "Lazy import: все эти модули тянут за собой DB / ml, которые уже
> готовы к моменту вызова. Импортируем здесь, а не на module-top —
> чтобы `app.orchestrator.runner` оставался лёгким и не грузил БД
> при импорте."

After extraction, `runner.start_all_loops` lazy-imports
`app.workers.demand_prediction.register`, which in turn lazy-imports
the loop function from `loop.py`. The `loop.py` module itself imports
`DemandPredictor` only when `demand_prediction_loop` is first
invoked (post-`load_ml_models`). Two levels of indirection now sit
between runner module-load and ml/predictor import — the original
invariant ("module-load triggers no DB/ml") is preserved.

---

## Lifecycle dependency (Vector 7)

| Stage | Action | Required for this worker |
|-------|--------|--------------------------|
| 1. lifespan stage 1 | `init_db()` | DB available for `train_all_zones` Mongo reads |
| 2. lifespan stage 2 | `load_ml_models()` → `DemandPredictor.load_persisted()` | Warms class-level `models`/`metadata` dicts. **Strict precondition.** If skipped, first `predict` calls return defaults until first train completes (acceptable degraded mode). |
| 3. lifespan stage 7 | `start_all_loops()` → `register()` | Task created. |
| 4. Worker tick 0 | `await asyncio.sleep(30)` | 30s additional warm-up (predates C15.1 — kept for safety) |
| 5. Worker tick 1+ | `DemandPredictor.train_all_zones()` then `await asyncio.sleep(TRAIN_INTERVAL_S)` | Steady state |

---

## Single writer owner

`demand_prediction_loop` is the sole writer to `ml_models`. Cross-
checked against PHASE_3C_WORKER_REGISTRY_AND_GLOBALS.md §2 row 3 and
§9 Tier A row 3.

## Hard invariants (do not regress)

1. **Overwrite-only writes** — `DemandPredictor.persist` upserts per zone; no incremental delta logic.
2. **Cadence from class attribute** — `DemandPredictor.TRAIN_INTERVAL_S` (not a local constant).
3. **30s warm-up sleep** — preserved before first train.
4. **Lazy DemandPredictor import** — must remain inside the loop body.
5. **No realtime, no Redis, no metrics** — observational over Mongo + class-dict cache only.
6. **Logger name = `"server"`** — explicitly preserved (NOT `__name__`-based) for consistency with runner-emitted log lines and any future log-scraping.

## Registration

Registered exactly once at runner startup via:

```python
from app.workers.demand_prediction import register as _register_demand_prediction
tasks.append(_register_demand_prediction())
```

(Called from `app/orchestrator/runner.py:start_all_loops`.)

## Public surface (re-exports from package root)

| Symbol | Purpose |
|--------|---------|
| `demand_prediction_loop()` | Long-running task body |
| `register()` | Runner registration hook; returns `asyncio.Task` |

## Anti-scope (NOT in this package — intentionally)

- ❌ `DemandPredictor` class itself (domain singleton; lives in `app/ml/predictor.py`)
- ❌ `load_ml_models` (lifespan concern, not worker concern)
- ❌ Admin forecast endpoints (handlers; not in scope per Phase 3D P-1)
- ❌ Generic worker base class / abstract registry
- ❌ Cadence override / per-worker config plumbing

## Sibling references

- Domain singleton: `app/ml/predictor.py:DemandPredictor`
- Hydration site: `app/core/lifespan.py:load_ml_models`
- Admin introspection: `app/admin/forecast.py:55` (reads `DemandPredictor.TRAIN_INTERVAL_S`)
- Test surface: `backend/tests/test_c14_ml_guard.py` (tests `DemandPredictor.predict`, NOT the loop)
- Phase 3D contract: `/app/memory/PHASE_3D_EXTRACTION_SEQUENCE.md` §3.2 PR-03

## Discovered couplings (PR-03 pre-check, before move)

| Vector | Finding |
|--------|---------|
| V1 Task list collector | `runner.start_all_loops` owns `List[asyncio.Task]` (used for shutdown). **FORCED signature divergence**. |
| V2 Shared try/except | NO. Each `create_task` is bare. |
| V3 Shared log summary | NO at start-line level (each worker has own log). YES at "{len(tasks)} background loops launched" final summary — preserved by returning the task. |
| V4 Shared imports w/ ordering | YES — intentional. Lazy imports at runner.start_all_loops L28-40. Preserved by 2-level lazy-import chain after extraction. |
| V5 Test assertions on logger/name | NONE. `test_c14_ml_guard.py` tests `DemandPredictor` class surface only. |
| V6 Lazy import reason | YES — preserved by keeping `DemandPredictor` import inside loop body. |
| V7 DemandPredictor singleton lifecycle | YES — preserved (load_ml_models stays in lifespan, 30s warm-up stays, TRAIN_INTERVAL_S read from class attr). |
