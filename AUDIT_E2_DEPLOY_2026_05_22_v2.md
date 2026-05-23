# 🔍 AUDIT v2 — A-Search Experts (Auto-Service Marketplace)

**Дата:** 2026-05-22
**Среда:** Emergent preview pod `mobile-app-expo-13`
**Аудитор:** E2 (Emergent, текущая сессия)
**Источник:** https://github.com/aliyalens1-stack/y32ey238dy23d
**Preview URL:** https://mobile-app-expo-13.preview.emergentagent.com
**Предыдущие аудиты:** `AUDIT_E1_DEPLOY_2026_02_22.md`, `AUDIT_E1_DEPLOY_2026_02_22_v2.md`, `AUDIT_E2_DEPLOY_2026_05_22.md`, `AUDIT_REPORT_2026_05_22.md`, `AUDIT_WEB_2026_05_22.md`

---

## 1. TL;DR — Развёртывание выполнено ✅

| Компонент | Статус | Деталь |
|---|---|---|
| **FastAPI Backend** | ✅ RUNNING | `:8001` — **650 endpoints** (рост с 637 в предыдущем E2 раунде = +13 новых) |
| **MongoDB** | ✅ RUNNING | `mongodb://localhost:27017`, db `test_database` |
| **Expo Frontend (web)** | ✅ RUNNING | `:3000` — Metro Bundler, web bundle отдаётся, UI отрисован |
| **Preview URL** | ✅ LIVE | HTTP 200, лендинг «Don't buy a car blind» |
| **Auth (3 роли)** | ✅ OK | admin / customer / provider_owner — все логинятся |
| **Health endpoint** | ✅ OK | `{"status":"ok","db":"connected","nestjs":"disabled"}` |
| **Redis** | ⚠️ NO-OP fallback | Не блокер (документировано в PRODUCTION_READINESS) |
| **NestJS subprocess** | ⏸️ disabled | `NESTJS_ENABLED=0` — весь API через FastAPI |
| **Workers** | ✅ RUNNING | orchestrator, demand predictor, vehicles refresh, exposures loops |
| **Index ensure** | ✅ OK | Sprints 1–8 индексы создаются на старте |
| **Seed data** | ✅ OK | admin user + 8 categories + 12 services + 11 organizations |
| **Admin SPA `/admin`** | ⏸️ не собран | `admin/dist/` отсутствует |
| **Web-app SPA `/web-app`** | ⏸️ не собран | `web-app/dist/` отсутствует |

**Стартовый экран в preview:** «A | Search Experts — Don't buy a car blind», PRE-PURCHASE CAR INSPECTION badge, CTA «Find & inspect a car» / «Become an inspector», список TÜV-style inspection / Local inspectors in Germany (Berlin · Hamburg · Munich · Frankfurt) / Reports within 24h / Photo & video proof. EN/RU/DE локализация. Тёмная палитра + жёлтый акцент. UI рендерится корректно.

---

## 2. Что сделано в этом раунде

| # | Шаг | Результат |
|---|---|---|
| 1 | `git clone aliyalens1-stack/y32ey238dy23d` → `/tmp/repo` | ✅ |
| 2 | Сохранил защищённые `.env` (backend + frontend) во временный буфер | ✅ |
| 3 | `mv /app/backend /app/backend.OLD`, `mv /app/frontend /app/frontend.OLD` | ✅ (backup preserved) |
| 4 | Скопировал `backend/`, `frontend/`, `admin/`, `web-app/`, `shared/`, `memory/`, `docs/`, `ops/`, `tests/`, `audit/` → `/app/` | ✅ |
| 5 | Восстановил protected `.env` файлы | ✅ |
| 6 | Добавил `EXPO_PUBLIC_BACKEND_URL` в `/app/frontend/.env` (Expo читает именно эту переменную, см. `src/services/api.ts:10`) | ✅ |
| 7 | `pip install -r requirements.txt` — 137 пакетов | ✅ без ошибок |
| 8 | `yarn install` в `/app/frontend` (Expo lockfile сгенерирован) | ✅ только deprecation warnings (uuid, rimraf, glob — не блокеры) |
| 9 | `supervisorctl restart backend frontend` | ✅ оба `RUNNING` |
| 10 | Smoke: `GET /api/health` → 200, db connected, mongo ping OK | ✅ |
| 11 | Smoke: `POST /api/auth/login` для admin/customer/provider | ✅ JWT для всех трёх ролей |
| 12 | Smoke: `GET /api/services` → каталог 12 сервисов в 3 локалях | ✅ |
| 13 | Preview screenshot — лендинг A|SEARCH EXPERTS | ✅ |
| 14 | Файлы `memory/` (134 closure-docs) восстановлены в `/app/memory/` | ✅ |

