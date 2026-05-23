# 🧭 DOMAIN BOUNDARY DECISION PLAN
**Дата:** 2026-05-12 · **Тип:** Strategic Planning · **Действие:** план, не исполнение

> **Контекст:** Принят к исполнению Inventory от 2026-05-12 (`domain_boundary_inventory_2026_05_12.md`). Этот документ фиксирует Step C decision и transition contract.

---

## 0. EXECUTIVE DECISION

**Стратегия:** **Option D — Officially Dual-Product Runtime**

**Формулировка:** Платформа официально становится **multi-cluster OS**, где `cluster ∈ {repair, inspection, selection, delivery}` — это first-class axis для каждого финансового, governance- и automation-решения. Legacy taxi-marketplace не удаляется, не изолируется флагом и не архивируется. Он становится **полноправным cluster `repair`** в декларированной таксономии Sprint 33, со своей валютой, governance, automation и UI surface.

**Ключевой принцип:**
> "Cluster axis должен стать таким же canonical, как `userId` или `zoneId`."

---

## 1. WHY OPTION D — обоснование

### 1.1 Что делает D правильным выбором

| Аргумент | Доказательство в codebase |
|---|---|
| **CLUSTERS уже canonical** | `app/marketplace/clusters.py:CLUSTERS` существует, формализован Sprint 33, имеет 4 verticals, declared currency+region+priceRange per cluster |
| **Cluster filter уже работает в ranker** | `quick_request.py:140` фильтрует provider по `cluster_id ∈ clusters[]`; `inspection`/`selection` имеют свои sort tweaks |
| **Cluster-aware revenue dashboards уже частично работают** | `clusters.py:_provider_dashboard` рисует per-cluster carde с currencySymbol, market revenue, FOMO upsells |
| **Auction cluster-aware** | `auction.py:149` имеет cluster filter с backward-compat для `cluster=repair` |
| **Frontend cluster-aware компоненты есть** | `ProviderMoneyDashboard.tsx`, `SmartNudgeCard.tsx`, `ReactivationBanner.tsx` — все читают `currencySymbol` из API |
| **Substrate is dual already** | identity_runtime + capability + accounts kind — Sprint 1A→1D намеренно multi-role |
| **legacy не мёртв** | 8 Kyiv orgs + 27 bookings + 76 reviews + 11 SKU UAH BILLING_PRODUCTS — это рабочий economic backbone |
| **Cost-benefit favours D** | Hard delete = −15K строк работающего кода и потенциальной revenue; D = добавление columns + dispatcher = +1500 строк, переиспользование 100% существующего |

### 1.2 Rejected alternatives — детальный анализ

#### ❌ Option A — Hard delete legacy
**Reject reason:** Преждевременная ампутация. Legacy `repair` cluster — это **не отходы, а полноценный vertical**:
- Активные UAH BILLING_PRODUCTS, которые могут быть включены для DE рынка как `boost_basic_24h: 19 EUR`
- Сложная self-learning логика (provider_ranking_optimizer 5min) — переписывать с нуля для inspection нерентабельно
- Auction floor heuristics (ZONE_FLOOR, surge_pressure_mult) — proven on real data
- ~15K строк кода, который **уже работает** на substrate
- Risk: бизнес-владелец может неожиданно решить вернуть UA рынок → не уничтожать.

#### ❌ Option B — LEGACY_TAXI_MODE feature flag
**Reject reason:** Не решает root problem, скрывает её.
- Flag не отвечает на вопрос "что произойдёт, если активны оба рынка" — а это ровно текущее состояние
- Single flag не покрывает 11 категорий контаминации (collections / endpoints / currency / FOMO / automation / ...)
- Каждое чтение/запись добавит ветвление `if LEGACY_TAXI_MODE: ... else: ...` — экспоненциально растёт complexity
- Dead-code maintenance: код существует, но не имеет owner и semantics drift
- При DE-only mode `quotes`/`bookings`/`organizations` всё равно лежат в БД и ломают reports

#### ❌ Option C — Archival namespace `legacy_*`
**Reject reason:** Слишком дорого, ломает coupled endpoints.
- 12 коллекций нужно rename → каждый writer/reader обновить → migration script + dual-read window
- Coupled dual-use endpoints (`/api/zones`, `/api/orchestrator/*`, `/api/notifications`) нельзя разделить — они служат **обоим** clusters legitimately
- `runtime_ledger_events`, `action_feedback`, `orchestrator_logs` — общий event spine; archival ломает analytics continuity
- Frontend routes `/booking/*`, `/quote/*` нужно переименовать в `/legacy/*` → ломает любые saved URLs / push notifications / external links
- Цена: ≈1 sprint move + import-path updates + dual-write window — без compensating benefit

