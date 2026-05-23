# Phase 3.4 Retrospective — Runtime Constitution

**Status:** RATIFIED (post-C-3)
**Scope:** Operational supervision layer for polling workers.
**Successor docs:** Phase 4 lifespan rewrite, Redis hardening, structured logging.

This document is the runtime constitution. It locks the doctrinal
decisions that emerged across C-2 (vehicles_refresh) and C-3
(receipts_poll) so that Phase 4+, future supervisor migrations, and the
team's collective memory do not re-litigate settled choices.

If you are about to write a new supervised worker, read sections 6 and 7
first. The rest is the *why*.

---

## 1. Why the tick model won

The original pattern across PR-01..PR-05 was:

```python
async def some_loop(...):
    while True:
        try:
            await do_one_iteration()
        except Exception:
            logger.warning(...)
        await asyncio.sleep(interval)
```

This pattern is correct in isolation but creates seven distinct
operational deficits when scaled to N workers:

1. **No observable tick boundaries** — `last_tick_started_at`,
   `last_tick_finished_at`, `last_tick_duration_ms` cannot be measured
   from outside the loop.
2. **No restart bookkeeping** — `restart_count` doesn't exist as a
   concept; a worker that survives 1000 silent restarts is
   indistinguishable from one that has never failed.
3. **No bounded shutdown** — cancellation depends on `asyncio.sleep`
   being the await point. If the iteration body is mid-DB-call, the
   cancellation latency is unbounded.
4. **No active-instance invariant** — nothing prevents the same loop
   from being registered twice (e.g., during a hot reload race or a
   careless lifespan refactor).
5. **No exhaustion state** — a worker that fails every tick keeps
   logging warnings forever; there is no terminal failed state to
   observe.
6. **Lifecycle log lines are *internal* to the worker** — startup,
   cancel, and error messages cannot be reordered or supplemented
   without touching every worker file.
7. **N copies of the same while-loop scaffolding** — every new worker
   reintroduces the same plumbing. This is the proximate trigger for
   accidental drift (PR-01 vs PR-02 vs PR-05 each had subtly different
   try/except shapes).

The **tick model** splits these concerns:

- The worker owns *one tick*: a coroutine with no while-loop, no sleep,
  no restart logic. Just "do the thing once".
- The supervisor owns the *envelope*: while-loop, sleep, restart,
  backoff, telemetry, cancellation, invariants.

This is the *foundational* architectural decision. Everything else in
this document is a consequence of it.

**Doctrine:** Polling workers in this codebase MUST expose a single-tick
coroutine. The while-loop is owned by the supervisor.

---

## 2. Why the supervisor is explicit

The temptation when writing supervision infrastructure is to make it a
framework:

- `@supervised_worker(name="x", interval=60)` decorator
- `WorkerBase` abstract class with `on_tick()` / `on_error()` hooks
- `discover_workers()` that scans `app.workers.*` and auto-registers
- A plugin registry that workers attach to via setuptools entry points
- A metaclass that intercepts subclassing
- A YAML config that specifies the wiring

Every one of these was REJECTED in C-2/C-3.

Reasons:

1. **Audit visibility.** When you grep `supervisor.register(`, you see
   exactly what runs at startup. With auto-discovery you have to *guess*.
2. **Rollback clarity.** When a worker misbehaves, the fix is to delete
   one explicit `register()` call. With decorators, you have to delete
   the decorator AND understand the import order that made it fire.
3. **Doctrine isolation.** Each worker preserves its *own* logger name,
   its *own* log wording, its *own* lifecycle quirks. A framework
   inevitably homogenises these "for consistency", erasing signal.
4. **Surface stability.** The supervisor has 8 public methods + 2
   dataclasses. Adding a 9th method is a deliberate act. A framework
   has no such bound.
5. **Test surface.** The pytest suite at
   `backend/tests/test_worker_supervisor.py` covers every public
   method with a runtime invariant test. A framework's behaviour
   depends on import order, decorator timing, metaclass mixin order
   — orders of magnitude more test combinations.

**Doctrine:** No decorators, DI, auto-discovery, plugins, metaclasses,
dynamic registries, YAML configs. The supervisor surface is
`register(spec)` / `start(name)` / `stop(name)` / `stop_all()` /
`status(name?)` / `is_running(name)` / `get_task(name)` / `registered(name)`.
Any future addition needs an ADR.

---

## 3. Archetype taxonomy (operational maturity ladder)

Workers in this codebase live at one of three maturity layers. The
ladder is *evolutionary*, not hierarchical: each layer captures a
fundamentally different ownership semantics.