---

## 3. Метрики кодовой базы

### Backend (FastAPI/Python)
- **126 872 LOC** в `*.py`
- **55 bounded contexts** в `/app/backend/app/`:
  ```
  admin, assignments, auto_requests, billing, booking,
  car_selection, car_selection_thread, chat, core, customer,
  customer_cognition, customer_continuity, disputes, escrow, geo,
  governance, growth, inspection, inspections, inspector,
  integrations, intelligence, marketplace, matching_v2, media,
  ml, notifications, observatory, offer_packages, ops_map,
  orchestrator, packages, parsers, payments, performance,
  pricing, provider, provider_trust, push, referrals,
  reports, reputation, retention, revenue, runtime_ledger,
  service_chat, service_marketplace, static, system, two_factor,
  vehicles, workers
  ```
- **650 эндпоинтов** в OpenAPI. Топ-10 неймспейсов:
  | endpoints | namespace |
  |---:|---|
  | 191 | `/api/admin/*` |
  | 83  | `/api/provider/*` |
  | 48  | `/api/inspector/*` |
  | 35  | `/api/customer/*` |
  | 30  | `/api/marketplace/*` |
  | 22  | `/api/payments/*` |
  | 15  | `/api/chat/*` |
  | 14  | `/api/inspections/*` |
  | 13  | `/api/car-selection/*` |
  | 12  | `/api/auth/*` |

### Frontend (Expo / React Native + expo-router)
- **77 381 LOC** в `*.ts(x)`
- **60+ routes** в `/app/frontend/app/` (expo-router file-based):
  - 9 tabs: `index, create, garage, profile, quotes, reports, requests, services` (+ layout)
  - Customer flows: `auto-request/`, `booking/`, `quote/`, `request/`, `selection/`, `disputes/`, `chat/`, `delivery/`, `payment/`, `payments/`, `vehicles/`, `review/`
  - Provider flows: `provider/`, `provider-boost*`, `provider-intelligence`, `subscription/`, `pricing-preview`, `service-marketplace/`
  - Inspector flows: `inspector/`, `inspection-preview`, `inspection-report/`
  - Admin flows: `admin/`, `operator/`, `zones/`
  - Trust/Review: `trust/`, `review/`, `disputes/`
  - Auth: `login.tsx`, `register.tsx`, `partner-register.tsx`, `forgot-password.tsx`, `2fa-verify.tsx`, `security-2fa.tsx`
  - Misc: `referral.tsx`, `notifications.tsx`, `messages.tsx`, `favorites.tsx`, `city-select.tsx`, `support.tsx`, `terms.tsx`, `privacy.tsx`, `help.tsx`, `about.tsx`

### Web-app (отдельный Vite проект)
- В `/app/web-app/` — есть исходники (`src/App.tsx`, pages/, shells/, i18n/, stores/), но `dist/` ещё **не собран**
- Backend сервирует его под `/api/web-app/` если есть build (см. `ADMIN_BUILD_DIR`, `WEBAPP_BUILD_DIR` в `config.py`)

### Admin (отдельный Vite + shadcn проект)
- В `/app/admin/` — Vite + Radix UI + shadcn (`components.json`)
- `admin/dist/` тоже отсутствует

---

## 4. Архитектура — что реально стоит за 650 endpoint'ами

**Замкнутый transactional loop:**

```
┌──────────────────────────────────────────────────────────────┐
│  customer  ──auto-request──>  marketplace  ──bid──>  provider │
│     │                                                  │      │
│     ▼                                                  ▼      │
│   booking ──escrow.intent──> Stripe PaymentIntent (held)      │
│     │                                                         │
│     ▼ work-in-progress                                        │
│  chat (service_chat) + inspection (60-point) + media (S3/local)│
│     │                                                         │
│     ▼                                                         │
│  trust (review) ─revealed→ reputation ←── arbitration         │
│     │                                                         │
│     ▼                                                         │
│  escrow.release ──Transfer──> provider's Stripe Connect       │
│     │           (12h gate + freeze guards + dispute hold)     │
│     │                                                         │
│     └──> notifications (push + in-app) + ops alerts          │
└──────────────────────────────────────────────────────────────┘
                              ▲
                              │ admin/ops control plane
                  (191 admin endpoints — disputes,
                   payments freeze, reconciliation,
                   forensic WS, integrations rotate)
```

