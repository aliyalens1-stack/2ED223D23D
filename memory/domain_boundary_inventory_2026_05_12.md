# 🗺️ DOMAIN BOUNDARY INVENTORY
**Дата:** 2026-05-12 · **Тип:** READ-ONLY · **Действие:** trace contamination, не удалять, не рефакторить.

## 0. ОПОРНАЯ ОНТОЛОГИЯ

Платформа сейчас — **один runtime, два продукта, общая substrate, частично пересекающаяся семантика**. Это уже формализовано в коде через **Cluster System v1** (Sprint 33, `app/marketplace/clusters.py`), но семантическое разделение **не завершено**.

### Источник истины — `app/marketplace/clusters.py`:
| Cluster | Региональная семантика | Валюта | Регион | Auction floor base | Default price | Status |
|---|---|---|---|---|---|---|
| **repair** | СТО, диагностика, ремонт | **UAH** | UA | ZONE_FLOOR (Kyiv 5-15₴) | 600 UAH | LEGACY / active |
| **inspection** | Pre-purchase TÜV-style check | **EUR** | DE | DEFAULT_FLOOR 3 EUR | 120 EUR | NEW / primary |
| **selection** | Подбор авто экспертом | **EUR** | DE | DEFAULT_FLOOR 3 EUR | 500 EUR | NEW / primary |
| **delivery** | Доставка авто из EU | **EUR** | DE | DEFAULT_FLOOR 3 EUR | 300 EUR | NEW / primary |

**Это — declared boundary**. То есть `cluster ∈ {repair}` = legacy taxi product, `cluster ∈ {inspection, selection, delivery}` = новый Auto Search product. Эта таксономия должна быть **canonical** для всего inventory ниже.

---

## 1. CONTAMINATION CARTOGRAPHY (по 11 категориям)

### 1.1 Collections

**Coupled (общая substrate — оба продукта пишут):**
| Collection | Используется legacy? | Используется new? | Контаминация |
|---|---|---|---|
| `users` | ✅ admin/customer/provider | ✅ admin/customer/inspector | ✓ legit — PERSON domain |
| `accounts` | ✅ kind=service_provider | ✅ kind=inspector | ✓ legit — Sprint 1A разделил |
| `account_capabilities` | ✅ capability=repair/wash/tow | ✅ capability=inspect/sell | ✓ legit — таксономия |
| `zones` | ✅ 6 Kyiv-UAH zones | ✅ 4 DE-EUR zones | ⚠️ **смешанная population, нет cluster filter** |
| `notifications` | ✅ | ✅ | ✓ legit |
| `payment_transactions` | ⚠️ legacy UAH txns | ✅ EUR txns | ⚠️ **currency mix без metadata.cluster** |
| `bookings` | ✅ 27 docs все Kyiv-UAH | ⚠️ нет inspection bookings (используют `inspection_jobs`) | ⚠️ **разные state machines!** |
| `orchestrator_logs` | ✅ для Kyiv-zones | ✅ для DE-zones | ⚠️ **одна таблица, разная семантика actions** |
| `pre_engagement_events` | ✅ | ✅ | ⚠️ **same** |
| `action_feedback` (Phase G) | ✅ | ✅ | ⚠️ **same — learning weights смешивают KPI обоих продуктов** |
| `zone_snapshots` | ✅ | ✅ | ⚠️ **same** |

**Legacy-only (repair cluster):**
| Collection | Назначение | Action |
|---|---|---|
| `organizations` (8 of 11 Kyiv) | СТО списки, listing | ⚠️ хранит provider type=mechanic/mobile_mechanic |
| `providers` | UAH provider verticals | legacy-only |
| `customer_bookings` | Taxi flow bookings | legacy-only |
| `customer_requests` + `quotes` | Quote-based price discovery | legacy-only |
| `quick_requests` | Taxi quick-flow ranker source | legacy-only |
| `provider_bids` + `provider_purchases` + `provider_daily_goals` | UAH lead bidding | legacy-only |
| `provider_missed_stats` | UAH FOMO tracking | legacy-only |
| `automation_feedback` | Taxi automation impact | legacy |
| `governance_actions` | Taxi admin levers | legacy |
| `automation_rules` (6 docs) | Все правила для repair cluster | legacy |