| Layer | Marker | Meaning | Examples |
|-------|--------|---------|----------|
| L1: Move-only extracted | own module under `app.workers.*`, raw `asyncio.create_task` in lifespan | structural separation only — runtime semantics unchanged from pre-extraction | (none remaining after C-3) |
| L2: Registry-attached | own `register(app)` hook, raw `asyncio.create_task` inside the hook | startup ownership consolidated, but task is still unsupervised | `exposures_stats`, `demand_prediction`, `provider_ranking` |
| L3: Supervised | registered with `worker_supervisor` via `WorkerSpec` | operational ownership — restart, cancel, telemetry, invariants are runtime-enforced | `vehicles_refresh` (C-2), `receipts_poll` (C-3) |

The ladder is one-directional. Workers go up, never down. A migration
from L2 → L3 is a checkpointed promotion (see §6).

**Doctrine:** Do NOT skip ladder rungs. A worker that needs both
structural extraction AND operational supervision must land at L2 first
(move-only) and be promoted to L3 in a separate PR. This preserves
rollback clarity AND lets the team observe the worker at each maturity
level before adding the next constraint.

---

## 4. Migration recipe (L2 → L3)

This is the recipe used in C-2 and C-3. Use it verbatim for the next
migration.

### Prerequisites
- Worker is at L2 (own module, own `register(app)` hook).
- Worker exposes a single-tick coroutine (or a function that does *one*
  iteration; the while-loop is the part being deleted).
- No external caller imports the legacy loop symbol (`grep -rn` the
  entire codebase).
- `test_worker_supervisor.py` is GREEN.

### Steps
1. **Split the loop body**: rewrite `worker_loop()` into:
   - `worker_tick()` — one iteration, no while, no sleep
   - `emit_startup_log()` — one-time startup wording (preserved verbatim)
   - `emit_cancel_log()` — graceful-cancel wording, *only if the original
     loop emitted one inside `except asyncio.CancelledError`*
2. **Rewrite `register(app)`** to call `supervisor.register(WorkerSpec(...))`
   then `supervisor.start(name)`. Capture any per-worker resources (e.g.
   `db`) in a closure for the `tick` callable.
3. **Preserve compat attributes**: `app.state.X_task = supervisor.get_task(name)`.
4. **Delete the legacy loop symbol** from the worker module AND from any
   `__init__.py` / compat shim re-export list. If a grep reveals a
   caller, STOP — that caller must be rewritten first (separate PR).
5. **Update `__init__.py` re-exports** to remove the legacy loop symbol
   and add `emit_startup_log`, `emit_cancel_log`.
6. **Run** `pytest backend/tests/test_worker_supervisor.py -v` to lock
   the supervisor surface.
7. **Restart backend** and verify in `/var/log/supervisor/backend.err.log`:
   - `worker_supervisor: registered worker={name} interval={X}s policy={Y} max_restarts={Z}`
   - lifespan-side wrapping log line (preserved verbatim)
   - worker-side startup log line (now via `on_start`)
   - on `supervisorctl restart`: `stop_all begin → cancel hook line → stopped worker={name} cancel_latency_ms<200 → stop_all complete`.
8. **Run OpenAPI freeze check**: endpoint count unchanged.
9. **Run lint**: `mcp_lint_python` on supervisor + worker module.
10. **Update `PHASE_3_4_*.md`** retrospective with the new worker.

### Anti-steps
- Do NOT introduce new decorators or base classes.
- Do NOT change `restart_policy` / `max_restarts` / `backoff_seconds`
  away from the defaults unless the worker's failure model is
  documented and reviewed.
- Do NOT migrate the worker's `on_start` log wording — preservation is
  the entire point of the `on_start` hook.

---

## 5. Rollback doctrine

Every supervisor migration is single-PR-reversible.

To roll back a supervised worker to L2 (move-only):

1. Revert `app/workers/{worker}/registry.py` to the move-only template
   (raw `asyncio.create_task(...)`).
2. Restore the legacy loop function (`worker_loop`) in
   `app/workers/{worker}/loop.py` — pull the while+sleep envelope back
   into the worker. `git show <pre-supervisor-commit>:path` is the
   source of truth.
3. Restore `worker_loop` re-export in `__init__.py` and any compat shim.
4. Restart backend; verify the legacy log lines fire in the original
   order.

There is NO migration data, NO schema change, NO storage migration.
Rollback is a code revert only.

**Doctrine:** A supervisor migration that requires a *data* rollback is
out of scope. The supervisor never owns persistent state.

---

## 6. Telemetry minimum viable surface

The telemetry below is the locked surface. Adding a field is a
deliberate act; removing a field is a breaking change.

