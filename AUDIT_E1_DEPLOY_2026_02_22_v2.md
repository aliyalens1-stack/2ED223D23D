# 🔍 AUDIT — A | Search Experts (Auto-Service / Pre-Purchase Car Inspection Marketplace)

**Дата:** 2026-02-22 (текущий pod), репозиторий обновлён 2026-05-22
**Среда:** Emergent preview pod `a990a250-1053-4aee-9251-406c4946b88b`
**Аудитор:** E1 (Emergent)
**Источник:** https://github.com/aliyalens1-stack/238eyye8232 (`main`, последний коммит — `Auto-generated changes`)
**Предыдущие аудиты:** `AUDIT_E1_DEPLOY_2026_02_22.md`, `AUDIT_E2_DEPLOY_2026_05_22.md`, `AUDIT_WEB_2026_05_22.md`

---

## 1. TL;DR — Развёртывание выполнено ✅

| Компонент | Статус | Детали |
|---|---|---|
| **FastAPI Backend** | ✅ RUNNING | `:8001` — **700 endpoints / 641 paths** |
| **MongoDB** | ✅ RUNNING | `mongodb://localhost:27017`, db `test_database` |
| **Expo Frontend (web)** | ✅ RUNNING | `:3000` — Metro Bundler, UI рендерится, темная палитра + жёлтый акцент |
| **Auth seed (admin)** | ✅ Работает | `admin@autoservice.com / Admin123!` → JWT, role=`admin` |
| **Health endpoint** | ✅ OK | `{"status":"ok","db":"connected","nestjs":"disabled"}` |
| **Preview URL** | ✅ Live | https://a990a250-1053-4aee-9251-406c4946b88b.preview.emergentagent.com |
| **Ingress `/api/*`** | ✅ OK | `/api/health` через ingress отвечает |
| **Background loops** | ✅ Активны | Orchestrator: ~14 actions / 15 zones каждые 10s |
| **Redis** | ⚠️ NO-OP fallback | Не запущен — orchestrator/rate-limit/idempotency деградированы (не блокер для FastAPI) |
| **NestJS backend** | ⏸ disabled | `NESTJS_ENABLED=False` |
| **Admin SPA (`/app/admin`)** | ⏸ не собран | `dist/` отсутствует |
| **Web-app SPA (`/app/web-app`)** | ⏸ не собран | `dist/` отсутствует |

**Стартовый экран preview:** «A | Search Experts — PRE-PURCHASE CAR INSPECTION — Don't buy a car blind». CTA: `Find & inspect a car` / `Become an inspector`. Локализация EN (есть переключатель). Sign-in / Continue as guest работают.

---

## 2. Что было сделано в этом раунде

1. ✅ `git clone https://github.com/aliyalens1-stack/238eyye8232 → /tmp/repo`
2. ✅ Сохранил защищённые `/app/backend/.env` и `/app/frontend/.env` в `/tmp/env_backup`
3. ✅ Скопировал из репо в `/app`: `backend/`, `frontend/`, `admin/`, `web-app/`, `shared/`, `docs/`, `memory/`, `audit/`, `tests/`, `test_reports/`, плюс верхнеуровневые `*.md`, `.gitignore`, `.gitconfig`
4. ✅ Восстановил защищённые `.env` поверх скопированных
5. ✅ `pip install -r backend/requirements.txt` — 137 пакетов, ~55 переустановок (apply pinned versions), без ошибок
6. ✅ `yarn install` в `/app/frontend` — успешно (только устаревшие peer-deps: uuid<11, rimraf<4, glob<8)
7. ✅ `supervisorctl restart backend && restart expo` — оба RUNNING
8. ✅ Smoke-проверки:
   - `GET /api/health` → `{db:"connected"}`
   - `POST /api/auth/login` admin → 200 + JWT, role=admin
   - Внешний ingress `/api/health` через preview URL → OK
9. ✅ Скриншот UI снят (тёмная тема рендерится, FAB кнопки на месте)
10. ✅ Создан этот audit-документ

---

## 3. Архитектура и стек