**New-only (inspection/selection/delivery clusters):**
| Collection | Назначение | Status |
|---|---|---|
| `car_requests` (0 docs) | Customer Auto-Request intake | new-canonical |
| `inspection_jobs` (6 docs) | 1:N fan-out per city | new-canonical |
| `inspection_drafts` (0) | TÜV draft state | new-canonical |
| `inspection_reports` (13 docs) | Final TÜV reports | new-canonical |
| `inspector_exposures` | Soft Marketplace top-N | new |
| `inspector_verifications` (0) | TÜV/Werkstatt verification | new |
| `vehicles` | Vehicle Memory | new (cross-app) |
| `vehicle_listings` + `market_searches` + `vehicle_subscriptions` | Listing-side | new |
| `runtime_ledger_events` | Phase D continuity | new |
| `parser_*` | mobile.de/autoscout24 cache | new |

### 1.2 Feature Flags

```python
# 5 docs, ВСЕ применимы только к legacy repair cluster:
new_matching_v2      enabled=True   # repair ranker v2
surge_pricing        enabled=True   # UAH zones surge
provider_boost       enabled=True   # UAH boost purchases
realtime_tracking    enabled=True   # taxi-flow ETA tracking
voice_requests       enabled=False  # taxi voice intake (beta)
```
⚠️ **Нет cluster-namespacing у feature flags.** Например, `surge_pricing=true` влияет одинаково на Kyiv repair zones и Berlin inspection zones — потенциальный конфликт UX.

### 1.3 Endpoints (445 routes, по доменам)

**legacy taxi (repair-cluster):**
- `quick_request.py` (1 054 строки) — taxi matching, ranker, surge
- `auction.py` (967 строк) — UAH zone floor, ZONE_FLOOR hardcoded Kyiv
- `provider/router.py` (31 routes) — earnings, pressure, tier, dashboard (UAH semantic)
- `customer/*` (606) — taxi customer flow
- `retention.py` (217) — `goalUAH`, `amountUAH`, ₴ formatting
- `growth/auto_money.py`, `nudges.py` — UAH nudges, cluster default = "repair"
- `marketplace/clusters.py` daily_goal — UAH fallback when no EUR active

**new Auto Search (inspection/selection/delivery-cluster):**
- `auto_requests/*` (4 774 строки, 22 файла) — Customer → Inspector pipeline
- `inspector/*` (1 883) — кабинет инспектора с TÜV semantics
- `parsers/*` (3 959) — 12 площадок (mobile.de canonical)
- `vehicles/*` (3 136) — Vehicle Memory System
- `pricing/router.py` — EUR packages/plans
- `payments/checkout_simple.py` — auto-request inline Stripe (EUR)

**Shared / dual-use (ambiguous):**
- `orchestrator/*` (2 058) — zone state engine; работает по обоим cluster types одновременно
- `marketplace/zones.py` — общая zone CRUD без cluster filter
- `marketplace/cities.py` — 25 городов (3 UA + 20 DE + 2 AT) с currency-per-city
- `realtime.py` — общая шина событий
- `notifications.py`, `chat.py`, `media.py` — cross-domain
- `customer_continuity.py`, `customer_cognition.py` — restraint surfaces (NEW concept, но используют legacy `customer_requests` тоже)

**Stage 4 Stripe Checkout (`app/payments/router.py`):**
- `/api/payments/checkout/create` — для `request_quotes` (legacy)  
- `/api/payments/checkout/verify` — same
- Currency берётся из `_resolve_stripe()` → DB config или env `STRIPE_CURRENCY=eur` default
- **⚠️ Quote priceBudget сейчас currencyless** (см. §1.4 ниже) — рискует биллить UAH-suma как EUR через Stripe

**Webhook contamination (`/api/webhook/stripe` зарегистрирован 3 раза):**
- `app/payments/router.py:294` — Stage 4 quote→booking
- `app/payments/checkout_simple.py` — auto-request inline
- `app/billing/stripe_payments.py` — Sprint 22 boost packages
→ First-match resolution. Сейчас `payments/router.py` registered first.

### 1.4 Pricing Constants

**EUR (new domain, canonical):**
```python
# app/pricing/defaults.py
DEFAULT_INSPECTION = {packages: [149, 399, 599]}    # 1/3/5 inspections
DEFAULT_SELECTION  = {plans:    [499, 699, 999]}    # basic/pro/premium

# app/marketplace/clusters.py
inspection: defaultPrice=120, priceRange=[80,200]
selection:  defaultPrice=500, priceRange=[300,1000]
delivery:   defaultPrice=300, priceRange=[150,900]

# app/auto_requests/* — Phase 3.0b inline Stripe
# uses EUR explicitly from pricing API
```

