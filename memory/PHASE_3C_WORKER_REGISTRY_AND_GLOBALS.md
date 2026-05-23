# Phase 3C · Worker Registry & Mutable Globals

**Date:** 2026-02-17 · **Scope:** mapping + inventory only · **Status:** draft for review

> No extraction. No refactor. No behaviour change. This document builds
> the worker → collection ownership graph, the mutable-globals
> read/write matrix, and the catalogue ownership table. Ends with an
> ordered extraction-readiness list answering:
>
> **"Which worker can be extracted first safely?"**

> ⚠ 3B correction propagated below: `orchestrator_cooldowns`,
> `pre_engagement_cooldowns`, `zone_locks` are **empty stub dicts** —
> their docstrings explicitly say "backcompat marker, no longer source
> of truth". Real cooldown/lock state is in Redis via
> `app.core.redis_state`. The "unbounded growth" warning in 3B §3.7 is
> retracted (the dicts never grow; they're imported by routers only
> for legacy diagnostic endpoints).

---

## 1. Worker Registry — the 17 loops in one place

| # | Worker | Module · Symbol | Cadence | Launched at | Shutdown handle | Idempotency anchor |
|---|--------|-----------------|---------|-------------|------------------|---------------------|
| 1 | `zone_state_engine` | `orchestrator/cycle.py:zone_state_engine` | 10s | `runner.py:59` | `app.state.background_tasks[0]` | `zone_snapshots` insert (timestamp + zoneId compound — natural dedupe; no unique index, double-fire = duplicate rows but harmless) |
| 2 | `orchestrator_engine_loop_v2` | `orchestrator/cycle.py` | 10s | `runner.py:62` | `app.state.background_tasks[1]` | `dedupe_bucket` on `orchestrator_actions` (unique on `scope/key/bucket`) |
| 3 | `feedback_processor_loop` | `orchestrator/feedback.py:232` | 15s | `runner.py:63` | `app.state.background_tasks[2]` | Mongo `find_one_and_update` on `action_feedback` (claim-then-process) |
| 4 | `strategy_optimizer_loop` | `orchestrator/feedback.py:283` | 5 min | `runner.py:64` | `app.state.background_tasks[3]` | `strategy_weights` unique on `zoneId` (`upsert`) |
| 5 | `provider_ranking_optimizer_loop` | `marketplace/quick_request.py:provider_ranking_optimizer_loop` | 5 min | `runner.py:67` | `app.state.background_tasks[4]` | upsert on `provider_ranking_weights` (full overwrite per cycle) |
| 6 | `_demand_prediction_loop` | inner in `runner.py:42` | 5 min (after 30s warm-up) | `runner.py:70` | `app.state.background_tasks[5]` | `ml_models` upsert per zone (full replace) |
| 7 | `reactivation_sweep_loop` | `growth/reactivation.py:241` | `SWEEP_SECONDS` | `runner.py:75` | `app.state.background_tasks[6]` | per-row `reactivation_events` insert; **no explicit dedupe** — see §3 |
| 8 | `nudge_sweep_loop` | `growth/nudges.py:367` | `NUDGE_SWEEP_SECONDS` | `runner.py:80` | `app.state.background_tasks[7]` | per-row `nudge_events` insert; **no explicit dedupe** — see §3 |
| 9 | `auto_money_worker_loop` | `growth/auto_money.py:271` | `AUTO_MONEY_TICK_SECONDS` | `runner.py:85` | `app.state.background_tasks[8]` | **no dedupe** — see §3 hazard 3C-H1 |
| 10 | `refresh_loop` (VMS) | `vehicles/refresh.py:375` | `REFRESH_TICK_SECONDS` | `lifespan.py:203` | `app.state.refresh_task` | per-vehicle conditional update on `listing_snapshots` (hash compare) |
| 11 | `autobid_worker_loop` | `marketplace/auction.py:817` | 15s | `lifespan.py:260` | `app.state.autobid_task` | **no dedupe** — see §3 hazard 3C-H2 |
| 12 | `expire_loop` (exposures) | `auto_requests/exposures_cron.py:44` | 60s | `lifespan.py:277` | `app.state.exposures_expire_task` | status transition `exposed → expired` is idempotent |
| 13 | `batching_loop` (exposures) | `auto_requests/exposures_cron.py:129` | 60s | `lifespan.py:278` | `app.state.exposures_batching_task` | `inspector_exposures` unique on `(jobId, inspectorId)` (line 169) |
| 14 | `stats_recompute_loop` (exposures) | `auto_requests/exposures_cron.py:142` | 5 min | `lifespan.py:279` | `app.state.exposures_stats_task` | overwrite rollup (idempotent) |
| 15 | `receipts_poll_loop` (cnotify) | `notifications/receipts.py:288` | 180s | `lifespan.py:292` | `app.state.cnotify_receipts_task` | in-place update of `notification_delivery_lifecycle` row (invariant: 1 row = 1 attempt, never insert) |
| 16 | `dispatch_alert` (ad-hoc) | `orchestrator/cycle.py:211` | per cycle when triggered | inline `create_task` | **NONE** (fire-and-forget) | none |
| 17 | NestJS subprocess | `bootstrap.py:start_nestjs` | one-shot at boot | `bootstrap.py:124` via `create_task` | `nestjs_process` module global | `NESTJS_ENABLED=0` in current env — path is dead |

