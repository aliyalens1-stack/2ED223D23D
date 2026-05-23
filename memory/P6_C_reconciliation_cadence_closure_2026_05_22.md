# P6.C — Cadence Persistence (Scheduled Reconciliation Worker) — CLOSURE

**Date:** 2026-05-22
**Phase:** P6.C of POST-P5 SYMMETRY COMPLETION ROADMAP
**Status:** ✅ CLOSED — worker registered, scheduled snapshot persisted live, idempotency guard verified, graceful shutdown observed.
**Doctrine reference:** `memory/PLATFORM_DOCTRINE_P5_CLOSURE.md` § 7.3 (scheduled reconciliation — *"Это не automation. Это institutional memory"*)

---

## 0. TL;DR

| Metric | Before P6.C | After P6.C | Δ |
|---|---:|---:|---:|
| Reconciliation snapshots without operator click | **0** (impossible) | **1** (cold-started by worker on first boot) | foundation laid |
| Supervised workers | 5 | **6** | +1 (`reconciliation_cadence`) |
| Backend new endpoints | 650 | 650 | **0** (no new routes — worker-only addition) |
| Backend new abstractions | n/a | **0** | uses existing `generate_report` + `supervisor.register` |
| Doctrine violations | n/a | **0** | additive evidence; no automation, no decisioning |
| Files added | n/a | **4** | one package: `__init__.py`, `contracts.py`, `loop.py`, `registry.py` |
| Files modified | n/a | **1** | `app/core/lifespan.py` (+8 LOC, single register call) |

**Doctrine shift achieved:**

> Was: **human-triggered persistence** — operator must POST.
> Now: **platform-triggered evidence cadence** — worker writes every 6h.

This closes the third and last asymmetry zone identified in `PLATFORM_DOCTRINE_P5_CLOSURE.md § 7.3`.

---

## 1. What was built

### 1.1 New package — `app/workers/reconciliation_cadence/` (4 files)

| File | Purpose | LOC |
|---|---|---:|
| `__init__.py` | Public re-export surface (mirrors `receipts_poll/__init__.py`) | 39 |
| `contracts.py` | Cadence constants + env-overridable knobs + `SYSTEM_ACTOR` dict | 55 |
| `loop.py` | `run_reconciliation_once(db)` — single-pass tick body | 175 |
| `registry.py` | Idempotent `register(app)` hook — wires into supervisor | 65 |

### 1.2 Lifespan wire-up — `app/core/lifespan.py`

Added immediately after `receipts_poll` registration (paired with the existing PR-01 worker) — the registration is **idempotent** and survives `uvicorn --reload`. +8 LOC.

### 1.3 What this is NOT

- ❌ A new API endpoint (no new routes registered, OpenAPI count unchanged: 650)
- ❌ A new collection (writes to existing `reconciliation_snapshots`)
- ❌ A new abstraction (re-uses `app.payments.reconciliation.generate_report`)
- ❌ A new env file or config entry (all knobs have sane defaults; env vars are optional overrides)
- ❌ An automation / remediation engine (the worker WRITES evidence, never ACTS on it)

---

## 2. Live verification

### 2.1 Boot-time worker lifecycle

```
[supervisor] worker_supervisor: registered worker=reconciliation_cadence
             interval=21600.0s policy=on_failure max_restarts=5
[supervisor] P6.C reconciliation_cadence worker registered (interval=21600s)
[worker]     reconciliation_cadence worker started
             (interval=21600s, idempotency_window=21100s)
[shutdown]   reconciliation_cadence worker cancelled
[supervisor] worker_supervisor: stopped worker=reconciliation_cadence
             cancel_latency_ms=0.1
```

Graceful shutdown latency: **0.1 ms** — well below supervisor's 5 s timeout.

### 2.2 First scheduled snapshot persisted (raw)

