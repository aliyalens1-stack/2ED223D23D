# 🔬 ПОЛНЫЙ АУДИТ AUTO SEARCH PLATFORM
**Дата:** 2026-05-12 · **Источник:** https://github.com/aliyalens1-stack/776768 · **Аудитор:** E1 (deep-scan)

---

## 0. TL;DR — Состояние системы на 100%

| Слой | Состояние | Размер | Готовность |
|---|---|---|---|
| **Backend (FastAPI)** | RUNNING | 67 459 строк Python · 445 endpoints · 132 DB-коллекций (72 живы) | ✅ функционально, ⚠️ домен смешан |
| **Mobile Expo** | bundled | 50 570 строк TSX · 99 routes · 4 ролевых режима | ✅ функционально |
| **Web Platform** | HTTP 200 | 21 196 строк TSX · 88 страниц · 4 кабинета | ✅ функционально |
| **Admin Panel** | HTTP 200 | 24 360 строк TSX · 70 страниц · 8 доменов | ✅ функционально |
| **Shared (Pure TS)** | linked | 5 212 строк · 7 state machines · 8 контрактов | ✅ готово |
| **MongoDB** | RUNNING | 72 коллекции · 1 380 документов · 4 reuser | ✅ |
| **Redis** | ❌ нет (port 6379) | — | ⚠️ NO-OP fallback включён |
| **NestJS subprocess** | disabled | NESTJS_ENABLED=0 | ⏸ отключено по проекту |

**Главные выводы:**
1. **Система в фазе пивота**: legacy taxi-marketplace (Kyiv/UAH) → новый Auto Search (Berlin/EUR, TÜV-style auto inspection). 60% backend всё ещё несёт устаревший код.
2. **Identity-слой архитектурно зрелый** (Sprint 1A→1D, capability×kind разделение), готов к мульти-аккаунту.
3. **Ranking + Orchestrator работают на ML** (DemandPredictor с EWMA fallback, learning weights, pre-engagement P90).
4. **Inspector / Customer / Provider кабинеты в каждом из 3 фронтов** дублируют функциональность с разными моделями (RN / React web / Admin).
5. **Auto Requests Core** (car_requests → 1:N inspection_jobs) — главный новый домен, intake живой.
6. **Платежи**: Stripe (test_emergent ключ) реален; PayPal — mock; Stripe Settings админ-управляемая.

---

## 1. АРХИТЕКТУРНАЯ КАРТА (5 поверхностей)

```
┌─────────────────────────────────────────────────────────────┐
│                    Mongo (test_database)                    │
│       72 active collections, 1380+ docs, 2dsphere idx       │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ Motor (async)
                              │
┌─────────────────────────────────────────────────────────────┐
│           FastAPI Backend  :8001  · 445 endpoints           │
│  ┌─ 33 domain modules (app/*/router.py + service.py)        │
│  ├─ core/ (identity_runtime + capability + ctx + lifespan)  │
│  ├─ orchestrator/ (10s cycle · zone state · ML demand)      │
│  ├─ marketplace/quick_request.py (ranking optimizer 5min)   │
│  ├─ parsers/ (mobile.de, autoscout24, kleinanzeigen + 6)    │
│  ├─ payments/ (Stripe real, PayPal mock, checkout_simple)   │
│  └─ static/router.py serves admin/dist + web-app/dist       │
└─────────────────────────────────────────────────────────────┘
       ▲                          ▲                  ▲
       │ /api/admin-panel/        │ /api/web-app/    │ /api/*
       │                          │                  │
┌─────────────┐           ┌─────────────┐    ┌─────────────────┐
│   Admin     │           │  Web-App    │    │  Mobile (Expo)  │
│ Vite React  │           │ Vite React  │    │  RN 0.81 SDK 54 │
│ 70 страниц  │           │ 88 страниц  │    │  99 routes      │
│ Layout +    │           │ 4 shell:    │    │  Tabs+Stack     │
│ Auth store  │           │ Public/Cust │    │  AuthCtx+I18n   │
│ lazy chunks │           │ Inspector/  │    │  Role-aware tab │
│ tab Govern  │           │ Operator    │    │  bar (cust/insp)│
└─────────────┘           └─────────────┘    └─────────────────┘
       └────────────── @platform/* (Shared TS) ────┘
       ─ state-machines: booking, quote, payment, vehicle,
         inspection-job, inspection-report
       ─ contracts: provider-earnings, work-item, vehicle …
       ─ cognition_guardrails: forbidden/required/structural
```

### Сервисы supervisor (статус сейчас):
```
backend   RUNNING  uvicorn :8001 + 8 background loops (orchestrator/cycle/feedback/optimizer/forecast/strategy/auction/auto_money)
expo      RUNNING  Metro :3000 + ngrok tunnel (для Expo Go)
mongodb   RUNNING  :27017
```

---

## 2. BACKEND — ДОМЕН-ЗА-ДОМЕНОМ (33 модуля, 445 routes)

