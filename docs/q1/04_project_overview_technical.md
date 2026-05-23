# 04 — Техническое описание всего проекта

> Документ для разработчика. Описывает **всю** платформу
> Auto Search, а не только Месяцы 1–2.

---

## Что это за продукт

**Auto Search** — мульти-сёрфейс операционная платформа для предпокупочной
инспекции автомобилей и маркетплейса сертифицированных инспекторов в
Германии (Berlin · Hamburg · Munich · Frankfurt · …) и Австрии (Wien,
Salzburg).

**Business model:** клиент вставляет ссылку на объявление (mobile.de,
autoscout24, kleinanzeigen и др., поддерживается 12 площадок).
Сертифицированный инспектор проводит TÜV-style проверку (60-point check)
и выдаёт PDF-отчёт за 24 часа с фото/видео-пруфами.

---

## Архитектура (4 поверхности + общий backend)

| Surface  | Tech stack                | Назначение                                       | Endpoint                              |
|----------|---------------------------|--------------------------------------------------|---------------------------------------|
| Expo     | RN 0.81 + Expo SDK 54     | Mobile: "что я делаю прямо сейчас"               | `/` (root, Metro :3000)               |
| Web-app  | Vite + React 18           | Operations: deep work, документы, multi-pane     | `/api/web-app/`                       |
| Admin    | Vite + React 18           | Governance: автоматизация, аудит, market-control | `/api/admin-panel/`                   |
| Backend  | FastAPI + MongoDB + Motor | State of record, REST API, WebSockets            | `/api/*` (порт 8001)                  |
| Shared   | Pure TypeScript (no JSX)  | Behavioral truth (state machines, contracts)     | `/app/shared/` (alias `@platform/*`)  |

**Surface philosophy:**
- **Expo** отвечает на вопрос *"что я делаю прямо сейчас?"* — execution,
  realtime, on-the-go.
- **Web-app** — *"как я работаю с этим в деталях?"* — operations, multi-pane,
  documents.
- **Admin** — *"как я управляю всей системой?"* — governance, automation, ops.
- **Backend** — *"что является истиной?"* — persistence, authority, state of record.
- **Shared** — *"как ведёт себя домен?"* — state machines, contracts.

---

## Backend — детально

### Структура модулей `/app/backend/app/`

| Модуль                  | Что внутри                                                         |
|-------------------------|--------------------------------------------------------------------|
| `core/`                 | config, db, security, utils, geo, context, lifespan, metrics       |
| `system/`               | auth, health, system, compat, telemetry, realtime                  |
| `marketplace/`          | providers, matching, zones, cities, quick_request, auction, clusters, trust |
| `customer/`             | customer-side endpoints (booking, profile, history)                |
| `provider/`             | provider/inspector workbench, onboarding, dashboard                |
| `inspector/`            | inspector cabinet, timeline, contact unlock, offline_replay         |
| `auto_requests/`        | car_requests + inspection_jobs (1:N), media, candidates             |
| `customer_continuity/`  | restrained interpretation of inspection report (customer view)      |
| `customer_cognition/`   | Pass A deterministic report interpreter                             |
| `admin/`                | dashboard, contact_audit, stripe_settings, verification_queue, …    |
| `payments/`             | Stripe checkout (real) + PayPal (sandbox)                          |
| `billing/`              | invoicing, subscriptions, packages                                  |
| `pricing/`              | dynamic pricing engine                                              |
| `parsers/`              | mobile.de / autoscout24 / kleinanzeigen / otomoto / leboncoin / willhaben / +6 |
| `inspection/`           | TÜV-style report generation                                         |
| `orchestrator/`         | governance loops (demand/supply auto-actions)                       |
| `intelligence/`         | draft engine + report intelligence                                  |
| `ml/`                   | demand forecast, surge zones, A/B experiments                       |
| `observatory/`          | operator cognition surface                                          |
| `reports/`              | report generation + workspace                                       |
| `reputation/`           | reputation engine (per-user reputation score)                       |
| `chat/`                 | user↔provider + user↔support + canonical chat                       |
| `notifications/`        | projector + unread counts + admin backfill                          |
| `runtime_ledger/`       | append-only continuity-topology trace                               |
| `ops_map/`              | live ops map snapshot for admin                                     |
| `assignments/`          | live assignments (admin-created, inspector-accepted)                |
| `growth/`               | reactivation, nudges, auto-money mode                               |
| `performance/`          | provider performance tracking                                       |
| `revenue/`              | revenue model + experiments                                         |
| `vehicles/`             | Vehicle as Memory System (public /vehicle/:id)                      |
| `packages/`             | inspection credit packages (1/3/5)                                  |
| `referrals/`            | referral system                                                     |
| `retention/`            | retention loops                                                     |
| `push/`                 | push device registration + dispatch                                 |
| `domination/`           | market-domination playbooks                                         |
| `media/`                | base64 image storage + serving                                      |

### Endpoint inventory

**Total: 230+ endpoints.**