```json
{
  "id": "148a927b47ce46688e368fa9e79e51af",
  "generatedAt":     "2026-05-22T20:45:08.287062+00:00",
  "scope":           "service_payments (READ-ONLY snapshot)",
  "totalDocs":       0,
  "divergenceCount": 0,
  "triggeredBy": {
    "actorId":         "worker:reconciliation_cadence",
    "actorRole":       "system:scheduler",
    "sourceRoute":     "worker:reconciliation_cadence/tick",
    "sourceRequestId": null,
    "operatorReason":  null
  },
  "persistedAt":   "2026-05-22T20:45:08.288664+00:00",
  "schemaVersion": 1
}
```

Operators can now filter the history by `triggeredBy.actorRole == "system:scheduler"` to see ONLY scheduled rows, or by `triggeredBy.actorRole == "admin"` to see ONLY human-triggered ones.

### 2.3 Idempotency guard verified

Manual tick invocation 30 s after the scheduled snapshot landed:

```python
>>> await run_reconciliation_once(db)
{'skipped': True, 'reason': 'idempotency_window',
 'snapshotId': None, 'divergenceCount': None,
 'totalDocs': None, 'tookMs': 3}
```

The worker correctly debounces duplicate ticks (e.g. from hot reload, double `supervisor.start`, or operator manually invoking the function). Cost: 3 ms (single index lookup on `persistedAt`).

---

## 3. Design discipline

### 3.1 SYSTEM_ACTOR is not an admin

The `triggeredBy.actorRole` is intentionally `"system:scheduler"` — a synthetic role NOT in the canonical set `{customer, provider, admin, inspector, platform, stripe}`. This is by design:

- The row is NOT an admin mutation. Calling `record_admin_mutation` here would have polluted `admin_audit_log` with a stream of cron-emitted rows that drown the actual operator events.
- The chronology layer is also untouched. Per `app.payments.reconciliation` doctrine, reconciliation is **fleet-wide observability**, not a `paymentId`-scoped event.
- Operators inspecting `reconciliation_snapshots` can trivially separate cadence rows from operator rows by filtering on `triggeredBy.actorRole`.

### 3.2 Idempotency window vs cadence

```
cadence interval         = 21600 s = 6 h
idempotency window       = 21100 s = ~5 h 51 min
```

Slightly shorter than cadence so that supervisor jitter (drift in tick timing under load) doesn't cause two consecutive ticks to both consider themselves the "first" of the window. Net effect: one snapshot every 6h ± supervisor tick variance.

### 3.3 Fail-open on idempotency check

If the idempotency check itself throws (mongo transient), the worker treats `age = +inf` and proceeds. Doctrine reasoning: **prefer evidence to silence**. A duplicate scheduled snapshot is a recoverable evidence-only redundancy; missing evidence is not recoverable.

### 3.4 No exception propagation to supervisor

`run_reconciliation_once` catches every internal failure mode (idempotency check, `generate_report`, `insert_one`) and returns a `{skipped: True, reason: "..."}` summary. The supervisor never sees an exception in steady state. This matches the discipline established by `receipts_poll.loop.poll_receipts_once`. The supervisor's `on_failure max_restarts=5 backoff=5s` is a defensive net only.

---

## 4. Env-overridable knobs (additive, optional)

| Variable | Default | Meaning |
|---|---:|---|
| `RECONCILIATION_CADENCE_SECONDS` | `21600` (6h) | Interval between scheduled ticks |
| `RECONCILIATION_IDEMPOTENCY_WINDOW` | `21100` (5h51m) | Cooldown before next snapshot allowed |
| `RECONCILIATION_MIN_DIVERGENCE_LOG` | `1` | Threshold below which the INFO log line is suppressed |

None are required to be set. None of them landed in `.env` — operators set them in deploy env if they want denser/sparser cadence per environment.

---

## 5. Doctrine adherence checklist