### 2.1 Core / Identity (app/core, 3 104 строк)
| Файл | Назначение | Состояние |
|---|---|---|
| `config.py` | env constants + load_dotenv | ✅ |
| `db.py` | get_db() singleton — Motor client | ✅ |
| `security.py` | bcrypt + verify_admin_token (delegate) | ✅ |
| `identity_runtime.py` | Sprint 1C: AccountView, IdentityContext, JWT issuance, capability gates | ✅ зрело |
| `capability.py` | Sprint 1A: vocabulary (KNOWN_CAPABILITIES, ACCOUNT_KINDS), legacy-derive | ✅ |
| `lifespan.py` | startup hooks (DB ping, ML hydrate, bootstrap, loops) | ✅ |
| `seed.py` | 746 строк seed (admin + 11 orgs + 10 zones + reviews + 20 bookings + …) | ⚠️ Kyiv+Berlin смешение |
| `realtime.py` | emit_realtime_event → NestJS WS / realtime_events Mongo | ✅ |
| `geo.py` | haversine + resolve_zone (point-in-polygon) | ✅ pure utils |
| `metrics.py` | request/error counters singleton | ✅ |
| `proxy.py` | NestJS catch-all proxy (disabled now) | ⏸ |
| `redis_client.py` + `redis_state.py` | Redis client с NO-OP fallback | ⚠️ Redis недоступен |

**Identity domain — Sprint 1A→1D 4 spr finished:**
- **PERSON** → `users` (email + passwordHash + firstName/lastName + role)
- **ACCOUNT** → `accounts` (userId, kind ∈ customer/admin/inspector/service_provider/dealer/transport_provider)
- **CAPABILITY** → `account_capabilities` (capability ∈ inspect/repair/wash/tow/transport/sell, verified|pending)
- **JWT payload** — sub + email + role(legacy) + caps + accountId + kind
- **Gates**: `require_admin()`, `require_account_kind(...)`, `require_capability_v2(...)` — все возвращают IdentityContext
- **Backwards-compat шим**: пользователи без `accounts` row синтезируются на лету из `users.role` (isLegacyShim=True)

### 2.2 Auto Requests (app/auto_requests, 4 774 строк, 22 файла)
**Новейший главный домен** — TÜV-style проверка авто.

- `car_requests` — 1 заявка клиента (бренд/модель/budget/links/cities/yearFrom/yearTo/fuel/transmission/mileageMax/uncertainty/schedulingWindow)
- `inspection_jobs` — N работ (1 на город, fan-out при create)
- Routers: customer / inspector / admin / marketplace / candidates / media / inspector_stats / inspector_profile
- Soft Marketplace (Phase 3): `inspector_exposures` — выставление job-а top-N инспекторам с TTL
- Phase 3.0b: Stripe Checkout inline (pre_paid_session_id) — alternative to credits/packages
- Runtime Ledger emit на каждое state transition (INSPECTION_CONTEXT_ESTABLISHED, ASSIGNMENT_CONTINUITY_CLAIMED, …)
- Атомарный claim через `find_one_and_update({status:"open"})` — race-safe
- Vehicle linkage (P4.1) — vehicleId денормализован в job, наследуется в report

### 2.3 Marketplace (app/marketplace, 4 338 строк)
- **quick_request.py** (1 054 строки) — старый taxi flow, всё ещё активен:
  - `classify_problem(text)` — rule-based на 11 категорий (engine_start_failure / battery / tow / tires / brakes / oil / diagnostics / electrical / suspension / noise / ac)
  - **Ranking formula**: weighted sum 6 features: `0.35·distance + 0.25·rating + 0.15·response + 0.10·online + 0.10·skillFit + 0.05·surgeMotivation`
  - **Self-learning weights** (Sprint 17): `provider_ranking_optimizer_loop` каждые 5 мин пересчитывает correlations против `_success_score(offer)` (35% accept + 35% complete + 15% fast + 15% no_cancel), требует MIN_SAMPLES=30 + MIN_CONFIDENCE=0.30
  - **Surge formula**: `surge = 1 + (ratio-1)·0.3` (BUSY), `1.3 + (ratio-2)·0.4` (SURGE), `min(2.5, 1.7 + (ratio-3)·0.3)` (CRITICAL)
  - **Cluster filter** (Sprint 33): provider должен иметь `cluster_id ∈ clusters[]` (repair/inspection/selection/delivery)
  - **Cluster-specific sort**: `inspection` → rating then score; `selection` → rating·√reviewsCount
- providers / matching / zones / requests / cities / clusters / trust / auction
- 31 endpoint в providers.py

### 2.4 Inspector (app/inspector, 1 883 строки)
- `cabinet.py` — 14 endpoints полного кабинета: dashboard / profile / inspections / availability / payouts / performance / verification / security / settings / change-password
- `timeline.py` — durable event spine (`timeline_events` append-only)
- `contact.py` — Customer Contact Unlock (legacy POST /reveal + новый GET /jobs/{id}/contact с visibility resolver)
- `offline_replay.py` — R2 offline queue audit log

### 2.5 Orchestrator (app/orchestrator, 2 058 строк)
**Самый сложный модуль — 10s zone-state recalc + автоматизация.**

