# 🔍 AUDIT — A-Search Experts (Auto-Service Marketplace)
**Дата:** 2026-05-22
**Среда:** Emergent preview pod `app-build-preview-6`
**Аудитор:** E2 (Emergent)
**Источник:** https://github.com/aliyalens1-stack/c2ed3232

---

## 1. TL;DR — Развёртывание выполнено ✅

| Компонент | Статус | Порт / URL |
|---|---|---|
| **FastAPI Backend** | ✅ RUNNING | `:8001` — **637 endpoints** зарегистрировано |
| **MongoDB** | ✅ RUNNING | local `mongodb://localhost:27017`, db `test_database` |
| **Expo Frontend (web)** | ✅ RUNNING | `:3000` — Metro Bundler, web build стартовал |
| **Auth seed** | ✅ Готов | `admin@autoservice.com / Admin123!` логинится, role=admin |
| **Health endpoint** | ✅ OK | `{"status":"ok","db":"connected","nestjs":"disabled"}` |
| **Preview URL** | ✅ Live | https://app-build-preview-6.preview.emergentagent.com |
| **Redis** | ⚠️ NO-OP fallback | Не критично, backend живёт |
| **NestJS backend** | ⏸️ disabled | `NESTJS_ENABLED=False` (всё через FastAPI) |
| **Admin SPA `/admin`** | ⏸️ не собран | dist/ отсутствует |
| **Web-app SPA `/web-app`** | ⏸️ не собран | dist/ отсутствует |

Стартовый экран в preview: **«A | Search Experts — Don't buy a car blind»**, CTA «Find & inspect a car» / «Become an inspector», EN-локализация, тёмная палитра + жёлтый акцент. UI рендерится корректно.

---

## 2. Что сделано в этом раунде

1. ✅ Клонировал `aliyalens1-stack/c2ed3232` → `/tmp/repo`
2. ✅ Сохранил защищённые `.env` (`/app/backend/.env`, `/app/frontend/.env`)
3. ✅ Перенёс `backend/`, `frontend/`, `admin/`, `web-app/`, `shared/`, `docs/`, `memory/` → `/app/`
4. ✅ Восстановил `.env` поверх скопированных файлов
5. ✅ `pip install -r requirements.txt` — 137 пакетов установлено без ошибок
6. ✅ `yarn install` в `/app/frontend` — без блокирующих варнингов, только устаревшие peer-deps
7. ✅ `supervisorctl restart backend frontend` — оба сервиса RUNNING
8. ✅ Smoke-проверка: `GET /api/health` → `{db:"connected"}`
9. ✅ Auth smoke: `POST /api/auth/login` admin → 200 OK с JWT
10. ✅ Preview URL отвечает HTTP 200, UI отрисован, скриншот снят

---

## 3. Архитектура

### 3.1 Layout
```
/app/
├── backend/              # FastAPI (Python) — 482 .py файлов, ~123K LOC
│   ├── server.py         # bootstrap + orchestrator
│   ├── app/              # 54+ доменных модуля
│   │   ├── core/         # config, db, security, realtime, metrics
│   │   ├── admin/        # 182 endpoints (governance, ops, integrations)
│   │   ├── provider/     # 83 endpoints
│   │   ├── inspector/    # 48 endpoints
│   │   ├── customer/     # 35 endpoints
│   │   ├── marketplace/  # 30 endpoints
│   │   ├── payments/     # 22 endpoints — Stripe Connect Express
│   │   ├── escrow/       # escrow release + dispute hooks
│   │   ├── disputes/     # arbitration (Sprint 6)
│   │   ├── chat/         # 15 endpoints (Sprint 4)
│   │   ├── orchestrator/ # demand/supply orchestrator (10 ep)
│   │   ├── ml/           # demand predictor, strategy optimizer
│   │   ├── intelligence/ # cognition layer
│   │   ├── two_factor/   # TOTP + recovery codes
│   │   ├── notifications/# Expo push + Firebase (7 ep)
│   │   ├── pricing/      # pricing_v2 frozen (9 ep)
│   │   ├── reputation/   # provider reputation (Sprint 5)
│   │   ├── integrations/ # encrypted credentials (Stripe, etc.)
│   │   └── ... остальные домены
│   ├── src/              # NestJS-вариант — disabled, dead code
│   ├── requirements.txt  # 137 пакетов
│   └── seed_*.py         # 9 сидеров (bonn, journey, providers...)
│
├── frontend/             # Expo SDK 54 (RN 0.81.5 / React 19) — 276 .ts(x), 65+ routes
│   ├── app/              # expo-router (tabs, admin, inspector, provider, customer, …)
│   ├── src/              # ~1.8 MB (components, zustand, i18n, theme)
│   ├── assets/           # 5.4 MB иконки/сплеши
│   └── package.json      # Expo 54.0.34, react-i18next, zustand, expo-camera, ...
│
├── admin/                # Vite + React + shadcn/radix-ui (отдельный SPA)
├── web-app/              # Vite + React + Leaflet (публичный сайт)
├── shared/               # @platform/* алиас (domain types, cognition_guardrails)
├── docs/                 # архитектурные доки
└── memory/               # 122 sprint-постмортема, источник истины
```

