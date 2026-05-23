# `app.workers.exposures_stats` — Ownership Boundary

**Phase 3D PR-02 · Tier A carve-out · move-only extraction**

Source of truth before extraction: `app/auto_requests/exposures_cron.py:142`
Source of truth after extraction:   `app/workers/exposures_stats/loop.py:stats_recompute_loop`

This package owns exactly one worker: the inspector stats recompute
loop (Phase 3 marketplace soft-launch).

---

## Ownership Table

> Phase 3D PR-02 introduces this **explicit ownership table** format
> as the template for all subsequent worker packages. Every field
> below MUST be filled for every extracted worker. No empty rows.

| Field | Value |
|-------|-------|
| **Worker** | `stats_recompute_loop` |
| **Tier** | A (3C §9 Tier A row 2 — zero inter-worker coupling) |
| **Reads** | `inspector_exposures`, `inspection_jobs` (via the delegated `recompute_inspector_stats`) |
| **Writes** | analytics rollup fields on inspector projection (overwrite-only) |
| **Produces** | Cached per-inspector aggregate stats: `ratingAvg`, `jobsCount`, `lastJobAt` (and related computed fields owned by `recompute_inspector_stats`) |
| **Consumed by** | Inspector dashboard read endpoints (admin/inspector cabinet), reputation projection layer. These are READ-ONLY consumers — they never write back to the rollup. |
| **Idempotency anchor** | **Overwrite-by-construction.** Each recompute fully regenerates the projection from `inspector_exposures + inspection_jobs`; concurrent or replayed runs converge to the same output. No claim-token, no dedupe_bucket, no unique index needed. |
| **Cadence** | 300 seconds (`DEFAULT_INTERVAL_S` in `contracts.py`) — same numeric value previously hard-coded at lifespan call site |
| **Startup site** | `app/core/lifespan.py` — Phase 3D PR-02 section, AFTER the B3 cluster (`expire_loop` + `batching_loop`) registration block. Order within lifespan spine: stage 7 (post-bootstrap, post-runner). |
| **Shutdown semantics** | Task stored at `app.state.exposures_stats_task` (attribute name preserved). On process exit, the asyncio task is cancelled by Python's interpreter shutdown; no explicit drain. The current loop body has no rollback obligation — an interrupted `recompute_inspector_stats` call is safe to retry on next boot because the next tick overwrites the projection anyway. |
| **Restart guarantee** | Next-tick recovery. A partial recompute leaves the projection in a possibly-stale-but-consistent state; the next tick (within 300s) fully overwrites it. |
| **Realtime emit** | none |
| **Redis touch** | none |
| **Metrics touch** | none |
| **External I/O** | none (Mongo-only) |
| **OpenAPI surface** | none touched |

---

## Single writer owner

`stats_recompute_loop` is the sole writer to the inspector stats
projection. No other worker, handler, or background task overwrites
the same fields. Cross-checked against PHASE_3C_WORKER_REGISTRY_AND_GLOBALS.md
§2 row 14 and §9 Tier A row 2.

The DELEGATED function `recompute_inspector_stats` lives at
`app/auto_requests/inspector_stats.py`. That function remains in place
(it's a domain helper used by both the worker and ad-hoc admin
endpoints); PR-02 moves only the LOOP that calls it on a cadence.

## Hard invariants (do not regress)

1. **Overwrite-only writes** — the rollup is fully regenerated each tick; no incremental delta logic.
2. **Cadence stability** — 300s tick; do not tune without a separate cadence-change PR.
3. **No realtime, no Redis, no metrics** — this worker is read-overwrite over Mongo only.
4. **Lazy import of `recompute_inspector_stats`** — preserved from the pre-extraction body to avoid module-load-order dependencies during lifespan startup.
5. **Logger name = `"server"`** — explicitly preserved (NOT `__name__`-based) so that the substring assertion `"stats_recompute_loop started" in text` in `tests/test_phase3_marketplace.py:426` continues to match without test modification.

## Registration

Registered exactly once at FastAPI lifespan startup via:

```python
from app.workers.exposures_stats import register as register_exposures_stats
register_exposures_stats(app)
```

The hook stores the task at `app.state.exposures_stats_task` (attribute
name unchanged from pre-extraction).

## Public surface (re-exports from package root)

| Symbol | Purpose |
|--------|---------|
| `stats_recompute_loop(interval_s=300)` | Long-running task body |
| `register(app)` | Lifespan registration hook |
| `DEFAULT_INTERVAL_S` | Read-only cadence reference |

## Anti-scope (NOT in this package — intentionally)

- ❌ Sibling loops `expire_loop` and `batching_loop` (B3 cluster — PR-11)
- ❌ `ensure_exposure_indexes` (index management remains in `exposures_cron.py`; will move with B3 cluster)
- ❌ Feature flag plumbing (`ensure_flags_seed`, `is_enabled`)
- ❌ `recompute_inspector_stats` itself (domain helper, not a worker)
- ❌ Per-inspector stats READ endpoints (handlers; not in scope per Phase 3D P-1)

## Sibling references (post-extraction)

- B3 cluster siblings (current location, future PR-11):
  `app/auto_requests/exposures_cron.py` — `expire_loop`, `batching_loop`, `ensure_exposure_indexes`, `find_jobs_needing_next_wave`, `exposed_inspector_ids`, `batching_once`, `expire_once`
- Delegated domain helper: `app/auto_requests/inspector_stats.py:recompute_inspector_stats`
- Frozen Phase 3 doctrine: `/app/memory/phase_3_1_mobile_parity_closure.md`
- Phase 3D contract: `/app/memory/PHASE_3D_EXTRACTION_SEQUENCE.md` §3.2 PR-02

## Outdated doc-references (NOT fixed in PR-02 per P-2 "no opportunistic cleanup")

The following inline doc-comments still reference
`exposures_cron.stats_recompute_loop` and will be inaccurate after
this PR ships:

- `app/auto_requests/inspector_stats.py:14` — module docstring
- `app/auto_requests/marketplace.py:108` — inline comment

These are free-text references (not imports). No runtime impact. They
will be swept in a follow-up doc-only PR after Tier A is complete.
Tracked here as extraction-friction telemetry.