- `cycle.py` — `orchestrator_run_cycle_with_feedback()` каждые 10с:
  1. Для каждой зоны: `predict_demand(zone_id)` через ML (DemandPredictor.predict_with_interval → P10/P50/P90)
  2. Если pressure = predicted/supply > 1.2 → `trigger_pre_engagement(zone, pressure, predicted, supply, p10, p90)` — Push мастерам
  3. Маппинг severity → rule (BALANCED / BUSY / SURGE / CRITICAL) → actions (set_surge / push_providers / fanout / priority_bias / zone_boost / expand_radius)
  4. **Strategy weight filter** — actions с weight < 0.4 → skipped
  5. **Zone lock** (15s TTL) — race protection
  6. Execute + track_action_feedback (capture зон snapshot до/после)
- `feedback.py` — Phase G: rolling 7d window correlation between `actionType → KPI delta` → updates `strategy_weights`
- `pre_engagement.py` — atomic Redis cooldown (NX EX 300s) — multi-worker safe
- Default rules seed: 4 severity → distinct surge/fanout/cooldown configs
- ZONE state engine: ratio < 1 = BALANCED, < 2 = BUSY, < 3 = SURGE, ≥ 3 = CRITICAL

### 2.6 Provider (app/provider, 3 217 строк, 31 routes)
- earnings / pressure / tier / availability / pre-engage / performance / skills / location / presence / inbox / chat / dashboard / boost
- `incentives.py` — provider goals & nudges
- `onboarding.py` (Sprint B-PO) — Berlin Launch v1

### 2.7 Vehicles (app/vehicles, 3 136 строк)
**Vehicle as Memory System** — революционный концепт:
- `public_memory.py` — public /vehicle/:id страница (VIN + история + текущее объявление)
- `ingest.py` — Listing URL → Vehicle pipeline (декод VIN + парсер ad)
- `refresh.py` — temporal evolution: snapshot diff, simulate-change
- `watchlist.py` — subscriptions/feed
- `market_searches.py` — saved searches (mobile.de query persisted)
- `timeline.py` — per-vehicle event log

### 2.8 Parsers (app/parsers, 3 959 строк)
12 площадок, рабочих для интеграции в Auto Search:
- **mobile.de** — основная (Berlin Launch B2)
- autoscout24 / kleinanzeigen / otomoto / willhaben / leboncoin
- `universal.py` — generic fallback parser
- `page_classifier.py` — определяет тип страницы перед парсингом
- `vin.py` — VIN decoder (WMI lookup)
- `contract.py` — единый Pydantic schema что обязан вернуть любой parser

### 2.9 Payments & Billing (app/payments + app/billing, 1 966 строк)
- **payments/router.py** — Stripe Checkout для packages (4 routes)
- **payments/checkout_simple.py** — Phase 3.0b: one-shot Stripe Checkout per auto-request (без credits) + webhook
- **payments/router_paypal.py** — PayPal credits (demo mode когда `PAYPAL_CLIENT_ID=demo_client_id`)
- **billing/router.py** — `BILLING_PRODUCTS` каталог: 11 SKU (promoted/priority/vip/boost basic-pro-max × 7d/24h/30d) → entitlements (UAH currency, legacy!)
- **billing/stripe_payments.py** — Sprint 22: real Stripe ONLY for test mode, конфиг (secret_key, webhook_secret, enabled) исключительно из MongoDB `platform_settings`. Идемпотентность через session_id upsert в `payment_transactions`. Использует `emergentintegrations.payments.stripe.checkout`.
- **admin/stripe_settings.py** — POST/GET конфиг Stripe из админки

### 2.10 Pricing (app/pricing)
**Critical** — единый источник цен (frontend НЕ хардкодит):
```python
DEFAULT_INSPECTION = {  # EUR — новый домен ✅
  packages: [
    {id:'p1', count:1, price:149, currency:'EUR'},
    {id:'p3', count:3, price:399, currency:'EUR', badge:'MOST POPULAR'},
    {id:'p5', count:5, price:599, currency:'EUR', badge:'BEST VALUE'},
  ]
}
DEFAULT_SELECTION = {  # EUR
  plans: [
    {id:'basic',   name:'Basic',   cars:3, price:499, currency:'EUR'},
    {id:'pro',     name:'Pro',     cars:5, price:699, currency:'EUR', badge:'MOST POPULAR'},
    {id:'premium', name:'Premium', cars:7, price:999, currency:'EUR'},
  ]
}
```
Admin может изменить через `PUT /api/admin/pricing`.

### 2.11 Остальные домены (краткий обзор)
- **Customer** (app/customer, 606 строк) — продолжение клиентского флоу
- **customer_continuity** (389) + **customer_cognition** (355) — restrained interpretive surfaces (читают inspection_drafts → genome для UI)
- **Observatory** (896) — Operator Cognition Observatory (admin-gated read of live substrate)
- **Intelligence** (846) — Draft Intelligence Engine (Sprint 2 Step 4)
- **Reputation** (695) — рейтинг engine (`reputation_snapshots`)
- **Assignments** (731) — Live Assignments (inspector accept/decline)
- **Ops Map** (388) — read-only zone projection для admin
- **Runtime Ledger** (714) — Phase D append-only continuity trace (EventTypes: INSPECTION_CONTEXT_ESTABLISHED, ASSIGNMENT_CONTINUITY_CLAIMED, …)
- **Notifications** (469) — projector + polling (unread-count, since-timestamp, backfill)
- **Chat** (439) — user↔provider, user↔support
- **Performance** (476) — provider performance metrics
- **Revenue** (363) — A/B experiments на surge/pricing
- **Growth** (1 159) — reactivation/nudges/auto_money
- **Push** (139) — Expo push tokens registry
- **Retention** (217) — track missed revenue для offline providers
- **Domination** (zone dominance) / **Referrals** / **Auction** (Sprint 27 — provider bidding for leads)
- **Reports** + **Media** — file uploads (base64 for mobile)
- **Inspection** (Sprint B1 — TÜV report generator)