### 3.2 Stack
| Слой | Технология | Версия |
|---|---|---|
| Mobile | Expo SDK | **54.0.34** |
| | React Native | 0.81.5 |
| | React | 19.1.0 |
| | expo-router | 6.0.22 (typed routes) |
| | State | Zustand 5 |
| | i18n | i18next 26 + react-i18next |
| | Animations | reanimated 4 |
| Backend | FastAPI | 0.110.1 |
| | Python | 3.11.15 |
| | Motor (Mongo async) | 3.3.1 |
| | Pydantic v2 | 2.12.5 |
| | uvicorn | 0.25.0 |
| | bcrypt | 4.1.3 |
| | PyJWT | 2.12.1 |
| | pyotp (2FA) | 2.9.0 |
| | stripe | 15.0.1 |
| | emergentintegrations | 0.1.0 |
| DB | MongoDB (local) | — |
| Cache | Redis | ❌ отсутствует (NO-OP) |

### 3.3 Ingress / маршруты
- `/` → port 3000 (Expo web)
- `/api/*` → port 8001 (FastAPI)
- `REACT_APP_BACKEND_URL = https://app-build-preview-6.preview.emergentagent.com`

---

## 4. Endpoint-инвентаризация (Top-20 групп)

| Префикс | Endpoints |
|---|---|
| `/api/admin` | 182 |
| `/api/provider` | 83 |
| `/api/inspector` | 48 |
| `/api/customer` | 35 |
| `/api/marketplace` | 30 |
| `/api/payments` | 22 |
| `/api/chat` | 15 |
| `/api/inspections` | 14 |
| `/api/car-selection` | 13 |
| `/api/auth` | 12 |
| `/api/system` | 10 |
| `/api/orchestrator` | 10 |
| `/api/zones` | 9 |
| `/api/pricing` | 9 |
| `/api/geo` | 8 |
| `/api/feedback` | 8 |
| `/api/service-requests` | 8 |
| `/api/notifications` | 7 |
| `/api/billing` | 7 |
| `/api/matching` | 6 |

**Итого: 637 endpoints.**

---

## 5. Health-checks (выполнены вживую)

```bash
GET /api/health
→ {"status":"ok","db":"connected","nestjs":"disabled","timestamp":"2026-05-22T11:18:33Z"}

POST /api/auth/login {email:"admin@autoservice.com", password:"Admin123!"}
→ 200 {accessToken: "eyJ...", user:{role:"admin"}, accounts:[1]}

GET https://app-build-preview-6.preview.emergentagent.com/api/health
→ {"status":"ok","db":"connected"}   ✅ ingress работает
```

Backend крутит фоновые циклы (видно в логах):
- Orchestrator cycle: ~25–29 actions across 15 zones / 10s
- Pre-engagement triggers: Tartu, Minsk, Brest, Riga, Skopje…
- Feedback processor: 50 records / 15s

---

## 6. Состояние модулей (из `memory/` + кода)

| Модуль | Sprint | Состояние |
|---|---|---|
| Auth (JWT, bcrypt, account-switcher) | ✅ | Готов, 12 ep, admin авто-сидинг |
| 2FA (TOTP + recovery) | ✅ | pyotp + qrcode |
| Marketplace + bids | ✅ | 30 ep |
| Service requests + quotes | ✅ | 8 + 15 ep |
| Escrow + Stripe Connect Express | Sprint 7 ✅ | Sandbox-ready |
| Disputes / arbitration | Sprint 6 ✅ | Resolution + freeze API |
| Trust / Reputation / Reviews | Sprint 5 ✅ | Compound indexes готовы |
| Service Chat | Sprint 4 ✅ | WS + REST, 15 ep |
| Notifications (Expo push + Firebase) | Sprint 8 ✅ | 7 ep |
| Pricing v2b frozen | ✅ | offer-packages versioning |
| Inspector workflow | ✅ | jobs, capture, timeline, OCR1 (VIN/odometer) |
| Provider workflow | ✅ | dispatch, topology, intelligence |
| Customer cognition | ✅ | timeline, continuity |
| Admin observatory / ops alerts | ✅ | 182 ep |
| Orchestrator (demand/supply) | ✅ | предиктор Sprint 20, optimizer 60s |
| i18n EN/RU/DE | Phase 5 frozen | audit script `i18n:audit` |
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

Перед изменением — читать соответствующий sprint-постмортем в `/app/memory/`.

---

## 8. Риски / Что НЕ готово к prod-релизу

