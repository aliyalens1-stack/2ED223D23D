# Phase 3D · Extraction Sequencing Plan

**Date:** 2026-02-17 · **Scope:** mapping + sequencing only · **Status:** draft for review

> No production code in this document. No extraction implementation, no lifecycle rewrites, no worker movement, no boundary invention. 3D consumes 3A (trust), 3B (time), 3C (ownership) and emits a deterministic **order** of moves, the **PR contracts** that govern each move, and the **gates** that block premature extraction. The boundaries already exist; 3D is the schedule that walks them.

> **Headline (carried from 3C §12):** the worker → collection graph is already tree-shaped. 5 Tier-A workers have zero inter-worker coupling. 6 Tier-B workers cluster into 3 natural pairs. 4 Tier-C workers carry latent dedupe hazards (3C-H1..H4). Mutable globals are net-6, all bounded, none unbounded (the 3 cooldown/lock dicts are stubs; real truth is Redis). This means **3D's job is sequencing, not boundary invention**.

---

## §1 — Extraction Principles

Every extraction PR shipped under Phase 3 must obey **all** of the following rules. Violation of any single rule is grounds for revert without review.

| # | Principle | Rationale |
|---|-----------|-----------|
| **P-1** | **Workers first, request handlers last.** | Workers own pure-writer collections (3C §2). Handlers participate in the OpenAPI surface (517 endpoints, 91 routers). A worker move never changes the public contract; a handler move always can. Move the silent things first. |
| **P-2** | **No semantic changes inside an extraction PR.** | Extraction must be a pure relocation: same code, same call sites, same logs, same Mongo writes. If a change is needed, it ships in a separate PR *before* (hardening) or *after* (improvement). This is the only way 3C's risk model stays valid. |
| **P-3** | **One ownership move per PR.** | One worker, one cluster, or one catalogue per PR. Never bundle. This keeps the rollback unit minimal and the review surface obvious. |
| **P-4** | **No auth migration bundled with worker extraction.** | Auth is identity_runtime + JWT (3A §4, §7). Worker extraction is structural. They share no files. Bundling forces auth-domain reviewers and worker-domain reviewers to co-approve, which guarantees neither reviews properly. |
| **P-5** | **No catalogue relocation bundled with worker extraction.** | Catalogues (`CITY_CATALOGUE`, `MARKET_BASELINES`, etc — 3C §8) drift slowly. Their moves trigger import-rewrite cascades. Mixing those cascades with a worker move corrupts both diffs. Catalogue moves are **post-Tier-A** standalone PRs. |
| **P-6** | **Tier C workers require hardening BEFORE extraction.** | Hazards 3C-H1..H4 (auto_money, autobid, reactivation, nudge) are *latent* today because Redis cooldowns mask double-fires. Extraction reorders startup; a Redis-down window during a restart can surface a double-charge. Hardening (Mongo-side dedupe) closes the hazard before the timing window opens. |
| **P-7** | **OpenAPI invariant must remain stable.** | No path string moves, no response shape changes, no status code changes during extraction. The 517 endpoints in `openapi.json` are a frozen contract for 4 consumer surfaces (mobile, web-app, admin, public). Verified by `openapi.json` byte-diff in CI. |
| **P-8** | **Restart safety is mandatory.** | Every PR must leave the system bootable from a cold start with no manual intervention. Verified by `supervisorctl restart backend && curl /api/health` returning `db:connected` within 30s. |
| **P-9** | **Rollback path is mandatory.** | Every PR identifies the single commit that reverts it. No multi-commit unwinds. No data migrations inside an extraction PR (P-2 follows from this). |
| **P-10** | **Old import path stays valid during transition where needed.** | If `app.foo` is splitting into `app.foo` + `app.foo_worker`, the old `app.foo` keeps a re-export for one PR cycle, so dependent code doesn't break before its own PR lands. Re-export is removed in the *next* PR. |

These ten principles are the **only** invariants the rest of Phase 3 needs. They are not aspirational — they are the literal pre-flight checklist for every PR.

---

## §2 — Tier Classification Recap