---

## 3. БАЗА ДАННЫХ (MongoDB)

**72 живых коллекции** vs **132 упомянутых в коде** — большой % создаётся lazy. Топ-15 по количеству docs:

| Collection | Docs | Назначение |
|---|---|---|
| `action_feedback` | 338 | Sprint G — Phase G feedback for strategy weights |
| `zone_snapshots` | 132 | 48h zone history (TTL cleanup) |
| `market_state_snapshots` | 108 | seeded — legacy zone analytics |
| `orchestrator_logs` | 103 | каждый orchestrator action |
| `pre_engagement_events` | 87 | Sprint 18 — TTL by expiresAt |
| `reviews` | 76 | seeded org reviews |
| `providerservices` | 55 | provider price list |
| `governance_actions` | 44 | admin actions audit |
| `provider_skills` | 39 | provider verticals |
| `auto_action_executions` | 30 | automation engine |
| `bookings` | 27 | legacy taxi-marketplace |
| `automation_feedback` | 25 | impact tracking |
| `inspection_reports` | 13 | TÜV reports seeded |
| `services` | 12 | seeded service catalog |
| `branches` | 11 | seeded org branches |
| `organizations` | 11 | 8 Kyiv + 3 Berlin ⚠️ |
| `provider_availability/performance/locations` | 11 each | |

**Domain mix (критическая находка):**
- 8 organizations с `city='kyiv'` + Russian names ("АвтоМастер Про", "СТО Формула") + UAH `priceFrom`
- 3 organizations с `city='berlin'` + English names ("Berlin Auto-Check", "Car Selection Expert EU") + EUR
- 6 zones Kyiv + 4 zones Germany (Berlin Mitte, Berlin Neukölln, Munich Zentrum, Hamburg Altona)
- Все 20 seeded bookings — Kyiv, UAH, taxi-flow

**Indexes созданы:**
- `organizations.location` (2dsphere)
- `branches.location` (2dsphere)
- `users.email` (unique)
- `favorites.(userId, organizationId)` (unique)
- `bookings.(userId, createdAt)`
- `notifications.(userId, createdAt)`
- `password_reset_tokens.token` (unique), `expiresAt` (TTL 86400)
- `pre_engagement_events.expiresAt` (TTL 0)
- `orchestrator_logs.createdAt` + `.(zoneId, createdAt)`

---

## 4. MOBILE EXPO (50 570 строк, 99 routes)

### Структура `/app/frontend/app/`:
```
(tabs)/                  ← bottom tabs (role-aware)
  index.tsx              Home
  requests.tsx           Customer: requests · Inspector: jobs (overrideHref → /inspector/exposures)
  create.tsx             Customer: + FAB → /auto-request/create · Inspector: earnings
  reports.tsx            Customer: reports · Inspector: history → /inspector/jobs
  profile.tsx            Profile (общая)
  garage.tsx / quotes.tsx / services.tsx (hidden)

auto-request/            ← главный flow Auto Search
  choose.tsx             Pre-form scenario picker (inspect / select / repair)
  create.tsx             Form (brand/model/budget/cities/uncertainty/scheduling)
  [id].tsx               Request status + jobs list

inspector/               ← инспектор-only
  exposures.tsx          Soft Marketplace feed (top-N jobs)
  assignments-live.tsx   Live assignments
  jobs.tsx               Claimed jobs
  notifications.tsx
  reputation.tsx
  verification.tsx

provider/                ← legacy provider (taxi mechanic)
  workbench.tsx          Phase 3.1 Mobile Parity — workspace
  workspace/[requestId]
  earnings-clarity.tsx   Phase 3.1 — money perception
  inbox.tsx / current-job.tsx / chats.tsx / clusters.tsx / performance.tsx / stats.tsx
  earnings.tsx / explain.tsx / availability.tsx

operator/                ← admin observatory
  observatory.tsx        Operator Cognition Observatory
  history/[id].tsx

vehicles/                ← Vehicle Memory
  index.tsx / [id].tsx / compare.tsx

booking/, request/, quote/, packages/, payment/, organization/, chat/, zones/, review/ …
```

### Контексты:
- `AuthContext.tsx` (398 строк) — login/register/me + `continueAsGuest()` + JWT персистится в AsyncStorage
- `CityContext` — onboarding gate (`hasSelected → /city-select`)
- `LocationContext` — expo-location permissions + watch
- `ThemeContext` — light/dark + tokens
- `ToastContext` — global notifications
- `i18n` (init from `src/i18n/`) — RU/EN/DE