**UAH (legacy domain, canonical):**
```python
# app/billing/router.py — BILLING_PRODUCTS — 11 SKU все UAH
promoted_7d:  499 UAH
priority_7d:  699 UAH
vip_7d:       999 UAH
boost_basic_24h: 199 UAH × 1.3 visibility
boost_top_24h:   399 UAH × 1.5
boost_max_24h:   699 UAH × 2.0
+ 30-day plans
+ promoted_30d, vip_30d, priority_30d

# app/marketplace/clusters.py
repair: defaultPrice=600 UAH, priceRange=[300,2000]

# app/marketplace/auction.py
ZONE_FLOOR (UAH): kyiv-pechersk=15, kyiv-center=12, kyiv-podil=10, kyiv-darnytsia=8, kyiv-obolon=5, kyiv-sviatoshyn=5
DEFAULT_FLOOR = 3 (UAH implied для unknown zones — bug at Berlin!)

# app/retention.py
DEFAULT_DAILY_GOAL_UAH = 3000   # provider FOMO target
```

**Currencyless numerics (HIGH RISK):**
| Field | File | Risk |
|---|---|---|
| `quotes.priceBudget` | seed.py, taxi flow | живут UAH-numbers (3592, 3165, 2863), но Stripe Checkout берёт `cfg.currency` (default EUR) → could bill ₴3592 as €3592 |
| `bookings.finalPrice` (some) | seed.py | seeded UAH без `currency` field |
| `provider_bids.bid` | auction.py | implicitly UAH (cluster=repair); explicit EUR in clusters инспекции (cluster=inspection) — единое поле, разная семантика |
| `provider_daily_goals.amountUAH` | retention.py | имя поля явно UAH-locked |
| `bookings.amount` (для CSV экспорта) | server.py:1593 | hardcoded `"currency": "UAH"` в response |
| `revenue_experiments.*` | revenue/__init__.py:308 | hardcoded UAH в metrics |
| `governance_actions.amount` | several | без currency |
| `automation_feedback.revenueDelta` | various | без currency |

→ **Любой report/aggregation, который суммирует amounts across clusters БЕЗ currency-awareness, выдаст semantically broken число.**

### 1.5 Orchestrator Branches

**Generic (cluster-agnostic):**
- `orchestrator_run_cycle_with_feedback()` — recalculates ALL zones каждые 10s
- `predict_demand(zone_id)` — DemandPredictor с EWMA fallback (нет cluster axis)
- Severity rules (BALANCED/BUSY/SURGE/CRITICAL) → одни и те же thresholds на UAH/EUR zones
- Strategy weight learning (Phase G) — KPI correlation без cluster bucket

**Cluster-implicit:**
- `pre_engagement.py` — Push providers с `earnings_pct = +X%`. Логи:
  ```
  PRE-ENGAGEMENT triggered: zone=munich-zentrum pressure=1.76 ... earnings_pct=+76%
  ```
  Сообщение `"+76%"` нейтрально по валюте, но send_push копи в `app/push.py:145` уже отделяет ₴/€ копи по zone country.

**Action-type repertoire:**
- `set_surge`, `push_providers`, `fanout`, `priority_bias`, `zone_boost`, `expand_radius`
- Все 6 — taxi-marketplace primitives. Для inspection-cluster (planned vehicle inspection, slot-based) **семантически инородны**: "expand_radius" не имеет смысла для предзапланированной TÜV-проверки.

### 1.6 UI Routes — Mobile Expo (99 routes)

**Legacy taxi-flow routes (visible через FAB или `customer_requests` API):**
```
/booking/[id]              — pickup/dropoff confirmation
/booking/confirm           — taxi confirm
/booking/payment            — Stage 4 Stripe
/booking/payment-success
/booking/payment-cancel
/booking/live-tracking      — taxi ETA map
/booking/repeat
/booking/stage3-confirm
/booking/success
/booking/summary
/quote/[id]                 — taxi quote
/quote/select-slot          — slot picker
/request/create             — quick-request flow
/request/[id]
```

**New Auto Search routes:**
```
/auto-request/choose        — pre-form scenario (inspect/select/repair)
/auto-request/create        — Customer car request form
/auto-request/[id]          — request status + jobs list
/inspector/exposures        — Soft Marketplace
/inspector/jobs
/inspector/assignments-live
/inspector/notifications
/inspector/reputation
/inspector/verification
/vehicles/                  — Vehicle Memory
/vehicles/[id]
/vehicles/compare
/packages/                  — EUR Stripe packages
```

**Shared / dual:**
```
/(tabs)/index               — Home (different surfaces per role)
/(tabs)/profile             — Profile (legacy + new)
/operator/observatory       — Admin overlay
/provider/*                 — legacy mechanic workbench (taxi)
/zones/                     — generic zone view
/chat/                      — generic
```

⚠️ **Tab `/(tabs)/create.tsx`**: для customer ведёт на `/auto-request/create` (new), для inspector — на `earnings` (legacy provider semantics). Один tab → две domain истории.

