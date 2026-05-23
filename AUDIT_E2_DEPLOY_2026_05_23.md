# 🔍 AUDIT E2 — A|Search Experts (Pre-Purchase Car Inspection Marketplace)

**Дата:** 2026-05-23
**Среда:** Emergent preview pod `mobile-app-preview-175`
**Аудитор:** E2 (Emergent, текущая сессия)
**Источник:** https://github.com/aliyalens1-stack/ayyyyyy
**Preview URL:** https://mobile-app-preview-175.preview.emergentagent.com
**Предыдущие аудиты:**
- `AUDIT_E1_DEPLOY_2026_02_22.md` / `_v2.md` (E1, февраль 2026)
- `AUDIT_E2_DEPLOY_2026_05_22.md` / `_v2.md` (E2, вчера, pod `mobile-app-expo-13`)
- `AUDIT_REPORT_2026_05_22.md`, `AUDIT_WEB_2026_05_22.md`
- `PRODUCTION_READINESS.md` (Sprint 9 closure)

---

## 1. TL;DR — Деплой выполнен ✅

| Компонент | Статус | Деталь |
|---|---|---|
| **FastAPI backend** | ✅ RUNNING | `:8001` — **710 endpoints** (+60 vs. предыдущий E2 раунд, было 650) |
| **MongoDB** | ✅ RUNNING | `mongodb://localhost:27017`, db `test_database`, индексы и seed созданы |
| **Expo frontend (web)** | ✅ RUNNING | `:3000` — Metro Bundler, web bundle отдаётся |
| **Preview URL ingress** | ✅ HTTP 200 | UI отрисован, лендинг «Don't buy a car blind» |
| **Auth (3 роли)** | ✅ OK | admin / customer / provider_owner — JWT выдан всем |
| **`/api/health`** | ✅ OK | `{"status":"ok","db":"connected","nestjs":"disabled"}` |
| **Background workers** | ✅ RUNNING | Orchestrator cycle #5: 45 actions across 15 zones (в логах) |
| **Seed data** | ✅ OK | admin user + categories + services + organizations |
| **Memory closure-docs** | ✅ OK | 140 файлов в `/app/memory/` восстановлены |
| **Redis** | ⚠️ NO-OP fallback | Не блокер (PRODUCTION_READINESS §1, помечено `⭕`) |
| **NestJS subprocess** | ⏸️ disabled | `NESTJS_ENABLED=0` — весь API через FastAPI |
| **Admin SPA `/admin`** | ⏸️ не собран | `/app/admin/dist/` отсутствует |
| **Web-app SPA `/web-app`** | ⏸️ не собран | `/app/web-app/dist/` отсутствует |
| **Smoke / e2e tests (16 шт.)** | ⏸️ не запущены | По запросу пользователя — следующим шагом |

**Стартовый экран в preview:** «A | Search Experts — PRE-PURCHASE CAR INSPECTION — Don't buy a car blind», два CTA («Find & inspect a car» / «Become an inspector»), список преимуществ (TÜV-style inspection, Local inspectors in Germany, Reports within 24h, Photo & video proof), три локали (EN/RU/DE), Sign-in / Continue as guest. Тёмная палитра + жёлтый акцент. UI рендерится без ошибок.

---

## 2. Что сделано в этом раунде