### API клиент (`services/api.ts`, 450 строк):
Axios с `baseURL = ${EXPO_PUBLIC_BACKEND_URL}/api` · 30s timeout · 401 interceptor → auto-logout
**28 named API объектов**: auth, services, organizations, vehicles, quotes, matching, bookings, reviews, map, cities, marketplace, requests, payments, disputes, favorites, providerInbox, currentJob, live, demand, zones, notifications, customer, providerIntelligence, marketplaceStats, quickRequest, telemetry, providerStatus, providerInboxPro

### Зависимости:
Expo SDK 54 + RN 0.81 + expo-router 6 + react-navigation 7
- @gorhom/bottom-sheet, expo-image-picker, expo-haptics, expo-blur, expo-localization, expo-location
- @react-native-async-storage/async-storage, expo-clipboard
- axios, react-i18next, **react-native-reanimated** (включён через babel-plugin)

---

## 5. ADMIN PANEL (24 360 строк, 70 страниц)

### Группировка:
1. **Operations** (29 страниц): Dashboard, AutoRequests, AutoPayments, LiveMonitor, Users, Customers, Organizations, Providers, ProviderDetail, Services, Map, Bookings, Quotes, Payments, Disputes, Reviews, ProviderInbox, Notifications, AdminInbox, AdminReputation, AdminAssignments, AdminOpsMap, Reports, AuditLog, FeatureFlags, Suggestions, SystemHealth, SystemErrors, ProviderLifecycle, OperatorPerformance
2. **Governance** (14): GeoOps, MarketControl, Reputation, SupplyQuality, ZoneControl, Economy, DistributionControl, VerificationQueue, Incidents, DemandControl, DemandActions, GovernanceScore, ProviderBehavior, RequestFlow
3. **Automation** (14): AutomationDashboard, AutomationControl, AutoActions, ActionChains, ExecutionMonitor, ExecutionReplay, ShadowMode, Idempotency, ROITracking, UnifiedState, Failsafe, FeedbackLoop, DryRun, AutoRulePerformance
4. **Forecast/Simulation** (4): Simulation, RuleVisualizer, Playbooks, ForecastDashboard
5. **Revenue/Billing** (6): RevenueExperiments, Monetization, StripePayments, StripeSettings, SupportChat, RevenueDashboard

### State / Auth:
- Zustand `authStore.ts` (78 строк) — token persistence (localStorage)
- Lazy chunks (Vite manualChunks split by domain → admin-ops / governance / automation / charts / revenue)
- Финальный bundle ~1.4 MB (gzipped 350 KB)

---

## 6. WEB PLATFORM (21 196 строк, 88 страниц)

### Shell-архитектура (4 shells):
1. **PublicShell** — гостям: MarketplaceHome, Inspect, SelectionRequest, Comparison, Reports, Case/:id, Vehicle/:id, Feed, Operator/:slug, Specialists, Packages, Provider/:slug, Booking/:id (18 страниц)
2. **CustomerShell** (RequireKind=customer): /dashboard/requests, /dashboard/request/new (RequestIntakePage), establishment, my-request-detail, customer-quotes, /account/home, bookings, garage, garage/:vehicleId, favorites, profile + ContinuityPage + ReportCognitionPage (15)
3. **OperatorShell** (RequireKind=service_provider/inspector_owner): /provider/inbox, workbench, current-job, earnings, earnings-clarity, demand, profile, billing (8)
4. **InspectorCabinetShell** (RequireKind=inspector): /inspector/home, jobs, jobs/:id, jobs/:id/report (ReportWorkspace!), inspections, profile, availability, payouts, performance, verification, security, settings (12)

### Зависимости:
Vite 5 + React 18 + react-router-dom 6 + zustand 4 + react-leaflet (карты!) + socket.io-client + i18next-browser-languagedetector + tailwindcss + lucide-react + @phosphor-icons/react

### Stores:
- authStore.ts (152 строки)
- vehicleMemoryStore.ts (118 строк)

---

## 7. SHARED (5 212 строк, pure TS, no JSX/runtime)

### State Machines (доступны всем 3 фронтам):
- `booking.ts` — pending/confirmed/on_route/in_progress/completed/cancelled
- `quote.ts` — open/matched/accepted/closed
- `payment.ts` — created/pending/paid/refunded/failed
- `vehicle.ts` — listed/inspecting/inspected/sold/withdrawn
- `inspection-job.ts` — open/claimed/inspecting/done
- `inspection-report.ts` — draft/submitted/published/disputed

### Contracts (Pydantic ↔ TS sync):
provider-earnings-item, provider-work-item, inspection-job, vehicle, inspection-report, booking, quote, payment

### Cognition Guardrails:
- `forbidden.ts` — слова которые НЕЛЬЗЯ показывать клиенту в восприятии отчёта (e.g., "сломан", "fucked")
- `required.ts` — обязательные структурные элементы (TÜV checklist sections)
- `structural.ts` — продуктовая грамматика отчёта

### Parsers:
- `canonical.ts` — нормализация brand/model/year/mileage/price из разных площадок в единую схему

---

## 8. ИНТЕГРАЦИИ