### 1.7 UI Routes — Web Platform (88 pages, 4 shells)

**InspectorCabinetShell** (RequireKind=`inspector`) — pure NEW:
- /inspector/home, jobs, jobs/:id, jobs/:id/report, inspections, profile, availability, payouts, performance, verification, security, settings

**CustomerShell** (RequireKind=`customer`) — mostly NEW + dual:
- /dashboard/request/new (RequestIntakePage — new)
- /dashboard/requests, my-request-detail (NEW: car_request based)
- /account/bookings, garage, garage/:vehicleId (NEW vehicle memory)
- /account/customer-quotes (LEGACY: request_quotes)
- /account/establishment, continuity, report-cognition (NEW restraint UI)

**OperatorShell** (RequireKind=`service_provider` OR `inspector_owner`) — DUAL:
- /provider/inbox, workbench, current-job (LEGACY mechanic workspace)
- /provider/earnings, earnings-clarity (DUAL — same component renders both UAH/EUR)
- /provider/billing (LEGACY UAH)

**PublicShell** — DUAL:
- /marketplace, /case/:id, /provider/:slug, /booking/:id (LEGACY display surface)
- /vehicle/:id, /feed, /reports, /comparison, /selection-request (NEW Auto Search surfaces)
- /packages, /specialists (NEW EUR)

### 1.8 UI Routes — Admin (70 pages)

**Operations cluster (29 pages):**
- LEGACY: BookingsPage, QuotesPage, ProviderInboxPage, ProvidersPage, ProviderDetailPage, ProviderLifecyclePage, ProviderBehaviorPage, ReputationPage, OperatorPerformance, AdminReputationPage
- NEW: AutoRequestsPage, AutoPaymentsPage, LiveMonitorPage (parser pipeline)

**Governance (14):**
- DUAL (apply to BOTH clusters): ZoneControl, DemandControl, DemandActions, MarketControl, GovernanceScore, RequestFlow
- LEGACY-leaning: SupplyQuality, Economy, DistributionControl

**Automation (14):**
- ALL автоматизация сейчас — repair-cluster automation (см. `automation_rules` в DB)
- Auto Search не имеет своих rules — пустой namespace

**Revenue (5):**
- StripePayments, StripeSettings (DUAL — admin can flip cluster awareness)
- Monetization (LEGACY UAH boost packages)
- RevenueExperiments (UAH semantics)

### 1.9 Seed Data (`app/core/seed.py`, 746 строк)

**Section breakdown:**
| Lines | Section | Domain |
|---|---|---|
| 1-100 | admin user + 1 customer + 1 provider + 1 inspector seed users | dual |
| 100-184 | 25 cities (`app/marketplace/cities.py` — pre-loaded) | dual |
| 184-300 | 8 Kyiv organizations (Russian names, UAH, taxi-mechanic types) | **LEGACY** |
| 300-340 | 3 Berlin/Hamburg inspector organizations | **NEW** |
| 340-420 | 6 Kyiv zones (UAH, hardcoded ratios for status demo) | **LEGACY** |
| 420-450 | 4 Germany zones (Berlin Mitte/Neukölln, Munich Zentrum, Hamburg Altona) | **NEW** |
| 450-550 | reviews × 76 (all for Kyiv orgs) | **LEGACY** |
| 550-650 | bookings × 20 (all Kyiv UAH taxi) | **LEGACY** |
| 650-700 | services × 12 catalog | dual (auto-services taxonomy) |
| 700-746 | feature_flags × 5, automation_rules × 6, failsafe × 5, action_chains × 4 | **LEGACY-leaning** |

**Auto-seed Auto Search hooks:**
- `seed_auto_requests_demo()` — 6 inspection_jobs + 13 inspection_reports (B1 sprint)
- `seed_provider_workbench_demo()` — Phase 3.1 mobile parity demo data
- `pricing/router.py:_ensure_pricing_seed()` — EUR pricing if не существует

### 1.10 Enums

**Account kinds (`app/core/capability.py`):**
```python
ACCOUNT_KINDS = {customer, admin, inspector, service_provider, dealer, transport_provider}
```
- `service_provider` — legacy mechanic/СТО
- `inspector` — new Auto Search
- `dealer`, `transport_provider` — reserved (planned new)
- `customer` — dual

**Capabilities:**
```python
KNOWN_CAPABILITIES = {
  'inspect'   → cluster=inspection (NEW),
  'sell'      → cluster=selection (NEW),
  'transport' → cluster=delivery (NEW),
  'repair'    → cluster=repair (LEGACY),
  'wash'      → legacy SVC subset,
  'tow'       → legacy tow subset,
}
```