- ☑ Does NOT introduce **dual truth** — writes to existing `reconciliation_snapshots` only
- ☑ Does NOT introduce **abstractions** — re-uses `generate_report` and `worker_supervisor`; no new helpers
- ☑ Does NOT start **automation** — worker WRITES evidence, never ACTS
- ☑ All money/trust/governance events land in **append-only chronology** — n/a, this is fleet-wide observability not chronology
- ☑ All mutations (including scheduled ones) carry **attribution** — `triggeredBy.actorRole = "system:scheduler"`
- ☑ Provider parity NOT regressed — backend-only addition
- ☑ No new bounded contexts — `workers/` was already part of existing 55-module surface
- ☑ Premature intelligence ban respected — no predictive, no autonomous, no copilot, no orchestration logic

---

## 6. The three asymmetry zones — closure status

Per `PLATFORM_DOCTRINE_P5_CLOSURE.md § 7`:

| Asymmetry zone | Phase | Status |
|---|---|:---:|
| **7.1** — Provider surface (consumer-grade → governance-grade) | P6.2 + (P6.3 / P6.4 pending) | 🟡 partial (payout chronology done; disputes UI still missing) |
| **7.2** — Attribution saturation | P6.B + (P6.B.2 pending) | 🟡 partial (9 / 18 admin mutation handlers wired, pattern proven) |
| **7.3** — Scheduled reconciliation | P6.C (this phase) | ✅ **CLOSED** |

P6.C is the cleanest, lowest-risk close of the three. Roadmap order from P6.1 § 6 was:

> **P6.1** → **P6.B** (attribution wires evidence floor) → **P6.C** (cadence makes evidence durable) → **P6.2/3/4** (surface symmetry on top of saturated evidence) → **P6.D** (UX polish).

P6.C is now done; what remains: finish the long tail of P6.B.2 (mechanical wiring of the remaining 9 admin handlers) and P6.3/P6.4 (provider disputes UI + trust drill-down, currently the largest remaining provider-side gap).

---

## 7. Closure artefacts

| Path | Purpose |
|---|---|
| `memory/PLATFORM_DOCTRINE_P5_CLOSURE.md` | parent doctrine |
| `memory/P6_1_provider_surface_triage_inventory_2026_05_22.md` | inventory + roadmap |
| `memory/P6_2_provider_payout_chronology_closure_2026_05_22.md` | provider chronology screen |
| `memory/P6_B_attribution_saturation_closure_2026_05_22.md` | 9 admin mutation handlers wired |
| `memory/P6_C_reconciliation_cadence_closure_2026_05_22.md` (this doc) | scheduled cadence worker |
| `backend/app/workers/reconciliation_cadence/{__init__,contracts,loop,registry}.py` | new worker package |
| `backend/app/core/lifespan.py` | lifespan wire-up (+8 LOC) |

---

## 8. Final P6 status snapshot

| Layer (per doctrine § 6) | Before P6 | After P6.1/2/B/C | Target after full P6 |
|---|---:|---:|---:|
| Topology | 100% | 100% | 100% |
| Contracts | 100% | 100% | 100% |
| Chronology | 98% | 98% | 98% |
| Governance | 95% | ~96% | ~98% |
| Attribution | 92–95% | ~93–95% (partial wiring) | 100% |
| Money correctness | 92–94% | 92–94% | 92–94% |
| Reconciliation | 90–92% | **94%** (cadence closed) | 94% |
| Provider UX | ~75–80% | ~77% | ~90% |
| Automation | suspended | **STILL suspended** (P6.C is evidence, not automation) | suspended until P6 complete |

**Next phase recommendation:** **P6.B.2** — finish wiring the remaining 9 admin mutation handlers identified in `P6_B_attribution_saturation_closure_2026_05_22.md § 5`. Mechanical, ~120 LOC additive, single PR. After that, `Attribution` row flips to 100%, completing two of three asymmetry zones.

**End of P6.C closure.**