| Интеграция | Статус | Ключи | Где |
|---|---|---|---|
| **Stripe** (real) | ✅ test mode | `STRIPE_API_KEY=sk_test_emergent` (env) + MongoDB `platform_settings` | `app/billing/stripe_payments.py`, `app/payments/router.py`, `app/payments/checkout_simple.py` |
| **PayPal** | ⚠️ MOCK | `PAYPAL_CLIENT_ID=demo_client_id` (default) | `app/payments/router_paypal.py`, `app/payments/paypal.py` |
| **emergentintegrations** | ✅ установлен | — | `StripeCheckout` wrapper |
| **mobile.de / autoscout24** | ✅ HTML scrapers | nothing — public | `app/parsers/*.py` |
| **WebSocket realtime** | ⚠️ NestJS off → Mongo events | — | `realtime_events` collection (polling) |
| **Redis** | ❌ down | port 6379 unreachable | NO-OP fallback в `app/core/redis_state.py` |
| **Push notifications** | ⚠️ registry only | — | `app/push.py` (no actual FCM/APNS sender wired) |
| **Email / SMS** | ❌ нет | — | — |
| **OpenAI / Anthropic / Gemini** | ❌ нет | — | (planned for cognition surfaces) |

**Stripe Webhooks** зарегистрированы 3 раза:
- `/api/webhook/stripe` (router.py — packages)
- `/api/webhook/stripe` (checkout_simple.py — auto-requests inline)
- `/api/billing/webhook` (billing/stripe_payments.py)

→ Возможный конфликт routing first-match. Сейчас `app/payments/router.py` подключается раньше `checkout_simple.py`.

---

## 9. ФОРМУЛЫ И БИЗНЕС-ЛОГИКА (критические)

### 9.1 Ranking score (quick_request.py:510)
```python
score = sum(features[k] * weights[k] for k in RANKING_FEATURES) * fit
# features: distance(1-d/10), rating(r/5), response(1-rsp/30), online(1|0.3), skillFit(1|0.7), surgeMotivation(surge-1)
# weights: default {distance:.35, rating:.25, response:.15, online:.10, skillFit:.10, surge:.05}
# learned per (zone, problem) когда samples ≥ 30 и confidence ≥ 0.30
```

### 9.2 Surge multiplier (orchestrator/cycle.py:165)
```python
if surge_ratio < 1:  surge = 1.0
elif surge_ratio < 2:  surge = 1 + (surge_ratio - 1) * 0.3      # 1.0..1.3
elif surge_ratio < 3:  surge = 1.3 + (surge_ratio - 2) * 0.4    # 1.3..1.7
else:  surge = min(2.5, 1.7 + (surge_ratio - 3) * 0.3)         # 1.7..2.5
# surge_ratio = max(current_ratio, forecast_ratio) — feed-forward
```

### 9.3 Zone status thresholds
```python
ratio < 1 → BALANCED (green)
ratio < 2 → BUSY     (amber)
ratio < 3 → SURGE    (orange)
ratio ≥ 3 → CRITICAL (red)
```

### 9.4 Pre-engagement trigger (Sprint 18+20)
```python
pressure = predicted_demand_P90 / current_supply   # P90 vs P50 — striking upper bound
if pressure > 1.2 and supply > 0:
    trigger_pre_engagement(zone, …)  # Push к мастерам с pct = max(10, int((pressure-1)*100))
```

### 9.5 Success score (training signal for ranker)
```python
_success_score(offer) =
  0.35 * (accepted ? 1 : 0)
+ 0.35 * (booking_completed ? 1 : 0)
+ 0.15 * (accepted AND 0 < response_sec < 30 ? 1 : 0)   # fast response bonus
+ 0.15 * (1 - cancelled)                               # no-cancel bonus
```

### 9.6 Strategy weight filter (Phase G)
```python
weight = get_strategy_weight(zone, action_type)  # rolling 7d KPI correlation
if weight < 0.4:  action.status = "skipped"
```

### 9.7 Trust enrichment (auction display)
Hash-based fallback для отсутствующих полей:
```python
slug_hash = sum(ord(c) for c in slug)
years = 5 + (slug_hash % 14)               # 5..18 лет опыта
vehicles = 120 + (slug_hash * 17 % 480)   # 120..600 машин осмотрено
tuv = (slug_hash % 2 == 0)                # 50% TÜV verified
```

### 9.8 Pricing (EUR — новый Auto Search домен)
- Inspection package: 149€ (1) / 399€ (3, popular) / 599€ (5, best value)
- Selection plan: Basic 499€ (3 cars) / Pro 699€ (5 cars, popular) / Premium 999€ (7 cars)

### 9.9 Billing products (UAH — legacy taxi-marketplace, ⚠️)
- Promoted 7d: 499 UAH (+15% boost)
- Priority 7d: 699 UAH (приоритет 20s window)
- VIP 7d: 999 UAH (promoted + priority)
- Boost SKU: basic_24h 199 UAH (×1.3), top_24h 399 UAH (×1.5), max_24h 699 UAH (×2.0)
- + 30-day plans

---

## 10. КРИТИЧЕСКИЕ ПОДКЛЮЧЕННЫЕ ПРОВАЙДЕРЫ И ВКЛЮЧЁННЫЕ ФИЧИ

