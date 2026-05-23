# 🔍 AUDIT — A-Search Experts (Auto-Service Marketplace Platform)
**Дата:** 2026-02-22  
**Источник:** https://github.com/L2PAD/A-Search-EX  
**Среда:** Emergent preview pod (`mobile-app-expo-11`)  
**Аудитор:** E1

---

## 1. Резюме / TL;DR

**Что это:** **A-Search Experts** — мобильное приложение и веб-платформа для **независимой инспекции авто перед покупкой** (B2C marketplace). Доменная модель уже сильно зрелая (Sprint 9, статус **Stabilization & Hardening**, по `PRODUCTION_READINESS.md`).

Закрытый экономический цикл: **marketplace → bids → escrow → work → chat → trust → arbitration → реальные выплаты Stripe Connect**.

**Текущее состояние развертывания (после моего раунда):**

| Компонент | Статус | Примечание |
|---|---|---|
| FastAPI Backend | ✅ **RUNNING** на `:8001` | 632 endpoint-а зарегистрировано; импорт чистый |
| MongoDB | ✅ RUNNING | local `mongodb://localhost:27017`, db `test_database` |
| Expo (mobile) | ✅ RUNNING на `:3000` | через ngrok-туннель, web-bundle собран (1303 модуля) |
| Redis | ⚠️ ОТСУТСТВУЕТ | Backend работает в NO-OP fallback (не блокер) |
| `admin/` SPA | ⏸️ не собран | dist-папка отсутствует, supervisor её не поднимает |
| `web-app/` SPA | ⏸️ не собран | dist-папка отсутствует, supervisor её не поднимает |
| NestJS backend (`backend/src`) | ⏸️ disabled | `NESTJS_ENABLED=False`, всё проксирует FastAPI |
| Auth | ✅ Работает | `admin@autoservice.com / Admin123!` логинится |
| 632 API endpoints | ✅ Зарегистрированы | OpenAPI: `/openapi.json` |

Скрин экрана входа (`/index`): «Don't buy a car blind», CTA «Find & inspect a car» / «Become an inspector», EN/RU/DE локализация, темная палитра + жёлтый акцент — **выглядит как продакшн**.

---

## 2. Архитектура

### 2.1 Repository layout
```
/app
├── backend/              # FastAPI (Python) — главный backend (632 routes)
│   ├── server.py         # 1600 LOC — orchestrator + bootstrap
│   ├── app/              # 339 .py файлов, 77 515 LOC
│   │   ├── core/         # config, db, security, realtime, metrics
│   │   ├── admin/        # 181 endpoints (governance, ops, integrations)
│   │   ├── provider/     # 82 endpoints
│   │   ├── inspector/    # 48 endpoints
│   │   ├── customer/     # 34 endpoints
│   │   ├── marketplace/  # 30 endpoints
│   │   ├── payments/     # 22 endpoints — Stripe Connect Express
│   │   ├── escrow/       # escrow + release + dispute hooks
│   │   ├── disputes/     # arbitration layer (Sprint 6)
│   │   ├── chat/         # service chat (Sprint 4)
│   │   ├── orchestrator/ # demand/supply orchestrator
│   │   ├── ml/           # demand predictor, strategy optimizer
│   │   ├── intelligence/ # cognition layer
│   │   ├── two_factor/   # TOTP + recovery codes
│   │   ├── notifications/ # Expo push + Firebase
│   │   ├── pricing/      # pricing_v2 frozen
│   │   ├── reputation/   # provider reputation (Sprint 5)
│   │   ├── provider_trust/ # trust cards
│   │   ├── integrations/ # encrypted credentials (Stripe etc.)
│   │   └── ... (54 модуля domain-driven)
│   ├── src/              # NestJS-вариант (disabled, не использован)
│   ├── requirements.txt  # 137 пакетов
│   └── seed_*.py         # 9 скриптов-сидеров (Bonn, journey, providers...)
│
├── frontend/             # Expo SDK 54 (React Native 0.81.5, React 19)
│   ├── app/              # 65 entry-маршрутов (expo-router), 273 .ts(x) файла
│   │   ├── (tabs)/       # bottom tabs: index, requests, quotes, reports, garage, services, create, profile
│   │   ├── admin/        # ~30 экранов админки
│   │   ├── inspector/    # экраны инспектора (jobs, capture, timeline, exposures)
│   │   ├── provider/     # экраны поставщика услуг
│   │   ├── customer/     # экраны клиента
│   │   ├── auto-request/, booking/, chat/, disputes/, payments/, packages/
│   │   └── operator/, organization/, vehicles/, zones/, etc.
│   ├── src/              # 1.8 MB кода (components, stores zustand, i18n, theme)
│   ├── assets/           # 5.4 MB (images, splash, icons)
│   └── package.json      # 75 dep-ов, Expo SDK 54
│
├── admin/                # Vite + React + shadcn/radix-ui (admin panel SPA)
├── web-app/              # Vite + React + Leaflet (публичный сайт)
├── shared/               # @platform/* alias для metro/tsconfig
│   ├── domain/           # shared domain types
│   └── cognition_guardrails/
├── docs/                 # архитектурные доки
├── memory/               # 114 sprint-постмортемов
└── PRODUCTION_READINESS.md  # runbook для go-live
```