**Cluster IDs (`app/marketplace/clusters.py`):**
```python
{repair (UA/UAH), inspection (DE/EUR), selection (DE/EUR), delivery (DE/EUR)}
```

**Problem types (`app/marketplace/quick_request.py:classify_problem`):**
- 11 taxi-mechanic categories: engine_start_failure / battery / tow / tires / brakes / oil / diagnostics / electrical / suspension / noise / ac
- **ВСЁ — repair-cluster**. Не покрывает inspection/selection/delivery.

**Inspector job statuses (`shared/state-machines/inspection-job.ts`):**
- `open → claimed → inspecting → done` — new-only

**Booking statuses (`shared/state-machines/booking.ts`):**
- `pending → confirmed → on_route → in_progress → completed/cancelled` — legacy-taxi semantics ("on_route" не имеет смысла для scheduled inspection)

**Quote statuses:**
- `open → matched → accepted → closed` — legacy

**Provider types (`organizations.providerType`):**
- LEGACY: `mechanic`, `mobile_mechanic`, `tow_truck`, `wash`, `car_wash`
- NEW: `inspector`, `mobile_mechanic` (dual — inspector who can also repair)

### 1.11 Cron Jobs / Background Loops

`app/core/lifespan.py` запускает 8 фоновых процессов:
| Loop | Period | Domain |
|---|---|---|
| `orchestrator_run_cycle_with_feedback` | 10s | DUAL (calculates over all zones) |
| `feedback_processor_loop` | 30s | DUAL (но weights smoothed across both products) |
| `provider_ranking_optimizer_loop` | 5min | **LEGACY** (re-trains repair-cluster ranker) |
| `forecast_loop` | 5min | DUAL (DemandPredictor) |
| `strategy_weight_loop` | 7d window | DUAL |
| `auction_cleanup_loop` | hourly | **DUAL** (Sprint 33 already cluster-aware) |
| `auto_money_engine` | 60s | **LEGACY** (UAH FOMO nudges) |
| `pre_engagement_orchestrator` (часть cycle) | 10s | DUAL |

⚠️ **Provider ranker optimizer работает ТОЛЬКО для legacy quick-request flow** — `inspection_jobs` имеют свой собственный (отдельный) flow через `inspector_exposures`, который НЕ self-tunes.

### 1.12 Ranking Semantics

**Legacy ranker** (`quick_request.py:510`):
- Features: distance, rating, response_time, online_status, skillFit, surgeMotivation
- Optimization signal: `_success_score(offer)` — 35% accept + 35% complete + 15% fast + 15% no-cancel
- Cluster filter: provider должен иметь `cluster_id ∈ clusters[]`
- Cluster-specific sort tweaks:
  - `inspection` → rating then score
  - `selection` → rating·√reviewsCount
- **Currency-agnostic** (использует distance + ratings без денег)

**New Soft Marketplace** (`auto_requests/marketplace.py`):
- Top-N exposure через `inspector_exposures` (нет explicit ranker — TTL-based queue?)
- Inspector claims first → wins → atomic find_one_and_update
- **Нет self-learning loop, нет explicit ranking formula**

→ **Два разных ranking model coexist** на одной BD.

---

## 2. CURRENCY SEMANTIC FLOW (Step B detail)

### 2.1 Currency-aware vs currency-naive places

```
                    SOURCE OF TRUTH
                          ↓
            app/marketplace/clusters.py (cluster → currency)
                          ↓
   app/marketplace/cities.py (city → currency, country-level)
                          ↓
       zones.currency  (zone-level, seeded в seed.py)
                          ↓
            ┌─────────────┴─────────────┐
            ↓                           ↓
     CONSUMER A (aware)         CONSUMER B (NAIVE)
     ─────────────────          ─────────────────
     pricing API                quotes.priceBudget (no currency)
     auto-requests EUR          bookings.amount (no currency)
     payments/checkout_simple   provider_bids.bid (no currency)
     billing.products UAH       retention.amountUAH (locked)
     paypal.currency=EUR        server.py:1593 hardcoded UAH
                                revenue_experiments hardcoded UAH
                                automation_feedback.revenueDelta (no currency)
```

### 2.2 Stripe Checkout currency resolution (3 paths)

**Path 1 — `app/payments/router.py` (Stage 4 quotes):**
```python
cfg = await _resolve_stripe()  # admin-config from DB or env
currency = cfg["currency"] or "eur"
# → goes to Stripe as lowercase 'eur' or 'usd'
# → BUT amount comes from compute_platform_fee(req, quote) — where quote.priceBudget is currencyless!
```
**RISK:** Если quote был UAH (3500), а cfg.currency=eur → Stripe берёт `amount=3500 EUR` (≈3500€ = ₴150K).