```python
# Feature flags в DB (5 docs):
new_matching_v2:    enabled=True,  rolloutPct=100
surge_pricing:      enabled=True,  rolloutPct=100
provider_boost:     enabled=True,  rolloutPct=100
realtime_tracking:  enabled=True,  rolloutPct=100
voice_requests:     enabled=False, rolloutPct=10   # beta
```

```python
# Automation rules в DB (6):
1. "Low Score Provider Limit"   trigger: provider.score<40    action: limit_visibility(0.3)
2. "Zone High Demand Surge"     trigger: zone.ratio>3         action: set_surge(1.5)
3. "Slow Response Push"         trigger: zone.avgResp>600s    action: send_push("New requests!")
4. "High Rating Boost"          trigger: provider.rating>4.8  action: boost_visibility(1.5) [shadow]
5. "Critical Supply Alert"      trigger: zone.supplyCount<2   action: expand_radius(10km)
6. "Auto Penalty No-Shows"      trigger: provider.noShow>3    action: limit_provider [disabled]
```

```python
# Failsafe rules (5): Surge Limit Guard, Conversion Floor, Supply Crisis Alert, Mass Cancel Detector, Revenue Drop Guard
# Action chains (4): Low Supply Critical (4 steps), Market Crash Response, Peak Hour Optimization, Provider Onboarding
```

---

## 11. ВЫЯВЛЕННЫЕ ПРОБЛЕМЫ И РИСКИ

### 🔴 Критические (нарушают доменную целостность)
1. **Смешение Kyiv-taxi + Berlin-auto** в seed:
   - 8 organizations с `city='kyiv'`, UAH цены, taxi-mechanic descriptions
   - 6 zones Kyiv UAH + 4 zones Germany EUR
   - 20 bookings — все Kyiv, UAH currency
   - PRD заявляет Berlin/Hamburg/Munich/Frankfurt → ⚠️ требуется чистка legacy данных или явное разделение через feature flag
2. **BILLING_PRODUCTS в UAH** — provider boost / promoted / VIP пакеты используют гривны в Auto Search Germany контексте
3. **Currency не унифицирован**: `Stage 4 — Payments (Stripe Checkout) + Revenue` ожидает EUR, а `provider_purchases` пишет UAH

### 🟡 Средние
4. **Redis недоступен** — NO-OP fallback не race-safe в multi-worker (cooldowns теряются)
5. **3 webhook handler-а на одном path** `/api/webhook/stripe` — first-match resolution, может скрывать баги
6. **PayPal — mock** — реальные платежи через PayPal не работают
7. **`db.X`, `db.collection`, `db.client`** — найдены 3 collection-имени с placeholder/искажениями в коде (грепом)
8. **Provider org `provider@test.com` имеет ownerId привязку только к 1-й org** — остальные 10 имеют `uid()` (фантомные владельцы)
9. **Server.py ещё 2 196 строк** — Sprint 21 C5–C17 вынес значительную часть, но монолитный файл ещё содержит ~30 endpoints (governance / demand-action / push devices)
10. **Параллельные WebSocket импорты** (`/api/socket.io/` упомянут в `observability_middleware` skip_log) — но без NestJS WS не работает; realtime через Mongo polling

### 🟢 Низкие (косметика / TODO)
11. **`scripts/migrate_users_to_accounts.py`** упоминается в комментариях — нужна проверка существования и идемпотентности
12. **Hash-based trust fallback** — определяет TÜV у 50% случайных провайдеров (`slug_hash % 2`). Для production нужна реальная верификация
13. **Hardcoded fallback addresses** в seed: `'Киев, ул. Тестовая ...'`, координаты `[30.5, 50.45]`
14. **No-op email/SMS** — `password_reset_tokens` создаются, но никто не отправляет письма
15. **Inspector users (Михаил Петров, Anna Schulz)** в коллекции `users` без `passwordHash` — войти могут только через synth seed (не login)

---

## 12. ТЕХ-ДОЛГ — НЕЗАВЕРШЁННЫЕ СПРИНТЫ

Из `/app/memory/sprint*.md`:
- **Sprint 21** (модуляризация server.py) — C5..C17 готовы, C22 (удалить shim mongo_url) ещё не сделан
- **Sprint 33** (Germany rollout) — C1..C8 готов; цены/seed/billing ещё в UAH (несоответствие)
- **Sprint 10a** (Parser Audit) — открыт
- **sprint1d3** (Admin Domain Closure) — частично done
- **identity_runtime / capability split** — финальная фаза
- **Phase D Pass 1** (Runtime Ledger) — работает, нужен Pass 2 (read endpoints)

---

## 13. ЗАВЕРШЁННЫЕ ФЛОУ (сейчас 100% работают)