Domains breakdown (округлено):
- `/api/auth/*` — 6
- `/api/cities/*` — 2
- `/api/marketplace/*` — 35
- `/api/admin/*` — 60
- `/api/inspector/*` — 25
- `/api/auto-requests/*` — 30 (customer + inspector + admin + media)
- `/api/payments/*` — 15
- `/api/chat/*` — 8
- `/api/notifications/*` — 5
- `/api/health`, `/api/system/*` — 6
- остальные — 30

### MongoDB collections (основные)

| Collection           | Purpose                                            |
|----------------------|----------------------------------------------------|
| `users`              | user account (email, hashedPassword, role)         |
| `accounts`           | account record (multi-account identity runtime)    |
| `organizations`      | СТО / inspector workshops + geo                    |
| `services`           | каталог услуг                                       |
| `servicecategories`  | категории услуг                                     |
| `bookings`           | основные заявки (legacy)                            |
| `web_bookings`       | web-marketplace заявки                              |
| `car_requests`       | AUTO 2.0 — заявки на инспекцию                      |
| `inspection_jobs`    | работы (1:N с car_requests, per-city)               |
| `inspection_reports` | PDF-отчёты                                          |
| `inspection_drafts`  | draft intelligence engine                          |
| `vehicles`           | Vehicle Memory System                              |
| `reviews`            | отзывы                                              |
| `zones`              | demand zones                                        |
| `payments`           | Stripe + PayPal transactions                        |
| `notifications`      | notification projector                              |
| `runtime_ledger`     | append-only event log                               |
| `system_logs`        | observability                                       |
| `governance_actions` | admin actions audit                                 |
| `idempotency`        | POST idempotency cache                              |
| ... +30 more         | mostly per-domain                                   |

### External integrations

- **Stripe** — real payments, через `app/billing/stripe_payments.py` +
  `app/payments/router.py`.
- **PayPal** — sandbox для credits.
- **Redis** — опционально (state ops, rate-limit, idempotency). Сейчас
  отключён → fallback на in-memory + Mongo TTL.
- **NestJS subprocess** — отключён (`NESTJS_ENABLED=0`). Legacy slot, не
  используется.

### Middleware stack

```
CORS → prod_readiness (rate-limit + idempotency) → observability → routes
```

---

## Frontend — детально

### Expo (`/app/frontend/`)

```
app/                   # expo-router file-based routing
├── _layout.tsx        # root layout + providers (Auth, City, Theme)
├── (tabs)/            # 5 tabs (home, search, requests, messages, profile)
├── index.tsx          # onboarding
├── login.tsx, register.tsx, forgot-password.tsx
├── city-select.tsx
├── about.tsx, terms.tsx, privacy.tsx, help.tsx, support.tsx
├── additional.tsx, direct.tsx, disputes.tsx, favorites.tsx
├── messages.tsx, notifications.tsx, referral.tsx, settings.tsx
├── zones.tsx, zones/[id].tsx
├── booking/[id].tsx, booking-confirmation.tsx
├── chat/[id].tsx, chat/list.tsx
├── customer/ (12 screens)
├── inspector/ (20 screens)
├── provider/ (15 screens)
├── operator/, organization/, packages/, payment/
├── quote/, request/, review/, vehicles/
├── auto-request/, dashboard/
├── invite/, inspection-preview.tsx, create-quote.tsx
└── provider-boost.tsx, provider-intelligence.tsx, ...

src/
├── services/api.ts        # axios + interceptors
├── context/{Auth,City,Theme}Context.tsx
├── stores/                # zustand
├── components/            # shared RN components
├── theme/, lib/, hooks/, utils/, i18n/, data/
└── inspector/             # inspector-specific
```

### Web-app (`/app/web-app/`)

```
src/
├── main.tsx, App.tsx
├── pages/
│   ├── public/            # SearchPage, LiveForecastMapPage, OperatorProfilePage, ProviderPage, …
│   ├── customer/          # 16 страниц (Bookings, Packages, Profile, Garage, …)
│   ├── provider/          # provider workbench, earnings, intelligence
│   ├── inspector/         # inspector workspace
│   └── chat/              # ChatPages
├── components/
│   ├── LiveMap.tsx        # react-leaflet
│   └── …
├── layouts/, shells/      # multi-pane shells (web-only)
├── services/api.ts
├── stores/                # zustand
├── i18n/, hooks/, lib/, shared/
```

**Сборка:** Vite (`yarn build` → `dist/`). FastAPI отдаёт `dist/` под `/api/web-app/*`.

### Admin (`/app/admin/`)

```
src/
├── pages/
│   ├── Login.tsx
│   ├── Dashboard.tsx
│   ├── Governance/ (verification queue, reputation, demand actions, …)
│   ├── Automation/ (orchestrator config, chains, replay)
│   ├── Ops/ (ops map, live feed, alerts)
│   ├── Revenue/ (experiments, results, A/B)
│   ├── Stripe/ (settings)
│   └── …
├── components/            # radix-ui based (Dialog, Dropdown, Toast, …)
└── …
```

**Сборка:** Vite. FastAPI отдаёт под `/api/admin-panel/*`.

