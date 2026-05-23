# Phase 3.4 C-2 — First true supervised polling worker rollout

**Date:** 2026-02 · **Worker:** `vehicles_refresh` (a.k.a. `_watchlist_live_poll_loop`)
**Status:** ✅ CLOSED

---

## What shipped

### New module
`app/core/worker_supervisor.py` (~270 LOC, no deps beyond stdlib + asyncio)

Explicit runtime supervision layer. Anti-scope: NO decorators, NO DI,
NO auto-discovery, NO plugins, NO metaclasses, NO dynamic registries.
Surface limited to:

```
WorkerSpec(name, tick, interval_seconds, restart_policy, max_restarts,
           backoff_seconds, on_start)
WorkerStatus(...)
WorkerSupervisor:
    register(spec)            # ValueError on duplicate
    start(name)               # RuntimeError if active_instances >= 1
    stop(name, timeout)       # bounded; pending-task warning on timeout
    stop_all(timeout)
    status(name?)             # in-memory only, no admin endpoint
    is_running(name)
    get_task(name)            # compat handle
    registered(name)
```

Module-level singleton: `supervisor`.

### Migration
- `app/workers/vehicles_refresh/loop.py` — `refresh_loop` (while+sleep envelope)
  removed; replaced by `vehicles_refresh_tick` (one batch scan) +
  `emit_startup_log` (called by supervisor before first tick).
- `app/workers/vehicles_refresh/registry.py` — promoted from Archetype A
  move-only wrapper (`asyncio.create_task(refresh_loop())`) to
  supervisor-driven `register(WorkerSpec(...))` + `start()`. `app.state.refresh_task`
  attribute preserved for compat (now read-only handle to supervisor task).
- `app/core/lifespan.py` — legacy block (lines 198-206) replaced; added
  `await supervisor.stop_all(timeout=5.0)` in shutdown phase BEFORE
  `shutdown_cleanup`.
- `app/vehicles/refresh.py` — dead `refresh_loop` (lines 375-402) removed.
- `app/workers/vehicles_refresh/__init__.py` — re-exports updated.

---

## Acceptance criteria — verification

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | watchlist loop managed ONLY by worker_supervisor | ✅ | `grep -rn "asyncio.create_task.*refresh_loop"` → zero hits |
| 2 | no legacy `asyncio.create_task` path remains active | ✅ | `refresh_loop` symbol fully removed from `vehicles/refresh.py` and `workers/vehicles_refresh/loop.py`; only `vehicles_refresh_tick` exists |
| 3 | polling cadence preserved | ✅ | `interval_seconds=REFRESH_TICK_SECONDS` (60s) passed to spec; supervisor sleeps `interval_seconds` after success |
| 4 | external API behavior preserved | ✅ | `refresh_vehicle()` unchanged; `parse_listing()` path untouched |
| 5 | cancellation clean (no pending task warnings) | ✅ | shutdown logs: `stop_all begin → stopped worker=vehicles_refresh cancel_latency_ms=0.0 → stop_all complete` |
| 6 | restart_policy verified | ✅ | synthetic test `restart_policy=on_failure, max_restarts=2` → exhausted after 2 restarts (see `/tmp/test_supervisor.py` results) |
| 7 | max_restarts enforced | ✅ | unit test: `bad_restart_count_eq_max` → restart_count==2, state==exhausted |
| 8 | OpenAPI unchanged | ✅ | 571 endpoints before and after |
| 9 | startup/shutdown logs preserved | ✅ | three startup lines in correct order:<br>`worker_supervisor: registered worker=vehicles_refresh interval=60.0s policy=on_failure max_restarts=5`<br>`VMS: refresh worker started (temporal evolution)`<br>`vehicle refresh loop started (tick=60s, batch=5)` |
| 10 | active_instances == 1 invariant visible | ✅ | enforced by start() (RuntimeError on double-start); visible via `supervisor.status("vehicles_refresh")["active_instances"]` |

### Telemetry available (in-memory only)
```python
supervisor.status("vehicles_refresh") → {
    "worker_name": "vehicles_refresh",
    "state": "running",
    "restart_count": 0,
    "started_at": "2026-05-18T12:15:08.xxx+00:00",
    "last_tick_started_at": ...,
    "last_tick_finished_at": ...,
    "last_tick_duration_ms": ...,
    "last_error": null,
    "last_error_at": null,
    "active_instances": 1,
}
```

### Unit verification (18/18 PASS)
Synthetic supervisor harness (`/tmp/test_supervisor.py`):
1. `duplicate_register_hard_error` ✅
2. `start_unregistered_raises` ✅
3-7. happy-path telemetry: state=running, active=1, last_tick_finished, duration_ms>0, tick actually ran ✅
8. `active_instances_invariant_enforced` (double-start raises) ✅
9-12. restart_policy=on_failure, max_restarts=2 → state=exhausted, restart_count==2, active=0, error recorded ✅
13-14. restart_policy=never → state=failed, restart_count==0 ✅
15-17. graceful shutdown: state=stopped, active=0, cancel_latency_ms<1ms ✅
18. restart_after_stop_ok (start after stop succeeds) ✅

---

## Doctrinal decisions (recorded)

1. **Location**: `app/core/worker_supervisor.py`, NOT `app/workers/_supervisor.py`.
   Rationale: runtime infrastructure, not a domain worker.