---

## 2. STRATEGIC CONTRACT — что становится правдой при Option D

### 2.1 Семантическая правда

```
RULE 1: cluster ∈ {repair, inspection, selection, delivery} is FIRST-CLASS axis.

RULE 2: ANY monetary field MUST carry explicit `currency`. No more naked numerics.

RULE 3: ANY automation/governance rule MUST declare `appliesToCluster: string[]`.
        Default for legacy-seeded rules: ["repair"].

RULE 4: ANY UI screen MUST be able to answer "for which cluster am I rendering?"
        — even if answer is "all".

RULE 5: ORCHESTRATOR can run cluster-aware OR cluster-blind cycles,
        BUT MUST tag each emitted event with `cluster` (or "*" for blind).

RULE 6: STRIPE webhook is SINGLE endpoint, dispatcher decides by `metadata.source`
        and `metadata.cluster`. No more 3 handlers at same path.

RULE 7: NO collection deletion. NO row deletion. NO endpoint removal.
        Only ADDITIVE changes during transition.

RULE 8: Backfill map MUST exist (and pass dry-run) BEFORE any data is updated.
        No "ALTER COLLECTION" without backfill rehearsal.

RULE 9: Each phase is INDEPENDENTLY ROLLBACKABLE. Phases are commutative
        within sub-tracks (schema | endpoint | UI | automation).

RULE 10: At ANY moment during transition, BOTH legacy AND new flows MUST
         continue working. Zero downtime, zero broken UX.
```

### 2.2 Что НЕ изменится (gated за RULE 7/10)
- Ни одна коллекция не удаляется
- Ни одна запись в БД не удаляется
- Ни один endpoint не удаляется
- Ни один UI route не удаляется
- Ни один user account не теряет capabilities
- Ни один live ledger event не переписывается

---

## 3. SCHEMA CHANGES — Cluster Axis Plan

### 3.1 Классификация всех 72 живых коллекций

#### Category A — Get `cluster` column (ambiguous → must discriminate)
| Collection | Default backfill | Backfill logic |
|---|---|---|
| `zones` | derive from `country` + zone semantics | UA → `repair`, DE/AT → set of `inspection,selection,delivery` |
| `payment_transactions` | derive from `metadata.source` | `stage4_checkout` → infer from quote.cluster; `auto_request_*` → `inspection`; boost → `repair` |
| `orchestrator_logs` | derive from `zone.cluster` | follow zone after zone migration |
| `pre_engagement_events` | derive from `zone.cluster` | follow zone |
| `zone_snapshots` | derive from `zone.cluster` | follow zone |
| `action_feedback` | derive from `zone.cluster` | follow zone — but PHASE 2 |
| `automation_feedback` | hardcode `repair` | all current data is legacy |
| `notifications` | derive from `payload.cluster` if present else `null` (= global) | safe default |
| `chat_messages` | derive from related entity (booking/job/quote) | followers |
| `governance_actions` | hardcode `repair` for existing | only legacy data exists |
| `feature_flags` | add `appliesToClusters: string[]` | default `["repair"]` for 5 existing flags |
| `automation_rules` | add `appliesToClusters: string[]` | default `["repair"]` for 6 existing |
| `failsafe_rules` | add `appliesToClusters: string[]` | default `["repair"]` |
| `action_chains` | add `appliesToClusters: string[]` | default `["repair"]` |
| `provider_skills` | already has `cluster` via Sprint 33 C7 | confirm |
| `provider_bids` | already has `cluster` | confirm via auction.py:149 |
| `runtime_ledger_events` | add `cluster` to payload | new writes only; old events untouched |
| `reviews` | infer via target type | `organizations` → repair; `inspection_reports` → inspection |
| `reputation_snapshots` | derive from target | as above |

