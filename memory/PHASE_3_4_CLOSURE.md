# Phase 3.4 — CLOSED · Operational Runtime Foundation

**Status:** ✅ RATIFIED · FROZEN · COMMIT-READY
**Closed:** 2026-05-18
**Successor:** Phase 4 (lifespan rewrite) — NOT YET STARTED. Cooling period required.

This file is the closure marker. It exists for one reason: to make it
mechanically obvious to anyone (future contributor, fork agent, audit
review) that Phase 3.4 is DONE and the supervisor contract is FROZEN
until Phase 4 formally opens.

If you came here looking for "what's the next supervisor change?" —
the answer is: nothing. The contract cools. See §3.

---

## 1. What Phase 3.4 actually delivered

Phase 3.4 is no longer "supervisor extraction" or "C-2/C-3 work". The
correct name, as ratified post-runtime-probe, is:

> **Operational Runtime Foundation**

Because the artifacts collectively constitute:

| Layer | Status |
|-------|--------|
| Extraction doctrine | stabilized |
| Worker ownership | stabilized |
| Tick model | validated |
| Supervision semantics | validated |
| Graceful shutdown | validated |
| Runtime telemetry | validated |
| Rollback doctrine | validated |
| Operational constitution | documented |
| Live-runtime evidence | captured |

This is foundation-grade infrastructure. It is not a sprint output.

---

## 2. The discipline that mattered

The Phase succeeded because of what did **NOT** get built:

- No decorators
- No plugin system
- No dynamic discovery
- No hidden registries
- No metaclass magic
- No framework creep
- No implicit lifecycle
- No premature abstraction
- No debug scaffolding left in production lifecycle

Every one of these was technically easy to add and would have felt
"professional". Refusing them is the actual architectural work.

The supervisor surface stays at:
- `register(spec) / start(name) / stop(name) / stop_all() / status(name?) / is_running(name) / get_task(name) / registered(name)`
- `WorkerSpec(name, tick, interval_seconds, restart_policy, max_restarts, backoff_seconds, on_start, on_cancel)`
- `WorkerStatus(10 fields)`

Until Phase 4 opens, this is the contract. **Adding anything to it is
a contract violation.**

---

## 3. Why cooling is mandatory before Phase 4

Three reasons not to extend the supervisor immediately:

1. **Two data points isn't a pattern.** `vehicles_refresh` and
   `receipts_poll` are similar workers (polling + DB + external HTTP).
   The third supervised worker will reveal whether the surface generalises
   — and that's the moment to evolve it, not before.

2. **Phase 4 inherits the runtime layer.** The lifespan rewrite needs
   the supervisor to be a fixed point of reference. If both move
   simultaneously, the rewrite can't be reviewed cleanly.

3. **Live-runtime evidence has a half-life.** The probe was captured on
   the actual production process state. Changing the surface invalidates
   the probe interpretation. Future probes can be compared to the
   `PHASE_3_4_RUNTIME_PROBE.md` snapshots only while the surface is
   unchanged.

**Doctrine:** No supervisor changes until Phase 4 opens formally with
its own scope document.

---

## 4. Phase 3 — full arc retrospective

The arc of Phase 3 was:

```
discovery → mapping → extraction → supervision → operational ratification
```

| Sub-phase | Outcome |
|-----------|---------|
| Phase 3.1 (discovery) | Inventoried all background loops |
| Phase 3.2 (mapping) | Identified archetype A/B candidates |
| Phase 3.3 (extraction) | PR-01..PR-05: workers moved to `app.workers.*` (move-only) |
| Phase 3.4 (supervision) | First true supervised worker (C-2 vehicles_refresh) + second (C-3 receipts_poll) + constitution + runtime evidence |

Across all four sub-phases the discipline held:

- No retroactive refactors triggered
- No domain logic touched
- No OpenAPI surface added (still 571)
- Rollback path stayed single-PR-reversible at every checkpoint
- Each phase produced its own dedicated memory artifact

This is the model for Phase 4 onwards.

---

## 5. What becomes orthogonal now

The clean separation produced by Phase 3.4 makes several previously
mixed concerns now independently tractable:

| Concern | Previously coupled to | Now orthogonal because |
|---------|----------------------|------------------------|
| Redis hardening | worker lifecycle + retry + state | worker runtime owns its own lifecycle; Redis ops can be replaced without touching workers |
| Structured logging | per-worker logger conventions | telemetry surface is locked; loggers can be re-pointed to JSON sinks per worker independently |
| Prometheus exposition | telemetry collection model | telemetry data already exists in-memory; exposition is a separate concern |
| Multi-process scaling | startup ordering + task ownership | task ownership is consolidated in supervisor; scaling is a deployment topology decision, not a code decision |
| Admin observability | worker visibility | `status()` already exists in-memory; the only remaining work is HTTP exposition |

Each of these is now a separate Phase 4+ candidate. None of them block
each other. None of them require touching the supervisor.

---

## 6. Commit / tag posture

Recommended VCS posture for closing Phase 3.4:

- Commit message includes: `Phase 3.4 closed — Operational Runtime Foundation. Supervisor contract frozen until Phase 4.`
- Tag: `phase-3.4-stable`
- Memory artifacts MUST be in the same commit as the supervisor surface lock — they are the contract's documentation
- No squash if individual C-2 / C-3 / probe commits are atomic — they are useful for `git log --oneline` reading

---

## 7. The four files that constitute the foundation

| File | Role |
|------|------|
| `backend/app/core/worker_supervisor.py` | Locked surface (~270 LOC, stdlib-only) |
| `backend/tests/test_worker_supervisor.py` | 13-test invariant gate |
| `memory/PHASE_3_4_C2_SUPERVISED_VEHICLES_REFRESH.md` | First migration audit |
| `memory/PHASE_3_4_RETROSPECTIVE.md` | Runtime constitution (12 sections) |
| `memory/PHASE_3_4_RUNTIME_PROBE.md` | Live evidence + operational decoder |
| `memory/PHASE_3_4_CLOSURE.md` | (this file) closure marker |

If any one of these is missing from the next checkout, the foundation
is incomplete. They are co-versioned by design.

---

## 8. The signal that Phase 4 is ready to open

Open Phase 4 when AT LEAST ONE of these is true:

- A third supervised worker is needed (and the L2 candidate is identified)
- A debugging incident reveals an observability gap that requires
  admin-endpoint visibility
- Structured logging rollout begins and needs to know the telemetry
  surface (it already does — see retrospective §6)
- Redis hardening is queued and the worker runtime needs to be
  re-verified before lifespan ordering changes
- Multi-process orchestration is queued

Do NOT open Phase 4 because:
- The supervisor "could be more general"
- More telemetry "would be nice"
- An admin endpoint "would be easy to add"
- A decorator "would make registration cleaner"

These are framework-creep symptoms. Reject them.

---

## 9. Acceptance signature (final, locked)

```
Phase 3.4: Operational Runtime Foundation
Status: CLOSED · RATIFIED · FROZEN

Surface:    locked
Telemetry:  populated in production process
Tests:      13/13 green
OpenAPI:    571 (unchanged across all of Phase 3)
Workers:    2 supervised, 3 L2-attached (deliberately not migrated)
Doctrine:   no decorators / DI / auto-discovery / plugins / metaclasses
Rollback:   single-PR-reversible per migration
Cooling:    mandatory until Phase 4 opens with its own scope document
```

End of Phase 3.