Source of truth: 3C §9. Reproduced here with extraction-time fields (collections touched, startup site, dependencies, why it's at this tier).

### §2.1 Tier A — Safe Carve-outs (5 workers, zero inter-worker coupling)

| # | Worker | Source · Symbol | Owned collections | Startup site | Catalogue/global deps | Coupling | Risk |
|---|--------|-----------------|-------------------|--------------|----------------------|----------|------|
| A1 | `receipts_poll_loop` | `app/notifications/receipts.py:288` | `notification_delivery_lifecycle` (in-place updates only) | `lifespan.py:292` direct | none | **zero** | **lowest** |
| A2 | `stats_recompute_loop` | `app/auto_requests/exposures_cron.py:142` | analytics rollups (overwrite) | `lifespan.py:279` direct | reads `inspector_exposures`, `inspection_jobs` (shared reads only) | **zero** (read-only consumer) | **very low** |
| A3 | `_demand_prediction_loop` | inner fn in `app/orchestrator/runner.py:42` | `ml_models` (overwrite per zone) | `runner.start_all_loops` | `_behavioral_cache` (300s TTL — see 3C §7) | **zero** | **very low** |
| A4 | `provider_ranking_optimizer_loop` | `app/marketplace/quick_request.py` | `provider_ranking_weights` (overwrite upsert) | `runner.start_all_loops` | none | **zero** | **very low** |
| A5 | `refresh_loop` (VMS) | `app/vehicles/refresh.py:375` | `listing_snapshots`, `vehicles` (hash-keyed conditional update) | `lifespan.py:203` direct | none | **zero** | **very low** |

**Why coupling is effectively zero (per 3C §2):** each of A1–A5 has its own pure-writer collection; no other worker writes to the same collection; reads are observational and tolerate stale data within their cadence window. Replay-on-restart is safe for all five: receipts is in-place (no duplicate insert possible by construction), stats is overwrite, ml_models is overwrite, ranking_weights is overwrite, refresh is hash-conditional.

**Estimated PR size (qualitative, per 3C §10):** ~0.5 day each. ~200–400 LOC moved per PR. No API surface change. No dependency rewrite beyond import path.

### §2.2 Tier B — Cluster Extraction (3 clusters, internal coupling)

Each cluster moves as **one** PR because the workers inside read each other's outputs. Splitting the cluster across PRs would require maintaining a temporary two-package import graph for a worker pair — that violates P-3's spirit (single ownership move).

| Cluster | Members | Why they move together | Owned collections |
|---------|---------|------------------------|-------------------|
| **B1 — Optimization** | `feedback_processor_loop` + `strategy_optimizer_loop` | `strategy_optimizer` reads `action_feedback`/`strategy_recommendations` written/cleared by `feedback_processor`. Cadence drift between them produces stale weights. | `action_feedback`, `strategy_weights`, `strategy_recommendations` |
| **B2 — Zone engine** | `zone_state_engine` + `orchestrator_engine_loop_v2` | Engine reads `zone_snapshots` written by state. Engine writes `orchestrator_logs` / claims `dedupe_buckets`. The state→engine flow IS the orchestrator. | `zone_snapshots`, `orchestrator_logs`, `dedupe_buckets` (shared with other claim sites) |
| **B3 — Exposures lifecycle** | `expire_loop` + `batching_loop` | Both write to `inspector_exposures`. Expire flips status, batching enforces `(jobId, inspectorId)` uniqueness. Splitting them creates a status-vs-uniqueness race window. | `inspector_exposures`, `inspector_exposure_events` |

**Cluster constraints:**
- B1 inherits `find_one_and_update` claim-then-process pattern → hard guard, no hardening needed.
- B2 inherits `dedupe_bucket` claim → hard guard, no hardening needed.
- B3 inherits unique index on `(jobId, inspectorId)` → hard guard, no hardening needed.

All three Tier B clusters are **clean but ordering-sensitive** (3C §9 wording preserved). Extraction is safe; the constraint is cluster cohesion, not hazard.

### §2.3 Tier C — Hardening-Required (4 workers, latent dedupe hazards)

| # | Worker | Hazard ID | Missing dedupe | Current mitigation | Failure mode | Required hardening (BEFORE extraction) |
|---|--------|-----------|----------------|--------------------|--------------|----------------------------------------|
| C1 | `auto_money_worker_loop` | **3C-H1** | no dedupe on RMW of `provider_bids` | Redis cooldown (`app.core.redis_state`) | Redis-down + restart → **double bid increment** | `dedupe_bucket` claim per `(orgId, zoneId, tick_bucket)` |
| C2 | `autobid_worker_loop` | **3C-H2** | no dedupe on `auction_charges` insert + `provider_bids` RMW | Redis cooldown | Redis-down + restart → **double auction charge** | `dedupe_bucket` claim per `(auctionId, providerId, tick_bucket)` OR unique partial index on `auction_charges.(auctionId, providerId, tickBucket)` |
| C3 | `reactivation_sweep_loop` | **3C-H3** | no dedupe on `reactivation_events` insert | Redis cooldown | Redis-down + restart → **duplicate reactivation notification** | unique partial index on `(orgId, kind, bucketDay)` |
| C4 | `nudge_sweep_loop` | **3C-H4** | no dedupe on `nudge_events` insert | Redis cooldown | Redis-down + restart → **duplicate provider nudge** | unique partial index on `(providerId, zoneId, bucketHour)` |

**All four hazards are latent today** — Redis cooldowns hide them in normal operation. They only surface during the specific window of *(Redis-down) + (worker restart) + (tick re-enters previous cooldown bucket)*. That window is small but real. Extraction reorders startup and lengthens the window. Therefore hardening is **prerequisite to extraction**, not concurrent with it.

C3 / C4 hardening is trivial: a single `create_index` with `partialFilterExpression`. One PR ships both.

C1 / C2 hardening touches money paths (bids, charges). They require explicit test coverage for the double-fire scenario before they ship — i.e. a regression test that simulates Redis-down + restart and asserts single-charge invariance.

---

## §3 — PR Sequencing Plan

The sequence below is the **prescribed order** of execution. Each PR is self-contained per §1 P-3. Each PR has a single rollback commit per §1 P-9.

### §3.1 Sequence summary (at a glance)

```
Phase 3D execution path
───────────────────────
PR-01  Tier A · receipts_poll                 ← proof-of-pattern (see §8)
PR-02  Tier A · stats_recompute (exposures)
PR-03  Tier A · _demand_prediction
PR-04  Tier A · provider_ranking_optimizer
PR-05  Tier A · refresh_loop (VMS)
───────────────────────  Tier A complete
PR-06  Tier C hardening · 3C-H3 + 3C-H4 indexes (one combined PR)
PR-07  Tier C hardening · 3C-H1 auto_money dedupe
PR-08  Tier C hardening · 3C-H2 autobid dedupe
───────────────────────  Tier C dedupe established (extraction gate cleared)
PR-09  Tier B · cluster B1 (feedback + strategy)
PR-10  Tier B · cluster B2 (zone_state + orchestrator_engine)
PR-11  Tier B · cluster B3 (expire + batching)
───────────────────────  Tier B complete
PR-12  Tier C · reactivation_sweep extraction
PR-13  Tier C · nudge_sweep extraction
PR-14  Tier C · auto_money extraction
PR-15  Tier C · autobid extraction
───────────────────────  All loops extracted
PR-16  Residual · catalogue relocation: CITY_CATALOGUE → app/geo/
PR-17  Residual · 4× @app.on_event → lifespan migration
PR-18  Residual · NestJS dead-code sweep (NESTJS_ENABLED=0 path)
PR-19  Residual · JWT_SECRET fallback removal + boot check
```

**Why this order:**

1. **Tier A first (PR-01..05)** — proves the worker-extraction pattern on zero-coupling workers. Every Tier-A PR succeeds or reveals a missing test pattern. Failure surface is bounded.
2. **Tier C hardening before Tier C or Tier B extraction (PR-06..08)** — closes the latent dedupe window before extraction lengthens the restart timing. C3/C4 first (trivial), then C1/C2 (money paths).
3. **Tier B clusters next (PR-09..11)** — once Tier A has validated the pattern and Tier C hardening has reduced overall hazard load, the cluster extractions are mechanical.
4. **Tier C extraction last (PR-12..15)** — by the time we move money-path workers, every other worker is extracted and every dedupe guard is in place.
5. **Residuals (PR-16..19)** — catalogue, lifecycle, dead-code, security-fallback. All independent of the worker graph.

### §3.2 Per-PR detail (PR-01..05 — Tier A)

> Each row below is the literal PR contract. Reviewers verify by checking each field.

#### PR-01 · `receipts_poll_loop` → `app.notifications.receipts.worker`
| Field | Value |
|-------|-------|
| Worker | `receipts_poll_loop` |
| Source | `app/notifications/receipts.py:288` |
| Target | new module `app/notifications/receipts/worker.py` (or stay-in-place rename) |
| Owned collections | `notification_delivery_lifecycle` only |
| Startup before | `lifespan.py:292` direct `create_task` |
| Startup after | same site; just imports from new module path |
| Rollback | revert single commit; no data, no schema change |
| Smoke tests | `notification_delivery_lifecycle` projection unchanged; receipts continue to flip status |
| OpenAPI invariant | no handler touched → `openapi.json` byte-identical |
| Expected LOC moved | ~150 |

#### PR-02 · `stats_recompute_loop` → `app.auto_requests.exposures.stats_worker`
| Field | Value |
|-------|-------|
| Worker | `stats_recompute_loop` |
| Source | `app/auto_requests/exposures_cron.py:142` (extract function; sibling `expire_loop` + `batching_loop` stay) |
| Target | `app/auto_requests/exposures/stats_worker.py` |
| Owned collections | analytics rollups only (no writes to `inspector_exposures`) |
| Startup before | `lifespan.py:279` |
| Startup after | same site; new import path |
| Rollback | single revert |
| Smoke tests | rollup count unchanged after cadence cycle |
| OpenAPI invariant | none touched |
| Caveat | sibling loops (B3 cluster) remain in `exposures_cron.py` — that's intentional per §2.2 |

#### PR-03 · `_demand_prediction_loop` → `app.ml.demand_worker`
| Field | Value |
|-------|-------|
| Worker | inner `_demand_prediction_loop` defined in `runner.py:42` |
| Source | `app/orchestrator/runner.py:42` |
| Target | `app/ml/demand_worker.py` |
| Owned collections | `ml_models` (overwrite upsert per zone) |
| Startup before | `runner.start_all_loops` (registered as task) |
| Startup after | `runner.start_all_loops` still launches it; only the function definition moves |
| Rollback | single revert |
| Smoke tests | `ml_models` continues to update; `DemandPredictor.behavioral_*` continues to read fresh values |
| Catalogue/global dep | `_behavioral_cache` stays in `ml/predictor.py` (already correctly co-located) |
| OpenAPI invariant | none |

#### PR-04 · `provider_ranking_optimizer_loop` → `app.marketplace.ranking.worker`
| Field | Value |
|-------|-------|
| Worker | `provider_ranking_optimizer_loop` |
| Source | `app/marketplace/quick_request.py` (function moves; quick_request handlers stay) |
| Target | `app/marketplace/ranking/worker.py` |
| Owned collections | `provider_ranking_weights` (overwrite upsert) |
| Startup before | `runner.start_all_loops` line `runner.py:67` |
| Startup after | same; new import |
| Rollback | single revert |
| Smoke tests | ranking weights regenerated within cycle |
| Caveat | the *handler* surface of `quick_request.py` is untouched (P-1, P-7). Only the loop moves. |

#### PR-05 · `refresh_loop` (VMS) → `app.vehicles.refresh_worker`
| Field | Value |
|-------|-------|
| Worker | `refresh_loop` |
| Source | `app/vehicles/refresh.py:375` (function moves; surrounding refresh endpoints stay) |
| Target | `app/vehicles/refresh_worker.py` |
| Owned collections | `listing_snapshots` (hash-conditional), `vehicles` (per-row update) |
| Startup before | `lifespan.py:203` direct |
| Startup after | same site; new import |
| Rollback | single revert |
| Smoke tests | VMS demo vehicle continues to refresh on cadence |
| OpenAPI invariant | refresh endpoints in `refresh.py` are unchanged |

### §3.3 Per-PR detail (PR-06..08 — Tier C hardening, NO extraction yet)

#### PR-06 · `reactivation` + `nudge` dedupe indexes (3C-H3 + 3C-H4)
| Field | Value |
|-------|-------|
| Type | Hardening (NOT extraction) |
| Action | Add unique partial indexes: `reactivation_events.(orgId, kind, bucketDay)` and `nudge_events.(providerId, zoneId, bucketHour)` |
| Files touched | `app/growth/reactivation.py` (index-ensure), `app/growth/nudges.py` (index-ensure) |
| Worker code | unchanged (no extraction) |
| Rollback | drop indexes (one mongo command); revert PR |
| Smoke tests | restart twice within cadence window; verify zero duplicate `reactivation_events` / `nudge_events` |
| OpenAPI invariant | none touched |

#### PR-07 · `auto_money_worker` dedupe (3C-H1) — hardening only
| Field | Value |
|-------|-------|
| Type | Hardening |
| Action | Wrap RMW in `app.core.dedupe_bucket.try_claim_bucket` keyed on `(orgId, zoneId, tick_bucket)` |
| Files touched | `app/growth/auto_money.py` only |
| Worker code | claim-then-write pattern added in-place; no relocation |
| Rollback | single revert |
| Smoke tests | regression test: simulate Redis-down + restart inside tick window; assert no double bid increment |
| OpenAPI invariant | none touched |
| Gate for | PR-14 (extraction) — without this, PR-14 is blocked |

#### PR-08 · `autobid_worker` dedupe (3C-H2) — hardening only
| Field | Value |
|-------|-------|
| Type | Hardening |
| Action | Two options (pick one): (a) `dedupe_bucket` claim per `(auctionId, providerId, tick_bucket)`, OR (b) unique partial index on `auction_charges.(auctionId, providerId, tickBucket)` |
| Recommendation | **(b)** — the collection is small, the index is targeted, the guard is enforced by Mongo not by code |
| Files touched | `app/marketplace/auction.py` only |
| Worker code | guard added in-place; no relocation |
| Rollback | drop index; revert |
| Smoke tests | regression test: simulate concurrent auction tick; assert single charge |
| Gate for | PR-15 (extraction) |

### §3.4 Per-PR detail (PR-09..11 — Tier B cluster extractions)

#### PR-09 · Cluster B1 → `app.orchestrator.optimization`
| Field | Value |
|-------|-------|
| Workers | `feedback_processor_loop` + `strategy_optimizer_loop` |
| Source | `app/orchestrator/feedback.py:232` and `:283` |
| Target | new package `app/orchestrator/optimization/` with `feedback.py` + `strategy.py` |
| Owned collections | `action_feedback`, `strategy_weights`, `strategy_recommendations` |
| Startup | both registered via `runner.start_all_loops` (unchanged) |
| Rollback | single revert |
| Smoke tests | feedback queue drains; strategy weights regenerate |
| OpenAPI invariant | none touched (workers only) |
| Why cluster | strategy reads what feedback writes/clears — see §2.2 |

#### PR-10 · Cluster B2 → `app.orchestrator.engine`
| Field | Value |
|-------|-------|
| Workers | `zone_state_engine` + `orchestrator_engine_loop_v2` |
| Source | both currently in `app/orchestrator/cycle.py` |
| Target | `app/orchestrator/engine/` with `zone_state.py` + `cycle.py` |
| Owned collections | `zone_snapshots`, `orchestrator_logs`, `dedupe_buckets` (shared claim store) |
| Startup | `runner.start_all_loops` lines `runner.py:59` and `:62` |
| Rollback | single revert |
| Smoke tests | `Orchestrator cycle #N` log entry continues to appear; `zone_snapshots` continues to grow |
| Caveat | `dispatch_alert` ad-hoc task (`orchestrator/cycle.py:211`) moves with this cluster as a sibling (it's the engine's outbound side-channel) |

#### PR-11 · Cluster B3 → `app.auto_requests.exposures.lifecycle`
| Field | Value |
|-------|-------|
| Workers | `expire_loop` + `batching_loop` |
| Source | `app/auto_requests/exposures_cron.py:44` and `:129` |
| Target | `app/auto_requests/exposures/lifecycle.py` (PR-02's `stats_worker.py` already lives in this package) |
| Owned collections | `inspector_exposures`, `inspector_exposure_events` |
| Startup | `lifespan.py:277` + `:278` |
| Rollback | single revert |
| Smoke tests | exposure flip `exposed → expired` continues; `(jobId, inspectorId)` uniqueness continues to deduplicate |

### §3.5 Per-PR detail (PR-12..15 — Tier C extractions, post-hardening)

Each Tier-C extraction PR is gated on its hardening PR landing first.

| PR | Worker | Source | Target | Gate | Rollback |
|----|--------|--------|--------|------|----------|
| PR-12 | `reactivation_sweep_loop` | `app/growth/reactivation.py:241` | `app/growth/reactivation/worker.py` | PR-06 merged | single revert |
| PR-13 | `nudge_sweep_loop` | `app/growth/nudges.py:367` | `app/growth/nudges/worker.py` | PR-06 merged | single revert |
| PR-14 | `auto_money_worker_loop` | `app/growth/auto_money.py:271` | `app/growth/auto_money/worker.py` | PR-07 merged | single revert |
| PR-15 | `autobid_worker_loop` | `app/marketplace/auction.py:817` | `app/marketplace/auction/worker.py` | PR-08 merged | single revert |

For all four: `runner.start_all_loops` / `lifespan.py` keeps the launch site; only the function definition moves. Owned collections unchanged. Smoke tests: each loop's idempotency anchor (now installed by §3.3 PRs) holds across restart.

### §3.6 Per-PR detail (PR-16..19 — Residuals)

#### PR-16 · `CITY_CATALOGUE` relocation (3C §8 drift item)
| Field | Value |
|-------|-------|
| Source | `app/marketplace/cities.py` |
| Target | `app/geo/cities.py` |
| Import-rewrite scope | callers in `pricing`, `provider/onboarding`, `core/lifespan` (via `geo.topology`) |
| Type | Catalogue relocation (NOT a worker move — P-5 prohibits bundling) |
| Rollback | single revert; old import path preserved as re-export for one PR cycle per P-10 |
| Smoke tests | `/api/cities` returns 25 cities unchanged |

#### PR-17 · 4× `@app.on_event("startup")` → lifespan migration
| Field | Value |
|-------|-------|
| Handlers | `_startup_two_factor_indexes`, `_runtime_ledger_startup`, +2 others (full list in 3B §1.1) |
| Action | inline each into `app.core.lifespan` after current index-ensure block |
| Rollback | single revert |
| Risk | very low — ordering is preserved (legacy hooks already ran AFTER lifespan, so moving them INTO lifespan keeps the same order) |
| Smoke tests | TOTP login, runtime_ledger event append both continue to work after restart |

#### PR-18 · NestJS dead-code sweep
| Field | Value |
|-------|-------|
| Action | remove NestJS subprocess code paths under `NESTJS_ENABLED=0` (see 3C §1 row 17 — currently dead) |
| Files touched | `app/core/bootstrap.py` (`start_nestjs`, `nestjs_process` global), `app/core/proxy.py` (NestJS fallback), `backend/package.json`, `backend/nest-cli.json`, `backend/tsconfig.json`, `backend/src/**` |
| Type | Dead-code removal — NOT extraction |
| Rollback | git revert (codebase is ~50 KB lighter; revert is mechanical) |
| Smoke tests | `/api/health` shows `nestjs:disabled` unchanged; no 502s for any endpoint |
| Caveat | only execute after Tier A + B + C are fully extracted; the NestJS path is currently inert, so this is a hygiene PR with no time pressure |

#### PR-19 · `JWT_SECRET` hardcoded fallback removal
| Field | Value |
|-------|-------|
| Action | Remove the `'auto_service_jwt_secret_key_2025_very_secure'` default in `app/core/config.py:40`; fail boot if `JWT_SECRET` env not set when `PRODUCTION=1` |
| Type | Security hardening — NOT extraction |
| Rollback | single revert |
| Smoke tests | boot fails fast in production mode without env; boots normally in dev mode with default |
| Caveat | a documentation update is in scope (env required in production); a code change is in scope (boot check). Both ship together as one PR. |

---

## §4 — Startup Ownership Map

The current startup order (3B §1) must be preserved across all of Phase 3. The mapping below freezes what may move and what must stay.

### §4.1 Startup order — immutable spine

```
init_db
  → load_ml_models
    → 18× index-ensure
      → bootstrap_side_effects (seed_data, geo indexes, provider_locations seed,
                                 ensure_idempotency_indexes, ensure_alert_indexes,
                                 ensure_ttl_indexes, quick_request TTL)
        → start_all_loops          ← 9 worker registrations (Tier A workers can re-anchor here)
          → lifespan direct tasks  ← 6 worker registrations (autobid, exposures×3, refresh, receipts)
            → @app.on_event hooks  ← 4 legacy startups (moves in PR-17 only)
```

This ordering is **immutable across Phase 3**. The Tier A / B / C PRs must register their workers at the **same launch site** the worker uses today (no reordering, no batching). The only PR that touches the spine itself is PR-17 (legacy `@app.on_event` migration), and even there the *effective* order is preserved.

### §4.2 What stays in lifespan (forever)

| Item | Why |
|------|-----|
| `init_db` (Mongo ping) | foundational — every later step depends on it |
| `load_ml_models` | hot-path predictor; must be ready before first request |
| 18× index-ensure | data-integrity guarantee; must run before any write |
| `bootstrap_side_effects` | seeds + idempotency indexes; admin-domain cross-cutting |
| `start_all_loops` invocation | central runner; Tier A/B/C PRs migrate worker *definitions* but not the invocation itself |

### §4.3 What migrates into worker packages (during extraction)

| Item | Current site | Future site | PR |
|------|--------------|-------------|----|
| Worker function definitions (15 of 17) | scattered across `app/*/...` | each worker's own package | PR-01..05, 09..15 |
| Worker-local index-ensure calls | scattered | inline in worker package's `ensure_indexes()` | bundled with worker's extraction PR |
| `start_all_loops` body | `app/orchestrator/runner.py` | unchanged — only import paths inside it change | every Tier-A/B/C PR |

### §4.4 What remains centralized intentionally

| Item | Reason |
|------|--------|
| 9× `start_all_loops` task list | Single oversight surface for all runner loops |
| 6× lifespan direct `create_task` | Each is paired with a specific index-ensure that's tied to its module-local bootstrap |
| Mongo client construction | `ctx.mongo` must be the single client process-wide (connection pooling) |
| `ctx.http_client` | Shared `httpx.AsyncClient` for upstream calls |
| `ctx.emit` realtime emitters | Single fan-out registry |
| `app.state.background_tasks` collection | Single shutdown handle list |

---

## §5 — Mutable Globals Strategy

Source of truth: 3C §7 with the 3B correction explicitly accepted.

### §5.1 Net mutable globals after correction

| Class | Count | Examples | Action in Phase 3 |
|-------|-------|----------|-------------------|
| **Singletons (boot-once, never rewrite)** | 4 | `ctx.mongo`, `ctx.db`, `ctx.http_client`, `ctx.emit.*` | **freeze — do-not-touch (§9)** |
| **Single-writer runtime-mutable** | 2 | `nestjs_process`, `_redis` | leave alone; `nestjs_process` retires with PR-18 |
| **Bounded caches** | 4 | `_token_cache` (PayPal), `_behavioral_cache` (ML), `_CACHE` (feature flags), `_META_CACHE` (customer pipeline) | leave alone — all have TTL / explicit refresh |
| **Bounded per-request state** | 1 | `_rate_state` (parsers) | leave alone — sliding-window self-bounds |
| **Bounded per-minute logging** | 1 | `_malformed_log_throttle` (revenue) | leave alone |
| **STUB dicts (kept for backcompat imports)** | 3 | `orchestrator_cooldowns`, `pre_engagement_cooldowns`, `zone_locks` | leave alone — empty by design; Redis is truth |

**Total real mutable globals: 6 (`nestjs_process` + `_redis` + 4 caches). None unbounded.**

### §5.2 Strategy for Phase 3

> **No global-state rewrite is required before extraction.**

The 3B "shrink mutable globals" agenda is **retracted**. 3C's audit found:
- The unbounded-growth warning on cooldown dicts was wrong (they're stubs).
- All bounded caches are correctly co-located with their consumer.
- All singletons are boot-once and treated as immutable post-boot.

### §5.3 Per-global verdict

| Global | May relocate during Phase 3? | When |
|--------|------------------------------|------|
| `ctx.*` | **never** | — |
| `nestjs_process` | retire with PR-18 | end of Phase 3 |
| `_redis` | **never** during extraction | post-Phase-3 if Redis becomes mandatory |
| `_behavioral_cache` | follows owner (`ml/predictor.py`) — stays in place even after PR-03 (worker moves, cache stays) | — |
| `_token_cache` (PayPal) | stays in `payments/paypal.py` | — |
| `_CACHE` (feature flags) | stays in `feature_flags_helper.py` | — |
| `_META_CACHE` (customer pipeline) | stays in `customer_pipeline.py` | — |
| `_rate_state` (parsers) | stays | — |
| `_malformed_log_throttle` (revenue) | stays | — |
| 3 stub dicts | stays (deletion candidate is post-Phase-3) | — |

### §5.4 What this unlocks

The mutable-globals dimension does **not** gate any extraction PR. The 3C correction collapses a perceived constraint and lets PR-01 ship as-is.

---

## §6 — Hardening Gates

Hardening gates are **explicit blockers**. A PR that violates a gate cannot be merged regardless of test status.

| Gate | What it blocks | Why | Evidence that closes it |
|------|----------------|-----|-------------------------|
| **G-1** | Tier C extraction (PR-12..15) without Mongo-side dedupe | Tier C hazards are masked by Redis cooldowns. Extraction reorders startup, lengthens restart window, surfaces double-fires. | Corresponding hardening PR (PR-06 for C3/C4, PR-07 for C1, PR-08 for C2) merged AND its regression test passing for 24h in main |
| **G-2** | Mixing extraction with semantic change | Extraction PRs must be pure relocations (P-2). Mixing makes the risk model collapse. | PR diff shows no logic delta — same conditions, same writes, same logs |
| **G-3** | Mixing worker move with auth migration | Auth domain has its own change discipline (3A). Bundling guarantees neither review properly. | PR touches no file under `app/system/auth.py`, `app/core/security.py`, `app/two_factor/`, identity_runtime |
| **G-4** | Mixing worker move with catalogue relocation | Catalogue moves cascade imports widely (P-5). | PR touches no module in 3C §8 catalogue table |
| **G-5** | Worker move while ownership unclear | 3C §2 read/write graph is the canonical source. If a PR claims a worker owns a collection not listed in §2, ownership analysis is incomplete. | PR's "owned collections" row matches 3C §2 row for that worker |
| **G-6** | Restart safety uncertain | Every PR must boot cleanly from scratch. | `supervisorctl restart backend && curl /api/health` returns 200 with `db:connected` in ≤30s on a clean container |
| **G-7** | OpenAPI surface drift | Worker extraction never touches the public contract (P-7). | `openapi.json` byte-diff is empty against the parent commit (or only whitespace/ordering differences) |
| **G-8** | Mongo schema or collection rename inside extraction PR | Schema changes need their own PR + backfill plan (P-2, P-9). | PR diff shows no new index, no rename, no field addition in any owned collection |
| **G-9** | Multi-commit rollback path | Rollback must be single-revert (P-9). | PR is one logical commit OR explicit single-revert tag documented |
| **G-10** | Worker move bundled with another worker move | One ownership move per PR (P-3). | PR touches exactly one worker's source file (Tier A) or exactly one cluster's two source files (Tier B) |

These ten gates are the merge checklist. They are **non-negotiable**. A gate failure means the PR is split.

---

## §7 — Rollback Doctrine

Every Phase 3 PR must satisfy the following rollback guarantees.

### §7.1 Hard guarantees

| # | Guarantee | Implication |
|---|-----------|-------------|
| R-1 | **Revertable in one commit.** | No multi-commit PRs. Squash-merge is acceptable. |
| R-2 | **No irreversible migrations.** | No data backfill, no schema breaking change, no enum value retirement. |
| R-3 | **No collection renames during extraction.** | If a collection is misnamed, it stays misnamed for now. Rename is a separate post-Phase-3 PR with its own migration plan. |
| R-4 | **No data backfill in same PR as code move.** | Backfill (e.g. populating a new field on old rows) belongs in its own PR. |
| R-5 | **Old import path remains valid through transition where needed.** | Per P-10. If a downstream consumer imports `from app.foo import worker_fn`, the new module path may co-exist with a re-export shim for one PR cycle. |
| R-6 | **Indexes are reversible.** | Hardening PRs (PR-06, PR-08) add indexes that can be dropped in one command. No partial unique indexes that would block writes if dropped (test: drop, write, re-add must work). |
| R-7 | **Restart-safe rollback.** | Reverting any extraction PR must leave the system bootable. |
| R-8 | **No silent rollback.** | Every revert emits a log entry on next boot ("Phase 3 PR-NN reverted at <timestamp>"). This is doctrine, not enforced — but reviewers should look for it. |

### §7.2 Rollback drill — recommended cadence

After each Tier-A PR (PR-01..05): perform one rollback drill on a staging container. Verify:
1. Code reverts cleanly
2. Worker still launches (from old site)
3. Owned collection continues to receive writes
4. No orphan tasks in `app.state.background_tasks`

After Tier-B clusters and Tier-C extractions: same drill, but also verify the **hardening guard remains in place** even after the extraction PR reverts. (Hardening PRs and extraction PRs are separate — reverting the extraction does NOT revert the hardening.)

### §7.3 What is NOT rollback-protected

- The **observation** that Phase 3 happened (commit history, audit trail) — these stay.
- The **hardening PRs** (PR-06..08) — these are independent improvements that don't need to be undone if the extraction is undone. They become harmless guards on the un-extracted worker.
- The **dead-code sweep** (PR-18) — if reverted, the NestJS subprocess code returns but `NESTJS_ENABLED=0` keeps it dormant.

---

## §8 — Recommended First Executable PR

### §8.1 Recommendation: `receipts_poll_loop` (PR-01)

**This is the safest first operational extraction.**

### §8.2 Why it is the safest proof-of-pattern

| Reason | Evidence |
|--------|----------|
| **Single-collection ownership** | Writes to `notification_delivery_lifecycle` and only that (3C §2 row 15) |
| **"1 row = 1 attempt" hard invariant** | In-place update; no insert-on-restart possible (3C §1 row 15, §3 row 15) |
| **Isolated index, isolated reads** | No worker reads from `notification_delivery_lifecycle` (3C §2 — no other worker lists it as a READ source) |
| **Zero coupling** | No upstream worker writes the rows this one updates; no downstream worker reads them as input (3C §9 Tier A row 1) |
| **No OpenAPI surface change** | The handler surface of `app/notifications/receipts.py` (the projector endpoints) is untouched — only the loop moves (P-1, P-7) |
| **No catalogue dependency** | Reads no module-level dict from 3C §8 |
| **No mutable-global dependency** | Doesn't read `_redis`, doesn't read any bounded cache |
| **Lifecycle namespace is mature** | The customer-notify subsystem already has frozen semantics (PHASE_7_INBOX_NOTIFICATIONS, customer_notify_3a_frozen_2026_05_15) — the doctrine is settled |

### §8.3 Why it validates the worker-extraction discipline

If PR-01 ships cleanly and survives a rollback drill, then the **entire Tier A queue** (PR-02..05) becomes mechanical. The pattern proved by PR-01 is:

```
1. Move function definition to new module
2. Update single import in launch site (lifespan.py:292)
3. Keep all other code untouched
4. Verify openapi.json byte-identical
5. Verify supervisorctl restart → /api/health 200
6. Verify owned collection continues to receive writes within cadence
```

If any step of this pattern surfaces an unexpected coupling, **that coupling is the real discovery**, and 3D's plan absorbs the lesson before PR-02 ships.

### §8.4 Why it minimizes blast radius

- **No customer-facing endpoint changes.** Mobile/web/admin contracts unchanged.
- **No revenue path touched.** Payments, auctions, bids, charges — all untouched.
- **No realtime channel touched.** WS/SSE emitters unchanged.
- **No auth flow touched.** identity_runtime untouched.
- **No 3rd-party integration touched.** Stripe/PayPal/Postmark/Firebase — none in scope.

The single side-effect of a failed PR-01 is: receipts polling pauses for the duration of the rollback (≤2 min on the standard container). The `notification_delivery_lifecycle` rows simply stay in their pre-poll state until the next cycle.

### §8.5 Success criteria for PR-01

- [ ] `app/notifications/receipts.py:288` (worker function) moves to new location
- [ ] `lifespan.py:292` import path updates (one line)
- [ ] `openapi.json` byte-identical to parent commit
- [ ] `supervisorctl restart backend` returns to RUNNING in ≤30s
- [ ] `curl /api/health` returns `db:connected` within 30s
- [ ] `notification_delivery_lifecycle` shows new `lastAttemptedAt` rows within 4× cadence (i.e. within 12 min)
- [ ] No new entries in `system_logs` with `level: error` during a 10-min observation window
- [ ] Rollback drill passes: revert commit → restart → verify worker still alive at OLD launch site

### §8.6 Rollback criteria for PR-01

Revert if **any** of the following are observed within 1h of merge:
- `notification_delivery_lifecycle` rows stop receiving updates for ≥3× cadence (≥9 min)
- `system_logs` shows `level: error` referencing `receipts` or `notifications.receipts`
- `openapi.json` diff shows any new/removed path
- `supervisorctl status backend` returns non-RUNNING
- `/api/health` returns `db:connected: false` or 5xx for ≥2 consecutive polls

### §8.7 Expected behavior

- **LOC moved:** ~150 (worker function + its private helpers)
- **LOC added:** ~10 (import path update + new module header)
- **Runtime behavior:** identical to pre-PR. Same cadence (180s), same Mongo writes, same log lines.
- **Memory footprint:** unchanged (the worker has no per-instance state).
- **Boot time:** unchanged (one extra import is sub-millisecond).

---

## §9 — Do-Not-Touch List

These systems are **frozen** for the duration of Phase 3 extraction. No PR may modify any item on this list unless explicitly re-scoped via an approved exception.

| # | Item | Source of freeze | Why frozen |
|---|------|------------------|------------|
| **DNT-1** | `ctx` singleton + `_DBProxy` | 3B §2.2, 3C §7 | The shared `AppContext` is the substrate every module reads. Mutating it during extraction would touch every PR. |
| **DNT-2** | Lifespan ordering | 3B §1, §4.1 above | The 8-stage startup spine is the only ordering guarantee. Extraction relocates *function definitions*, never the spine. |
| **DNT-3** | Redis lazy reconnect logic | 3B §2.2, 3C §7 (`_redis` row) | The retry-on-None pattern is what makes Redis-down a NO-OP instead of a crash. Touching this would change failure semantics during exactly the window Tier C hardening targets. |
| **DNT-4** | identity_runtime | 3A §4 (gates), §7 (JWT topology) | Auth has its own discipline and review surface. Bundling forbidden (P-4, G-3). |
| **DNT-5** | offer_packages subsystem (frozen domain) | `app/offer_packages/__init__.py` docstring, 3A §10, PHASE_6_OFFER_PACKAGES.md | Immutable commercial commitments. Lifecycle is frozen — draft → delivered → accepted/declined/revoked. No structural changes. |
| **DNT-6** | Notification semantics | PHASE_7_INBOX_NOTIFICATIONS.md, customer_notify_3a_frozen_2026_05_15.md | The customer-pipeline projection contract is frozen. PR-01 moves the *worker* that polls receipts, NOT the projection semantics. |
| **DNT-7** | Customer-facing workflow semantics (customer-grammar) | `frontend/src/customer-grammar/`, customer_loc_1_*, customer_nav_coherence_*.md | The grammar layer is the linguistic contract with end users. Worker extraction is invisible to customers; that invisibility is mandatory. |
| **DNT-8** | OpenAPI contract shape | `openapi.json` (517 endpoints) | The cross-surface contract. P-7 + G-7 enforce byte-stability. |
| **DNT-9** | i18n vocabulary | PHASE_5_I18N_FREEZE.md | Translation surface is frozen. No catalogue moves that would touch i18n keys (G-4 covers most of this). |
| **DNT-10** | Existence privacy rules | 3A §6 (visibility matrix) | The "does this account exist" privacy rule is enforced at the gate layer. Workers don't touch it; auth domain owns it (DNT-4). |
| **DNT-11** | Sentinel & special accounts | 3A §5 | Operational invariants. Workers should not enumerate or check sentinels. |
| **DNT-12** | Idempotency middleware (90s/24h policy) | `app/core/dedupe.py`, server.py:790–810 | The cross-cutting idempotency layer is itself the dedupe substrate (3C-H1/H2 target it). Don't restructure the substrate while using it. |
| **DNT-13** | `dedupe_bucket` semantics | 3C §3 row 2, §6 | Workers rely on the bucket-claim protocol. Same reason as DNT-12. |
| **DNT-14** | Realtime emitter contract (`ctx.emit.*`) | 3B §2.2, 3C §7 | Realtime side-channels are stable; extraction must not change their delivery semantics. |
| **DNT-15** | Mongo collection names | R-3 | No rename during Phase 3. Mis-named collections are deferred to post-Phase-3. |

Any PR that proposes to touch any DNT item must be re-scoped: either the touch is removed, or the work moves to a separate post-Phase-3 sprint with its own design doc.

---

## §10 — Final Sequencing Verdict

```
Phase 3A mapped trust.
Phase 3B mapped time.
Phase 3C mapped ownership.
Phase 3D defines movement.
```

**The operational core is already structurally separable.**

3C established it: 11 pure-writer collections each have exactly one owner worker; 0 worker-vs-worker write conflicts; 5 Tier-A workers carry zero inter-worker coupling; 6 Tier-B workers cluster into 3 natural pairs; 4 Tier-C workers carry latent hazards closeable by one index or one `dedupe_bucket` claim each.

The graph that prior sprints (Sprint 21's `ctx`, Sprint 24's Redis migration, Sprint 21 C15.1's `runner.start_all_loops`, Sprint Redis-Truthfulness's `dedupe_bucket`) *meant* to draw — they actually drew. 3C just discovered that the boundaries hold.

3D consumes that discovery and emits:
- **19 PRs** in a fixed order (PR-01..19, §3).
- **10 principles** (§1) that govern every PR.
- **10 gates** (§6) that block premature merges.
- **8 rollback guarantees** (§7) that make every PR reversible.
- **15 frozen surfaces** (§9) that no PR may touch.

**The remaining work is sequencing and discipline, not discovery.**

The minimum viable Phase 3 ships the Tier A queue (PR-01..05) — 5 workers, ~2.5 PR-days, zero hazard load. If nothing else lands, those five carve-outs are the highest-confidence moves in the entire roadmap.

The maximum viable Phase 3 ships all 19 PRs and ends with a fully extracted worker substrate, hardened Tier C money paths, retired NestJS dead code, and a tightened JWT_SECRET boot check — ~13 PR-days total (per 3C §10 estimate, ratified here).

**The first executable PR is PR-01: `receipts_poll_loop` extraction.** Single collection. Hard invariant ("1 row = 1 attempt"). Zero coupling. Sub-day PR. Maximum information per unit risk. It is the smallest meaningful step that validates the entire pattern.

After PR-01 lands and survives one rollback drill, the queue is mechanical. The plan ends there — execution is the next phase, not this one.

---

## Sign-off criteria for 3D

- [ ] §1 ten principles ratified by reviewer
- [ ] §2 Tier classifications match 3C §9 (no silent re-tiering)
- [ ] §3 PR sequence (PR-01..19) reviewed; no extraction PR precedes its hardening gate
- [ ] §4 startup spine (`init_db → models → indexes → bootstrap → loops`) confirmed immutable
- [ ] §5 mutable-globals strategy ("nothing to do") ratified
- [ ] §6 ten gates accepted as merge blockers
- [ ] §7 rollback doctrine accepted
- [ ] §8 first PR target (`receipts_poll_loop`) ratified
- [ ] §9 do-not-touch list locked
- [ ] No production code changed by this document (verified ✅)

Once these are checked, **the extraction sequence is frozen**. Execution begins with PR-01.