#### Category B — Already cluster-implicit (no schema change needed, but contract MUST document the implicit binding)
| Collection | Implicit cluster | Documentation update |
|---|---|---|
| `car_requests` | `inspection` (always) | add note in models.py docstring |
| `inspection_jobs` | `inspection` | same |
| `inspection_drafts` | `inspection` | same |
| `inspection_reports` | `inspection` | same |
| `inspector_exposures` | `inspection` | same |
| `inspector_verifications` | `inspection` | same |
| `vehicles` | cross-cluster but used PRIMARILY by `inspection`/`selection` | clarify |
| `vehicle_listings` | same | clarify |
| `market_searches` | `selection` (primarily) | clarify |
| `parser_*` | `inspection`/`selection` | clarify |
| `bookings` | `repair` (all legacy taxi flow) | add note; future cross-cluster bookings would require new collection or schema bump |
| `quotes` | `repair` (currently) | same |
| `customer_requests` | `repair` | same |
| `quick_requests` | `repair` | same |
| `provider_purchases` | `repair` (currently UAH) | same |
| `provider_missed_stats` | `repair` | same |
| `provider_daily_goals` | `repair` (locked UAH) | same |

#### Category C — Stay global (no cluster concept applies)
| Collection | Why |
|---|---|
| `users` | PERSON layer, cluster-orthogonal |
| `accounts` | ACCOUNT layer, kind separates roles, cluster comes from capabilities |
| `account_capabilities` | already implies cluster through capability vocabulary (`inspect`→inspection, `repair`→repair) |
| `password_reset_tokens` | auth utility |
| `push_devices` | device registry |
| `cities` | geographic (already has country) |
| `platform_settings`, `stripe_settings` | infrastructure |
| `pricing_config` | already cluster-shaped via products |
| `services` (catalog) | cross-cluster service taxonomy |
| `feature_definitions` (taxonomy) | meta |

### 3.2 Currency Normalization — Field-by-Field Plan

#### B1. Add explicit `currency` field where missing
| Collection | Field | Add | Backfill |
|---|---|---|---|
| `quotes` | `priceBudget` (currencyless) | add `currency: string` | infer from `requestId`→`customer_requests.city`→`cities.currency`; fallback "UAH" |
| `bookings` | `finalPrice`, `amount` | add `currency: string` | infer from `city`/zone; fallback "UAH" for legacy |
| `customer_requests` | `priceBudget`, `priceMin`, `priceMax` | add `currency` | same logic |
| `request_quotes` | same as `quotes` | same | same |
| `provider_bids` | `bid` | add `currency` | derive from `cluster` (repair=UAH, others=EUR) |
| `revenue_experiments` | metrics | add `currency` | hardcode UAH for existing |
| `governance_actions` | `amount` | add `currency` (when present) | UAH for legacy |
| `automation_feedback` | `revenueDelta` | add `currency` | UAH for legacy |

#### B2. Rename UAH-locked schema fields (with dual-read transition)
| Field | New name | Strategy |
|---|---|---|
| `provider_daily_goals.amountUAH` | → `amount` + `currency` | dual-read for 1 sprint, write both, then drop old |
| `retention.DEFAULT_DAILY_GOAL_UAH=3000` | → `DEFAULT_DAILY_GOAL = {repair:3000 UAH, inspection:200 EUR, selection:500 EUR, delivery:300 EUR}` | constant table per cluster |
| `goalUAH`, `todayUAH`, `remainingUAH` (response keys) | → `goal`, `today`, `remaining` + `currency` | additive response — keep both for 1 sprint |

#### B3. Frontend fallback fix
| File | Current | Change |
|---|---|---|
| `frontend/src/components/ReactivationBanner.tsx:105` | `current.currencySymbol \|\| '₴'` | Replace fallback to use **explicit `null/undefined → "—"`** instead of silent ₴. Frontend MUST require currency from API. |
| `frontend/src/components/SmartNudgeCard.tsx:151` | same | same |
| `admin/src/pages/Monetization*.tsx` (55 ₴ refs) | UAH hardcoded | introduce `<Money amount currency />` component; existing displays kept but routed through component |

### 3.3 Stripe Webhook Unification

**Current state:**
- `app/payments/router.py:294` POST `/api/webhook/stripe` (Stage 4 quotes)
- `app/payments/checkout_simple.py:_` POST `/api/webhook/stripe` (auto-requests inline)
- `app/billing/stripe_payments.py:_` POST `/api/billing/webhook` (Sprint 22 boost)

**Target state:**
- **Single** POST `/api/webhook/stripe` handler in new `app/payments/webhook_dispatcher.py`
- Reads `event.data.object.metadata.source` field:
  - `stage4_checkout` → delegate to `_handle_stage4_quote_paid()`
  - `auto_request_*` → delegate to `_handle_auto_request_paid()`
  - `billing_*` → delegate to `_handle_boost_purchase_paid()`
  - unknown → 200 + log warning + emit observability event