### 2.2 Stack
| Слой | Технология | Версия |
|---|---|---|
| Mobile | Expo SDK | **54.0.34** |
| | React Native | 0.81.5 |
| | React | 19.1.0 |
| | expo-router | 6.0.22 (typed routes) |
| | State | Zustand 5 |
| | i18n | i18next 26 + react-i18next |
| | Animations | react-native-reanimated 4 |
| Backend | FastAPI | 0.110.1 |
| | Python | 3.11 |
| | Motor (Mongo async) | 3.3.1 |
| | Pydantic v2 | 2.12.5 |
| | uvicorn | 0.25.0 |
| | bcrypt | 4.1.3 |
| | PyJWT | 2.12.1 |
| | pyotp (2FA) | 2.9.0 |
| | stripe | 15.0.1 |
| | emergentintegrations | 0.1.0 |
| Web (SPA) | Vite + React 18 | — |
| Admin (SPA) | Vite + React 18 + Radix UI | — |
| DB | MongoDB | local |
| Cache (опционально) | Redis | ❌ не запущен |

### 2.3 Ingress / порты
- `/` → port 3000 (Expo metro web)
- `/api/*` → port 8001 (FastAPI)
- `EXPO_PUBLIC_BACKEND_URL = https://mobile-app-expo-11.preview.emergentagent.com`

---

## 3. Что я сделал (deploy steps выполнены)

1. ✅ Клонировал `L2PAD/A-Search-EX` в `/tmp/asearch`
2. ✅ Сохранил защищённые `.env` (`/app/backend/.env`, `/app/frontend/.env`)
3. ✅ Скопировал `backend/` → `/app/backend/`, восстановил `.env`
4. ✅ Скопировал `frontend/app|src|assets|scripts|*.json|*.js` → `/app/frontend/`, восстановил `.env`
5. ✅ Скопировал `shared/` → `/app/shared/` (требуется metro.config.js)
6. ✅ Скопировал `admin/`, `web-app/`, `docs/`, `memory/`, `PRODUCTION_READINESS.md`
7. ✅ `pip install -r /app/backend/requirements.txt` (137 пакетов, без ошибок)
8. ✅ `yarn install` в `/app/frontend` (без блокирующих warning-ов, только устаревшие peer-deps)
9. ✅ Запустил `supervisorctl start backend expo`
10. ✅ Backend поднялся, авто-сидинг админа сработал
11. ✅ Expo web-bundle собрался (~1303 модуля), туннель ngrok готов
12. ✅ Скрин показывает рендер корневого экрана корректно (logo «A | Search Experts», CTA, EN-локаль)
13. ✅ Проверил health, register, login admin'а — всё работает

---

## 4. Health-checks (executed live)

```bash
# Health
GET /api/health
→ {"status":"ok","db":"connected","nestjs":"disabled","timestamp":"2026-05-22T08:50:12Z"}

# Register
POST /api/auth/register {email, password, role:"customer", fullName}
→ 200 {accessToken, user{id,email,role,kind:"customer"}}

# Admin login (seeded по умолчанию)
POST /api/auth/login {email:"admin@autoservice.com", password:"Admin123!"}
→ 200 {accessToken, role:"admin"}

# Real frontend hit
GET /api/cities (от Expo bundle) → 200 OK
```

**Backend orchestrator** уже крутит фоновые циклы:
- Orchestrator cycle: 29 actions across 15 zones / 10s
- Feedback processor: 50 records / 15s
- Pre-engagement triggers: Tartu, Minsk, Brest, …

---

## 5. Состояние модулей (по областям)