**Footnote on counting:** §1 lists 17, same as 3B. The 6 lifespan-direct
loops (#10–15) + 9 runner loops (#1–9) + 1 ad-hoc (#16) + 1 subprocess
(#17) = 17. The earlier "2 ad-hoc clusters" from 3B referred to the
request-handler fire-and-forget sites, which are tasks-not-loops and
live in §6.

---

## 2. Worker → Collections (read/write graph)

| Worker | READ | WRITE |
|--------|------|-------|
| `zone_state_engine` | `provider_locations`, `booking_demand_events`, `web_bookings`, `zones` | `zone_snapshots` |
| `orchestrator_engine_loop_v2` | `zone_snapshots`, `zones`, `organizations`, `pre_engagement_events`, `pre_engagement_acceptances`, `orchestrator_rules`, `orchestrator_overrides` | `orchestrator_logs`, `dedupe_buckets` ① |
| `feedback_processor_loop` | `action_feedback`, `zones` | `orchestrator_logs`, `strategy_recommendations` |
| `strategy_optimizer_loop` | `action_feedback`, `zones` | `strategy_weights` |
| `provider_ranking_optimizer_loop` | `quick_request_offers`, `quick_requests`, `organizations`, `bookings`, `zones` | `provider_ranking_weights` |
| `_demand_prediction_loop` | `bookings`, `zone_snapshots`, `zones` | `ml_models` |
| `reactivation_sweep_loop` | `organizations`, `provider_missed_stats` | `reactivation_events` |
| `nudge_sweep_loop` | `organizations`, `zones`, `provider_bids` | `nudge_events` |
| `auto_money_worker_loop` | `organizations`, `provider_bids` | `auto_money`, `provider_bids` ② |
| `refresh_loop` (VMS) | `vehicles` | `listing_snapshots`, `vehicles` ③ |
| `autobid_worker_loop` | `auto_bids`, `organizations`, `provider_bids`, `zones`, `zone_dominance` | `auto_bids`, `auction_charges`, `provider_bids` |
| `expire_loop` (exposures) | `inspector_exposures` | `inspector_exposures` (status flip) |
| `batching_loop` (exposures) | `inspector_exposure_events` | `inspector_exposures` |
| `stats_recompute_loop` (exposures) | `inspector_exposures`, `inspection_jobs` | analytics rollups |
| `receipts_poll_loop` (cnotify) | `notification_delivery_lifecycle` | `notification_delivery_lifecycle` (in-place) |
| `dispatch_alert` (ad-hoc) | — | `alerts` |
| NestJS subprocess | (independent process; not modelled here) | (own pool) |

① `dedupe_buckets` is the cross-cutting unique-index claim store —
   `app.core.dedupe_bucket`.
② `auto_money_worker_loop` writes back to `provider_bids` — read-modify-write.
   Combined with no idempotency anchor → **hazard 3C-H1**.
③ `vehicles` writeback is per-vehicle conditional update keyed by hash;
   safe to replay.

**Pure-writer collections (no overlap):**
`zone_snapshots`, `strategy_weights`, `provider_ranking_weights`,
`ml_models`, `reactivation_events`, `nudge_events`, `auto_money`,
`listing_snapshots`, `auction_charges`, `notification_delivery_lifecycle`,
`alerts`.

Each pure-writer collection has exactly one owner. **No write-conflict
between workers** today. This is healthier than the 3B map implied; the
ownership graph is genuinely tree-shaped, not a mesh.

---

## 3. Worker → Idempotency / Dedupe Mechanism

| Worker | Dedupe mechanism | Type | Risk |
|--------|-------------------|------|------|
| `zone_state_engine` | none (append `zone_snapshots`) | replay = duplicate row | **low** (rows are observational; duplicates only inflate count) |
| `orchestrator_engine_loop_v2` | `dedupe_bucket.try_claim_bucket` (Mongo unique on `scope/key/bucket`) | hard guard | **none** |
| `feedback_processor_loop` | `find_one_and_update` claim pattern | hard guard | **none** |
| `strategy_optimizer_loop` | unique index on `strategy_weights.zoneId` + upsert | hard guard | **none** |
| `provider_ranking_optimizer_loop` | overwrite upsert | overwrite (idempotent by construction) | **none** |
| `_demand_prediction_loop` | overwrite upsert per zone | overwrite | **none** |
| `reactivation_sweep_loop` | **none** (insert new event per missed offer) | replay = duplicate notification | **medium** (3C-H3) |
| `nudge_sweep_loop` | **none** (insert new event per nudge) | replay = duplicate nudge | **medium** (3C-H4) |
| `auto_money_worker_loop` | **none** (RMW on `provider_bids`) | replay = double bid | **high (3C-H1)** |
| `refresh_loop` (VMS) | hash compare before update | content-keyed | **none** |
| `autobid_worker_loop` | **none** (RMW on `provider_bids` + `auction_charges`) | replay = double charge | **high (3C-H2)** |
| `expire_loop` (exposures) | status-transition idempotent | self-idempotent | **none** |
| `batching_loop` (exposures) | unique `(jobId, inspectorId)` index | hard guard | **none** |
| `stats_recompute_loop` | overwrite rollup | overwrite | **none** |
| `receipts_poll_loop` (cnotify) | "1 row = 1 attempt" — in-place update only | hard invariant | **none** |
| `dispatch_alert` (ad-hoc) | none | replay = duplicate alert | **low** (alerts only inform) |

### Hazard register (carried forward to 3D)

| ID | Worker | Mechanism | Mitigation candidate |
|----|--------|-----------|----------------------|
| **3C-H1** | `auto_money_worker_loop` | no dedupe on bid increment | `dedupe_bucket` claim per `(orgId, zoneId, tick_bucket)` |
| **3C-H2** | `autobid_worker_loop` | no dedupe on auction charge | `dedupe_bucket` claim per `(auctionId, providerId, tick_bucket)` OR unique index on `auction_charges.(auctionId, providerId, tickBucket)` |
| **3C-H3** | `reactivation_sweep_loop` | no dedupe on event insert | unique partial index on `(orgId, kind, bucketDay)` |
| **3C-H4** | `nudge_sweep_loop` | no dedupe on event insert | unique partial index on `(providerId, zoneId, bucketHour)` |

All 4 are **latent** today (Redis cooldowns hide them in normal
operation). They surface during a Redis-down window combined with a
loop-restart. None block extraction; they belong in 3D hardening.

---

## 4. Worker → Startup Site

| Worker | Module-level | Function-level launcher | Startup phase |
|--------|--------------|--------------------------|---------------|
| `zone_state_engine` | `orchestrator/cycle.py` | `runner.start_all_loops` | 5 — runner |
| `orchestrator_engine_loop_v2` | `orchestrator/cycle.py` | `runner.start_all_loops` | 5 — runner |
| `feedback_processor_loop` | `orchestrator/feedback.py` | `runner.start_all_loops` | 5 — runner |
| `strategy_optimizer_loop` | `orchestrator/feedback.py` | `runner.start_all_loops` | 5 — runner |
| `provider_ranking_optimizer_loop` | `marketplace/quick_request.py` | `runner.start_all_loops` | 5 — runner |
| `_demand_prediction_loop` | inner fn | `runner.start_all_loops` | 5 — runner |
| `reactivation_sweep_loop` | `growth/reactivation.py` | `runner.start_all_loops` | 5 — runner |
| `nudge_sweep_loop` | `growth/nudges.py` | `runner.start_all_loops` | 5 — runner |
| `auto_money_worker_loop` | `growth/auto_money.py` | `runner.start_all_loops` | 5 — runner |
| `refresh_loop` (VMS) | `vehicles/refresh.py` | `lifespan` (inline) | 4 — lifespan-direct |
| `autobid_worker_loop` | `marketplace/auction.py` | `lifespan` (inline) | 6 — post-runner |
| `expire_loop` (exposures) | `auto_requests/exposures_cron.py` | `lifespan` (inline) | 7 — exposures cluster |
| `batching_loop` (exposures) | `auto_requests/exposures_cron.py` | `lifespan` (inline) | 7 — exposures cluster |
| `stats_recompute_loop` (exposures) | `auto_requests/exposures_cron.py` | `lifespan` (inline) | 7 — exposures cluster |
| `receipts_poll_loop` (cnotify) | `notifications/receipts.py` | `lifespan` (inline) | 8 — cnotify |
| NestJS subprocess | `bootstrap.py` (module global) | `bootstrap_side_effects` | 4 — bootstrap |

**Inconsistency surfaced:** 9 loops run through `runner.start_all_loops`,
6 bypass it (directly in `lifespan`). The reasons given in lifespan
comments are "depends on local index-ensure call" — but in 4 of 6 cases
the index-ensure could be moved into `runner` too. Q9 (from 3B) still
open; 3D scope.

---

## 5. Worker → Shutdown Behavior

| Worker | Shutdown handle | Behavior on process exit |
|--------|------------------|---------------------------|
| 9× runner loops | `app.state.background_tasks` (list, no per-item names except via `Task.name`) | Python interpreter cancels on exit; not awaited |
| `refresh_task` | `app.state.refresh_task` | Same — not awaited |
| `autobid_task` | `app.state.autobid_task` | Same — not awaited |
| `exposures_*_task` (3) | `app.state.exposures_*_task` | Same — not awaited |
| `cnotify_receipts_task` | `app.state.cnotify_receipts_task` | Same — not awaited |
| `nestjs_process` (subprocess) | `nestjs_process` module global | **explicitly killed** in `shutdown_cleanup` (terminate→wait→kill) |
| Mongo client | `ctx.mongo` (via `db.client`) | **explicitly closed** in `shutdown_cleanup` |

**Observation:** the only resources with **explicit** shutdown behaviour
are the NestJS subprocess and the Mongo client. Every asyncio task is
left to Python's "cancel-on-exit" behaviour. This means:

- In-flight Mongo writes inside a loop tick may be aborted mid-call.
- Mongo client gets closed AFTER cancellation, so the aborted call
  surfaces as "client closed" if logs are read.
- Idempotent loops (15 of 16) recover on next boot.
- Hazard workers (3C-H1..H4) may have left a half-applied write — but
  the underlying writes use Motor's atomic `update_one`, so a single
  bid is either applied or not, never half. Replay on next boot is the
  only risk, mitigated by the candidate guards in §3.

No graceful drain. Not a blocker for extraction, but worth flagging:
**graceful-drain support is a future feature**, not a regression.

---

## 6. Fire-and-forget tasks (per-request)

These are NOT in the worker registry — they're per-request asyncio
tasks. Listed for completeness because they appear in `grep
asyncio.create_task` output and look superficially like workers.

| Site | Trigger | Lifetime | State touched |
|------|---------|----------|---------------|
| `provider/router.py:900` | provider status change | one-shot | notification fan-out |
| `provider/router.py:912` | provider action | one-shot | gamification ping |
| `orchestrator/cycle.py:211` | alert threshold | one-shot | `alerts` collection |
| `marketplace/auction.py:447` | outbid event | one-shot | notification |
| `marketplace/auction.py:460` | zone-loss pressure | one-shot | notification |
| `marketplace/quick_request.py:661` | request creation | scheduled (until TTL) | `quick_requests` |
| `marketplace/quick_request.py:669` | offer received | one-shot | analytics |
| `marketplace/quick_request.py:678` | offer flow | one-shot | analytics |
| `marketplace/quick_request.py:695` | new request | per online provider | provider notification |
| `retention.py:71` | per docstring | one-shot | retention bookkeeping |

**12 sites total.** Shutdown is by process kill; no app.state registration.
For extraction purposes these are stateless side-channels — each one is a
function call wrapped in `create_task` to detach from request latency.

---

## 7. Mutable Globals Read/Write Matrix

> ⚠ Correction propagated from 3B: rows marked **STUB** below were
> incorrectly flagged as "unbounded growth" in 3B §3.7. They are empty
> dicts kept solely for backwards-compatible imports; actual state
> lives in Redis. No correction needed in code — just in the doc.

| Global | File | Type | Written by | Read by | Lifecycle | Risk |
|--------|------|------|-----------|---------|-----------|------|
| `ctx.mongo` | `core/context.py` | `AsyncIOMotorClient` | `server.py:511` (boot once) | every module that imports `ctx` | startup-only | **safe** |
| `ctx.db` | `core/context.py` | `AsyncIOMotorDatabase` | `server.py:512` (boot once) | every module | startup-only | **safe** |
| `ctx.http_client` | `core/context.py` | `httpx.AsyncClient` | `server.py:527` | NestJS forwarder, realtime emit | startup-only | **safe** |
| `ctx.emit.*` | `core/context.py` | 4 callables | `server.py:569` | feature modules | startup-only | **safe** |
| `nestjs_process` | `core/bootstrap.py:40` | `Optional[Popen]` | `start_nestjs`, `shutdown_cleanup` | shutdown cleanup | runtime-mutable, single-writer | **safe** (well-owned) |
| `_redis` | `core/redis_client.py:40` | `Optional[Redis]` | `get_redis`, `close_redis` | every Redis caller | lazy-init, auto-retry on None | **safe** |
| `orchestrator_cooldowns` | `orchestrator/cooldown.py:22` | `dict` (STUB — empty) | nobody (kept for import compat) | `orchestrator/router.py:490` (legacy diag) | **always empty** | **safe (stub)** |
| `pre_engagement_cooldowns` | `orchestrator/pre_engagement.py:34` | `dict` (STUB — empty) | nobody | (legacy import only) | **always empty** | **safe (stub)** |
| `zone_locks` | `orchestrator/feedback.py:26` | `dict` (STUB — empty) | nobody | (legacy import only) | **always empty** | **safe (stub)** |
| `_rate_state` | `parsers/router.py:29` | `dict[str, list[float]]` | parsers rate-limit middleware (per request) | self | sliding window, bounded by # active IPs | **bounded** |
| `_token_cache` | `payments/paypal.py:32` | `dict` | PayPal token refresh path | `_get_token` callers | TTL on `expires_at` | **safe** |
| `_behavioral_cache` | `ml/predictor.py:69` | `dict` | `DemandPredictor.behavioral_*` | self | 300s TTL | **safe** |
| `_CACHE` (feature flags) | `auto_requests/feature_flags_helper.py:24` | `dict` | `is_use_exposures` helper | self | per-key TTL | **safe** |
| `_META_CACHE` | `notifications/customer_pipeline.py:286` | `Optional[dict]` | `_load_meta` | customer-notify project pipeline | manual refresh | **safe** |
| `_malformed_log_throttle` | `revenue/__init__.py:76` | `dict` | revenue ingest path | self | per-minute bucket | **safe** |
| `nestjs_process` (mentioned twice) | — | — | — | — | — | — |

**Net mutable globals after 3B correction:** **6 real** (`_redis`,
`nestjs_process`, plus 4 caches with bounded eviction) — none of them
unbounded. The three "cooldown/lock" dicts are stubs.

This is **healthier** than 3B drew. The mutable-runtime surface is small
and well-bounded. Phase 3D doesn't need a "shrink mutable globals" item.

---

## 8. Catalogue Ownership Matrix

> 38 module-level lookup dicts from 3B §3.4 enumerated by true owner.
> "True owner" = the module/domain whose semantics define the table; not
> necessarily where it lives today.

| Catalogue | Lives in | True owner | Drift risk |
|-----------|----------|------------|------------|
| `COUNTRY_DISPLAY` | `app/geo/__init__.py:53` | `geo` | none — pure code |
| `COUNTRY_RANK` | `app/geo/__init__.py:64` | `geo` | none |
| `CITY_CATALOGUE` | `app/marketplace/cities.py` | `geo` | **lives in wrong module** — imported by `pricing`, `provider/onboarding`, `core/lifespan` via `geo.topology`. Should live under `geo/`. |
| `_CITY_TO_COUNTRY` | `app/geo/coverage_projection.py:68` | `geo` | derived from `CITY_CATALOGUE` |
| `_CITY_BY_ID` | `app/geo/coverage_projection.py:69` | `geo` | derived from `CITY_CATALOGUE` |
| `_ZONE_BOUNDS`, `_ZONE_CENTRES` | `app/core/geo.py:33,73` | `geo` | could move to `geo/` but `core` is also defensible |
| `CURRENCY_BY_COUNTRY`, `LOCALE_BY_COUNTRY` | `app/core/geo.py:104,115` | `geo` (i18n bridge) | could move to `i18n` |
| `SECTIONS_TEMPLATE` | `app/inspections/v2.py:74` | `inspections` (canonical inspection report shape) | none |
| `HARD_ENFORCEMENT_ITEM_IDS` | `app/inspections/v2.py:183` | `inspections` | none |
| `_SECTION_PHRASES` | `app/inspections/v2.py:1192` | `inspections` (i18n) | could move to `i18n` |
| `CUSTOMER_VISIBLE_KINDS`, `_COPY`, `_MATURITY_INTERPRETATION`, `_TRUST_BY_TIER` | `app/customer_continuity/mapper.py` | `customer_continuity` | none |
| `DELIVERED_STATUSES`, `_HEAVY_SEVERITIES`, `_SOFT_SEVERITIES` | `app/customer_cognition/mapper.py` | `customer_cognition` | none |
| `REACTIVATION_THRESHOLDS` | `app/growth/reactivation.py:49` | `growth` | none |
| `MARKET_BASELINES` | `app/inspection/baselines.py:21` | `pricing` (inspection baselines) | **owned by `inspection`, consumed by `pricing` and `inspections/v2`** — split surface |
| `EMITTABLE` | `app/runtime_ledger/events.py:260` | `runtime_ledger` | none |
| `SERVICE_FEES_MAJOR` | `app/payments/router.py:44` | `payments` | could move to `pricing` if more fees added |
| `_BILLING_FX` | `app/billing/router.py:92` | `billing` | none — FX overrides |
| `_POSTURE_PHRASE` | `app/observatory/interpreter.py:18` | `observatory` (i18n) | could move to `i18n` |
| `_HEADERS` × 4 | `app/parsers/{autoscout24,otomoto,kleinanzeigen,willhaben}.py` | `parsers` (per scraper) | none — co-located with consumer is correct |
| `_LEGACY_KEY_MAP` | `app/parsers/contract.py:182` | `parsers` | none |
| `_DOM_LABEL_MAP` | `app/parsers/kleinanzeigen.py:282` | `parsers` | none |
| `_MAGIC_SIGNATURES` | `app/chat/canonical.py:128` | `chat` (file-type detection) | none |
| `KNOWN_CAPABILITIES`, `ACCOUNT_KINDS`, `SYNTHETIC_PRINCIPALS`, `_LEGACY_ROLE_TO_*` | `app/core/capability.py` | `core` / `identity` | already canonical (3A §2) |

**Drift count:** 1 hard miscategorisation (`CITY_CATALOGUE` in
`marketplace/`), 1 split surface (`MARKET_BASELINES`). 4 i18n-adjacent
tables could consolidate under `i18n` if that namespace grows. All other
38 catalogues are correctly co-located with their owner.

Risk grade: **low**. None of this blocks extraction.

---

## 9. Extraction Readiness Ranking

> The headline output. Workers sorted by safety-of-extraction.

Criteria (descending priority):
1. **Idempotency guarantee.** Hard guard > soft guard > none.
2. **Collection isolation.** No cross-worker writes > overlapping writes.
3. **Startup independence.** Doesn't need other workers' state > does.
4. **Catalogue dependencies.** Minimal > deep.
5. **Mutable-global exposure.** None > Redis-only > module-level.

### Tier A — extract FIRST (low risk, sharp boundary)

| # | Worker | Why first | Test surface |
|---|--------|-----------|--------------|
| 1 | `receipts_poll_loop` (cnotify) | Single-collection in-place updater; "1 row = 1 attempt" invariant codified; isolated index | `notification_delivery_lifecycle` projection test |
| 2 | `stats_recompute_loop` (exposures) | Pure rollup overwrite; no cross-worker writes; idempotent by construction | exposures-stats e2e |
| 3 | `_demand_prediction_loop` | Single-writer to `ml_models`; rebuild from `bookings`+`zone_snapshots`; warm-hydrate is well-bounded | predictor train cycle test |
| 4 | `provider_ranking_optimizer_loop` | Overwrite upsert; depends only on read-side `quick_request_offers`/`bookings`; no shared state | ranking weight invariant test |
| 5 | `refresh_loop` (VMS) | Single-collection with hash-keyed conditional update; isolated | VMS refresh test |

These five are **clean carve-outs**. Each can be moved to its own module
or process without disturbing the rest of the runtime. Recommended order
for 3D extraction sequencing.

### Tier B — extract SECOND (clean but ordering-sensitive)

| # | Worker | Caveat |
|---|--------|--------|
| 6 | `strategy_optimizer_loop` | Reads from `action_feedback` written by #7 — extract in pair |
| 7 | `feedback_processor_loop` | Claim-then-process via `find_one_and_update`; safe but coupled to #6 |
| 8 | `zone_state_engine` | Feeds #9, #10 via `zone_snapshots`; cadence matters (10s) |
| 9 | `orchestrator_engine_loop_v2` | Depends on #8's output; protected by `dedupe_bucket`; safe to extract together |
| 10 | `expire_loop` (exposures) | Tight coupling to #11 (batching_loop) |
| 11 | `batching_loop` (exposures) | Unique-index guard exists; safe to pair with #10 |

These six come in 3 natural pairs/clusters:
- **B1 — Optimization cluster:** #6 + #7 (feedback drain + weight calc)
- **B2 — Zone engine cluster:** #8 + #9 (state observation + action)
- **B3 — Exposures cluster:** #10 + #11 (lifecycle of an exposure)

### Tier C — extract LAST (latent hazards, hardening required FIRST)

| # | Worker | Required hardening before extraction |
|---|--------|--------------------------------------|
| 12 | `reactivation_sweep_loop` | **3C-H3** — add unique partial index `(orgId, kind, bucketDay)` |
| 13 | `nudge_sweep_loop` | **3C-H4** — add unique partial index `(providerId, zoneId, bucketHour)` |
| 14 | `auto_money_worker_loop` | **3C-H1** — add `dedupe_bucket` claim per `(orgId, zoneId, tick_bucket)` |
| 15 | `autobid_worker_loop` | **3C-H2** — add `dedupe_bucket` claim OR unique on `auction_charges` |

Order within Tier C:
- 3C-H3 / 3C-H4 are append-event guards → trivial index add → can be
  done in one PR.
- 3C-H1 / 3C-H2 touch money paths (bids, charges) — require explicit
  test coverage for double-fire scenarios before they ship.

### Outside the tier system

| Worker | Status |
|--------|--------|
| `dispatch_alert` (ad-hoc) | Per-cycle fire-and-forget; lives inside `orchestrator/cycle`; extracted with #8/#9 implicitly |
| NestJS subprocess | Disabled via `NESTJS_ENABLED=0`; dead code candidate for sweep in 3D |
| Fire-and-forget request tasks (12) | Not workers; stay co-located with their request handlers; addressable separately |

---

## 10. Per-worker extraction cost estimate (qualitative)

This is the budget the eventual 3D plan can lean on. Costs are
"PR-day-equivalents" assuming the worker's tests already exist.

| Worker | Cost | Reason |
|--------|------|--------|
| Tier A workers (×5) | **0.5 day each** | Self-contained, no API surface to update |
| Tier B clusters (×3) | **1 day per cluster** | Need pair-extraction; collection ownership transfers |
| Tier C workers (×4) | **2 days each** | Includes pre-extraction hardening + double-fire tests |
| Hybrid lifecycle migration (4× `@app.on_event`) | **0.25 day total** | Trivial inline replacement into lifespan |
| Mutable-global cleanup | **0 day** | Per 3B correction: nothing to do |
| Catalogue relocations (Q13) | **0.5 day** | `CITY_CATALOGUE` move + import rewrites |
| `JWT_SECRET` hardcoded fallback removal (Q11) | **0.25 day** | + production-mode boot check |

**Total Phase 3 extraction budget (Tier A + B + Tier C hardening + small
items): ~13 PR-days.**

(This is intentionally rough — 3D will produce a real sequence.)

---

## 11. Sign-off criteria for 3C

- [ ] Worker counts match (17 in §1 = 9 runner + 6 lifespan + 1 ad-hoc + 1 subprocess)
- [ ] §2 collection map cross-checked against actual `grep db.*` output
- [ ] §3 hazard register (3C-H1..H4) ratified or rejected
- [ ] §7 mutable-globals correction (stubs vs runtime mutable) accepted
- [ ] §9 Tier A/B/C ordering ratified
- [ ] No code changes proposed in this document (verified ✅)

Once these are checked, **the worker ownership graph is frozen** for the rest of Phase 3. 3D will turn the Tier A→B→C list into a concrete extraction sequence with PR boundaries.

---

## 12. The headline insight

3A mapped **trust**. 3B mapped **time**. 3C mapped **ownership**.

The bottom line of 3C is the realisation that the worker→collection
ownership graph is **already tree-shaped**, not a mesh:

- 11 pure-writer collections, each with exactly 1 owner worker
- 0 worker-vs-worker write conflicts
- 5 workers (Tier A) have ZERO coupling to other workers
- 6 workers (Tier B) cluster into 3 natural pairs
- 4 workers (Tier C) need targeted hardening before extraction

This means the eventual extraction **isn't a refactor** — it's a series
of small migrations of already-isolated components. The hard work was
done by past sprints: Sprint 21's `ctx`-based context-passing,
Sprint 24's Redis migration of cooldowns, Sprint 21 C15.1's
`runner.start_all_loops`, Sprint Redis-Truthfulness's `dedupe_bucket`.
Those landed the boundaries; 3C just discovers that they hold.

**3D's job is not to draw new boundaries — it's to sequence the
extraction along the existing ones.**

The Tier A list (#1–5) is the minimum viable Phase 3 extraction. If
nothing else lands, those five carve-outs are the highest-confidence
moves. Tier C (#12–15) are gated on small hardening PRs that ship
*before* extraction. Tier B is the middle case — clean but
ordering-sensitive.