- Old `/api/billing/webhook` keeps working (alias) for 1 sprint, then 308 → `/api/webhook/stripe`
- Each handler is independently testable

**Idempotency contract:**
- All 3 handlers MUST upsert by `session_id` (already the case in Sprint 22)
- Dispatcher MUST NOT mutate state — only routes

---

## 4. ENDPOINT CHANGES PLAN

### 4.1 Endpoints that gain optional `?cluster=` query param (cluster-aware listing)
- `GET /api/zones` → support `?cluster=repair|inspection|selection|delivery|all`
- `GET /api/orchestrator/logs` → same
- `GET /api/admin/billing/revenue` → return **array** of `{cluster, currency, totalRevenue}` instead of single hardcoded UAH
- `GET /api/admin/monetization/overview` → same
- `GET /api/notifications` → same
- `GET /api/reviews` → same
- `GET /api/reports` (admin) → same
- `GET /api/admin/zones/heatmap` → same
- `GET /api/admin/zones/dashboard` → same

**Rule:** missing `cluster` param → returns **all clusters** (cluster-blind). Specifying invalid cluster → 400. Specifying valid → filtered.

### 4.2 Endpoints that gain `cluster` field in response (decoration, no breaking)
- `GET /api/auction/bids` → each bid includes `cluster` (already does)
- `GET /api/provider/dashboard` → already cluster-aware
- `POST /api/quick-request/resolve` → response includes `cluster: "repair"` always (legacy assumption made explicit)
- `POST /api/auto/requests` → response includes `cluster: "inspection"` always

### 4.3 New endpoints (additive only)
- `GET /api/clusters` → public list of active clusters with metadata (already exists в `clusters.py`)
- `GET /api/admin/clusters/{cluster_id}/health` → per-cluster ops snapshot (zones, providers, leads, revenue today, automation rules status)
- `GET /api/admin/clusters/{cluster_id}/automation` → list of automation rules scoped to cluster

### 4.4 No-op endpoints (already cluster-correct)
- `GET /api/pricing` (EUR canonical для inspection/selection)
- `POST /api/payments/auto-request/checkout` (`checkout_simple.py`, EUR canonical)
- `GET /api/vehicles/*` (inspection-cluster implicit)
- `POST /api/parsers/*` (selection-cluster implicit)
- `GET /api/inspector/*` (inspection-cluster)
- `POST /api/auto/requests/*` (inspection-cluster)

### 4.5 Endpoints to mark explicitly `cluster=repair` (legacy, but stays operational)
- `POST /api/quick-request/*`
- `POST /api/customer/requests/*`
- `GET /api/customer/quotes/*`
- `POST /api/auction/bid`
- `POST /api/provider/boost/purchase`
- `GET /api/provider/retention/*`
- `GET /api/admin/bookings/*`
- `GET /api/admin/quotes/*`
- `GET /api/admin/providers/*` (legacy mechanic dashboard)
- `GET /api/admin/reputation/*`

**Action:** add to each — `# CLUSTER: repair (legacy taxi-marketplace)` docstring header, no logic change.

---

## 5. AUTOMATION PLAN

### 5.1 Feature Flags evolution
**Schema add:** `appliesToClusters: string[]` (default `["repair"]` for existing)

**Migration table:**
| Flag | Current state | New `appliesToClusters` | Reasoning |
|---|---|---|---|
| `new_matching_v2` | enabled=true, rollout=100 | `["repair"]` | ranker rebuilt for taxi only |
| `surge_pricing` | enabled=true, rollout=100 | `["repair", "inspection"]` | applies to dynamic markets only (selection/delivery are scheduled) |
| `provider_boost` | enabled=true, rollout=100 | `["repair"]` | boost SKUs are UAH legacy |
| `realtime_tracking` | enabled=true, rollout=100 | `["repair"]` | only taxi has ETA tracking |
| `voice_requests` | enabled=false, beta | `["repair"]` | future inspection voice intake separate flag |

**New flags (after Phase 2):**
- `inspector_soft_marketplace` → `["inspection"]`
- `vehicle_memory_v2` → `["inspection", "selection"]`
- `parser_autoscout24_active` → `["inspection", "selection"]`