### 3.1 Структура `/app`
```
/app/
├── backend/                # FastAPI · 347 .py файлов · 53 доменных модуля
│   ├── server.py           # bootstrap, lifespan, workers, ingress proxy
│   ├── app/                # 53 домена (см. §4)
│   │   ├── core/           # config, db, security, lifespan, hot_indexes, structured_log
│   │   ├── admin/          # 196 endpoints (governance, ops, integrations)
│   │   ├── provider/       # 98 endpoints
│   │   ├── inspector/      # 53 endpoints
│   │   ├── customer/       # 42 endpoints
│   │   ├── marketplace/    # 30 endpoints
│   │   ├── payments/       # 22 endpoints (Stripe Connect Express + escrow)
│   │   ├── escrow/ disputes/ chat/ orchestrator/ ml/ intelligence/ …
│   ├── requirements.txt    # 137 пакетов
│   ├── seed_*.py           # 9 сидеров
│   └── test_*.py           # 14 e2e/smoke-сьютов
├── frontend/               # Expo SDK 54 (RN 0.81.5 / React 19) · 164 ts(x) в app/ + 120 в src/
│   ├── app/                # expo-router, ~70+ файлов-маршрутов (tabs, admin, provider, inspector, customer, chat, payments, disputes, …)
│   ├── src/                # components, zustand, i18n (EN/RU/DE), theme
│   ├── assets/             # иконки/сплеши
│   └── package.json        # Expo 54.0.34, zustand 5, i18next 26, reanimated 4, expo-camera, …
├── admin/                  # Vite + React + shadcn/radix-ui SPA (отдельный)
├── web-app/                # Vite + React + Leaflet (публичный сайт)
├── shared/                 # @platform/* алиасы (типы, cognition_guardrails)
├── docs/q1/                # архитектурные доки
├── memory/                 # 131 sprint-постмортем (источник истины!)
├── audit/                  # JSON-инвентаризации и reconciliation-отчёты
├── tests/ test_reports/    # глобальные тесты
└── *.md                    # PRODUCTION_READINESS, AUDIT_*, test_result, README
```

### 3.2 Stack
| Слой | Технология | Версия |
|---|---|---|
| Mobile/Web | Expo SDK | **54.0.34** |
| | React Native | 0.81.5 / React 19.1.0 |
| | expo-router | 6.0.22 (typed routes) |
| | State / i18n | Zustand 5 · i18next 26 (EN/RU/DE) |
| | Animations | reanimated 4 · worklets 0.5 |
| Backend | FastAPI | 0.110.1 / Python 3.11 |
| | Motor (Mongo async) | 3.3.1 |
| | Pydantic | 2.12.5 |
| | uvicorn | 0.25.0 |
| | bcrypt 4.1.3 · PyJWT 2.12.1 · pyotp 2.9.0 · stripe 15.0.1 | |
| | emergentintegrations | 0.1.0 |
| DB | MongoDB (local) | — |
| Cache | Redis | ❌ не запущен → NO-OP fallback |
| LLM/ML | scikit-learn 1.8 · litellm · google-genai 1.71 · openai 1.99 · pandas/numpy/scipy | — |

### 3.3 Ingress
- `/` → port 3000 (Expo web / Metro)
- `/api/*` → port 8001 (FastAPI)
- Preview URL: `https://a990a250-1053-4aee-9251-406c4946b88b.preview.emergentagent.com`

---

## 4. Endpoint-инвентаризация (топ-15 групп)

| Префикс | Endpoints |
|---|---:|
| `/api/admin` | **196** |
| `/api/provider` | 98 |
| `/api/inspector` | 53 |
| `/api/customer` | 42 |
| `/api/marketplace` | 30 |
| `/api/payments` | 22 |
| `/api/chat` | 18 |
| `/api/inspections` | 14 |
| `/api/car-selection` | 14 |
| `/api/auth` | 13 |
| `/api/orchestrator` | 12 |
| `/api/system` | 10 |
| `/api/pricing` | 10 |
| `/api/vehicles` | 9 |
| `/api/zones` | 9 |

**Итого: 700 operations / 641 уникальных пути.**

---

## 5. Health-checks (выполнены вживую)

```bash
GET http://localhost:8001/api/health
→ 200 {"status":"ok","db":"connected","nestjs":"disabled","timestamp":"2026-05-22T18:52:40Z"}

POST /api/auth/login {email:"admin@autoservice.com", password:"Admin123!"}
→ 200 { accessToken: "eyJ...", user:{id, email, role:"admin"}, accounts:[…] }

GET https://a990a250-1053-4aee-9251-406c4946b88b.preview.emergentagent.com/api/health
→ 200 {"status":"ok","db":"connected"}   ✅ ingress OK
```