**Path 2 — `app/payments/checkout_simple.py` (auto-requests inline):**
- Hard-coded EUR
- Берёт amount из pricing API → safe для new flow

**Path 3 — `app/billing/stripe_payments.py` (Sprint 22 boost):**
- Берёт `currency` из `BILLING_PRODUCTS` SKU (UAH)
- Idempotency через session_id
- Test-mode только → Stripe accepts UAH (`uah`) для test, но это **wrong currency для DE provider**

### 2.3 Frontend currency display

| Surface | Source | Risk |
|---|---|---|
| Expo `frontend/src/components/ProviderMoneyDashboard.tsx` | `dailyGoal.currency`, `cluster.currencySymbol` from `/api/clusters` | ✓ aware |
| Expo `ReactivationBanner.tsx` line 105 | `current.currencySymbol \|\| '₴'` | ⚠️ fallback to ₴ |
| Expo `SmartNudgeCard.tsx` line 151 | `data.currencySymbol \|\| '₴'` | ⚠️ fallback to ₴ |
| Web `web-app/src/...` | mixed — some EUR-locked, some UAH-fallback | mixed |
| Admin `admin/src/pages/Monetization*.tsx` | UAH hardcoded (₴) во всех 55 местах | ⚠️ DE provider видит ₴ цены |

---

## 3. CONTAMINATION SCORECARD

| Category | Boundary Clear? | Currency Aware? | Cluster Aware? | Score |
|---|---|---|---|---|
| Cluster taxonomy declaration | ✅ formalized | ✅ per-cluster currency | ✅ canonical | **A** |
| City catalog | ✅ per-country | ✅ per-city currency | ❌ no cluster column | **B+** |
| Zones (DB collection) | ⚠️ mixed Kyiv+DE | ✅ per-zone currency | ❌ no cluster column | **C** |
| Organizations | ⚠️ mixed types | ❌ no currency field | ❌ implicit by providerType | **D** |
| Quotes / Bookings (legacy) | ✅ legacy-only | ❌ priceBudget currencyless | ❌ no cluster | **F** |
| Car-requests / Inspection-jobs | ✅ new-only | ✅ EUR by region | ✅ implicit cluster=inspection | **A−** |
| Billing products | ✅ legacy-only | ✅ UAH explicit | ❌ no inspection/selection SKUs | **C** |
| Pricing (auto-search) | ✅ new-only | ✅ EUR explicit | ✅ per-product | **A** |
| Stripe routing | ⚠️ 3 webhooks same path | ⚠️ currency resolution depends on path | ❌ no metadata.cluster | **D** |
| Auction floor | ⚠️ 6 Kyiv zones hardcoded UAH | ❌ DEFAULT_FLOOR=3 EUR semantics? UAH? | ⚠️ cluster-aware via filter | **D** |
| Feature flags | ❌ no cluster axis | n/a | ❌ no cluster | **F** |
| Automation rules | ❌ all repair-cluster | ❌ implicit UAH | ❌ no cluster | **F** |
| Orchestrator actions | ⚠️ taxi-primitive verbs | n/a | ❌ no cluster | **D** |
| Ranker / matching | ✅ cluster filter exists | n/a | ✅ cluster-aware | **B+** |
| Provider earnings | ⚠️ DUAL component, mixed currency | ⚠️ aggregates across | ⚠️ component clusters by API | **C** |
| Retention / FOMO | ❌ locked UAH (`amountUAH` field) | ❌ no EUR variant | ❌ legacy-only | **F** |
| Notifications copy | ⚠️ ₴/€ split in push.py | ⚠️ fallback ₴ | ❌ no cluster header | **D+** |
| Reviews / Reputation | ✅ generic numerics | n/a | ❌ no cluster filter (mixed orgs) | **C** |
| Vehicle Memory | ✅ new-only | ✅ EUR | ✅ tied to inspection | **A** |
| Parsers | ✅ new-only | ✅ canonical EUR/PLN | ✅ cluster=inspection | **A** |

**Overall product-identity coherence: ~C+** (formal taxonomy great, financial layer leaks, automation/retention 100% legacy-shaped).

---

## 4. CONTAMINATION BOUNDARIES (where the fracture actually lives)