### 5.2 Automation Rules evolution
**Schema add:** `appliesToClusters: string[]` (default `["repair"]`)

**Migration table:**
| Rule | New `appliesToClusters` |
|---|---|
| Low Score Provider Limit | `["repair"]` |
| Zone High Demand Surge | `["repair"]` |
| Slow Response Push | `["repair"]` |
| High Rating Boost | `["repair"]` |
| Critical Supply Alert | `["repair", "inspection"]` |
| Auto Penalty No-Shows | `["repair"]` |

**Inspection-cluster automation (planned for Phase 4):**
- "Inspector Verification Reminder" — for inactive `inspector_verifications`
- "TÜV Report SLA Breach" — when claimed job > 48h not delivered
- "Slot Conflict Detector" — overlap on `inspector_availability`

### 5.3 Background Loops cluster-tagging
| Loop | Current | New cluster-tag |
|---|---|---|
| `orchestrator_run_cycle_with_feedback` | dual | tag emitted events with `zone.cluster` |
| `feedback_processor_loop` | dual | filter by `cluster` per zone |
| `provider_ranking_optimizer_loop` | repair-only de-facto | rename log prefix to `[repair-ranker]`, add `cluster=repair` to logs |
| `forecast_loop` | dual | tag predictions with `zone.cluster` |
| `strategy_weight_loop` | dual | bucket by cluster |
| `auction_cleanup_loop` | dual (already cluster-aware) | confirm |
| `auto_money_engine` | repair-only de-facto | rename to `repair_auto_money_engine`, scope explicit |
| `pre_engagement_orchestrator` | dual | tag with cluster |

---

## 6. MIGRATION PHASES — Ordered Plan

### Phase 0 — Pre-flight (READ-ONLY, no DB writes)
**Goal:** Build backfill map, validate hypotheses on real data.

**Deliverables (artifacts only, no code merged):**
1. **Backfill dry-run report** (`/app/memory/backfill_dryrun_TBD.md`):
   - For each Category A collection, compute and print proposed `cluster` value per document (sample 100 docs)
   - Identify ambiguous documents (where logic gives null/multiple clusters)
   - Manual disambiguation list for ambiguous cases
2. **Currency inference report** (`/app/memory/currency_inference_TBD.md`):
   - For each currencyless field, run inference logic dry-run
   - Sample 100 quotes, 27 bookings, identify outliers (negative amounts, zero, etc.)
3. **Webhook traffic shape audit** (`/app/memory/webhook_audit_TBD.md`):
   - Inspect last 30d of `payment_transactions` to validate `metadata.source` coverage
   - Identify transactions with missing/inconsistent metadata
4. **Frontend cluster-awareness scorecard** — per-screen audit: какие screens нужно дополнить cluster context

**Exit criteria:** All artifacts reviewed and signed off. Ambiguity resolved or marked "fix at runtime."

**Duration:** 1 work session (read-only).

---

### Phase 1 — Additive Schema Changes (write side only, no reads change)
**Goal:** Add `cluster` columns + `currency` fields. Old code keeps working unchanged.

**Schema operations (all `$set` on insert, no `$unset`):**
- Add `cluster` column to: `zones`, `payment_transactions`, `orchestrator_logs`, `pre_engagement_events`, `zone_snapshots`, `action_feedback`, `automation_feedback`, `governance_actions`, `runtime_ledger_events` (write side)
- Add `currency` column to: `quotes`, `bookings`, `customer_requests`, `request_quotes`, `provider_bids`, `revenue_experiments`
- Add `appliesToClusters` to: `feature_flags`, `automation_rules`, `failsafe_rules`, `action_chains` (default `["repair"]`)

**Code changes:**
- `app/core/seed.py` — new seeds write with `cluster` + `currency`
- `app/orchestrator/cycle.py` — emit events with `cluster` tag
- All writers in Category A — set `cluster` on insert
- All money-writers — set `currency` on insert
- **Readers UNCHANGED** in Phase 1

**Backfill:**
- One-shot script (`scripts/backfill_phase1.py`) — runs after deploy
- Updates existing rows with computed `cluster` + `currency` per backfill map from Phase 0
- Idempotent (skips rows that already have cluster/currency)
- Logs per-collection counts: `{collection: N processed, M updated, K already_correct, X ambiguous}`

**Acceptance:**
- All existing endpoints return identical responses (regression test)
- `db.zones.count({cluster: {$exists: false}})` == 0
- `db.payment_transactions.count({currency: {$exists: false}})` == 0

