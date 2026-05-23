# `app.workers.vehicles_refresh` — Ownership Boundary

**Phase 3D PR-05 · Tier A carve-out · lifespan-coupled move-only extraction**

Source of truth before extraction: `app/vehicles/refresh.py:375-402`
Source of truth after extraction:   `app/workers/vehicles_refresh/loop.py:refresh_loop`

This package owns exactly one worker: the VMS temporal evolution
(listing refresh) loop.

---

## Ownership Table

| Field | Value |
|-------|-------|
| **Worker** | `refresh_loop` |
| **Tier** | A (3C §9 Tier A row 5 — hash-conditional update, idempotent dedupe on snapshot identity) |
| **Reads** | `vehicles` (filter on `lastRefreshAt`/`listing_url`), `listing_snapshots` (via `refresh_vehicle`) |
| **Writes** | `vehicles` (per-row update of `lastRefreshAt` + aggregate fields), `listing_snapshots` (insert if material change) — both via the delegated `refresh_vehicle` helper |
| **Produces** | Per-vehicle audit dict returned by `refresh_vehicle` (verdict bucket: `ok` / `degraded` / `disappeared` / `relisted` / fetch_error categories); timeline event rows on material change |
| **Consumed by** | `/api/vehicle/:id/timeline` read endpoints (read `listing_snapshots`); admin temporal-evolution surface; vehicle aggregate read endpoints (read `vehicles.lastRefreshAt`, `lastPrice`, etc.) |
| **Idempotency anchor** | **Hash-conditional snapshot dedupe.** Identical `{price, mileage, available, title}` is NOT re-written to `listing_snapshots`, but `vehicles.lastRefreshAt` IS bumped. Concurrent ticks for the same vehicle converge (both bump `lastRefreshAt`; both either insert the same diff or skip — no divergent state). |
| **Cadence** | `REFRESH_TICK_SECONDS` env-driven (default 60s). Lazy-imported from `app.vehicles.refresh` at runtime — NOT duplicated locally. |
| **Batch size** | `REFRESH_BATCH` env-driven (default 5). |
| **Cooldown** | `REFRESH_COOLDOWN_HOURS` env-driven (default 6h). |
| **Startup site** | `app/core/lifespan.py` — Phase 3D PR-05 section. Order within lifespan spine: stage 7 (post-bootstrap). Runs AFTER `ensure_refresh_indexes()` which stays in lifespan. |
| **Shutdown semantics** | Task stored at `app.state.refresh_task` (attribute name preserved). Cancellation handled by Python interpreter shutdown. Mid-tick cancellation is safe: the per-vehicle loop body wraps `refresh_vehicle(vid)` in its own try/except, so a cancelled fetch is non-fatal; next process boot retries within the cooldown window. |
| **Restart guarantee** | Cooldown-bounded recovery. A vehicle whose `lastRefreshAt` was bumped (but whose fetch failed mid-tick) won't be re-attempted for `REFRESH_COOLDOWN_HOURS`. This is acceptable per the original design — see refresh.py module docstring. |
| **Realtime emit** | none (the worker itself does not emit; `refresh_vehicle` emits timeline events into Mongo, which downstream subscriptions read separately) |
| **Redis touch** | none |
| **Metrics touch** | none |
| **External I/O** | **YES** — but indirect. `refresh_vehicle(vid)` calls `parse_listing(listing_url)` which performs the actual provider HTTP fetch. All I/O semantics (timeout, retry policy, error categorisation) live in `app.vehicles.refresh` and are NOT moved into this worker package. |
| **OpenAPI surface** | none touched |

---

## External I/O preservation (V-EXT-3, per user request)

The worker body invokes external I/O **only via the delegated
`refresh_vehicle` helper**, which lives in `app.vehicles.refresh`.
The actual HTTP fetch happens inside `parse_listing(...)`,
several call-frames deep. None of that surface is moved.

What the worker IS responsible for (and preserves verbatim):
  • **Failure swallowing at two levels:**
      - per-vehicle: `try: await refresh_vehicle(vid) except Exception as e: logger.warning(...)` — a single bad listing does NOT crash the tick
      - per-tick: `try: ... except Exception as e: logger.warning(...)` — a Mongo blip does NOT crash the loop
  • **Log wording for both failure modes (verbatim):**
      - `"vehicle refresh {vid} failed (non-fatal): {e}"`
      - `"vehicle refresh loop tick failed (non-fatal): {e}"`
  • **Log wording for scan progress (verbatim):**
      - `"vehicle refresh loop started (tick=Ns, batch=N)"`
      - `"vehicle refresh: scanning N vehicles"`
  • **No retry, no backoff inside the loop.** Failed fetches simply wait for the next cooldown-window cycle. This is the original design (refresh.py docstring "Failures are non-fatal — the next tick retries").