### 4.1 Hard fractures (semantically incompatible)
1. **`quotes.priceBudget`** (currencyless) → Stripe Checkout (cfg.currency) — **production-billing risk**
2. **`retention.py`** — `amountUAH`, `DEFAULT_DAILY_GOAL_UAH=3000`, fields locked at schema level — нельзя обслужить EUR provider без миграции
3. **`auction.py ZONE_FLOOR`** — hardcoded 6 Kyiv zones; для DE zones `DEFAULT_FLOOR=3` без знания, что это `3 EUR` (= ₴120) ≠ `3 UAH` (= €0.07)
4. **Frontend fallback `'₴'`** в `ReactivationBanner.tsx`, `SmartNudgeCard.tsx` — DE provider потенциально видит ₴ при отсутствии cluster context
5. **`automation_rules`** — 6 правил, все `cluster=repair` implicit. Никакая автоматизация не написана для inspection cluster
6. **`server.py:1593`** — `/api/admin/billing/revenue` хардкодит `"currency": "UAH"` для total
7. **`revenue/__init__.py:308,353`** — revenue_experiments emit `"currency": "UAH"`
8. **`bookings` collection** — все 27 docs legacy-Kyiv, но БД таблица не помечена legacy → агрегаторы видят это как канон
9. **Orchestrator's repertoire** — `expand_radius`, `push_providers`, `set_surge` — taxi primitives. Для scheduled inspection нет аналогов

### 4.2 Soft fractures (mitigable через namespacing)
10. `zones` collection — mixed UA+DE, нет `cluster` column. Можно добавить вычисляемое поле без миграции
11. `feature_flags` без cluster axis — можно ввести `appliesToCluster: ['repair']`
12. Webhook conflict `/api/webhook/stripe` × 3 — first-match. Можно разделить по `metadata.source` filter inside handler
13. `payment_transactions` mix — добавить `cluster` column на write-side не ломает читателей

### 4.3 Legitimate dual-use (not contamination)
- `users`, `accounts`, `account_capabilities` — PERSON layer (Sprint 1A canonical)
- `vehicles`, `notifications`, `chat`, `media`, `runtime_ledger_events` — generic substrate
- `orchestrator_logs`, `zone_snapshots`, `action_feedback` — generic event spine (но **нужна `cluster` discrimination** в каждой записи)
- `parsers/*`, `cities.py`, `pricing/*` — already cluster/region-aware

---

## 5. PRODUCT-IDENTITY DECISION SURFACES (готово к Step C, но НЕ принимаем сейчас)

Без рекомендации, только **explicit decision points**, которые предстоит выбрать после inventory:

| Decision | Option A: hard delete legacy | Option B: feature-flag isolation `LEGACY_TAXI_MODE` | Option C: archival namespace | Option D: officially dual-product runtime |
|---|---|---|---|---|
| **Кому это нужно** | если Kyiv-таксі бизнес мёртв | если у вас активная Kyiv-база и DE rollout | если хочется сохранить data для возврата | если оба продукта живут параллельно |
| **Что произойдёт с `bookings/quotes/customer_requests`** | drop | keep, read через flag | move to `legacy_*` namespace | keep, namespaced through cluster |
| **Что с `BILLING_PRODUCTS UAH`** | удалить | оставить, скрыть UI | rename `legacy_billing_products` | keep, добавить EUR SKUs alongside |
| **Что с `quick_request.py + auction.py`** | удалить 2 000 строк | оставить за флагом | move to `legacy_marketplace/*` | оба активны, cluster-filtered |
| **Что с automation_rules** | wipe | flag-skip non-DE | namespace legacy_ | дописать DE-rules рядом |
| **Что с `provider.workbench` (mobile + web)** | удалить | hide за role | move to `legacy_provider/*` | оставить (sluzhit Auto Search providers тоже) |
| **Что с UI routes `/booking/*`, `/quote/*`, `/request/*`** | удалить | role-conditional render | move to `/legacy/*` namespace | оставить + добавить `/auto-request/*` (уже есть) |
| **Cost** | ≈ −15K строк кода, ≈ 1-2 sprints чистки | ≈ 1 sprint isolation work | ≈ 1 sprint move + import path updates | ≈ 0 (status quo) |
| **Risk** | потеря возможной revenue от Kyiv | dead code maintained | namespace churn | semantic confusion forever |

---

## 6. КАРТА ФАЙЛОВ ДЛЯ ПРИНЯТИЯ РЕШЕНИЯ

Если Option A (hard delete):
```
DELETE: app/marketplace/quick_request.py (1054)
DELETE: app/marketplace/auction.py (967)
DELETE: app/retention.py (217)
DELETE: app/growth/auto_money.py + nudges.py
DELETE: app/customer/* (606)
DELETE: app/billing/router.py BILLING_PRODUCTS UAH
DELETE: frontend/app/booking/* + quote/* + request/* + provider/* (legacy)
DELETE: web-app routes /booking, /provider-*
DELETE: admin routes BookingsPage, QuotesPage, Reputation*, Monetization
PURGE: seed.py lines 184-300, 340-420 (Kyiv orgs+zones), 450-650 (legacy reviews/bookings)
DROP COLLECTIONS: organizations, providers, bookings, quotes, customer_requests, customer_bookings, quick_requests, provider_bids, provider_purchases, provider_daily_goals, provider_missed_stats
```