**Duration:** 1 sprint.

---

### Phase 2 — Reader Awareness (consume new fields)
**Goal:** Make all consumers cluster-aware. UI stays unchanged.

**Code changes:**
- `app/admin/billing.py` — `/api/admin/billing/revenue` returns per-cluster array
- `app/marketplace/zones.py` — `/api/zones?cluster=` filter works
- `app/orchestrator/*` — pre-engagement copy splits ₴/€ per zone cluster
- `app/retention.py` — daily-goal computed per cluster (`DEFAULT_DAILY_GOAL` table)
- `app/marketplace/clusters.py:_provider_dashboard` — already cluster-aware, confirm consistency
- `app/notifications.py` — payload includes `cluster` field; UI consumes it for ₴/€ display

**Frontend:**
- `frontend/src/components/ReactivationBanner.tsx`, `SmartNudgeCard.tsx` — replace `'₴'` fallback with `currency` from prop required
- `web-app/src` — per-route guard via `cluster` query param awareness
- `admin/src/pages/Monetization*.tsx` — wrap money displays через `<Money amount currency />` component (new, simple)

**Acceptance:**
- DE inspector никогда не видит ₴ в UI
- UA repair provider никогда не видит € в UI
- Admin revenue dashboard показывает разбивку: "Repair: 12 450 ₴ · Inspection: 890 €"
- All existing endpoints pass regression tests

**Duration:** 1 sprint.

---

### Phase 3 — Webhook Unification
**Goal:** Single Stripe webhook dispatcher.

**Code changes:**
- New `app/payments/webhook_dispatcher.py` — dispatcher by `metadata.source`
- `app/payments/router.py:294` — moved logic to `_handle_stage4_quote_paid()`, route removed
- `app/payments/checkout_simple.py` — moved to `_handle_auto_request_paid()`, route removed
- `app/billing/stripe_payments.py` — moved to `_handle_boost_purchase_paid()`, route removed
- New single route: `POST /api/webhook/stripe` → dispatcher
- Alias: `POST /api/billing/webhook` → 308 redirect (sprint window only)

**Acceptance:**
- All 3 Stripe test events (quote-paid, auto-request-paid, boost-paid) processed correctly
- `payment_transactions` show single source-of-truth `metadata.source`
- Manual test через Stripe CLI on test mode

**Duration:** 0.5 sprint.

---

### Phase 4 — Cluster-Scoped Automation
**Goal:** Automation rules respect `appliesToClusters`.

**Code changes:**
- `app/automation/engine.py` — when iterating rules, skip if `cluster not in rule.appliesToClusters`
- `app/admin/automation_*` UI — show cluster scope per rule, allow filter
- Add 2-3 inspection-cluster automation rules as proof
- Background loops add cluster scope to log messages

**Acceptance:**
- Toggling automation rule scope from `["repair"]` → `["repair", "inspection"]` propagates without code change
- New "TÜV Report SLA Breach" rule fires for inspection cluster only

**Duration:** 1 sprint.

---

### Phase 5 — UAH-locked field rename (dual-read window)
**Goal:** Remove schema-level UAH lock.

**Schema operations:**
- `provider_daily_goals` — start writing both `amountUAH` AND `amount`+`currency`
- `retention.py` responses include both `goalUAH` and `goal`+`currency`

**After 1 sprint of dual-write:**
- Migrate readers to new fields
- Stop writing old field
- After 1 more sprint: drop old field (only here, end of Phase 5, do we DROP anything — and only schema, never collection)

**Acceptance:**
- DE provider gets `{goal: 200, currency: "EUR"}` instead of `{goalUAH: 200}`
- UA provider gets `{goal: 3000, currency: "UAH"}`

**Duration:** 2 sprints (dual-write window).

---

### Phase 6 — Inspection-cluster product expansion (parity)
**Goal:** EUR variants of boost SKUs for inspectors.

**Additive only:**
- `BILLING_PRODUCTS` adds inspection-cluster SKUs:
  - `promoted_7d_inspection: 49 EUR`
  - `priority_7d_inspection: 79 EUR`
  - `vip_7d_inspection: 99 EUR`
  - `boost_basic_24h_inspection: 19 EUR`
  - etc.
- Each SKU has `cluster: "inspection"`
- UI filters SKUs by user's active capabilities → inspector видит EUR SKUs, mechanic видит UAH SKUs

