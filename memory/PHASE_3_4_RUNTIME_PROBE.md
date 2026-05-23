# Phase 3.4 Runtime Probe — Live supervisor state evidence

**Date:** 2026-05-18 12:34–12:35 UTC
**Process:** uvicorn `server:app --host 0.0.0.0 --port 8001 --reload`, pid in supervisord
**Probe duration:** 70 seconds (snapshots at t=5s and t=70s)
**Outcome:** ✅ ALL acceptance invariants met. Singleton supervisor confirmed alive in production process, telemetry tied to runtime, cadence preserved per worker.

This document is the operational sanity gate of Phase 3.4. It proves that
the supervisor surface defined in `app/core/worker_supervisor.py` and
ratified in `PHASE_3_4_RETROSPECTIVE.md` is not just unit-test theory —
it is the actual runtime in the live uvicorn process.

After this probe was captured, the probe code was **fully removed** from
`app/core/lifespan.py` in the same commit. The supervisor is back to its
locked production surface (no debug-log surface change, OpenAPI=571).

---

## 1. Probe snippet (one-shot lifespan hook, removed after capture)

The probe lived briefly inside `lifespan.py` after
`"C15 lifespan: startup phase complete"`:

```python
import asyncio as _probe_asyncio
import json as _probe_json
from app.core.worker_supervisor import supervisor as _probe_supervisor

async def _runtime_probe() -> None:
    await _probe_asyncio.sleep(5.0)
    snap1 = _probe_supervisor.status()
    logger.info("RUNTIME_PROBE t=5s snapshot=" + _probe_json.dumps(snap1, default=str))
    logger.info(
        "RUNTIME_PROBE t=5s is_running vehicles_refresh="
        f"{_probe_supervisor.is_running('vehicles_refresh')} "
        f"receipts_poll={_probe_supervisor.is_running('receipts_poll')}"
    )
    await _probe_asyncio.sleep(65.0)
    snap2 = _probe_supervisor.status()
    logger.info("RUNTIME_PROBE t=70s snapshot=" + _probe_json.dumps(snap2, default=str))

app.state._runtime_probe_task = _probe_asyncio.create_task(_runtime_probe())
```

The two snapshots were captured in `/var/log/supervisor/backend.err.log`,
extracted via `grep RUNTIME_PROBE`, then the probe code was removed.

**To repeat this probe in the future** (e.g. before Phase 4 sign-off or
after a debugging incident): re-add the snippet, restart backend, wait
80 seconds, grep the log, remove the snippet, restart again. Total
operational cost: ~3 minutes.

---

## 2. Live snapshots (verbatim from backend.err.log)

### Snapshot t=5s (post-registration, after the very first tick of each worker)

```json
[
  {
    "worker_name": "vehicles_refresh",
    "state": "running",
    "restart_count": 0,
    "started_at":            "2026-05-18T12:34:55.979500+00:00",
    "last_tick_started_at":  "2026-05-18T12:34:55.979727+00:00",
    "last_tick_finished_at": "2026-05-18T12:34:55.980572+00:00",
    "last_tick_duration_ms": 0.845,
    "last_error": null,
    "last_error_at": null,
    "active_instances": 1
  },
  {
    "worker_name": "receipts_poll",
    "state": "running",
    "restart_count": 0,
    "started_at":            "2026-05-18T12:34:56.717856+00:00",
    "last_tick_started_at":  "2026-05-18T12:34:56.718593+00:00",
    "last_tick_finished_at": "2026-05-18T12:34:56.719888+00:00",
    "last_tick_duration_ms": 1.295,
    "last_error": null,
    "last_error_at": null,
    "active_instances": 1
  }
]
```

`is_running("vehicles_refresh") == True`
`is_running("receipts_poll") == True`

### Snapshot t=70s (65 seconds later)

```json
[
  {
    "worker_name": "vehicles_refresh",
    "state": "running",
    "restart_count": 0,
    "started_at":            "2026-05-18T12:34:55.979500+00:00",   // ← unchanged (lifecycle stamp)
    "last_tick_started_at":  "2026-05-18T12:35:55.981293+00:00",   // ← ADVANCED ~60s
    "last_tick_finished_at": "2026-05-18T12:35:55.982245+00:00",   // ← ADVANCED ~60s
    "last_tick_duration_ms": 0.952,
    "last_error": null,
    "last_error_at": null,
    "active_instances": 1
  },
  {
    "worker_name": "receipts_poll",
    "state": "running",
    "restart_count": 0,
    "started_at":            "2026-05-18T12:34:56.717856+00:00",   // ← unchanged
    "last_tick_started_at":  "2026-05-18T12:34:56.718593+00:00",   // ← UNCHANGED (interval=180s, only 65s elapsed)
    "last_tick_finished_at": "2026-05-18T12:34:56.719888+00:00",   // ← UNCHANGED
    "last_tick_duration_ms": 1.295,
    "last_error": null,
    "last_error_at": null,
    "active_instances": 1
  }
]
```

---

## 3. Expected invariants — verified