**Background workers** (supervised by `worker_supervisor`, registered `policy=on_failure max_restarts=5`):
| Worker | Interval | Purpose |
|---|---:|---|
| Orchestrator cycle | 10s | Phase E+G demand prediction (видим в логах: «Orchestrator cycle #4: 40 actions across 15 zones») |
| Feedback processor | 15s | Phase G action feedback |
| Exposures expire loop | 60s | Mark expired exposures |
| Exposures batching loop | 60s | Batch send notifications |
| Exposures stats recompute | 300s | Recompute inspector stats |
| Strategy optimizer | 60s | Recalculate orchestrator weights |
| Sprint 20 DemandPredictor | 60s | Train per-zone demand model |
| Push receipts poll | 180s | Poll Expo push receipts |
| Vehicles refresh | 60s | Temporal evolution of demo vehicles |

**Sprint history (всё закрыто):**
| Sprint | Focus | Статус |
|---:|---|:---:|
| 5 | Trust & Retention (reviews + reputation + trust cards) | ✅ |
| 6 | Disputes & Resolution Layer | ✅ |
| 7 | Stripe Connect Express (sandbox-ready) | ✅ |
| 8 | Firebase Realtime + Operational UX | ✅ |
| 9 | Stabilization & Hardening | ✅ |
| Phase B/B4_3_A | Reconciliation audit closure, TOCTOU status hardening, supervisor closure | ✅ (`memory/B4_3_A_*` — 134 closure-docs) |

---

## 5. Smoke / интеграционные тесты в репозитории

В `/app/backend/` лежат **16 готовых smoke/e2e скриптов** (запускаются `python test_*.py`):
```
test_admin_forensic_ws_smoke.py          test_payment_chronology_realtime_smoke.py
test_customer_timeline_ws_smoke.py       test_payment_chronology_writer_smoke.py
test_deeplink_resolver_smoke.py          test_payment_status_toctou_smoke.py
test_disputes_e2e.py                     test_provider_timeline_ws_smoke.py
test_inspector_timeline_ws_smoke.py      test_reconciliation_audit_smoke.py
test_payment_chronology_attached_e2e.py  test_reconciliation_supervisor_smoke.py
test_payment_chronology_e2e.py           test_sprint8_ops_e2e.py
                                         test_stripe_connect_e2e.py
                                         test_trust_e2e.py
```
И `prod_readiness.py` — pre-launch check.

> Per `PRODUCTION_READINESS.md §8`, 4 ключевых suites (`test_trust_e2e`, `test_disputes_e2e`, `test_stripe_connect_e2e`, `test_sprint8_ops_e2e`) ДОЛЖНЫ пройти ДО `STRIPE_CONNECT_ENABLED=1`. В этом раунде я их не гонял — это будет следующим шагом по запросу пользователя.

---

## 6. Внешние интеграции

| Интеграция | Где | Статус |
|---|---|---|
| **Stripe** (sandbox keys) | `app/integrations/stripe_service.py`, `router_stripe.py`, `billing/stripe_payments.py` | ✅ тестовые ключи seedятся idempotent через `integrations/seed.py` |
| **Stripe Connect Express** | `app/integrations/stripe_connect_service.py`, `router_connect.py` | ✅ sandbox-ready, требует `STRIPE_CONNECT_ENABLED=1` для live |
| **Firebase Push (Expo)** | `app/push.py`, `app/notifications/`, `services/pushRegistration.ts` | ✅ Expo push receipts polling worker запущен |
| **MongoDB Motor** | глобально через `app.core.db` | ✅ |
| **Redis** (orchestrator state) | `app.core.redis_client` | ⚠️ нет инстанса в этой среде, NO-OP fallback (не блокер) |
| **emergentintegrations** (LLM lib) | в `requirements.txt` (v0.1.0) | ⚪ установлен, использование не аудировано |
| **openai / litellm / google-genai** | в `requirements.txt` | ⚪ установлены (intelligence module) |
| **boto3 / s3transfer** | в `requirements.txt` | ⚪ S3 для media опционально |
| **SendGrid / Twilio** | объявлены как providers в `router_admin_integrations.py:34-35` | 🚫 credentials НЕ заданы — функционал ждёт admin UI |
| **NestJS subprocess** | `NESTJS_ENABLED=0` (default) | ⏸️ выключен, не блокер |

---

## 7. Безопасность — что нашёл

### 🔴 HIGH

| # | Issue | Файл | Действие |
|---:|---|---|---|
| H1 | **Хардкод Stripe TEST ключей в публичном GitHub репо.** `app/integrations/seed.py:18-20` содержит реальные `pk_test_`/`sk_test_`/`rk_test_` ключи. Они помечены TEST mode, но это ваш Stripe Sandbox account — любой клонировавший репо может вызывать Stripe API от вашего имени (rate-limit hijack, sandbox event flood). | `/app/backend/app/integrations/seed.py` | Переместить в `.env`, `_STRIPE_TEST_DEFAULTS` читать через `os.environ.get`, в репозитории — placeholder. **Rotate** текущие ключи в Stripe Dashboard. |

### 🟡 MEDIUM

| # | Issue | Файл | Действие |
|---:|---|---|---|
| M1 | **JWT_SECRET имеет небезопасный default** `'auto_service_jwt_secret_key_2025_very_secure'`. Если в prod env vars не задать — токены кто угодно может подделать. | `app/core/config.py:38` | В deploy-prod env обязательно задать ≥32 char random `JWT_SECRET`. |
| M2 | **ADMIN_PASSWORD default `Admin123!`** — задокументировано в `PRODUCTION_READINESS.md`, но на момент аудита пароль admin'а — это всё ещё дефолт (я только что им залогинился). | `app/core/config.py:41`, seed | В prod env override + ротация после первого login. |
| M3 | **CORS = `*`** (`backend/.env`: `CORS_ORIGINS="*"`) | `backend/.env` | Для live: ограничить до preview/prod domain'ов. Для preview/dev оставить как есть. |
| M4 | **`TEST_BYPASS_TOKEN` infrastructure присутствует** (`config.py:52`). Если случайно установить в prod env — auth rate-limit полностью отключается через header `X-Test-Bypass`. | `app/core/config.py` | Перед prod deploy явно проверить, что `TESTING=0` и `TEST_BYPASS_TOKEN` пуст. |

### 🟢 LOW / Info

- **Redis отсутствует** — orchestrator/exposures fallback в NO-OP. Не блокер для money-flows (см. PRODUCTION_READINESS §1, помечено `⭕`). Для нагрузочных тестов и live — поднять Redis.
- **NestJS subprocess отключён** — все API через FastAPI. Это сознательный архитектурный выбор по `config.py:24-32`.
- **`admin/dist/`** и **`web-app/dist/`** не собраны — backend готов сервить их под `/api/admin-panel/` и `/api/web-app/` если выполнить `yarn build` в этих папках.
- **130+ closure-docs в `memory/`** — отличный аудит-след всех закрытых sprint'ов, использовать как контекст для будущих изменений.

---

## 8. Что делать дальше — рекомендации

### Сразу (до первого live customer)
1. **Ротировать Stripe TEST ключи**, вынести в `backend/.env`, удалить из `seed.py` (заменить на `os.environ.get`).
2. Прогнать 4 smoke-suites из `PRODUCTION_READINESS.md §8`:
   ```bash
   cd /app/backend && python test_trust_e2e.py && python test_disputes_e2e.py \
     && python test_stripe_connect_e2e.py && python test_sprint8_ops_e2e.py
   ```
3. Собрать admin SPA (`cd /app/admin && yarn install && yarn build`) → проверить `/api/admin-panel/`.
4. Собрать web-app SPA (`cd /app/web-app && yarn install && yarn build`) → проверить `/api/web-app/`.

### Phase B (per PRODUCTION_READINESS §9)
- Найти первых 10 провайдеров в Berlin + 100 customer заявок.
- Не расширять архитектуру — фокус на conversion / response time / liquidity tuning.

### Что **НЕ делать** (per PRODUCTION_READINESS §10)
- ❌ AI dispatch / ML pricing — преждевременно
- ❌ Microservices / Kafka — bottleneck это users, не arch
- ❌ GraphQL / CQRS / blockchain — vanity

---

## 9. Тестовые учётные данные (для последующего ручного / автоматического тестирования)

| Роль | Email | Password |
|---|---|---|
| Admin | `admin@autoservice.com` | `Admin123!` |
| Customer | `customer@test.com` | `Customer123!` |
| Provider (owner) | `provider@test.com` | `Provider123!` |

Все три **проверены логином** через `POST /api/auth/login` — JWT выдан, role распознан корректно.

---

## 10. Финальный статус развёртывания

| Проверка | Результат |
|---|:---:|
| Backend стартует без ошибок | ✅ |
| MongoDB подключён, индексы созданы | ✅ |
| Все workers зарегистрированы и крутятся | ✅ |
| Seed (admin user + categories + services + organizations) | ✅ |
| Auth login (3 роли) | ✅ |
| Frontend Expo web bundle отдаётся | ✅ |
| Preview URL отвечает HTTP 200, UI отрисован | ✅ |
| 650 endpoints зарегистрированы в OpenAPI | ✅ |
| Memory/closure docs восстановлены | ✅ |

**Готово к продолжению разработки.** Жду вашего следующего фокуса: smoke-suites? security fixes (H1 Stripe keys)? admin/web-app build? Sprint 10 (Phase B pilot users)? Конкретные фичи?