What this worker explicitly does NOT do (anti-scope):
  • No HTTP client management (lives in `app.vehicles.refresh` / `parse_listing`)
  • No provider-specific parser dispatch
  • No verdict categorisation (`_refresh_verdict` stays in refresh.py)
  • No external API key handling

---

## Lazy import preservation (Vector 6)

The loop body lazy-imports four symbols from `app.vehicles.refresh`:
  1. `refresh_vehicle` — per-vehicle fetcher (the I/O entrypoint)
  2. `REFRESH_TICK_SECONDS` — cadence (used to resolve signature default)
  3. `REFRESH_BATCH` — max vehicles per tick
  4. `REFRESH_COOLDOWN_HOURS` — minimum interval between refreshes per vehicle

It also lazy-imports `db` from `app.core.db` (mirrors the same
deferral used by lifespan).

**Why lazy and not top-of-module:**
`app.vehicles.refresh` is ~544 LOC including a FastAPI router with
3 endpoints (`/api/vms/refresh`, `/api/vms/snapshots`,
`/api/vms/simulate-change`) and several response models. Importing
it at module-top would force the entire VMS surface onto
worker module-load. The 2-level lazy chain (lifespan → register →
loop body) preserves the Phase 3D V6 invariant.

---

## Signature note (one deliberate divergence from original)

The original function signature was:

    async def refresh_loop(tick_seconds: int = REFRESH_TICK_SECONDS) -> None

That default is evaluated at function-definition time, which would
require importing `REFRESH_TICK_SECONDS` (and therefore
`app.vehicles.refresh`) on this module's module-load path,
breaking V6.

To preserve V6, the signature was changed to:

    async def refresh_loop(tick_seconds: int | None = None) -> None

with `None` resolved to `REFRESH_TICK_SECONDS` inside the body.

**Behavioural impact: zero.** All existing callers
(`lifespan.py:203` and the new registry hook) call `refresh_loop()`
with NO argument. Both old and new resolve to the same env-driven
default. The signature is now slightly more permissive (accepts
`None`) but no caller exercises that path. Documented here as the
only intentional divergence in PR-05; not a candidate for
post-extraction reversion.

---

## Single writer owner

`refresh_loop` is the sole orchestrator of `vehicles.lastRefreshAt`
updates and `listing_snapshots` inserts under the cooldown-window
contract. Cross-checked against PHASE_3C_WORKER_REGISTRY_AND_GLOBALS.md
§2 row 5 and §9 Tier A row 5.

The admin manual-refresh endpoint (`POST /api/vms/refresh/{vid}`)
ALSO calls `refresh_vehicle` directly (out-of-band, force-mode).
There is no concurrent-write hazard because both paths converge
through the same Mongo writes and the same hash-conditional dedupe.

## Hard invariants (do not regress)

1. **Hash-conditional snapshot dedupe** — identical content does NOT create a new snapshot; only `lastRefreshAt` bumps.
2. **Cadence from env** — `REFRESH_TICK_SECONDS` lazy-imported from upstream module.
3. **Two-level failure swallowing** — per-vehicle AND per-tick try/except. Both preserved.
4. **Sleep at end-of-tick** — `await asyncio.sleep(tick_seconds)` AFTER batch processing.
5. **Logger name = `"vehicles.refresh"`** — preserved literally (NOT `__name__`, NOT `"server"`, NOT `ctx.logger`). Fifth distinct logger choice across PR-01..PR-05.
6. **`refresh_vehicle` import path** — `from app.vehicles.refresh import refresh_vehicle` (no rename, no surface change).
7. **No realtime, no Redis, no metrics** — observational over Mongo only; external fetches are encapsulated in `refresh_vehicle`.
8. **`ensure_refresh_indexes` stays adjacent to handlers**, NOT bundled into the worker registration hook.

## Registration

Registered exactly once at FastAPI lifespan startup via:

```python
from app.workers.vehicles_refresh import register as register_vehicles_refresh
register_vehicles_refresh(app)
```

The hook stores the task at `app.state.refresh_task` (attribute
name unchanged).

## Public surface (re-exports from package root)

| Symbol | Purpose |
|--------|---------|
| `refresh_loop(tick_seconds=None)` | Long-running task body |
| `register(app)` | Lifespan registration hook |

## Anti-scope (NOT in this package — intentionally)