### 🔴 Критично перед live
1. **Redis отсутствует.** Orchestrator, rate-limit, idempotency-кэш, breakers → NO-OP fallback. Денежные потоки безопасны (так заявлено в runbook), но **деградированы**. Перед live поднять `redis://127.0.0.1:6379`.
2. **Дефолтный `ADMIN_PASSWORD`** = `Admin123!`. **MUST** переопределить через env.
3. **Дефолтный `JWT_SECRET`** в `app/core/config.py`. **MUST** заменить на 32+ случайных символов.
4. **Stripe ключи** = sentinel `sk_test_emergent`. Загрузить реальные `sk_live_*` через `/api/admin/integrations` UI (encrypted).
5. **Stripe webhook** (`POST /api/billing/webhook/connect`) **не зарегистрирован** в Stripe Dashboard. Без подписки на `account.updated`, `payment_intent.succeeded`, `transfer.*`, `refund.*` — escrow flow развалится в проде.
6. **MongoDB backup не настроен.** Критичные коллекции: `service_payments`, `disputes`, `provider_reviews`, `integration_credentials`, `stripe_webhook_events`.

### 🟡 Средний приоритет
7. **Admin SPA** (`/app/admin/dist`) не собран. Команда: `cd /app/admin && yarn && yarn build`.
8. **Web-app SPA** (`/app/web-app/dist`) не собран. Команда: `cd /app/web-app && yarn && yarn build`.
9. **`STRIPE_CONNECT_ENABLED=0`** (sandbox). Перед live: 1 → restart backend.
10. **Firebase admin SDK** — заглушка. Для FCM push нужен service-account JSON + `GOOGLE_APPLICATION_CREDENTIALS`.
11. **NestJS backend (`backend/src`)** — dead code. Решить: удалить или включить.
12. **Supervisor не управляет admin/web-app/redis** — текущая Emergent-конфигурация поднимает только `backend + frontend + mongodb`.

### 🟢 Низкий приоритет
13. Старые yarn warning-и (uuid<11, rimraf<4, glob<8).
14. Sentry/observability — структурированные логи есть (`app/core/structured_log.py`), но внешний sink не подключен.
15. **Среда:** текущий pod на образе `fastapi_react_mongo_shadcn_base_image_cloud_arm`, а репо рассчитан на `expo_mongo_base_image_cloud_arm`. Web-build Expo работает, но `expo --tunnel` для нативных сборок может требовать другую конфигурацию.

---

## 9. Что я НЕ трогал

- ❌ Ни одного `.py` / `.tsx` файла не редактировал
- ❌ Не менял `package.json`, `requirements.txt`
- ❌ Не трогал `MONGO_URL`, `REACT_APP_BACKEND_URL`, `EXPO_PACKAGER_*`
- ❌ Не запускал миграции / сидеры (`seed_bonn_providers.py` и т.п.)
- ❌ Не собирал `admin/` и `web-app/` SPA
- ❌ Не менял `JWT_SECRET` / `ADMIN_PASSWORD` — остались дефолты

---

## 10. Рекомендации — что делать дальше

### Готово для разработки (можно тестировать клиентские флоу прямо сейчас):
- Войти как `admin@autoservice.com / Admin123!`
- Открыть https://app-build-preview-6.preview.emergentagent.com
- Тестировать UI customer / inspector / provider экраны

### Если нужен полный prod-стенд внутри Emergent:
1. Засеять данные:
   ```bash
   cd /app/backend
   python seed_bonn_providers.py
   python seed_regional_providers.py
   python seed_stage2_cities.py
   ```
2. Собрать SPA:
   ```bash
   cd /app/admin    && yarn && yarn build
   cd /app/web-app  && yarn && yarn build
   ```
3. Сменить `JWT_SECRET` и `ADMIN_PASSWORD` в `/app/backend/.env`
4. Smoke-suite:
   ```bash
   cd /app/backend
   python test_trust_e2e.py
   python test_disputes_e2e.py
   python test_stripe_connect_e2e.py
   python test_sprint8_ops_e2e.py
   ```

### Если развивать фичи / фиксить баги:
- Перед каждой задачей **читать `/app/memory/`** (122 sprint-докa)
- Соблюдать заморозки из §7
- Использовать существующие домены (`app/admin`, `app/provider`, etc.) вместо параллельных реализаций

---

## 11. Готов к следующему шагу

Бэкенд (637 endpoints) и Expo web-приложение **подняты, отвечают, UI рендерится корректно**. Auth admin работает.

Скажите, **что делаем дальше**:
- **A)** Засеять города/провайдеров (Bonn, regional, stage2) и пройтись по флоу customer → request → bid → escrow → release
- **B)** Собрать admin SPA и web-app SPA (полный stack)
- **C)** Добавить новую фичу / поправить багу (укажите какую)
- **D)** Подключить реальные Stripe-ключи / Redis / webhook
- **E)** Что-то другое — опишите задачу

---

**Артефакты:**
- Аудит (этот документ): `/app/AUDIT_E2_DEPLOY_2026_05_22.md`
- Предыдущий аудит E1: `/app/AUDIT_E1_DEPLOY_2026_02_22.md`
- Production runbook: `/app/PRODUCTION_READINESS.md`
- Sprint-постмортемы: `/app/memory/` (122 шт.)