| # | Шаг | Результат |
|--:|---|---|
| 1 | `git clone aliyalens1-stack/ayyyyyy` → `/tmp/repo` (1 582 файла) | ✅ |
| 2 | Сохранил protected `.env` (backend + frontend) в `/tmp/env_backup/` | ✅ |
| 3 | `mv /app/backend /app/backend.template_bak`, `mv /app/frontend /app/frontend.template_bak` | ✅ (template сохранён для отката) |
| 4 | Скопировал в `/app/` директории: `backend/`, `frontend/`, `admin/`, `web-app/`, `shared/`, `memory/`, `docs/`, `ops/`, `audit/`, плюс `tests/` | ✅ |
| 5 | Восстановил protected `.env` | ✅ |
| 6 | Добавил `EXPO_PUBLIC_BACKEND_URL` в `/app/frontend/.env` (Expo читает именно его, см. `src/services/api.ts`) | ✅ |
| 7 | `pip install -r requirements.txt` — установлено/обновлено ~30 пакетов (boto3, google-genai, stripe, scikit-learn, pandas и т.д.) | ✅ без ошибок |
| 8 | `yarn install` в `/app/frontend` — lockfile сгенерирован, ~1 700 пакетов, только deprecation warnings (uuid, rimraf, glob — не блокеры) | ✅ |
| 9 | `supervisorctl restart backend frontend` | ✅ оба `RUNNING` |
| 10 | Smoke: `GET /api/health` → 200, `db: connected` | ✅ |
| 11 | Smoke: `POST /api/auth/login` для всех 3 ролей | ✅ JWT выдан |
| 12 | Smoke: `GET /api/services?locale=en` → каталог кластеров (`repair`, `inspection`, ...) | ✅ |
| 13 | Smoke: `GET /openapi.json` → **710 endpoints** | ✅ |
| 14 | Скриншот preview URL — лендинг A\|SEARCH EXPERTS | ✅ |
| 15 | 140 closure-docs из `memory/` восстановлены | ✅ |

---

## 3. Метрики кодовой базы (актуально на 2026-05-23)

### Backend (FastAPI / Python)
- **127 720 LOC** в `*.py` (рост с 126 872 в прошлом аудите → +848 строк)
- **49 bounded contexts** в `/app/backend/app/`:
  ```
  admin · assignments · auto_requests · billing · booking ·
  car_selection · car_selection_thread · chat · core · customer ·
  customer_cognition · customer_continuity · disputes · escrow · geo ·
  governance · growth · inspection · inspections · inspector ·
  integrations · intelligence · marketplace · matching_v2 · media ·
  ml · notifications · observatory · offer_packages · ops_map ·
  orchestrator · packages · parsers · payments · performance ·
  pricing · provider · provider_trust · reports · reputation ·
  revenue · runtime_ledger · service_chat · service_marketplace ·
  static · system · two_factor · vehicles · workers
  ```
- **710 OpenAPI endpoints** (+60 vs. 650 вчера). Топ-10 неймспейсов:

  | endpoints | namespace |
  |---:|---|
  | 206 | `/api/admin/*` |
  |  98 | `/api/provider/*` |
  |  53 | `/api/inspector/*` |
  |  42 | `/api/customer/*` |
  |  30 | `/api/marketplace/*` |
  |  22 | `/api/payments/*` |
  |  18 | `/api/chat/*` |
  |  14 | `/api/inspections/*` |
  |  14 | `/api/car-selection/*` |
  |  13 | `/api/auth/*` |

### Frontend (Expo + expo-router, мобильное приложение / web)
- **78 285 LOC** в `*.ts(x)`
- **165 файлов маршрутов** в `/app/frontend/app/` (file-based expo-router)
- Топ-уровень `/app/frontend/app/`:
  - **Tabs**: `(tabs)/` (index · create · garage · profile · quotes · reports · requests · services)
  - **Customer flows**: `auto-request/`, `booking/`, `quote/`, `request/`, `selection/`, `disputes/`, `chat/`, `delivery/`, `payment/`, `payments/`, `vehicles/`, `review/`, `customer/`, `dashboard/`
  - **Provider flows**: `provider/`, `provider-boost*`, `provider-intelligence`, `subscription/`, `pricing-preview`, `service-marketplace/`, `organization/`, `packages/`
  - **Inspector flows**: `inspector/`, `inspection-preview`, `inspection-report/`
  - **Admin / Ops**: `admin/`, `operator/`, `zones/`
  - **Trust / Review**: `trust/`, `review/`, `disputes/`
  - **Auth**: `login.tsx`, `register.tsx`, `partner-register.tsx`, `forgot-password.tsx`, `2fa-verify.tsx`, `security-2fa.tsx`
  - **Misc**: `referral.tsx`, `notifications.tsx`, `messages.tsx`, `favorites.tsx`, `city-select.tsx`, `support.tsx`, `terms.tsx`, `privacy.tsx`, `help.tsx`, `about.tsx`, `map.tsx`, `additional.tsx`

### Web-app (отдельный Vite + React проект)
- **24 211 LOC** в `*.ts(x)` в `/app/web-app/src/`
- Pages: `auth/`, `chat/`, `customer/`, `inspector/`, `notifications/`, `provider/`, `public/`
- `dist/` ⏸️ **не собран** — backend может сервить под `/api/web-app/` после `yarn build`