- ❌ `refresh_vehicle` (domain helper; lives in `app.vehicles.refresh`; shared with `manual_refresh` endpoint)
- ❌ `ensure_refresh_indexes` (index management for shared collections; lives in `app.vehicles.refresh`)
- ❌ `_compute_diff`, `_is_material_change`, `_refresh_verdict` (pure helpers used by `refresh_vehicle` and tested separately)
- ❌ `_DEGRADED_REASONS`, `_DISAPPEARED_REASONS`, `_HARD_ANOMALY_REASONS` (frozenset constants used by `_refresh_verdict`)
- ❌ `REFRESH_*` env-driven constants (shared with admin / domain endpoints)
- ❌ FastAPI router + 3 endpoints (`manual_refresh`, `list_snapshots`, `simulate_change`)
- ❌ Generic worker base class / abstract registry (still copy-structure phase)

## Sibling references

- Domain helpers: `app/vehicles/refresh.py:69-369`
- I/O entrypoint: `app/vehicles/refresh.py:241 refresh_vehicle`
- Endpoints: `app/vehicles/refresh.py:415,421,432`
- Test surface: `tests/test_parser_contract_step10b_pass2.py:42` imports `_refresh_verdict` (private helper) — NOT affected by extraction
- Server router mount: `server.py:448 from app.vehicles.refresh import router as vehicle_refresh_router` — also NOT affected
- Phase 3D contract: `/app/memory/PHASE_3D_EXTRACTION_SEQUENCE.md` §3.2 PR-05

## Discovered couplings (PR-05 pre-check, before move)

| Vector | Finding |
|--------|---------|
| **V1 Task list collector** | lifespan-owned (Archetype A). `app.state.refresh_task` is the task handle. |
| **V2 Shared try/except** | YES at lifespan (refresh worker AND ensure_refresh_indexes in same try). RESOLVED by keeping ensure_refresh_indexes adjacent in lifespan but pulling worker registration into the hook — same approach as PR-02. |
| **V3 Shared log summary** | NO. The worker emits its own log; no aggregated summary. |
| **V4 Shared imports w/ ordering** | YES. Heavy upstream (544 LOC + FastAPI router). 2-level lazy chain preserved. |
| **V5 Test assertions on logger/name** | NONE. `test_parser_contract_step10b_pass2.py` tests `_refresh_verdict` (private helper, stays in refresh.py). No assertion on `refresh_loop` symbol or its log lines. |
| **V6 Lazy import preservation** | YES — extra-critical, since refresh.py mounts a FastAPI router. Forced the signature-default divergence (see "Signature note" above). |
| **V7 Hidden singleton ownership** | None discovered. All `REFRESH_*` constants are immutable env-reads. `refresh_vehicle` is a function not a singleton. `db`, `logger` are module-level references resolved via standard imports. |

## Archetype A confirmation (third instance)

This is the THIRD lifespan-coupled extraction after PR-01
(receipts_poll) and PR-02 (exposures_stats). All three:

| Trait | PR-01 receipts_poll | PR-02 exposures_stats | **PR-05 vehicles_refresh** | Match? |
|-------|---------------------|------------------------|----------------------------|--------|
| `register()` signature | `register(app) -> None` | `register(app) -> None` | `register(app) -> None` | ✅ |
| Task storage | `app.state.cnotify_receipts_task` | `app.state.exposures_stats_task` | `app.state.refresh_task` | ✅ same shape |
| Lazy import depth | 1 (in register body) | 1 (in register body) | 1 (in register body — task starts immediately) + 1 (inside loop body) | ⚠️ extra depth in PR-05 |
| Heavy upstream module | none (whole module moved) | `inspector_stats` (lightweight) | `app.vehicles.refresh` (heavy, FastAPI router) | ⚠️ PR-05 is heaviest upstream |
| Log line wording | preserved verbatim | preserved verbatim | preserved verbatim | ✅ |
| `contracts.py` present | ✅ (cadence + receipt-age constants) | ✅ (cadence) | ❌ (cadence lives in upstream env-read) | ⚠️ divergent |
| Logger name | `app.workers.receipts_poll.loop` (`__name__`) | `"server"` | `"vehicles.refresh"` (preserved) | ⚠️ all three divergent |

**Verdict:** Archetype A signature + task storage shape + lifespan
coupling are CONFIRMED across three instances. Per-worker
divergence (logger name choice, presence of `contracts.py`, lazy
import depth) varies BUT is per-worker preservation — each worker
inherits its original behaviour intact. No PR forces a worker to
change to match a sibling. Asymmetry = signal, preserved.

The taxonomy is **architecturally stable but behaviourally
permissive**: archetypes constrain the registration contract, not
the worker's internal conventions.