| Модуль | Sprint | Состояние |
|---|---|---|
| Auth (JWT, bcrypt, account-switcher) | ✅ | Готов, 12 endpoints, admin авто-сидинг |
| 2FA (TOTP + recovery) | ✅ | 6 endpoints, pyotp + qrcode |
| Marketplace + bids | ✅ | 30 endpoints |
| Service requests + quotes | ✅ | 8 + 15 endpoints |
| Escrow + Stripe Connect Express | Sprint 7 ✅ | Sandbox-ready, нужен `sk_live_*` для прод |
| Disputes / arbitration | Sprint 6 ✅ | Resolution + freeze API |
| Trust / Reputation / Reviews | Sprint 5 ✅ | Compound indexes готовы |
| Service Chat | Sprint 4 ✅ | WS + REST |
| Notifications (Expo push) | Sprint 8 ✅ | + Firebase Realtime |
| Pricing v2b frozen | ✅ | offer-packages versioning |
| Inspector workflow | ✅ | jobs, capture, timeline, exposures, OCR1 (VIN/odometer) |
| Provider workflow | ✅ | dispatch, topology, intelligence |
| Customer cognition | ✅ | timeline, continuity |
| Admin observatory / ops alerts | ✅ | 181 endpoints |
| Orchestrator (demand/supply) | ✅ | предиктор Sprint 20, optimizer 60s |
| i18n EN/RU/DE | Phase 5 frozen | audit script `i18n:audit` |
| Production runbook | Sprint 9 ✅ | `PRODUCTION_READINESS.md` |

---

## 6. Риски / Что НЕ готово к прод-релизу