### Admin (отдельный Vite + Radix UI + shadcn проект)
- **25 212 LOC** в `*.ts(x)` в `/app/admin/src/`
- Pages: `AdminAssignmentsPage`, `AdminInboxPage`, `AdminOpsMapPage`, `AdminReputationPage`, `AuditLogPage`, `AutoRequestsPage`, `BookingsPage`, `CarSelectionPage`, `CustomerNotify*` и др.
- `dist/` ⏸️ **не собран**

### Shared (типизированные контракты, домен-модели)
- **6 679 LOC** в `*.ts`
- Папки: `contracts/`, `formatters/`, `identity/`, `parsers/`, `state-machines/`, `validators/`, `cognition_guardrails/`

### Memory (audit trail закрытых sprint'ов)
- **140 closure-docs** в `/app/memory/` — sprint1d2..1e, sprint2..sprint21, phase B4_3_A, и т.д.
- Использовать как контекст для будущих изменений (что уже закрыто, что мокировано, что ожидает Phase B).

**Суммарно:** ~262 K LOC по 4 приложениям + shared.

---

## 4. Архитектура — замкнутый transactional loop

```
┌──────────────────────────────────────────────────────────────┐
│  customer ─auto-request→ marketplace ─bid→ provider          │
│     │                                              │          │
│     ▼                                              ▼          │
│   booking ─escrow.intent→ Stripe PaymentIntent (held)         │
│     │                                                         │
│     ▼ work-in-progress                                        │
│  chat (service_chat) + inspection (60-point) + media (S3/local)│
│     │                                                         │
│     ▼                                                         │
│  trust (review) ─revealed→ reputation ←── arbitration         │
│     │                                                         │
│     ▼                                                         │
│  escrow.release ─Transfer→ provider's Stripe Connect          │
│       (12h gate + freeze guards + dispute hold)               │
│     │                                                         │
│     └→ notifications (push + in-app) + ops alerts            │
└──────────────────────────────────────────────────────────────┘
                              ▲
                              │ admin/ops control plane
                  (206 /api/admin/* endpoints — disputes,
                   payments freeze, reconciliation,
                   forensic WS, integrations rotate)
```

### Background workers (supervised, `policy=on_failure max_restarts=5`)