| Field | Type | Semantics |
|-------|------|-----------|
| `worker_name` | str | Stable identity. Matches the `name` argument to `register()`. |
| `state` | enum | `pending` → `starting` → `running` → (`stopping` →) `stopped` OR `failed` OR `exhausted`. Monotonic per lifecycle. |
| `restart_count` | int | Number of restarts *attempted* (not successful restarts). Capped by `max_restarts`. |
| `started_at` | iso8601 | First `start()` time. Persists across restarts within one process lifetime. |
| `last_tick_started_at` | iso8601\|null | Most recent tick entry. |
| `last_tick_finished_at` | iso8601\|null | Most recent tick exit (success OR failure). |
| `last_tick_duration_ms` | float\|null | `last_tick_finished_at − last_tick_started_at`. |
| `last_error` | str\|null | Most recent exception, `{type}: {message}`. Stays populated after the next successful tick. |
| `last_error_at` | iso8601\|null | When `last_error` was recorded. |
| `active_instances` | int | Always `0` or `1`. Enforced invariant. |

**Not in surface (deferred):**
- Prometheus exposition format → Phase 4+, when admin endpoint lands
- Per-tick histogram → only if/when a worker has variable tick cost
- Tracing IDs → only when distributed tracing lands across the codebase
- Mean/p95/p99 — supervisor stays per-tick, not aggregate

**Doctrine:** Telemetry stays in-memory until a third supervised worker
OR a debugging incident requires exporting it. At that point an admin
endpoint `GET /api/admin/workers` lands as a separate PR. OpenAPI
freeze is enforced at 571 endpoints until that point.

---

## 7. Shutdown doctrine

Graceful shutdown is **bounded**, **deterministic**, and **observable**.

The contract:

1. Lifespan-side calls `await supervisor.stop_all(timeout=5.0)` BEFORE
   the generic `shutdown_cleanup()`. Order matters: workers stop first,
   process resources second.
2. `stop_all` invokes `stop(name, timeout=5.0)` for each registered
   worker in parallel via `asyncio.gather`.
3. `stop(name)` issues `task.cancel()`, then `asyncio.wait_for(... ,
   timeout)`. If the worker exits within the timeout, log:
   `worker_supervisor: stopped worker={name} cancel_latency_ms={X}`.
   If it doesn't, log:
   `worker_supervisor: worker={name} did not exit within {timeout}s — task.done={X} (pending-task warning)`.
4. The `on_cancel` hook (if any) fires inside the supervisor's
   `CancelledError` handler BEFORE the state transitions to `stopped`.
   This is how worker-specific cancel log lines (like
   `cnotify receipts loop cancelled`) are preserved verbatim.
5. After `stop`, `_tasks` no longer holds the task; `active_instances`
   is back to 0; `state == "stopped"`.

Verified behaviour on the live process (C-2 + C-3):

```
worker_supervisor: stop_all begin (workers=2 timeout=5.0s)
cnotify receipts loop cancelled                              ← on_cancel
worker_supervisor: stopped worker=vehicles_refresh cancel_latency_ms=0.1
worker_supervisor: stopped worker=receipts_poll cancel_latency_ms=0.1
worker_supervisor: stop_all complete
```

Real cancel latency is sub-millisecond on the current workers (both
exit at `await asyncio.sleep(interval_seconds)`, which propagates
`CancelledError` immediately).

**Doctrine:** Workers MUST cooperate with cancellation. A tick body
that holds a non-cancellable resource (e.g., a synchronous DB call
without a timeout) violates the shutdown contract and must be
refactored before promotion to L3.

---

## 8. Operational invariants

The supervisor enforces these at runtime. They are not aspirational —
each one is locked by a pytest case in `test_worker_supervisor.py`.

| # | Invariant | Enforcement | Test |
|---|-----------|-------------|------|
| 1 | `active_instances <= 1` per worker | `start()` raises `RuntimeError` on double-start; flipped to 1 synchronously inside `start()` so post-start probes observe it | `test_double_start_violates_active_instances_invariant`, `test_start_observes_active_instances_eq_1_synchronously` |
| 2 | `duplicate register(name) → hard error` | `register()` raises `ValueError` if `name` already in spec table | `test_duplicate_register_is_hard_error` |
| 3 | `start(unregistered) → hard error` | `start()` raises `ValueError` if name not in spec table | `test_start_unregistered_raises` |
| 4 | `restart_count <= max_restarts` | supervisor exits `_run()` with `state="exhausted"` once the cap is hit | `test_on_failure_restart_bounded_by_max_restarts` |
| 5 | `restart_policy=never` → no restart attempt | supervisor exits `_run()` with `state="failed"` on first error | `test_never_policy_fails_on_first_error` |
| 6 | Graceful cancel within timeout | `stop()` uses `asyncio.wait_for` with bounded timeout; no pending-task leak | `test_graceful_stop_cancels_within_timeout_no_pending` |
| 7 | `on_cancel` hook fires once before state=stopped | supervisor calls `spec.on_cancel()` inside `CancelledError` handler before re-raise | `test_on_cancel_hook_fires_before_stopped_state` |
| 8 | `on_start` hook fires once before first tick | supervisor calls `spec.on_start()` after `state=running` is set, before entering tick loop | `test_on_start_hook_fires_once_before_first_tick` |
| 9 | Restart after stop is permitted | `start()` succeeds after `stop()` (idempotent lifecycle) | `test_restart_after_stop_is_permitted` |
| 10 | `stop_all` with zero workers is a no-op | early return when `_tasks` is empty | `test_stop_all_handles_zero_workers_cleanly` |
| 11 | `status()` lists all registered workers | aggregate accessor returns one row per spec | `test_status_aggregate_lists_all_registered_workers` |
| 12 | Telemetry populated on success | `last_tick_*` and `last_tick_duration_ms` set on every tick exit | `test_happy_path_runs_ticks_and_populates_telemetry` |