Если Option B (feature flag):
```
ADD: env LEGACY_TAXI_MODE=true|false (default true сейчас, false на DE-only)
GUARD: все endpoints выше — return 410 Gone if not LEGACY_TAXI_MODE
GUARD: clusters.py — exclude 'repair' from CLUSTERS if not LEGACY_TAXI_MODE
GUARD: BILLING_PRODUCTS — filter currency=='EUR' only when not LEGACY
UI: feature-detect через GET /api/clusters, hide tabs/routes for repair if not in list
```

Если Option C (archival):
```
RENAME: app/marketplace/quick_request.py → app/legacy_taxi/quick_request.py
RENAME: app/marketplace/auction.py → app/legacy_taxi/auction.py
RENAME: collections: organizations → legacy_organizations, bookings → legacy_bookings, etc.
KEEP: read endpoints; DISABLE: write endpoints (return 410 in legacy routers)
```

Если Option D (dual-product):
```
ADD: `cluster` column to ALL ambiguous collections (zones, payment_transactions, orchestrator_logs, action_feedback, feature_flags, automation_rules, notifications)
ADD: cluster-aware orchestrator actions per cluster type
ADD: EUR variants of BILLING_PRODUCTS (alongside UAH)
ADD: per-cluster automation_rules
NORMALIZE: quotes.priceBudget add `currency` field (write-side migration)
NORMALIZE: retention `amountUAH` → `amount` + `currency`
NORMALIZE: server.py revenue endpoints — sum per currency, not aggregate
```

---

## 7. WHAT'S READY (no fracture, no decision needed)

These domains **уже не загрязнены** и могут продолжать развитие независимо от Step C:
- **Identity / Capability / Account layer** (Sprint 1A→1D) — canonical
- **Vehicle Memory** (vehicles, listings, watchlist, market_searches) — pure new
- **Parsers** (mobile.de, autoscout24, kleinanzeigen, otomoto, willhaben, leboncoin, vin, universal) — pure new
- **Pricing API** (EUR canonical, admin-managed)
- **Auto Requests pipeline** (car_requests → inspection_jobs → reports) — pure new
- **Inspector cabinet** (web-app InspectorCabinetShell + frontend /inspector/*) — pure new
- **Runtime Ledger** (Phase D append-only continuity trace) — pure new
- **Customer Cognition / Continuity** (restraint surfaces) — pure new, в начале
- **Stripe inline auto-request checkout** (`checkout_simple.py`) — EUR canonical
- **Cluster taxonomy declaration** (`clusters.py:CLUSTERS`) — canonical decision-source

---

## 8. ACKNOWLEDGED ARCHITECTURE (не баги, а признанные intentional divergences)

- **Sprint 33 Cluster System** — намеренный multi-vertical OS. `repair` остался intentionally чтобы преимущество для multi-product roll-out.
- **`emergentintegrations.payments.stripe`** — обёртка, не raw SDK. Известное ограничение `payment_method_types` (см. router.py:156).
- **NestJS disabled** — намеренно. Realtime через Mongo polling работает для current scale.
- **Redis NO-OP fallback** — намеренный graceful degradation pattern (single-worker сейчас).
- **Hash-based trust enrichment** (auction.py:trust) — намеренный demo-stub, обещано заменить real verification в Sprint B-PO+1.
- **In-memory store fallback** (где упоминается в restraint surfaces) — намеренно для idempotency tests; production переключает на DB.

---

## 9. WHAT WAS NOT TOUCHED IN THIS INVENTORY

- Не запускались никакие миграции
- Не удалён ни один файл, документ или строка кода
- Не изменён ни один collection, ни одна запись в DB
- Не deployed
- Не вызваны testing agents

**Это pure observation deliverable.**

---

## 10. NEXT DELIBERATE STEP

После прочтения этого документа возможны 3 траектории — выбор за вами:

1. **Углубление inventory** — например, по конкретной категории (e.g., "разобрать каждый из 67 endpoints orchestrator + automation на cluster-applicability")
2. **Step C decision** — выбрать стратегию (A / B / C / D) и составить detailed transition plan **без выполнения**
3. **Pause + reflection** — оставить inventory как state map для следующего session

Никакой код не модифицируется до явного решения по Step C.

---

**END OF INVENTORY**