В логах backend стабильно крутятся фоновые циклы:
- `Orchestrator cycle: 14 actions across 15 zones` каждые 10s
- `Feedback processor` каждые 15s
- `exposures expire/batching/stats_recompute` каждые 60/60/300s
- `Strategy optimizer` и `DemandPredictor` каждые 60s
- `push receipts_poll` каждые 180s

**Все workers зарегистрированы через `worker_supervisor` с `policy=on_failure, max_restarts=5`.**

---

## 6. Состояние модулей (по `memory/` + код)

| Модуль | Sprint | Состояние |
|---|---|---|
| Auth (JWT, bcrypt, account-switcher, admin auto-seed) | ✅ | 13 endpoints |
| 2FA (TOTP + recovery codes) | ✅ | `pyotp` + `qrcode` |
| Marketplace + bids | ✅ | 30 endpoints |
| Service requests + quotes | ✅ | 8 + 14 endpoints |
| Escrow + Stripe Connect Express | Sprint 7 ✅ | Sandbox-ready, `STRIPE_CONNECT_ENABLED=0` |
| Disputes / arbitration / freeze API | Sprint 6 ✅ | Resolution + freeze global/provider |
| Trust / Reputation / Reviews | Sprint 5 ✅ | Compound indexes ensured |
| Service Chat (WS + REST) | Sprint 4 ✅ | 18 endpoints |
| Notifications (Expo push + Firebase RTDB) | Sprint 8 ✅ | 7 endpoints, receipts poll |
| Pricing v2b frozen | ✅ | offer-packages versioning |
| Inspector workflow | ✅ | jobs, capture, timeline, VIN/odometer OCR |
| Provider workflow | ✅ | dispatch, topology, intelligence |
| Customer cognition / continuity | ✅ | timeline, retention |
| Admin observatory / ops alerts | ✅ | 196 endpoints |
| Orchestrator (demand/supply, ML strategy optimizer) | ✅ | Sprint 20 DemandPredictor |
| i18n EN/RU/DE | Phase 5 frozen | `scripts/i18n-audit.mjs` |
| Reconciliation audit + supervisor | Sprint B4.3 (May 2026) ✅ | new closure docs в memory |
| Payment chronology realtime | Sprint P0bCh/P0bCi ✅ | WS smoke pass |
| Production runbook | Sprint 9 ✅ | `PRODUCTION_READINESS.md` |

---

## 7. Заморозки (не трогать без явной нужды)

Из `memory/`:
- **`pricing_v2b`** (frozen 2026-05-17)
- **`notify_pref_1`** (frozen 2026-05-15)
- **`Phase 5 i18n` EN/RU/DE** (frozen)
- **`revenue_semantics_layer`** (frozen 2026-05-13)
- **`payments_2a_pay_button`** (frozen 2026-05-16)
- **`stripe_1_wired`** (frozen 2026-05-15)
- **`reconciliation_audit_supervisor`** (closure 2026-05-22)

Перед любым изменением — читать соответствующий sprint-документ в `/app/memory/`.

---

## 8. Риски / Что НЕ готово к prod

### 🔴 Критично перед live
1. **Redis отсутствует.** Orchestrator state ops, rate-limit, idempotency-кэш, circuit-breakers → NO-OP fallback. Денежные потоки безопасны (по runbook), но **деградированы**. Перед live: поднять `redis://127.0.0.1:6379/0`.
2. **`ADMIN_PASSWORD` = `Admin123!`** (default в `app/core/config.py`). **MUST** переопределить.
3. **`JWT_SECRET` = `auto_service_jwt_secret_key_2025_very_secure`** (default). **MUST** заменить на ≥32 случайных символов.
4. **Stripe ключи** = sentinel `sk_test_emergent`. Загрузить реальные через `/api/admin/integrations` UI (encrypted в `integration_credentials`).
5. **Stripe webhook** `POST /api/billing/webhook/connect` **не зарегистрирован** в Stripe Dashboard — без подписки на `account.updated`, `payment_intent.*`, `transfer.*`, `refund.*`, `charge.refunded` escrow flow в live развалится.
6. **MongoDB backup не настроен.** Критичные коллекции: `service_payments`, `disputes`, `provider_reviews`, `integration_credentials`, `stripe_webhook_events`.