2. **Rollout scope**: only `vehicles_refresh` migrated. The Archetype A
   wrappers for `receipts_poll`, `exposures_stats`, `demand_prediction`,
   `provider_ranking` remain move-only (raw `asyncio.create_task`).
   Rollback clarity preserved.

3. **No admin endpoint**: visibility deferred. Currently: structured logs
   on state transitions + in-memory `status()` only. No OpenAPI churn
   (571 → 571).

4. **No generic framework**: no decorators, DI, auto-discovery, plugins,
   metaclasses, dynamic registries. Surface stays at register/start/stop/
   status.

5. **Three restart policies** (`never` / `on_failure` / `always`) with bounded
   fixed backoff. No exponential sophistication yet. `always` is currently
   identical to `on_failure` for steady-state polling (no forced
   crash-loop semantics).

6. **active_instances == 1 invariant is ENFORCED**, not logged:
   `start()` raises `RuntimeError` if `active_instances >= 1`.
   Synchronously set to 1 in `start()` so probes immediately after `start()`
   observe the invariant.

7. **Graceful shutdown contract**: `stop()` cancels task → `wait_for` with
   bounded timeout → warning log if timeout exceeded (pending-task) →
   `state=stopped`, `active_instances=0`, `_tasks` entry removed.
   Verified on real polling worker via `supervisorctl restart`:
   `cancel_latency_ms=0.0` consistently.

8. **vehicles_refresh tick exception semantics preserved**: original
   loop swallowed BOTH per-vehicle AND per-tick exceptions. C-2 preserves
   this — `vehicles_refresh_tick` never propagates. Consequence: this
   particular worker's `restart_policy` lies dormant under normal failure
   modes (DB blip, parse error). Supervisor's restart mechanism is a
   defensive net for truly catastrophic asyncio-level failures only.
   The mechanism itself was verified via synthetic tick (see unit tests).

---

## Retrospective: scaffold vs. long-term runtime layer?

**Verdict: long-term operational runtime layer.**

Rationale:

- The supervisor introduces telemetry semantics (per-tick boundaries,
  restart bookkeeping, cancellation latency) that have no equivalent
  in the raw `asyncio.create_task` pattern. These will be needed by every
  future polling worker that crosses the "operational" threshold (e.g.,
  payments dispatch, ops_guardian, transfer_detector, resolver).

- The enforced `active_instances <= 1` and duplicate-register hard errors
  are runtime invariants, not scaffolding niceties. Removing the
  supervisor would re-open both defects.

- Bounded graceful shutdown is now demonstrably better than
  interpreter-teardown cancellation: zero pending-task warnings on real
  polling worker, deterministic state transitions in logs.

- The surface is intentionally narrow (8 public methods + 2 dataclasses).
  No generic-framework bloat. Adding more workers is N×constant cost, not
  N×N.

**Open questions for the post-C-2 retrospective with the team:**

1. When (not if) we extend to a SECOND supervised worker, do we migrate
   one of the existing Archetype A wrappers (receipts_poll has the most
   adjacent telemetry need given its 180s cadence + provider-receipt
   semantics) or attach a brand-new worker (e.g., a watchlist-fanout
   reconciler that is currently NOT in the codebase)?

2. The `restart_policy="always"` is currently a semantic no-op for
   steady-state polling. Either we drop it from the public surface or we
   add forced-restart-on-success semantics. Decision deferred until the
   second supervised worker reveals the need (or doesn't).

3. Admin visibility surface — when? Trigger: third supervised worker,
   OR first time someone needs to inspect supervisor state from outside
   the process. Until then, structured logs + in-memory `status()` are
   sufficient.

4. Should the synthetic test harness (`/tmp/test_supervisor.py`) move
   to `backend/tests/test_worker_supervisor.py` as a pytest module?
   Recommended: yes, for the SECOND supervised worker rollout — the
   harness will catch regressions in supervisor semantics. C-2 itself
   doesn't need it (verification already happened).

---

## Files touched

| File | Change |
|------|--------|
| `app/core/worker_supervisor.py` | **NEW** (~270 LOC) |
| `app/core/lifespan.py` | legacy block (9 LOC) → register hook (3 LOC); shutdown phase adds `supervisor.stop_all()` (5 LOC) |
| `app/workers/vehicles_refresh/loop.py` | `refresh_loop` (while+sleep) → `vehicles_refresh_tick` (one batch) + `emit_startup_log`; dead-shim removed |
| `app/workers/vehicles_refresh/registry.py` | raw `create_task` → `supervisor.register + start`; `registered()` idempotent guard for hot reload |
| `app/workers/vehicles_refresh/__init__.py` | re-exports updated |
| `app/vehicles/refresh.py` | dead `refresh_loop` (28 LOC) removed |

Net LOC delta: +270 (supervisor) − 28 (dead refresh_loop) − 28 (dead shim) − 7 (legacy lifespan) + ~80 (split tick/startup + telemetry doc) ≈ **+287 LOC**.

---

## Next checkpoints (not in C-2 scope, queued)

- Redis bring-up (rate-limit/idempotency) — independent of supervisor
- C-3: SECOND supervised worker rollout (candidate: receipts_poll OR new watchlist-reconciler)
- Phase 4 — TBD after the C-3 retrospective