**Doctrine:** A change to any of these invariants requires the
corresponding pytest case to be updated in the same PR. New invariants
require a new pytest case AND an entry in this table.

---

## 9. The `restart_policy="always"` semantic

Currently `"always"` is a *reserved* value with identical behaviour to
`"on_failure"` for steady-state polling workers.

Rationale for keeping the value live:

- Phase 4 may introduce a forced-restart trigger (e.g., schema migration
  signal, config reload) that needs a worker to restart on success,
  not just failure.
- Removing the value from the enum is a breaking change; reserving it
  is free.
- Adding behavioural divergence now (without a real consumer) would
  speculatively add complexity.

**Doctrine:** `"always"` remains in the `RestartPolicy` enum but with
no behavioural divergence from `"on_failure"`. The first concrete use
case promotes it.

---

## 10. Open questions (deferred, not yet decided)

These remain open after C-3 and will be revisited as evidence arrives.

| # | Question | Trigger to decide |
|---|---------|-------------------|
| Q1 | Should the L2 wrappers (`exposures_stats`, `demand_prediction`, `provider_ranking`) be migrated to L3? | When ONE of them needs telemetry, restart-policy, OR has a debugging incident. NOT speculatively. |
| Q2 | Admin endpoint `/api/admin/workers/status`? | Threshold: 3 supervised workers OR first operational debugging incident. Hard freeze on OpenAPI until then. |
| Q3 | Should `on_start` / `on_cancel` be split into structured event hooks (`on_state_change(prev, next)`)? | When a worker needs more than two lifecycle hooks. So far: 0 such workers. |
| Q4 | Multi-process orchestration (e.g., one worker per CPU)? | Out of scope for the current uvicorn `--reload` deployment. Phase 4+ when single-process saturation is observed. |

---

## 11. Files of record

| Path | Role |
|------|------|
| `app/core/worker_supervisor.py` | Supervisor singleton + `WorkerSpec` / `WorkerStatus` dataclasses. Constitutional surface. |
| `app/core/lifespan.py` | The only caller of `supervisor.start()` and `supervisor.stop_all()`. |
| `app/workers/{name}/loop.py` | The single-tick coroutine + `emit_startup_log` + (optionally) `emit_cancel_log`. |
| `app/workers/{name}/registry.py` | The `register(app)` hook that calls `supervisor.register(WorkerSpec(...))` + `supervisor.start(name)`. |
| `app/workers/{name}/contracts.py` | Cadence + provider constants. Lazy-loaded, never global state. |
| `backend/tests/test_worker_supervisor.py` | The locked invariant suite. 13 tests. CI gate. |
| `memory/PHASE_3_4_C2_SUPERVISED_VEHICLES_REFRESH.md` | C-2 (first supervised worker) audit + acceptance evidence. |
| `memory/PHASE_3_4_RETROSPECTIVE.md` | (this file) |

---

## 12. Pre-Phase-4 checklist

Before opening Phase 4 (lifespan rewrite, Redis hardening, structured
logging), verify:

- [x] `worker_supervisor` surface is locked (no API additions since C-3)
- [x] `test_worker_supervisor.py` is green and covers all 12 invariants
- [x] Both supervised workers (`vehicles_refresh`, `receipts_poll`) restart cleanly across `supervisorctl restart backend`
- [x] OpenAPI endpoint count = 571 (no admin churn)
- [x] All L2 wrappers (`exposures_stats`, `demand_prediction`, `provider_ranking`) still start via their `register()` hooks; no regression
- [x] Compat attributes `app.state.refresh_task` and `app.state.cnotify_receipts_task` still resolve to live tasks
- [x] Doctrinal decisions in §2 (no decorators / DI / auto-discovery / plugins / metaclasses / dynamic registries) hold

Phase 4 may proceed.