---

## Shared (`/app/shared/`)

```
shared/
├── domain/
│   ├── contracts/         # Request/response types, IDs, enums
│   ├── state-machines/    # booking, quote lifecycles
│   ├── identity/          # Account, Kind, Capability
│   ├── formatters/        # currency, date, mileage, plate, VIN
│   ├── validators/        # zod schemas, URL parsers (mobile.de, autoscout24)
│   ├── parsers/
│   └── index.ts
├── cognition_guardrails/  # behavioural constraints
└── tsconfig.json          # strict, ES2020, no DOM lib
```

**Boundary law:** No JSX. No React. No platform imports. Если `node /tmp/foo.js`
не запустит файл — он не для shared/.

**Path alias `@platform/*`** в Expo (metro), Web-app (vite), Admin (vite).

---

## Service architecture (как всё запускается)

```
supervisor (process manager)
   │
   ├── mongodb           :27017     RUNNING (autostart)
   │
   ├── backend           :8001      uvicorn server:app --workers 1 --reload
   │   ├── lifespan startup:
   │   │   • seed_data (admin/customer/provider users + 11 demo orgs)
   │   │   • ensure_idempotency_indexes
   │   │   • ensure_alert_indexes
   │   │   • ensure_ttl_indexes
   │   │   • runtime_ledger.ensure_indexes
   │   │   • performance/revenue init
   │   ├── background loops:
   │   │   • orchestrator cycle (every ~60s) — demand/supply auto-actions
   │   │   • feedback processor (every ~3min)
   │   │   • provider_ranking_optimizer_loop
   │   │   • pre_engagement (every 30s)
   │   └── 230+ endpoints через include_router
   │
   ├── expo              :3000      yarn expo start --tunnel
   │   • Metro bundler
   │   • web-preview HTTP 200
   │   • Ngrok tunnel для mobile QR-code
   │
   └── (Admin + Web-app)            ОБРАБАТЫВАЮТСЯ FastAPI как static
       • /api/admin-panel/  → admin/dist/
       • /api/web-app/      → web-app/dist/
```

**Kubernetes ingress:**
- `/api/*` → port 8001 (backend)
- `/*` → port 3000 (expo metro)

---

## Что и где запускать

### Локально (этот контейнер)

```bash
# Все три сервиса управляются supervisor
sudo supervisorctl status

# Перезапуск
sudo supervisorctl restart backend
sudo supervisorctl restart expo

# Логи
tail -f /var/log/supervisor/backend.{err,out}.log
tail -f /var/log/supervisor/expo.{err,out}.log
```

### Сборка фронтов (после изменений)

```bash
cd /app/admin && yarn build       # → admin/dist/
cd /app/web-app && yarn build     # → web-app/dist/
# Expo (mobile) собирается Metro on-the-fly, не нуждается в yarn build
```

### Установка зависимостей

```bash
cd /app/backend  && pip install -r requirements.txt
cd /app/frontend && yarn install
cd /app/web-app  && yarn install
cd /app/admin    && yarn install
```

---

## Env vars (rough overview)

### `/app/backend/.env`
```
MONGO_URL=mongodb://localhost:27017
DB_NAME=test_database
# (опционально) NESTJS_ENABLED=0, JWT_SECRET=..., STRIPE_*, PAYPAL_*
```

### `/app/frontend/.env`
```
EXPO_TUNNEL_SUBDOMAIN=web-platform-build-1
EXPO_PACKAGER_HOSTNAME=https://web-platform-build-1.preview.emergentagent.com
EXPO_PUBLIC_BACKEND_URL=https://web-platform-build-1.preview.emergentagent.com
EXPO_USE_FAST_RESOLVER=1
METRO_CACHE_ROOT=/app/frontend/.metro-cache
EXPO_PACKAGER_PROXY_URL=https://web-platform-build-1.preview.emergentagent.com
```

---

## Тестирование

```
/app/backend/tests/         # 70+ pytest файлов
/app/test_reports/pytest/   # отчёты
```

Запуск: `cd /app/backend && pytest tests/`.

---

## Активные sprint'ы (см. `/app/memory/sprint_*.md`)

- **Sprint 10a** — Parser audit (mobile.de / autoscout24 / kleinanzeigen).
- **Sprint 21 C1-C16** — Модуляризация server.py (50+ модулей).
- **Sprint 1d3** — Admin domain closure (identity_runtime + capability).
- **Sprint 27-33** — Revenue, experiments, retention, growth.
- **Phase 1B Tier 1-4** — Cluster writer (тенант-сегментация).
- **Phase D Pass 1** — Runtime Continuity Ledger.

---

## Ограничения / TODOs

1. **Redis отключён** — orchestrator state ops в no-op fallback. Включить
   → стабильность auto-actions.
2. **NestJS subprocess отключён** — `NESTJS_ENABLED=0`. Если придётся
   включить — нужен `yarn build` в `/app/backend/src/`.
3. **Expo tunnel** — иногда переподключается. Localhost:3000 всегда работает.