| Worker | Interval | Purpose |
|---|--:|---|
| Orchestrator cycle | 10s | Phase E+G demand prediction (в логах: «Orchestrator cycle #5: 45 actions across 15 zones») |
| Feedback processor | 15s | Phase G action feedback |
| Exposures expire loop | 60s | Mark expired exposures |
| Exposures batching loop | 60s | Batch send push notifications |
| Exposures stats recompute | 300s | Inspector stats refresh |
| Strategy optimizer | 60s | Recalculate orchestrator weights |
| Sprint 20 DemandPredictor | 60s | Train per-zone demand model |
| Push receipts poll | 180s | Poll Expo push receipts |
| Vehicles refresh | 60s | Temporal evolution of demo vehicles |

### Sprint history (closure docs в `memory/`)

| Sprint | Focus | Status |
|--:|---|:---:|
| 1d2–1e | Customer / Admin domain + account switcher | ✅ |
| 2 | Step 5: offline queue | ✅ |
| 3 | Verification admin | ✅ |
| 5 | Trust & Retention (reviews + reputation + trust cards) | ✅ |
| 6 | Disputes & Resolution Layer | ✅ |
| 7 | Stripe Connect Express (sandbox-ready) | ✅ |
| 8 | Firebase Realtime + Operational UX | ✅ |
| 9 | Stabilization & Hardening | ✅ |
| 20–21 | DemandPredictor + auth refactor | ✅ |
| Phase B4_3_A | Reconciliation audit closure, TOCTOU status hardening, supervisor closure | ✅ |
| A1 | Notification canonicalization | ✅ |

---

## 5. Готовые smoke / e2e скрипты (16 шт., запускаются `python test_*.py`)

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
+ `prod_readiness.py` — pre-launch check.

> Per `PRODUCTION_READINESS.md §8`, 4 ключевых suites (`test_trust_e2e`, `test_disputes_e2e`, `test_stripe_connect_e2e`, `test_sprint8_ops_e2e`) ДОЛЖНЫ пройти ДО `STRIPE_CONNECT_ENABLED=1`. В этом раунде я их **ещё не гонял** — это следующим шагом по вашему запросу.

---

## 6. Внешние интеграции

| Интеграция | Где | Статус |
|---|---|---|
| **Stripe** (sandbox keys) | `app/integrations/stripe_service.py`, `router_stripe.py`, `billing/stripe_payments.py` | ✅ тестовые ключи seedятся idempotent через `integrations/seed.py` |
| **Stripe Connect Express** | `app/integrations/stripe_connect_service.py`, `router_connect.py` | ✅ sandbox-ready, требует `STRIPE_CONNECT_ENABLED=1` для live |
| **Firebase Push (Expo)** | `app/push.py`, `app/notifications/`, `services/pushRegistration.ts` | ✅ Expo push receipts polling worker запущен |
| **MongoDB Motor** | глобально через `app.core.db` | ✅ connected |
| **Redis** (orchestrator state) | `app.core.redis_client` | ⚠️ нет инстанса, NO-OP fallback (не блокер для money-flows) |
| **emergentintegrations** (LLM lib) | в `requirements.txt` (v0.1.0) | ⚪ установлен, использование не аудировано |
| **openai / litellm / google-genai** | в `requirements.txt` | ⚪ установлены (intelligence module) |
| **boto3 / s3transfer** | в `requirements.txt` | ⚪ S3 для media опционально |
| **SendGrid / Twilio** | объявлены как providers в `router_admin_integrations.py` | 🚫 credentials НЕ заданы — ждут admin UI |
| **NestJS subprocess** | `NESTJS_ENABLED=0` (default) | ⏸️ выключен, не блокер |

---

## 7. Безопасность — что нашёл

### 🔴 HIGH

| # | Issue | Файл | Действие |
|--:|---|---|---|
| **H1** | **Хардкод Stripe TEST ключей в публичном GitHub репо.** `app/integrations/seed.py:18-20` содержит реальные `pk_test_51TP0RO…`, `sk_test_51TP0RO…`, `rk_test_51TP0RO…`. Помечены TEST mode, но это ваш Stripe Sandbox account — любой клонировавший репо может вызывать Stripe API от вашего имени (rate-limit hijack, sandbox event flood, провокация webhook'ов). | `/app/backend/app/integrations/seed.py` | Переместить в `backend/.env`, читать через `os.environ.get('STRIPE_…')`, в репо — placeholder. **Rotate** ключи в Stripe Dashboard. |

### 🟡 MEDIUM

| # | Issue | Файл | Действие |
|--:|---|---|---|
| **M1** | `JWT_SECRET` default `'auto_service_jwt_secret_key_2025_very_secure'` — публично известен, в prod нужно obязательно override через env. | `app/core/config.py:40` | В prod env задать ≥32-char random secret. |
| **M2** | `ADMIN_PASSWORD` default `'Admin123!'` — задокументирован в PRODUCTION_READINESS, но на момент аудита админ всё ещё логинится этим паролем (я только что проверил). | `app/core/config.py:45`, seed | В prod override через env + сменить после первого login. |
| **M3** | `CORS_ORIGINS="*"` в `backend/.env` | `backend/.env` | Для live: ограничить до preview/prod domain. Для preview/dev — оставить как есть. |
| **M4** | `TEST_BYPASS_TOKEN` infrastructure (config.py:57). Если случайно установить в prod env — auth rate-limit отключается через header `X-Test-Bypass`. | `app/core/config.py:51-57` | Перед prod deploy проверить, что `TESTING=0` и `TEST_BYPASS_TOKEN` пуст. |

### 🟢 LOW / Info

- **Redis отсутствует** — orchestrator/exposures fallback в NO-OP. Не блокер для money-flows (PRODUCTION_READINESS §1, помечено `⭕`). Для нагрузочных тестов / live — поднять Redis инстанс.
- **NestJS subprocess отключён** — все API через FastAPI. Сознательный архитектурный выбор по `config.py:24-32`.
- **`admin/dist/`** и **`web-app/dist/`** не собраны — backend готов сервить их под `/api/admin-panel/` и `/api/web-app/` если выполнить `yarn build`.
- **140 closure-docs в `memory/`** — отличный аудит-след всех закрытых sprint'ов, использовать как контекст для будущих изменений.
- **+60 новых endpoints за 1 сутки** (650 → 710) — указывает на активную разработку в репо между двумя E2 раундами. Стоит просмотреть `git log` для понимания, что именно добавилось.

---

## 8. Тестовые учётные данные (для последующего ручного / автоматического тестирования)

| Роль | Email | Password |
|---|---|---|
| Admin | `admin@autoservice.com` | `Admin123!` |
| Customer | `customer@test.com` | `Customer123!` |
| Provider (owner) | `provider@test.com` | `Provider123!` |

Все три **проверены логином** через `POST /api/auth/login` — JWT выдан, role распознан корректно.

Подробнее в `/app/memory/test_credentials.md`.

---

## 9. Что делать дальше — рекомендации

### A. Сразу (до первого live customer)
1. **Ротировать Stripe TEST ключи** (H1), вынести в `backend/.env`, удалить из `seed.py` (заменить на `os.environ.get`).
2. Прогнать 4 smoke-suites из `PRODUCTION_READINESS.md §8`:
   ```bash
   cd /app/backend && python test_trust_e2e.py && python test_disputes_e2e.py \
     && python test_stripe_connect_e2e.py && python test_sprint8_ops_e2e.py
   ```
3. Собрать admin SPA: `cd /app/admin && yarn install && yarn build` → проверить `/api/admin-panel/`.
4. Собрать web-app SPA: `cd /app/web-app && yarn install && yarn build` → проверить `/api/web-app/`.
5. Просмотреть git log за последние сутки (что добавили в +60 endpoints) и убедиться, что новые ручки покрыты тестами.

### B. Phase B (per PRODUCTION_READINESS §9)
- Найти первых 10 провайдеров в Berlin + 100 customer заявок.
- НЕ расширять архитектуру — фокус на conversion / response time / liquidity tuning.

### C. Что **НЕ делать** (per PRODUCTION_READINESS §10)
- ❌ AI dispatch / ML pricing — преждевременно
- ❌ Microservices / Kafka — bottleneck это users, не arch
- ❌ GraphQL / CQRS / blockchain — vanity tech

---

## 10. Финальный чек-лист развёртывания

| Проверка | Результат |
|---|:---:|
| Backend стартует без ошибок | ✅ |
| MongoDB подключён, индексы созданы, seed применён | ✅ |
| Все workers зарегистрированы и крутятся (видно в логах) | ✅ |
| Auth login (3 роли) выдаёт JWT | ✅ |
| Frontend Expo web bundle отдаётся (Metro Bundler) | ✅ |
| Preview URL отвечает HTTP 200, UI отрисован (скриншот сделан) | ✅ |
| 710 endpoints зарегистрированы в OpenAPI | ✅ |
| Memory/closure docs (140 файлов) восстановлены | ✅ |
| `/api/health` → `{"status":"ok","db":"connected"}` | ✅ |
| Smoke `/api/services?locale=en` отдаёт каталог в 3 локалях | ✅ |
| 16 готовых test_*.py скриптов лежат в `/app/backend/` (не запущены) | ⏸️ |
| `admin/dist`, `web-app/dist` — не собраны | ⏸️ |

---

## 11. Следующий фокус — выберите

Развёртывание готово. Жду вашего следующего фокуса — варианты:

1. **🔐 Security fix H1** — вынести Stripe TEST keys в `.env`, ротировать в Dashboard. ~15 мин.
2. **🧪 4 smoke-suites** из PRODUCTION_READINESS §8 — `trust`, `disputes`, `stripe_connect`, `sprint8_ops`. ~10 мин.
3. **📦 Собрать admin SPA** (`/app/admin/dist/` → `/api/admin-panel/`) и **web-app SPA** (`/app/web-app/dist/` → `/api/web-app/`). ~10 мин.
4. **🚀 Конкретная фича** — Sprint 22? Phase B pilot? Конкретный bug?
5. **🔄 Git log diff** между предыдущим E2 раундом и сегодняшним — узнать что появилось за +60 endpoints.

> Готово к продолжению разработки. **Что выбираете?**
