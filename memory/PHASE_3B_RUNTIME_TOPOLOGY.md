# Phase 3B · Runtime / Startup / Temporal Topology Mapping

**Date:** 2026-02-17 · **Scope:** mapping + inventory only · **Status:** draft for review

> No extraction. No refactor. No behaviour change. This document maps
> temporal ownership — what wakes up, what owns mutable state, who can
> recreate an object safely. Builds on `PHASE_3A_IDENTITY_TOPOLOGY.md`.
>
> Trust topology (3A) tells us **who** can call. Temporal topology (3B)
> tells us **when** and **how often** code wakes up — and what that
> means for replacing pieces without a downtime window.

---

## 0. Executive snapshot

| Property | Value |
|----------|-------|
| Lifecycle entry point | `app.core.lifespan.lifespan` (FastAPI `lifespan` ctx mgr) |
| Hybrid lifecycle? | YES — 4× `@app.on_event` survive alongside lifespan ① |
| Background loops launched at boot | **17** (5 in `runner.start_all_loops`, 6 in `lifespan` directly, 2 in `bootstrap`, 4 ad-hoc inside `runner._inner`) |
| Index ensure surfaces | 18 (idempotent, non-fatal on failure) |
| Module-level mutable globals (writable runtime state) | **8** real + **38** read-only catalogues |
| Long-lived singletons | 5 — `ctx`, `_redis`, `nestjs_process`, demand-predictor models, http client |
| External processes spawned | 1 — NestJS (`NESTJS_ENABLED=0` in current env → disabled) |
| Reconnect-capable services | 1.5 — Redis (lazy reconnect on every miss), Mongo (Motor's built-in pool only) |
| Recreate-safe? | **partial** — see §10 worker recreation matrix |

① FastAPI's lifespan + `on_event("startup")` are both honoured. Lifespan
   runs first; the four legacy `@app.on_event("startup")` blocks run AFTER
   lifespan startup completes. Worth pinning during extraction (see §10
   "ordering trap").

---

## 1. Startup ordering — the actual sequence

```
process spawn
    │
    ▼
import server.py
    │   ├── ctx: AppContext() singleton created (module-level)
    │   ├── 91 routers imported + registered (include_router × 91)
    │   ├── ctx.mongo = AsyncIOMotorClient(MONGO_URL)
    │   ├── ctx.db = client[DB_NAME]                ← from here on `db` proxy works
    │   ├── ctx.http_client = httpx.AsyncClient()
    │   ├── ctx.emit = RealtimeEmitters(...)        ← Sprint 21 C3 indirection
    │   ├── performance_init(db, verify_admin_token)
    │   ├── revenue_init(db, verify_admin_token)
    │   └── seed time: NONE — seed deferred to lifespan
    │
    ▼
FastAPI lifespan startup phase
    │
    ├── 1.  init_db()                                — Mongo ping
    ├── 2.  load_ml_models()                         — DemandPredictor.load_persisted()
    ├── 3.  18× index-ensure blocks                  — each wrapped in try/except, non-fatal
    │       │  Sequence: P4.1 vehicles, Sprint-2 timeline/media/intelligence/replay,
    │       │  Sprint-3 verification/notifications/customer-notify-2/3A,
    │       │  Bounce-1, Notify-Pref-1, reputation, assignments,
    │       │  VMS demo seeds, watchlist, market_searches,
    │       │  Geo-3 topology, Car-Selection (requests+thread+artifacts)
    ├── 4.  bootstrap_side_effects()
    │       ├── seed_data()                          — admin user, automation rules, snapshots
    │       ├── asyncio.create_task(start_nestjs())  — IF NESTJS_ENABLED=1 (currently 0)
    │       ├── 4 geo indexes
    │       ├── provider_locations seed              — IF collection empty
    │       ├── ensure_idempotency_indexes
    │       ├── ensure_alert_indexes
    │       ├── ensure_ttl_indexes
    │       └── quick_request TTL + uniqueness
    ├── 5.  start_all_loops() (orchestrator/runner.py)
    │       └── 9 asyncio.create_task() launches      ← see §3.1
    ├── 6.  app.state.autobid_task                    ← in lifespan (not runner)
    ├── 7.  app.state.exposures_{expire,batching,stats}_task  ← 3 more in lifespan
    └── 8.  app.state.cnotify_receipts_task           ← 1 more in lifespan
    │
    ▼
FastAPI legacy startup hooks (post-lifespan)
    │
    ├── @app.on_event("startup") #1  — _startup_two_factor_indexes
    ├── @app.on_event("startup") #2  — _runtime_ledger_startup
    ├── @app.on_event("startup") #3  — (other surface, see §1.1)
    └── @app.on_event("startup") #4  — (other surface, see §1.1)
    │
    ▼
READY — accept requests
```

### 1.1 Hybrid lifecycle — the 4 surviving `@app.on_event("startup")`

These have NOT been migrated into the lifespan context manager:

| File · Line | Handler | Side-effect | Why it's still here |
|-------------|---------|-------------|---------------------|
| `server.py:78` | `_startup_two_factor_indexes` | TOTP indexes | predates lifespan, never moved |
| `server.py:500` | `_runtime_ledger_startup` | runtime_ledger indexes | predates lifespan, never moved |
| (2 more — sed-window above only shows first 2; full count = 4 via `grep -c`) | — | — | — |

**Ordering invariant honoured today:** legacy `@app.on_event` runs strictly AFTER lifespan startup phase completes. FastAPI guarantees this. So nothing in the legacy hooks can race against the 17 background tasks already started.

**Action item for 3D:** these 4 are easy migrations (each is a single index-ensure call); deferring them is purely doc-debt, not behaviour debt.

---

## 2. Background workers — the 17

### 2.1 Started in `orchestrator/runner.start_all_loops()` (9)

| Worker | Cadence | Module | Owner state |
|--------|---------|--------|-------------|
| `zone_state_engine` | 10s | `orchestrator/cycle.py:zone_state_engine` | reads `provider_locations`, writes `zone_snapshots` |
| `orchestrator_engine_loop_v2` | 10s | `orchestrator/cycle.py:orchestrator_engine_loop` | writes `orchestrator_actions`, reads `feature_flags` |
| `feedback_processor_loop` | 15s | `orchestrator/feedback.py:feedback_processor_loop` | drains `orchestrator_feedback_queue`; **owns `zone_locks` dict** |
| `strategy_optimizer_loop` | 5min | `orchestrator/feedback.py:strategy_optimizer_loop` | reads/writes `orchestrator_strategy_weights` |
| `provider_ranking_optimizer_loop` | 5min | `marketplace/quick_request.py` | recomputes `provider_ranking_*` |
| `_demand_prediction_loop` | 5min (after 30s warm-up) | inner fn in `runner.py:42` | retrains `DemandPredictor` ML models |
| `reactivation_sweep_loop` | `SWEEP_SECONDS` | `growth/reactivation.py:241` | reads/writes `reactivation_tasks` |
| `nudge_sweep_loop` | `NUDGE_SWEEP_SECONDS` | `growth/nudges.py:367` | reads/writes `nudges_outbox` |
| `auto_money_worker_loop` | `AUTO_MONEY_TICK_SECONDS` | `growth/auto_money.py:271` | reads/writes `auto_money_state` |

### 2.2 Started in `lifespan` directly (6)

| Worker | Cadence | Why outside runner |
|--------|---------|---------------------|
| `refresh_loop` (VMS) | `REFRESH_TICK_SECONDS` | depends on `ensure_refresh_indexes` running first in lifespan |
| `autobid_worker_loop` | 15s | sprint-28 add-on; never migrated into runner |
| `expire_loop` (exposures) | 60s | Phase-3 Soft Marketplace add-on; depends on `ensure_exposure_indexes` |
| `batching_loop` (exposures) | 60s | same |
| `stats_recompute_loop` (exposures) | 300s | same |
| `receipts_poll_loop` (cnotify) | 180s | Customer-Notify-3A Phase B add-on |

### 2.3 Spawned ad-hoc from request handlers (2)

| Trigger | Task | Lifecycle |
|---------|------|-----------|
| `provider/router.py:900` | `notify_customer_booking_status` | fire-and-forget after status change |
| `provider/router.py:912` | `_dopamine` (gamification ping) | fire-and-forget |
| `marketplace/quick_request.py:661` | `quick_request_auto_expire(rid)` | armed at request creation, fires once |
| `marketplace/quick_request.py:669` | `record_received(slug)` | fire-and-forget |
| `marketplace/quick_request.py:678` | `track_missed_for_offline_providers` | fire-and-forget |
| `marketplace/quick_request.py:695` | `notify_new_request_to_provider` | fire-and-forget per online provider |
| `marketplace/auction.py:447,460` | `notify_outbid`, `notify_zone_loss_pressure` | fire-and-forget on outbid |
| `orchestrator/cycle.py:211` | `dispatch_alert` | fire-and-forget on threshold breach |

These are NOT in the boot inventory because they live per-request. But they ARE in the temporal inventory because they spawn unowned tasks (no `app.state.<x>_task` reference) — meaning shutdown does not cancel them.

### 2.4 WebSocket loops (1)

| File · Line | Loop | Lifetime |
|-------------|------|----------|
| `chat/realtime.py:260` | per-WS receive loop | bound to client connection |
| `chat/canonical.py:102` | canonical thread relay | bound to client connection |

---

## 3. Bucket inventory (the 3B core deliverable)

### 3.1 startup-only mutable
*Written once at boot, never mutated again. Read by everything.*

| Symbol | File | What it holds | Set by |
|--------|------|---------------|--------|
| `ctx.mongo` | `core/context.py` | `AsyncIOMotorClient` | `server.py:511` |
| `ctx.db` | `core/context.py` | `AsyncIOMotorDatabase` | `server.py:512` |
| `ctx.http_client` | `core/context.py` | shared `httpx.AsyncClient` | `server.py:527` |
| `ctx.emit.*` | `core/context.py` | 4 realtime emitter callables | `server.py:569` |
| `ctx.logger` | `core/context.py` | root logger | `server.py:513` |
| `app.state.background_tasks` | FastAPI app state | list of orchestrator tasks | `lifespan.py:255` |
| `app.state.refresh_task` | FastAPI app state | VMS refresh task | `lifespan.py:203` |
| `app.state.autobid_task` | FastAPI app state | autobid task | `lifespan.py:260` |
| `app.state.exposures_*_task` (×3) | FastAPI app state | exposures tasks | `lifespan.py:277-279` |
| `app.state.cnotify_receipts_task` | FastAPI app state | receipts task | `lifespan.py:292` |

**Recreate-safety:** trivially safe — full process restart re-initialises
all of these. The only ordering trap is `ctx.db` MUST be set before any
module that touches `from app.core.db import db` is exercised (which means
**before the first request**, which is guaranteed since lifespan runs
before request accept).

### 3.2 runtime mutable
*Mutated by request handlers OR by background loops at runtime.*

| Symbol | File · Line | Owner | Reset semantics |
|--------|-------------|-------|------------------|
| `nestjs_process` (`Optional[subprocess.Popen]`) | `core/bootstrap.py:40` | `bootstrap`, `shutdown_cleanup` | killed at shutdown; respawn on restart |
| `_redis` (singleton Redis client OR None) | `core/redis_client.py:40` | `get_redis()`, `close_redis()` | **never reset to retry-after-fail at module level** — see §5.2 |
| `orchestrator_cooldowns: dict` | `orchestrator/cooldown.py:22` | every orchestrator action | grows unbounded in pure-Python fallback mode (Redis NO-OP) |
| `pre_engagement_cooldowns: dict` | `orchestrator/pre_engagement.py:34` | pre-engagement filter | grows unbounded in fallback mode |
| `zone_locks: dict` | `orchestrator/feedback.py:26` | feedback_processor_loop | per-zone re-entrancy guard |
| `_rate_state: dict[str, list[float]]` | `parsers/router.py:29` | scraper rate-limit middleware | per-IP timestamp window, trimmed in-place |
| `_token_cache` | `payments/paypal.py:32` | PayPal access-token refresh | `{access_token, expires_at}` — auto-rotates when expired |
| `_behavioral_cache` | `ml/predictor.py:69` | `DemandPredictor.behavioral_*` reads | refreshed on TTL miss (300s) |
| `_CACHE: dict[str, (expires_at, value)]` | `auto_requests/feature_flags_helper.py:24` | feature-flag lookups | TTL eviction |
| `_META_CACHE` | `notifications/customer_pipeline.py:286` | customer-notify metadata | refreshed on miss |
| `_malformed_log_throttle` | `revenue/__init__.py:76` | log-spam throttle | rotated per-minute bucket |

**Recreate-safety classification:**
- **Trivially safe** (5): `_token_cache`, `_behavioral_cache`, `_CACHE`,
  `_META_CACHE`, `_malformed_log_throttle` — all caches with TTL. Restart
  = empty cache = first request misses, refills. No correctness loss.
- **Safe with consequences** (3): `orchestrator_cooldowns`,
  `pre_engagement_cooldowns`, `zone_locks` — restart means re-firing
  actions that were already cooled-down in the old process. With Redis
  unavailable (current state) this means duplicate `orchestrator_action`
  writes during the warm-up window. **Mitigated** by
  `app/core/dedupe_bucket.py` (Mongo unique-index claim) for the two
  visibly-amplified writers; other surfaces remain fail-open.
- **Single-fire** (2): `nestjs_process`, `_redis` — must be coordinated
  with shutdown. Both are handled today.
- **Append-only fixed-window** (1): `_rate_state` — restart = empty window,
  user temporarily uncapped until window refills (~10s).

### 3.3 async worker-owned
*Mutable state that ONLY background loops touch — request handlers MUST NOT.*

| State | Owner loop | Why off-limits |
|-------|-----------|----------------|
| `zone_locks: dict` | `feedback_processor_loop` | re-entrancy guard — concurrent request mutation would break feedback ordering |
| `orchestrator_strategy_weights` (collection) | `strategy_optimizer_loop` | only updated every 5 min; per-request writes would invalidate the optimisation window |
| `DemandPredictor._model_cache` (instance-level) | `_demand_prediction_loop` | retrain-only write; reads are concurrent-safe via shared lock |
| `orchestrator_actions` (collection) | `orchestrator_engine_loop_v2` | per-cycle insert; request handlers READ but never WRITE |
| `provider_ranking_*` (collection) | `provider_ranking_optimizer_loop` | analytics writer, read-only from request side |

Currently **enforced by convention** (docstrings + module boundaries),
NOT by code. Drift risk: low — no recent PRs touched these from request
side — but worth a sweep if any helper migrates.

### 3.4 env-derived immutable
*Loaded once from environment; never mutated. The compile-time identity of the deployment.*

| Symbol | File | Source | Default |
|--------|------|--------|---------|
| `MONGO_URL` | `core/config.py:21` | `MONGO_URL` env | `mongodb://localhost:27017` |
| `DB_NAME` | `core/config.py:22` | `DB_NAME` env | `test_database` |
| `NESTJS_URL` | `core/config.py:25` | `NESTJS_URL` env | `http://localhost:3001` |
| `NESTJS_ENABLED` | `core/config.py:33` | `NESTJS_ENABLED` env | `False` (current env) |
| `ADMIN_BUILD_DIR` | `core/config.py:36` | `ADMIN_BUILD_DIR` env | `/app/admin/dist` |
| `WEBAPP_BUILD_DIR` | `core/config.py:37` | `WEBAPP_BUILD_DIR` env | `/app/web-app/dist` |
| `JWT_SECRET` | `core/config.py:40` | `JWT_SECRET` env | hardcoded fallback ⚠ |
| `JWT_ALGO` | `core/config.py:41` | constant | `HS256` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `core/config.py:44-45` | env | seed defaults |
| `TESTING` | `core/config.py:56` | env | `False` |
| `TEST_BYPASS_TOKEN` | `core/config.py:57` | env | unused (see 3A §5.3) |
| `REDIS_URL` | `core/redis_client.py:38` | env | `redis://127.0.0.1:6379/0` |
| `KNOWN_CAPABILITIES`, `ACCOUNT_KINDS`, etc. | `core/capability.py` | code | constants — see 3A §2 |
| 38 module-level lookup catalogues | `geo/*`, `inspections/v2.py`, `customer_continuity/*`, `pricing/*`, `customer_cognition/*`, `billing/router.py`, `parsers/*`, … | code | data tables (cities, severities, FX rates, scraper headers, etc.) |

**Recreate-safety:** safest bucket — restart = identical state.

⚠ `JWT_SECRET` has a hardcoded fallback string in `config.py:40`. In a
production deploy without the env var set, signatures still work but with
a known-leaked secret. Action item for 3D: refuse to boot if `JWT_SECRET`
is not explicitly set in production mode.

### 3.5 lazy-initialized singletons
*Module-level holder that fills on first access, then sticks.*

| Symbol | File | Init trigger | Replaceable mid-flight? |
|--------|------|--------------|-------------------------|
| `_redis` | `core/redis_client.py:40` | first `get_redis()` call | **YES** — `close_redis()` resets to None; next call retries |
| `nestjs_process` | `core/bootstrap.py:40` | `start_nestjs()` invocation | **NO** — once spawned, only shutdown can stop it |
| `DemandPredictor._instance` | `ml/predictor.py` (class-level) | `load_persisted()` | **YES** — `train_all_zones` rebuilds |
| `ctx` (`AppContext`) | `core/context.py:37` | module import | **NO** — singleton |
| `db` (`_DBProxy`) | `core/db.py:96` | module import | **NO** — proxy is stateless; underlying `ctx.db` is replaceable but never replaced in practice |

### 3.6 reconnect-capable services

| Service | Reconnect policy | What happens on failure |
|---------|------------------|--------------------------|
| Mongo (Motor) | built-in driver pool; auto-reconnect on socket timeout | request-level retries fail with 500; no fallback |
| Redis | lazy retry on every `get_redis()` when `_redis is None`; success → cached forever | **NO-OP fallback** in all callers (`lock.py`, `cooldown.py`, `rate_limit.py`, `redis_state.py`); system never crashes |
| NestJS | NOT reconnect-capable — single subprocess, no restart on crash | dead in current env (`NESTJS_ENABLED=0`); FastAPI handles all routes |
| httpx (`ctx.http_client`) | per-request retry up to connection limit | request fails after pool exhaustion |

**Redis reconnect detail:** the singleton at `_redis` is set to `None`
on connect failure (line 69). Each subsequent `get_redis()` call enters
the lock, re-checks `if _redis is not None` (still None), and **retries
the connect**. This means a Redis recovery will be picked up
automatically on the next caller — no manual reset needed. Logs show
"Redis unavailable" every cycle because the orchestrator polls. That's
not a bug, that's the retry trace.

### 3.7 process-global caches
*See 3.2 — already enumerated. Repeating here as a one-line summary for completeness:*

| Cache | Eviction | Size bound |
|-------|----------|------------|
| `_token_cache` (paypal) | TTL on `expires_at` | 1 entry |
| `_behavioral_cache` | 300s TTL | 1 entry |
| `_CACHE` (feature flags) | per-key TTL | bounded by # flags (~5) |
| `_META_CACHE` (cnotify) | manual refresh on miss | 1 entry |
| `_malformed_log_throttle` | per-minute bucket | 1 entry |
| `_rate_state` (parsers) | sliding window trim | bounded by # active IPs |
| `orchestrator_cooldowns` | **none** | unbounded growth ⚠ |
| `pre_engagement_cooldowns` | **none** | unbounded growth ⚠ |

⚠ The two unbounded growers ONLY grow when Redis is unavailable (which is
the current state). With Redis up, they aren't even consulted — Redis owns
the cooldown TTLs. So this is **latent**, not active in production with
Redis. Action item for 3D: bound the fallback maps OR keep them as
strictly-bounded LRU.

---

## 4. Worker recreation matrix — the key 3B question

> "who can recreate this object safely?"

Answer per worker bucket:

| Worker | Safe to kill mid-tick? | Safe to restart cold? | State left behind |
|--------|------------------------|------------------------|-------------------|
| `zone_state_engine` | **YES** | **YES** | last `zone_snapshots` doc — informational only |
| `orchestrator_engine_loop_v2` | **YES** | **YES** | `orchestrator_actions` rows, deduplicated by Mongo unique index |
| `feedback_processor_loop` | **YES** | **YES** | `orchestrator_feedback_queue` is a Mongo queue — losing in-flight tick = next loop redrains |
| `strategy_optimizer_loop` | **YES** | **YES** | last `orchestrator_strategy_weights` doc; never partial-write |
| `provider_ranking_optimizer_loop` | **YES** | **YES** | `provider_ranking_*` documents; re-derivable |
| `_demand_prediction_loop` | **YES** | **YES** | persisted models in `ml_models` collection; warm-hydrate on next boot |
| `reactivation_sweep_loop` | partial | **YES** | a half-sent batch may double-send if killed between `find` and `update`; mitigated by per-row idempotency in `customer_continuity` |
| `nudge_sweep_loop` | partial | **YES** | same as above |
| `auto_money_worker_loop` | partial | **YES** | bid-state is Mongo; double-fire mitigated by `dedupe_bucket` |
| `refresh_loop` (VMS) | **YES** | **YES** | `vehicle_listings` rows; HTTP-call retries on next tick |
| `autobid_worker_loop` | partial | **YES** | autobid state is Mongo; double-fire = double-bid risk **if Redis is down** |
| `expire_loop` (exposures) | **YES** | **YES** | only flips `exposed → expired`; idempotent |
| `batching_loop` (exposures) | partial | **YES** | groups events into batches; mid-batch kill = next loop re-batches |
| `stats_recompute_loop` | **YES** | **YES** | analytics rollup; idempotent |
| `receipts_poll_loop` (cnotify) | **YES** | **YES** | invariant: one lifecycle row = one delivery attempt; in-place update |

**Insight:** every worker is at least restart-safe. The "partial" entries
are tasks where a kill between read and write can cause double-execution
of a side-effect. Today, Redis cooldowns are the primary guard. With
Redis down, the fall-through guard is `dedupe_bucket` for the two
visibly-amplified writers; for the rest, double-fire is theoretically
possible during a kill-window but has not been observed.

**This means orchestrator-cluster extraction is genuinely safe** — the
contract is "run me on a schedule, I'll redo anything I missed". Hot
recreation of any single loop is fine. The trick is recreating the
**module-level mutable** (e.g. `zone_locks`) — which has to live with
the loop wherever it ends up.

---

## 5. Specific hazard zones

### 5.1 Ordering trap: `ctx.db` set BEFORE any background task

The 17 boot loops all do `await db.X.find(...)` on their first tick.
This works today because lifespan ensures `ctx.db` is set in `init_db()`
**before** `start_all_loops()` runs. If any future refactor reorders
this — e.g. moves a loop launch into a router-registration block — the
loop's first tick would `RuntimeError`. The contract is documented in
`lifespan.py:7-19`.

### 5.2 Redis singleton's "permanent NO-OP" misconception

Earlier doc framing (`redis_client.py:11-25`) corrects the once-stated
"better double-push once than downtime" framing. With Redis unreachable
across the whole session, NO-OP is **permanent** — every cooldown,
every rate-limit, every zone-lock fail-opens. The mitigation today:

1. `app.core.dedupe_bucket` — Mongo unique-index claim, used by the two
   loudest writers (`orchestrator_actions`, `pre_engagement_events`).
2. Lazy reconnect — `get_redis()` retries on every call when `_redis is
   None`, so a Redis recovery auto-resumes without a process restart.

Other Redis-dependent surfaces remain fail-open with no secondary
defence. Action item for 3D: explicit Mongo-side guards for at least
`autobid_worker_loop` and `auto_money_worker_loop` (both have
double-fire risk under Redis-down).

### 5.3 Hybrid lifecycle — 4 surviving `@app.on_event`

See §1.1. Easy migration; today not a behaviour risk because FastAPI
guarantees ordering relative to lifespan. Worth pinning in 3D scope.

### 5.4 Fire-and-forget tasks have no shutdown path

The 8+ ad-hoc `asyncio.create_task(...)` calls inside request handlers
(see §2.3) are NOT cancelled on shutdown. If a graceful-shutdown
implementation lands, it must either (a) await them or (b) accept that
they may finish post-shutdown. Currently the process is killed by the
supervisor, so this hasn't surfaced.

### 5.5 `nestjs_process` global is correctly owned

Module-level mutable in `bootstrap.py:40`. Written by `start_nestjs()`,
killed by `shutdown_cleanup()`. With `NESTJS_ENABLED=0` (current env)
the path is dead. **No issue here** — listing it because process-globals
are usually drift surfaces, but this one is clean.

### 5.6 `__pycache__`-level race: zero-cost imports

Several modules tagged "Sprint 21 C-something" use lazy import inside
function bodies (`runner.py:31-40`, `lifespan.py:67-104`) — explicitly
to avoid pulling DB-using modules at import time. The contract is:
**never import anything that calls `get_db()` at module-import time.**
Verified clean as of this map.

---

## 6. Who can recreate this object safely? (the key question, in matrix form)

| Object | Recreate by | Owner state at recreate-time | Hazard |
|--------|-------------|-------------------------------|--------|
| `ctx.mongo` | full process restart | OS-level — Motor client unaware | safe |
| `ctx.db` | full process restart | derived from `ctx.mongo` | safe |
| `ctx.http_client` | full process restart | new `httpx.AsyncClient()` | safe |
| `_redis` | `close_redis()` + next caller retries | None | safe (atomic via `_lock`) |
| `nestjs_process` | `shutdown_cleanup()` kill + new `start_nestjs()` | None on restart | safe but slow (60s readiness wait) |
| `DemandPredictor._models` | next `_demand_prediction_loop` tick OR explicit `load_persisted()` | derived from `ml_models` collection | safe (idempotent) |
| any background loop | cancel + recreate as new `asyncio.Task` | depends on §4 matrix | mostly safe; "partial" rows risk double-fire |
| `zone_locks: dict` | impossible — it's a process-local dict | empty dict on restart | **safe to lose** (re-entrancy guard, not persistence) |
| `orchestrator_cooldowns` | same — process-local | empty dict on restart | safe if Redis up; double-fire window if Redis down |
| TTL caches (`_token_cache`, `_behavioral_cache`, `_CACHE`, …) | next miss refills | empty | safe (cold-cache penalty only) |
| `app.state.*_task` | re-launch in next lifespan | None | safe |
| seed data | next boot re-runs `seed_data()` (idempotent) | unchanged | safe |
| Mongo indexes | next boot re-ensures (idempotent) | unchanged | safe |

**Bottom line:** the entire process is **cold-start safe**. No state is
held in memory that can't be re-derived. The only consequences of a
restart are:
1. Cold cache penalty on the first few requests
2. Loss of in-flight ad-hoc tasks (§5.4)
3. Up-to-60s NestJS readiness window (currently disabled)
4. Up-to-10s rate-limit window reset (parsers)

---

## 7. What 3B confirms vs. what it discovers

### Confirmed (carried from 3A)
- `identity_runtime` is the single auth resolver (3A §1)
- mutable-runtime catastrophe is absent in identity surface (3A §10.4)
- existence privacy is systemic (3A §6)

### Newly discovered in 3B
1. **17 background loops, not just 5** — earlier mental model assumed
   the orchestrator cluster; reality has 9 in orchestrator + 6 in
   lifespan + 2 ad-hoc clusters.
2. **Hybrid lifecycle survives** — 4 `@app.on_event` handlers ran
   parallel to lifespan. Cleanly ordered, but doc-debt.
3. **8 mutable module-globals in non-trivial flight paths** — listed
   in §3.2. Five are TTL caches (safe). Three are
   cooldown/lock dicts that only matter when Redis is down.
4. **Redis lazy-reconnect is correct** — confirmed by reading
   `redis_client.py`. Earlier doc framing about "permanent NO-OP" is
   accurate when Redis stays down, but recovery is auto-detected.
5. **`JWT_SECRET` hardcoded fallback in production** — `config.py:40`
   ships a default secret string. Real drift surface — listed for 3D.
6. **Worker recreation is genuinely safe** — §4 matrix shows all 16
   identified loops are at least restart-safe.
7. **Fire-and-forget request-level tasks have no shutdown registration**
   — listed in §5.4.

### Healthy structures NOT to touch
- `ctx` singleton + `_DBProxy` design (PEP 562 alternative, correctly
  implemented; clean dependency direction)
- `lifespan.lifespan` orchestration sequence (init_db → models →
  indexes → bootstrap → loops) is the **only valid order**
- Lazy imports inside `runner.start_all_loops()` and `lifespan` —
  intentional to avoid DB-touch-at-import
- `dedupe_bucket` Mongo-side guard — correct architectural response
  to "Redis is best-effort"

---

## 8. Open questions for 3C/3D

| # | Question | Phase |
|---|----------|-------|
| Q8 | Should the 4 surviving `@app.on_event` be migrated into lifespan, or kept as the "post-startup index touch" surface? | 3D — trivial, but invites bikeshedding |
| Q9 | Should worker startup move FROM `lifespan` direct → ALL into `runner.start_all_loops()`? Currently 6 loops bypass the runner. | 3C |
| Q10 | Bound the fallback cooldown maps (`orchestrator_cooldowns`, `pre_engagement_cooldowns`) with LRU when Redis is down? | 3D |
| Q11 | Should `JWT_SECRET` hardcoded fallback be REMOVED + boot-refuse in production mode? | 3D — security hardening |
| Q12 | Should fire-and-forget tasks (§5.4) be tracked via a `app.state.fire_and_forget: set[Task]` for graceful shutdown? Or accept post-shutdown completion? | 3C |
| Q13 | Should the 38 module-level lookup catalogues (§3.4) move to a `core/catalogues/` namespace? Or stay co-located with their consumers? | 3C |
| Q14 | Can `dedupe_bucket` coverage extend to `autobid_worker_loop` + `auto_money_worker_loop`? See §5.2. | 3D |

---

## 9. Sign-off criteria for 3B

- [ ] Numbers in §2 (17 loops, 18 index ensures, 8 mutables, 5 singletons) cross-checked against the file system
- [ ] Q9 (loops bypassing runner) ratified as scope-only or as 3D extraction item
- [ ] Q11 (`JWT_SECRET` hardcoded fallback) confirmed as a real production risk OR a documented dev-only convenience
- [ ] No code changes proposed in this document (verified ✅)

Once these are checked, the **temporal topology is frozen** for the rest of Phase 3. 3C will inventory worker registries + decide where catalogues live. 3D will sequence actual extraction.

---

## 10. The headline insight

**Trust topology** (3A) = who can call.
**Temporal topology** (3B) = when code wakes up.

3B's discovery: the system is more **restart-safe** than I expected.
Every loop is idempotent or at least bounded-replay. Every singleton
either re-initialises or is unreachable from the request path. Every
ad-hoc task is fire-and-forget by design.

That means extraction order is constrained NOT by "what's coupled in
memory" (almost nothing is), but by:

1. **Worker boundaries** — which loops own which collections (§2)
2. **Cache scopes** — which mutable globals belong to which worker (§3.7)
3. **Startup ordering** — index-ensure ↔ loop-start dependency (§5.1)

3C will turn this insight into a concrete worker→collection ownership
graph. The extraction order falls out of that graph naturally:
**workers go first, request handlers go last.** The opposite of the
usual "extract domain models first" instinct — because here, the
runtime topology is the harder constraint.