### 🔴 Высокий приоритет
1. **Redis не запущен.** Orchestrator работает в NO-OP fallback — это OK для денежных потоков (как заявлено в runbook), но **breakers, rate-limit, idempotency**-кэш также деградируют. Перед live-запуском поднять `redis://127.0.0.1:6379` (нет в supervisord-конфиге Emergent — нужно либо добавить, либо принять degraded mode).
2. **Дефолтные креды админа** в коде (`Admin123!`). **MUST** переопределить через `ADMIN_PASSWORD` env перед прод.
3. **`JWT_SECRET`** — дефолтный в `app/core/config.py`. **MUST** заменить на 32+ случайных символов.
4. **Stripe ключи**: сейчас sentinel `sk_test_emergent`. Нужно загрузить через `/api/admin/integrations` UI (encrypted в `integration_credentials`). См. чек-лист §2 в `PRODUCTION_READINESS.md`.
5. **Stripe webhook endpoint** не зарегистрирован в Stripe Dashboard (`POST /api/billing/webhook/connect`). Без подписки на events `account.updated`, `payment_intent.succeeded`, `transfer.*`, `refund.*` — escrow flow развалится в проде.
6. **Резервное копирование MongoDB не настроено** (нет cron'а). Критичные коллекции: `service_payments`, `disputes`, `provider_reviews`, `integration_credentials`, `stripe_webhook_events`. Команда из runbook §3 не запланирована.

### 🟡 Средний приоритет
7. **Admin SPA не собран** (`/app/admin/dist`). Если нужен веб-админ — `cd /app/admin && yarn && yarn build`. Backend уже умеет раздавать его с `/api/admin-panel/*`.
8. **Web-app SPA не собран** (`/app/web-app/dist`). Аналогично, если нужен публичный сайт — `cd /app/web-app && yarn && yarn build`.
9. **`STRIPE_CONNECT_ENABLED=0`** (sandbox). Перед live: 1 → перезапустить backend.
10. **`Firebase admin SDK`** — установлен (npm + py пакет нет, но в коде есть `firebase-admin` в NestJS). В Python-варианте используется заглушка Realtime через сервер. Если нужны push-уведомления через FCM — нужно скачать service-account JSON и положить в `/app/backend/firebase-admin.json` + `GOOGLE_APPLICATION_CREDENTIALS`.
11. **NestJS backend в `backend/src`** — **dead code** в данной развёртке (NESTJS_ENABLED=False). Решить: удалить, либо включить как secondary микросервис.
12. **Supervisor не управляет admin/web-app/redis** — текущая Emergent-конфигурация поднимает только expo+backend+mongo. Если нужен полный stack — модифицировать supervisord-конфиг (через Emergent).

### 🟢 Низкий приоритет / nice-to-have
13. **77 K LOC бэкенда** — велик. Локальная тестовая база собрана, но `pytest`-suite требует Redis + MongoDB. Гонять полностью CI/CD пайплайн вне Emergent.
14. **Старые предупреждения yarn** (uuid<11, rimraf<4, glob<8) — не блокеры, можно обновить позже.
15. **Sentry/observability** — структурированные логи есть (`app/core/structured_log.py` whitelisted events), но внешний sink не подключен.
16. **15 предыдущих AUDIT_*.md** в репозитории — много дубликатов, можно почистить (но это контекст для разработки, оставил).

---

## 7. Файлы предыдущих аудитов (как контекст для роадмапа)

В корне репозитория **15 audit-отчётов** разных дат (2026-02 → 2026-05). Самые свежие:
- `AUDIT_E1_FULL_DEEP_2026_05_20.md`
- `AUDIT_E1_DEPLOY_2026_05_20_FRESH.md`
- `AUDIT_E2_DEPLOY_2026_05_20.md`

И **114 sprint-постмортемов** в `/app/memory/`. Включая:
- `PRD.md`
- `SPRINT_3A_ESCROW.md`, `SPRINT_4_SERVICE_CHAT.md`
- `stripe_1_wired_2026_05_15.md`
- `payments_2a_pay_button_frozen_2026_05_16.md`
- `pricing_v2b_freeze_closure_2026_05_17.md`
- `phase_3_1_mobile_parity_closure.md`

→ Это **главный источник истины** для понимания, что заморожено и что можно трогать.

---

## 8. Известные ограничения окружения Emergent

- Один backend-процесс (uvicorn `--workers 1 --reload`) — для серьёзной нагрузки нужен gunicorn/multi-worker.
- Нет встроенного Redis, Postgres, S3.
- Ingress даёт **только два маршрута**: `/` → :3000, `/api/*` → :8001. Если нужно поднять `admin` на отдельном порту 3001 — потребуется кастомный nginx-конфиг через Emergent support.
- Expo запущен с `--tunnel` (ngrok), что подходит для preview, но для прод-store-сборки нужно EAS build (использовать кнопку Emergent Publish).

---

## 9. Что я НЕ менял (чтобы не сломать заморозки)

- ❌ Не редактировал ни одного `.py` / `.tsx` файла.
- ❌ Не менял `package.json`, `requirements.txt`.
- ❌ Не трогал `EXPO_PACKAGER_PROXY_URL`, `EXPO_PACKAGER_HOSTNAME`, `MONGO_URL`.
- ❌ Не запускал миграции / сидеры данных (`seed_bonn_providers.py` и т.п.) — нужно ваше явное согласие.
- ❌ Не собирал `admin/` и `web-app/` (отдельные SPA) — оставил решение за вами.

---

## 10. Рекомендации — что делать дальше

### Минимум для «play-mode» в preview (готово ✅ всё):
- Mobile Expo поднят, admin auth работает, можно тестировать клиентские флоу.

### Если хотите полный продакшн-стенд внутри Emergent:
1. **Поднять Redis** (если возможно в данной конфигурации).
2. **Засеять данные**: `cd /app/backend && python seed_bonn_providers.py && python seed_regional_providers.py && python seed_stage2_cities.py` (даст начальный набор городов/провайдеров).
3. **Собрать admin SPA**: `cd /app/admin && yarn && yarn build` → `/api/admin-panel/` начнёт отдавать SPA.
4. **Собрать web-app SPA**: `cd /app/web-app && yarn && yarn build` → `/api/web-app/` начнёт отдавать публичный сайт.
5. **Сменить JWT_SECRET и ADMIN_PASSWORD** в `/app/backend/.env`.
6. **Запустить smoke-suite**:
   ```bash
   cd /app/backend
   python test_trust_e2e.py
   python test_disputes_e2e.py
   python test_stripe_connect_e2e.py
   python test_sprint8_ops_e2e.py
   ```

### Если хотите развивать (фичи / багфиксы):
- Перед каждой фичей **читать `/app/memory/`** — там 114 sprint-доков, многое уже зафиксировано (frozen).
- Не трогать без явной нужды:
  - `pricing_v2b` (frozen 2026-05-17)
  - `notify_pref_1` (frozen 2026-05-15)
  - `Phase 5 i18n` (frozen)
  - `revenue_semantics_layer` (frozen 2026-05-13)
  - `payments_2a_pay_button` (frozen 2026-05-16)

---

## 11. Готов к следующему шагу

Скажите, что делаем дальше:
- **A)** Засеять города/провайдеров и пройтись по флоу как customer (поиск → запрос → bid → escrow → release)?
- **B)** Собрать admin SPA и проверить ops-панель?
- **C)** Добавить фичу / поправить багу (укажите какую)?
- **D)** Подключить реальные Stripe-ключи / Redis / webhook?
- **E)** Что-то другое?

Бэкэнд (`:8001`) + мобильное приложение (`:3000`) **подняты и отвечают**. Скрин стартового экрана выше подтверждает работающий UI.