### 🟡 Средний приоритет
7. **Admin SPA** (`/app/admin/dist`) не собран → `cd /app/admin && yarn && yarn build`
8. **Web-app SPA** (`/app/web-app/dist`) не собран → `cd /app/web-app && yarn && yarn build`
9. **`STRIPE_CONNECT_ENABLED=0`** (sandbox). Перед live: `1` → restart backend.
10. **Firebase admin SDK** — заглушка. Для FCM push нужен service-account JSON + `GOOGLE_APPLICATION_CREDENTIALS`.
11. **NestJS backend** (`backend/src` + `nest-cli.json` + `backend/package.json`) — dead code (`NESTJS_ENABLED=False`). Решить: удалить или поднять.
12. **Supervisor** управляет только `backend + expo + mongodb`. Admin SPA / web-app / redis отдельно не разворачиваются.
13. **Дублирующиеся Operation ID** в OpenAPI:
    - `stripe_webhook_api_webhook_stripe_post` в `app/payments/checkout_simple.py`
    - `proxy_to_nestjs_api__path__options` в `server.py`

### 🟢 Низкий приоритет
14. Устаревшие npm peer-deps: `uuid<11`, `rimraf<4`, `glob<8`, `inflight`. Не блокеры.
15. **Sentry/observability external sink** — структурированные JSON-логи есть (`app/core/structured_log.py`), но внешний приёмник не подключен.
16. README репозитория содержит только `# Here are your Instructions` — нет онбординг-документа верхнего уровня для нового разработчика (хотя `PRODUCTION_READINESS.md` и `memory/` это компенсируют).

---

## 9. Что я НЕ трогал

- ❌ Ни одного `.py` / `.tsx` файла не редактировал
- ❌ Не менял `package.json`, `requirements.txt`
- ❌ Не трогал `MONGO_URL`, `EXPO_PACKAGER_*`, `EXPO_PUBLIC_BACKEND_URL`
- ❌ Не запускал миграции / сидеры (`seed_bonn_providers.py` и т.п.)
- ❌ Не собирал `admin/` и `web-app/` SPA
- ❌ Не менял `JWT_SECRET` / `ADMIN_PASSWORD` — остались дефолты (для dev OK)

---

## 10. Что готово прямо сейчас

- **Логин админа:** `admin@autoservice.com / Admin123!` → JWT 7d
- **Preview URL:** https://a990a250-1053-4aee-9251-406c4946b88b.preview.emergentagent.com (мобильный UI Expo)
- **API base:** `https://a990a250-1053-4aee-9251-406c4946b88b.preview.emergentagent.com/api/*`
- **Swagger:** доступен через `/openapi.json` (700 ops)
- **131 sprint-постмортем** в `/app/memory/` — основной источник истины при доработках

---

## 11. Готов к следующему шагу

Бэкенд (700 endpoints) и Expo web подняты, отвечают, UI рендерится. Auth admin работает.

Скажите, **что делаем дальше**:

- **A)** Засеять данные (Bonn, regional, stage2 providers) и пройти customer-флоу: request → bid → escrow → release
- **B)** Собрать admin SPA и web-app SPA (полный stack: mobile + admin + landing)
- **C)** Добавить новую фичу / поправить багу (укажите какую)
- **D)** Подключить реальные Stripe-ключи / Redis / webhook → довести до live-readiness
- **E)** Прогнать prod-readiness smoke (`test_trust_e2e.py`, `test_disputes_e2e.py`, `test_stripe_connect_e2e.py`, `test_sprint8_ops_e2e.py`)
- **F)** Что-то другое — опишите задачу

---

**Артефакты:**
- Этот аудит: `/app/AUDIT_E1_DEPLOY_2026_02_22_v2.md`
- Предыдущий E2 (расширенный): `/app/AUDIT_E2_DEPLOY_2026_05_22.md`
- Production runbook: `/app/PRODUCTION_READINESS.md`
- Sprint-постмортемы: `/app/memory/` (131 шт.)
- Reconciliation snapshots: `/app/audit/`