**Acceptance:**
- DE inspector может купить boost через Stripe checkout in EUR
- UA mechanic continues с UAH SKUs

**Duration:** 1 sprint.

---

## 7. ROLLBACK PLAN

Each phase has independent rollback. No phase depends on later phase being completed.

### Phase 1 rollback
- Drop added columns: `db.{coll}.updateMany({}, {$unset: {cluster: ""}})` — safe because Phase 1 readers don't yet use them
- Revert seed.py / writer changes — single commit revert
- No data loss

### Phase 2 rollback
- Revert reader code (single git revert)
- Schema changes from Phase 1 remain (additive, harmless)
- Frontend reverts to ₴ fallback — degraded UX but functional

### Phase 3 rollback
- Re-add old 3 webhook routes alongside dispatcher (additive)
- Or: revert dispatcher route, restore 3 originals
- Stripe webhook URL config unchanged

### Phase 4 rollback
- Set all rule `appliesToClusters: ["repair", "inspection", "selection", "delivery"]` — effectively cluster-blind (current behavior)
- Engine treats absent field as "applies to all" (already the case)

### Phase 5 rollback (critical — dual-read window)
- During dual-write: revert reader change → reads old `amountUAH` field again. Writes still produce both. Zero data loss.
- After old-field-drop: requires schema un-rename migration. **This is the only phase with non-trivial rollback** — that's why it's last.

### Phase 6 rollback
- Remove new SKUs from `BILLING_PRODUCTS`. Old UAH SKUs untouched.
- Stripe Checkout sessions already created stay valid (idempotent by session_id).

---

## 8. ACCEPTANCE CRITERIA — Per Phase

### Phase 0 — Pre-flight
- [ ] Backfill dry-run report exists with sample of 100 docs per Category A collection
- [ ] Currency inference report identifies all ambiguous quotes/bookings
- [ ] Webhook traffic audit shows expected `metadata.source` distribution
- [ ] All ambiguous cases have manual resolution plan

### Phase 1 — Additive Schema
- [ ] All Category A collections have `cluster` field on new inserts
- [ ] All money-writing fields have `currency` on new inserts
- [ ] Backfill script idempotent (running twice produces identical result)
- [ ] Regression test: every existing endpoint returns byte-identical response
- [ ] `db.zones.count({cluster: {$exists: false}})` == 0
- [ ] `db.payment_transactions.count({currency: {$exists: false}})` == 0

### Phase 2 — Reader Awareness
- [ ] `GET /api/admin/billing/revenue` returns array of `{cluster, currency, totalRevenue}` (no breaking — caller adapts)
- [ ] `GET /api/zones?cluster=inspection` returns only DE zones with appropriate cluster
- [ ] Frontend Money component displays correct symbol for every cluster
- [ ] No ₴ visible to DE inspector in any UI surface
- [ ] No € visible to UA mechanic in any UI surface

### Phase 3 — Webhook
- [ ] Single `POST /api/webhook/stripe` handles all 3 sources
- [ ] Each Stripe test event (3 scenarios) processed correctly
- [ ] `payment_transactions.metadata.source` populated for all new transactions
- [ ] Old alias `/api/billing/webhook` returns 308 redirect

### Phase 4 — Cluster Automation
- [ ] Automation engine skips rules where `cluster not in appliesToClusters`
- [ ] At least 2 inspection-cluster rules exist and fire on test triggers
- [ ] Admin UI shows cluster scope per rule

### Phase 5 — UAH-lock removal
- [ ] During dual-write: both `amountUAH` and `amount`+`currency` populated
- [ ] After reader migration: readers consume new fields only
- [ ] After drop: schema no longer has `amountUAH`

### Phase 6 — EUR SKU parity
- [ ] DE inspector can purchase boost in EUR via Stripe Checkout
- [ ] UA mechanic continues using UAH SKUs
- [ ] `BILLING_PRODUCTS` filters by user's active capabilities

---

## 9. SAFETY CONSTRAINTS