| # | Invariant | Expected | Observed | ✅/❌ |
|---|-----------|----------|----------|------|
| 1 | `len(supervisor.status()) == 2` | 2 workers | 2 | ✅ |
| 2 | `vehicles_refresh.state == "running"` | running | running | ✅ |
| 3 | `receipts_poll.state == "running"` | running | running | ✅ |
| 4 | `active_instances == 1` for both | 1 / 1 | 1 / 1 | ✅ |
| 5 | `restart_count == 0` for both | 0 / 0 | 0 / 0 | ✅ |
| 6 | `last_tick_started_at != None` for both | non-null | populated | ✅ |
| 7 | `last_tick_finished_at != None` for both | non-null | populated | ✅ |
| 8 | `last_tick_duration_ms >= 0` for both | ≥ 0 | 0.845ms / 1.295ms | ✅ |
| 9 | `is_running("vehicles_refresh") == True` | True | True | ✅ |
| 10 | `is_running("receipts_poll") == True` | True | True | ✅ |
| 11 | `vehicles_refresh.last_tick_finished_at` CHANGED between t=5s and t=70s | advanced ~60s | advanced 60.001673s exactly | ✅ |
| 12 | `vehicles_refresh.started_at` UNCHANGED between snapshots | same value | identical to microsecond | ✅ |
| 13 | `receipts_poll.last_tick_finished_at` UNCHANGED at t=70s (interval=180s) | unchanged | identical to microsecond | ✅ |
| 14 | `last_error`/`last_error_at` null for both | null | null | ✅ |

---

## 4. Interpretation guide

This section is the operational decoder for future incidents. Read it
before reaching for `gdb`.

### 4.1 What a healthy snapshot looks like

A healthy supervised worker in steady state shows:

- `state == "running"`
- `active_instances == 1`
- `restart_count` low and not increasing across snapshots
- `last_tick_started_at` and `last_tick_finished_at` ADVANCE between
  snapshots taken ≥ `interval_seconds` apart
- `last_tick_duration_ms` is small relative to `interval_seconds`
  (a long tick relative to interval starves the cadence)
- `last_error` is null OR an old value that hasn't changed (the worker
  recovered)
- `last_error_at` matches `last_error` semantics

### 4.2 What indicates a stuck worker

| Symptom | Interpretation | First diagnostic action |
|---------|---------------|------------------------|
| `last_tick_started_at` advanced, `last_tick_finished_at` did NOT | tick body is hung (mid-await) | check DB / external API health that the tick body uses |
| Both timestamps UNCHANGED across an interval boundary | event loop is starved OR worker task crashed silently | check `state` field; check for `last_error`; check uvicorn process CPU |
| `state == "running"` but `active_instances == 0` | invariant violated, supervisor bug | escalate; pytest `test_status_aggregate_lists_all_registered_workers` should have caught this |
| `state == "failed"` | `restart_policy=never` and a tick raised | check `last_error`; either fix the tick body or change policy |
| `state == "exhausted"` | `restart_count >= max_restarts` | check `last_error`; restart backend after fixing root cause |
| `restart_count` advancing across snapshots | repeated tick failures with backoff | check `last_error`; expect cadence degradation by `backoff_seconds` per restart |
| `last_tick_duration_ms` close to `interval_seconds × 1000` | tick body is slow; effective cadence is degraded | profile the tick body |
| `last_tick_duration_ms` close to `interval_seconds × 1000` AND `state="running"` AND timestamps advancing | worker is barely keeping up but functioning | reduce work per tick OR increase interval |

### 4.3 What this probe does NOT tell you

- Whether the tick body actually performed its intended work (telemetry
  is mechanical — `poll_receipts_once` could be returning empty)
- Whether external dependencies (DB / Expo HTTP) are responsive — the
  worker's specific business logs cover that
- Whether the supervisor's `_run` envelope itself is correct in edge
  cases — `test_worker_supervisor.py` is the source of truth

### 4.4 When to re-run this probe

- Before Phase 4 sign-off
- After any change to `app/core/worker_supervisor.py`
- After promoting a worker from L2 (registry-attached) to L3 (supervised)
- After any debugging incident involving a supervised worker
- Periodically as a smoke test if/when Prometheus exposition is delayed

### 4.5 What to do BEFORE escalating to the supervisor team

1. Re-run this probe (snippet in §1) — confirm whether timestamps move
2. Run `pytest backend/tests/test_worker_supervisor.py -v` — confirm no
   regression in supervisor invariants
3. Run `grep -E "worker_supervisor|VMS: refresh|cnotify receipts" /var/log/supervisor/backend.err.log | tail -30`
4. Check OpenAPI: `curl -s http://localhost:8001/openapi.json | jq '.paths | length'` should be 571
5. Cross-reference the snapshot against §4.2 above

---

## 5. Acceptance signature

```
Phase 3.4 operational layer — ratified.

Evidence:
  • 2 supervised workers live in singleton supervisor (vehicles_refresh, receipts_poll)
  • Tick model proven alive — timestamps advance per cadence
  • Per-worker interval correctness — 60s ≠ 180s observed at t=70s probe
  • active_instances <= 1 invariant holds in live process
  • Telemetry surface (§6 of retrospective) populated end-to-end
  • Graceful shutdown verified across supervisorctl restart cycles
  • Pytest suite (13/13) green on the same surface
  • OpenAPI 571 frozen — no admin surface added

Phase 3.4 contract is stable. Phase 4 may proceed.
```

---

## 6. Files of record (this artifact)

- `memory/PHASE_3_4_C2_SUPERVISED_VEHICLES_REFRESH.md` — C-2 audit
- `memory/PHASE_3_4_RETROSPECTIVE.md` — runtime constitution
- `memory/PHASE_3_4_RUNTIME_PROBE.md` — **this file**, operational evidence
- `backend/tests/test_worker_supervisor.py` — 13-test invariant lock
- `backend/app/core/worker_supervisor.py` — supervisor surface (locked until Phase 4)