✅ **Гостевой профиль** — `continueAsGuest()` → `/(tabs)` без auth, доступны publish surfaces  
✅ **Login flow** — `/api/auth/login` → JWT с caps + accountId + kind (verified тремя credentials)  
✅ **Registration** — `/api/auth/register` → создаёт user + ensure_account_for_user → account + capabilities  
✅ **City onboarding gate** — first launch → city-select if not chosen  
✅ **Customer create request** — `/auto-request/create` → POST `/api/auto/requests` → car_request + N inspection_jobs + ledger event + exposures top-N inspectors  
✅ **Inspector claim job** — `/inspector/exposures` → POST `/api/inspector/jobs/{id}/claim` (atomic) → timeline + ledger event  
✅ **Quick-request taxi flow** — `/api/quick-request/resolve` → ranker + 3 providers + 60s window → realtime + auto-expire  
✅ **Orchestrator cycle** — 10s zone recalc + auto-actions per severity + pre-engagement Push  
✅ **Web platform main page** — `/api/web-app/` — AUTO SEARCH home с парсером 12 площадок и LIVE feed  
✅ **Admin login** — `/api/admin-panel/` → 70 страниц управления  
✅ **Pricing read** — `GET /api/pricing` → EUR inspection + selection с auto-seed  
✅ **Stripe checkout** (test mode) — for packages and auto-requests inline  
✅ **Vehicle Memory** — public `/vehicle/:id` page + ingest from listing URL + watch/subscriptions  

## 14. ЧАСТИЧНО РАБОТАЮЩИЕ / ТРЕБУЮТ ВНИМАНИЯ

⚠️ **Inspector verification queue** — endpoints есть, UI есть, но `inspector_verifications=0` docs в DB (нет тестовых заявок)  
⚠️ **Notifications projector** — endpoints есть, `notifications=4 docs`, push не отправляется реально  
⚠️ **PayPal flow** — frontend `packages/paypal-return.tsx` ожидает callback, но backend в mock mode  
⚠️ **NestJS-зависимые ops** — `/api/admin/live-feed`, `/api/admin/alerts-enhanced` использовали NestJS proxy, теперь stub returns  
⚠️ **Ops Map snapshot** — endpoint есть, но требует свежих `zones` с координатами (есть для Kyiv+Germany)  
⚠️ **Provider Reputation** — engine работает, но `reputation_snapshots=0` docs (никто ещё не запускал /recompute)  

## 15. НЕ РЕАЛИЗОВАНО / ПЛАНИРУЕТСЯ

❌ **Push отправка** (FCM/APNS sender)  
❌ **Email (SMTP/SendGrid/Resend)** — пароль reset не доставляется  
❌ **SMS** (Twilio) — нет integration  
❌ **AI cognition** (GPT/Claude/Gemini) — restrained interpretive слои `customer_cognition`/`continuity` сейчас на правилах, без LLM  
❌ **TÜV-style PDF report generation** — endpoint `app/inspection/router.py` есть, но реальный PDF builder?  
❌ **Real-time WebSocket** для клиента — Mongo polling вместо socket.io  
❌ **i18n** мобильного для немецкого языка — RU/EN в локалях, DE может быть неполным  

---

## 16. РЕКОМЕНДАЦИИ ПО ПРИОРИТЕТАМ

### A. Чистка домена (P0)
1. Решить судьбу Kyiv-данных: либо удалить их seed, либо явный feature flag `LEGACY_TAXI_MODE`
2. Переписать `BILLING_PRODUCTS` в EUR — провайдеры в Германии не покупают boost за UAH
3. Унифицировать currency в `bookings` / `quotes` / `payments` (сейчас разрыв)

### B. Завершить незакрытые спринты (P1)
4. Sprint 21 C22 — удалить `mongo_url`/`db_name` shim, мигрировать оставшиеся 30 server.py endpoints в `app/admin/*`
5. Sprint 33 C9 — Germany seed для billing
6. Sprint 10a — Parser audit (mobile.de / autoscout24 на корректность парсинга)

### C. Интеграции (P2)
7. Email (Resend / SendGrid) для password reset + booking notifications
8. Push реальный — Expo Push Service wrapper
9. PayPal real (production credentials) или удалить mock
10. WebSocket transport (без NestJS) — socketio-asgi на FastAPI

### D. Production readiness (P3)
11. Redis запустить (cooldowns multi-worker safe, idempotency, rate limit)
12. Inspector verification real flow + admin queue test data
13. TÜV PDF generator (reportlab или weasyprint)

---

## 17. ФАЙЛЫ-ОРИЕНТИРЫ ДЛЯ ДОРАБОТКИ

| Что | Файлы |
|---|---|
| Чистка legacy Kyiv | `app/core/seed.py:184-300`, `app/billing/router.py:1-50` |
| Server.py модуляризация | `backend/server.py:715-2196` (governance endpoints) |
| Auto Requests расширение | `app/auto_requests/*` |
| Ranking ML | `app/marketplace/quick_request.py:140-200` |
| Pricing/Currency | `app/pricing/router.py`, `app/billing/router.py:1-100` |
| Inspector cabinet | `app/inspector/cabinet.py` + `web-app/src/pages/inspector/*` |
| Customer flow | `app/customer/router.py` + `frontend/app/auto-request/*` + `web-app/src/pages/customer/*` |
| Admin governance | `admin/src/pages/Governance*Page.tsx` + `app/admin/*` |
| Parsers | `app/parsers/{mobile_de,autoscout24,kleinanzeigen}.py` |
| Identity миграция | `app/core/identity_runtime.py` + `scripts/migrate_users_to_accounts.py` |

---

**КОНЕЦ АУДИТА**  
~Состояние системы зафиксировано полностью. Готовы к доработке любого слоя — ждём указаний.~