```
🔒 RULE: NO collection deletion at any phase.
🔒 RULE: NO row deletion at any phase.
🔒 RULE: NO endpoint removal until Phase 5 reader migration confirmed in production for >1 sprint.
🔒 RULE: NO breaking response shape change. Only additive (new fields) or array-wrap (with sprint backward-compat).
🔒 RULE: Backfill scripts MUST be idempotent — running 5 times produces same result as running once.
🔒 RULE: Each phase has unique commit history, independently revertable via single `git revert`.
🔒 RULE: Testing agent runs after every phase. Phase merges only after acceptance criteria pass.
🔒 RULE: Production data is NEVER directly touched. All migrations go through staging fixture first.
🔒 RULE: When dropping fields (Phase 5 end): keep field for 1 sprint as deprecated comment, drop in follow-up.
🔒 RULE: Cluster axis values are FROZEN at {repair, inspection, selection, delivery}. New verticals require explicit decision document.
🔒 RULE: Currency codes follow ISO 4217. Frozen set: {UAH, EUR}. New currencies require explicit decision.
```

---

## 10. WHAT THIS PLAN INTENTIONALLY DEFERS

These are **explicitly out of scope** for Option D execution:
1. **Redis deployment** — Phase 3 unification doesn't depend on Redis. Multi-worker safety is separate concern.
2. **NestJS reactivation** — WebSocket continues via Mongo polling. Cluster-axis works equally for both transports.
3. **AI/LLM cognition** — Restraint surfaces remain rule-based. Cluster-aware copywriting is Phase 7+ если потребуется.
4. **TÜV PDF generator** — inspection-cluster product completeness, separate sprint.
5. **PayPal production credentials** — Stripe-first strategy. PayPal mock acceptable до Phase 6.
6. **DE i18n полноценный** — separate localization sprint. Cluster-axis is currency, not language.
7. **Capacity expansion** — Frankfurt zones, Cologne, additional DE cities — separate seed sprint.
8. **Vehicle Memory revolution** — already pure-new, evolves independently.

---

## 11. WHAT WAS DELIBERATED AND CONFIRMED

✅ **Cluster taxonomy is canonical** (Sprint 33 declared)  
✅ **Both products keep operating** during entire transition  
✅ **No hard deletes** at any phase  
✅ **Currency normalization is mandatory** before any production billing-DE  
✅ **Stripe webhook unification** is required for clean dispatcher  
✅ **Schema additive-only** until Phase 5 dual-write window  
✅ **Each phase independently rollbackable**  
✅ **Testing agent gates each phase**  
✅ **No code changes until this plan accepted**

---

## 12. WHAT WAS DELIBERATED AND REJECTED

❌ **Hard delete of repair cluster** (Option A) — preserves rebuilding optionality, kills proven economic substrate  
❌ **Feature flag `LEGACY_TAXI_MODE`** (Option B) — single boolean cannot express 11 categories of contamination  
❌ **Archival namespace `legacy_*`** (Option C) — breaks coupled dual endpoints, expensive rename, no compensating benefit  
❌ **Big-bang migration in single sprint** — too risky, no rollback granularity  
❌ **Schema changes before backfill dry-run** — risks silent data corruption  
❌ **Removing UAH currency support** — alienates UA market entirely, conflicts with declared multi-vertical OS  
❌ **Forcing all collections to have cluster column** — Category C collections (users, accounts, cities) are legitimately global  
❌ **Forcing orchestrator to be cluster-only** — orchestrator legitimately processes zone-level events that may span clusters  

---

## 13. TRANSITION CONTRACT — Signed by Plan, Not Yet Code

This document is the **transition contract**. Code MUST follow this plan exactly. Deviations require:
1. Updated decision document at `/app/memory/domain_boundary_decision_plan_TBD.md`
2. Explicit reasoning for deviation
3. Updated acceptance criteria

Until then: **no code, no migrations, no schema changes**. The platform continues to operate exactly as it does today.

---

## 14. NEXT DELIBERATE STEPS

After this plan is accepted, three concrete next moves possible (in priority order):

1. **Begin Phase 0** — produce 3 dry-run artifacts (backfill_dryrun, currency_inference, webhook_audit) as **read-only** scripts. No DB writes yet. Output goes to `/app/memory/`.
2. **Plan-level review** — additional category audit (e.g., AI/LLM cognition surfaces, future-vertical hooks) before Phase 0.
3. **Pause + reflection** — keep this contract as state map, return later with refined scope.

**No code modification will happen until explicit "begin Phase 0" decision.**

---

**END OF DECISION PLAN**

Plan accepted by author at: _(pending user confirmation)_  
First phase ready to start: Phase 0 (read-only artifact production)  
Total estimated duration if executed: ~6-8 sprints (Phases 0-6, with sprint = 1-2 work sessions)
