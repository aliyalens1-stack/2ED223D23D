# 🔍 AUDIT REPORT — A | Search Experts

**Дата:** 2026-05-22
**Среда:** Emergent preview pod `mobile-app-staging-4`
**Аудитор:** E1 (Emergent)
**Источник:** https://github.com/aliyalens1-stack/32323232
**Тип:** полное развёртывание + аудит архитектуры, безопасности, качества кода, готовности к prod

---

## 0. TL;DR

| Показатель | Значение |
|---|---|
| **FastAPI Backend** | ✅ RUNNING на `:8001` — **637 endpoints** |
| **MongoDB** | ✅ RUNNING (`mongodb://localhost:27017`, db `test_database`) |
| **Expo Frontend (web)** | ✅ RUNNING на `:3000`, Metro bundler |
| **Preview URL** | ✅ Live — https://mobile-app-staging-4.preview.emergentagent.com |
| **Health endpoint** | ✅ `{"status":"ok","db":"connected","nestjs":"disabled"}` |
| **Auth admin** | ✅ `admin@autoservice.com / Admin123!` → 200 OK + JWT |
| **UI рендер** | ✅ «Don't buy a car blind» — лендинг с CTA, тёмная палитра + жёлтый акцент |
| **Redis** | ⚠️ Не установлен → NO-OP fallback |
| **Admin SPA / Web-app SPA** | ⏸️ `dist/` не собран |
| **NestJS backend (`backend/src`)** | ⏸️ disabled (`NESTJS_ENABLED=0`) — dead code |

### Критические находки (MUST FIX перед prod)
1. 🔴 **JWT_SECRET по умолчанию** — `auto_service_jwt_secret_key_2025_very_secure` зашит в `app/core/config.py:40`.
2. 🔴 **ADMIN_PASSWORD по умолчанию** — `Admin123!` в `config.py:45`.
3. 🔴 **Stripe Connect** — не активирован (`STRIPE_CONNECT_ENABLED` отсутствует, ключи в коде sentinel `sk_test_emergent`).
4. 🔴 **Redis отсутствует** — rate-limit / idempotency / orchestrator работают в NO-OP fallback.
5. 🟡 **Backend lint: 594 предупреждения ruff** (278 unused-import, 169 пустых f-string, 30 unused-vars).
6. 🟡 **Frontend lint: 130 ошибок + 411 warnings** (`expo-secure-store` не резолвится в `src/utils/storage/index.ts`).
7. 🟡 **MongoDB backup** не настроен (критичные коллекции: `service_payments`, `disputes`, `integration_credentials`).

---

## 1. Развёртывание

| Шаг | Статус |
|---|---|
| `git clone aliyalens1-stack/32323232` → `/tmp/repo_clone` | ✅ 16 000 файлов |
| Backup `/app/backend/.env`, `/app/frontend/.env` | ✅ |
| Rsync `admin/`, `audit/`, `backend/`, `docs/`, `frontend/`, `memory/`, `shared/`, `tests/`, `test_reports/`, `web-app/` → `/app/` | ✅ |
| Восстановлены protected `.env` файлы | ✅ |
| `pip install -r backend/requirements.txt` — 137 пакетов | ✅ |
| `yarn install` в `/app/frontend` | ✅ 39 сек (warnings: uuid<11, rimraf<4, glob<8) |
| `supervisorctl restart backend && expo` | ✅ оба RUNNING |
| Smoke: `GET /api/health` | ✅ `db:"connected"` |
| Smoke: `POST /api/auth/login` admin | ✅ 200 + JWT |
| Smoke: preview URL UI screenshot | ✅ рендерится корректно |

---

## 2. Архитектура

```
/app/
├── backend/              FastAPI (Python 3.11) — 489 .py, ~125 K LOC
│   ├── server.py         (~6 K LOC bootstrap + 60+ include_router'ов)
│   ├── app/              55 доменных модулей (admin, provider, inspector,
│   │                     customer, marketplace, payments, escrow, disputes,
│   │                     chat, orchestrator, ml, vehicles, ...)
│   ├── src/              NestJS-вариант (disabled, dead code)
│   ├── seed_*.py         9 сидеров (bonn, regional, stage2, journey, ...)
│   ├── test_*.py         15 e2e тестов (trust, disputes, stripe, ops, ...)
│   └── requirements.txt  137 пакетов
│
├── frontend/             Expo SDK 54 (RN 0.81 / React 19) — 284 .ts(x)
│   ├── app/              156 expo-router screens, 30+ маршрутных групп
│   │                     (tabs, admin, provider, inspector, customer, chat,
│   │                     booking, payment, dispute, inspection-report, ...)
│   ├── src/              components, zustand stores, i18n EN/RU/DE, theme
│   └── assets/           иконки/сплеши/бренд
│
├── admin/                Vite + React + shadcn/radix-ui (85 .tsx) — отдельный SPA
├── web-app/              Vite + React + Leaflet (95 .tsx) — публичный сайт
├── shared/               @platform/* alias (domain types, validators, guardrails)
├── docs/                 архитектурные документы
├── memory/               127 sprint-постмортемов (13 frozen)
├── audit/                ранее сгенерированные отчёты-инструменты
└── tests/                pytest fixtures
```

### Stack
| Слой | Технология | Версия |
|---|---|---|
| Mobile | Expo SDK | **54.0.34** |
| | React Native | 0.81.5 / React 19.1.0 |
| | expo-router | 6.0.22 (typed routes) |
| | State | Zustand 5 |
| | i18n | i18next 26 + react-i18next |
| | Animations | reanimated 4 |
| Backend | FastAPI | 0.110.1 |
| | Motor (Mongo async) | 3.3.1 |
| | Pydantic | 2.12.5 |
| | bcrypt / PyJWT / pyotp | 4.1.3 / 2.12.1 / 2.9.0 |
| | stripe / emergentintegrations | 15.0.1 / 0.1.0 |
| DB | MongoDB (local) | — |
| Cache | Redis | ❌ отсутствует |

### Ingress
- `/` → port 3000 (Expo web)
- `/api/*` → port 8001 (FastAPI)

---

## 3. Endpoint-инвентаризация

**Итого 637 endpoints в 60+ группах.** Топ-15:

| Префикс | Endpoints | Назначение |
|---|---:|---|
| `/api/admin` | 182 | governance / ops / integrations / verification |
| `/api/provider` | 83 | dispatch / topology / intelligence / onboarding |
| `/api/inspector` | 48 | jobs / timeline / verification / capture |
| `/api/customer` | 35 | requests / continuity / cognition |
| `/api/marketplace` | 30 | bids / providers / matching |
| `/api/payments` | 22 | Stripe Checkout + Escrow + Chronology |
| `/api/chat` | 15 | service chat (Sprint 4) |
| `/api/inspections` | 14 | reports v2 + timeline |
| `/api/car-selection` | 13 | advisory workflow |
| `/api/auth` | 12 | JWT login/register/me + 2FA TOTP |
| `/api/system` | 10 | health / metrics / errors / deeplink / telemetry |
| `/api/orchestrator` | 10 | demand prediction + governance |
| `/api/zones` | 9 | geo zones admin |
| `/api/pricing` | 9 | pricing v1 + v2 (density-aware) |
| `/api/geo` | 8 | countries / cities / topology |

---

## 4. Состояние модулей (по `memory/` + код)

| Модуль | Sprint | Состояние |
|---|---|---|
| Auth (JWT + bcrypt + account-switcher) | C5 ✅ | 12 ep, admin авто-сидинг работает |
| 2FA (TOTP + recovery) | ✅ | pyotp + qrcode |
| Marketplace + bids | ✅ | 30 ep |
| Service requests + quotes | ✅ | 8 + 15 ep |
| Escrow + Stripe Connect Express | Sprint 7 ✅ | sandbox-ready |
| Disputes / arbitration | Sprint 6 ✅ | resolution + freeze API |
| Trust / Reputation / Reviews | Sprint 5 ✅ | compound indexes |
| Service Chat | Sprint 4 ✅ | WS + REST, 15 ep |
| Notifications (Expo push + Firebase) | Sprint 8 ✅ | 7 ep |
| Pricing v2b | frozen 2026-05-17 | offer-packages versioning |
| Inspector workflow | ✅ | jobs / capture / timeline / OCR1 |
| Provider workflow | ✅ | dispatch / topology / intelligence |
| Customer cognition | ✅ | timeline / continuity |
| Admin observatory / ops alerts | ✅ | 182 ep |
| Orchestrator (demand/supply) | ✅ | predictor + optimizer (60 s) |
| i18n EN/RU/DE | Phase 5 frozen | audit script `i18n:audit` |
| Production runbook | Sprint 9 ✅ | `PRODUCTION_READINESS.md` |
| Vehicle Memory MVP | Sprint 2B ✅ | ingest / refresh / watchlist / market searches |
| Service Marketplace v1 | ✅ | 9 категорий — public/customer/provider/admin |

### Заморозки (`memory/*_frozen_*.md`)
13 модулей помечены frozen — **не трогать без явной нужды**:
- `pricing_v2b` (2026-05-17)
- `notify_pref_1` (2026-05-15)
- `Phase 5 i18n EN/RU/DE`
- `revenue_semantics_layer` (2026-05-13)
- `payments_2a_pay_button` (2026-05-16)
- `stripe_1_wired` (2026-05-15)
- `customer_bounce_1_notify_3b` (2026-05-15)
- `customer_email_receipt_1` (2026-05-15)
- `customer_notify_3a` (Phase ABC, 2026-05-15)
- `P0bCf_F1_taxonomy` (2026-02-22)
- `PHASE_9_UI`
- `PHASE_5_I18N`

---

## 5. Live Health checks

```bash
GET /api/health
→ {"status":"ok","db":"connected","nestjs":"disabled",
   "timestamp":"2026-05-22T13:13:03.827953+00:00"}

GET /api/system/health
→ {"status":"ok","requestsTotal":8,"errorsTotal":0,
   "orchestratorAlive":true,"feedbackAlive":true,...}

POST /api/auth/login {admin@autoservice.com / Admin123!}
→ 200  accessToken (JWT HS256, exp=+7d), role=admin, accountId

GET https://mobile-app-staging-4.preview.emergentagent.com/api/health
→ 200 OK (ingress работает корректно)
```

В live-логах видны фоновые циклы:
- Orchestrator cycle (10 s)
- Feedback processor (15 s)
- Strategy optimizer (60 s)
- DemandPredictor Sprint 20 (60 s)
- Push receipts poll (180 s)
- TTL/expiry workers

---

## 6. 🔴 Безопасность — критичные находки

### 6.1. Дефолтные секреты в коде

**`/app/backend/app/core/config.py:40`**
```python
JWT_SECRET: str = os.environ.get(
    'JWT_SECRET',
    'auto_service_jwt_secret_key_2025_very_secure'  # ❌ хардкод!
)
```
**Риск:** если `JWT_SECRET` не задан в env, любой, кто видел репо, может выписать валидный admin-токен.
**Fix:** `JWT_SECRET = os.environ['JWT_SECRET']` без default → сервер не стартует без явного секрета.

**`config.py:45`**
```python
ADMIN_PASSWORD: str = os.environ.get('ADMIN_PASSWORD', 'Admin123!')  # ❌
```
**Риск:** seed admin создаётся с паролем `Admin123!` (видно сейчас в БД, bcrypt hash проверен).
**Fix:** убрать default + добавить fail-fast в `seed_data` если env пуст.

### 6.2. Hardcoded Stripe sentinel
`STRIPE_API_KEY=sk_test_emergent` (sentinel) в коде → в `integration_credentials` MongoDB должны быть реальные ключи через `/api/admin/integrations`. Сейчас не загружены.

### 6.3. Сертификаты / шифрование
✅ Хорошо: `cryptography==46.0.7` подключена, `integration_credentials` шифруются.
⚠️ Нет ротации ключей шифрования.

### 6.4. Rate-limit / idempotency
Реализованы в `prod_readiness.py`, но без Redis работают на in-memory dict → теряются при рестарте, не masштабируются.

### 6.5. Прочее
- ✅ CORS — не открыт настежь (видно по middleware).
- ✅ JWT валидация с TTL.
- ⚠️ Rate-limit обходим через `X-Test-Bypass` header при наличии `TEST_BYPASS_TOKEN` env — убедиться, что в prod env это пусто.
- ✅ Bcrypt cost=12 (по умолчанию).

---

## 7. 🟡 Качество кода

### 7.1. Backend (ruff)
**594 lint-нарушения** (447 авто-fix):
| Код | Кол-во | Описание |
|---|---:|---|
| F401 | 278 | unused-import |
| F541 | 169 | f-string без плейсхолдеров |
| E701 | 79 | multiple-statements-on-one-line |
| F841 | 30 | unused-variable |
| E402 | 19 | module-import-not-at-top |
| E702 | 9 | multiple-statements (semicolon) |
| E741 | 5 | ambiguous-variable-name |

**Не блокирует прод**, но мешает. Рекомендация: `ruff check --fix` (безопасно для 447 правил).

### 7.2. Frontend (eslint)
**130 errors + 411 warnings**.
Самая критичная:
```
/app/frontend/src/utils/storage/index.ts:7:30
  error  Unable to resolve path to module 'expo-secure-store'
```
`expo-secure-store` отсутствует в `package.json`, но импортируется. На вебе работает (есть `index.web.ts`), на native — упадёт. **Fix:** `yarn expo install expo-secure-store` либо удалить native импорт.

Остальное — `import/no-duplicates`, `no-unused-vars`, нестрашные React/TS warnings.

### 7.3. Server.py размер
`server.py` ~6 000 строк (включая комментарии «Sprint 21 C* — moved to ...»). Видно последовательную миграцию монолита в доменные роутеры. **Рекомендация:** завершить вынос (осталось ~30% legacy кода).

---

## 8. 🟡 Готовность к продакшену

### Critical-блокеры
1. ❌ **Redis не установлен** — orchestrator, rate-limit, idempotency деградированы.
2. ❌ **Stripe Connect** — `STRIPE_CONNECT_ENABLED=0`, реальные ключи не загружены.
3. ❌ **Stripe webhook** не зарегистрирован в Stripe Dashboard.
4. ❌ **MongoDB backup** не настроен (см. `PRODUCTION_READINESS.md §3`).
5. ❌ Дефолтные `JWT_SECRET` и `ADMIN_PASSWORD` (см. §6).

### Средний приоритет
6. ⏸️ **Admin SPA** (`/app/admin/dist`) не собран. `cd /app/admin && yarn && yarn build`.
7. ⏸️ **Web-app SPA** (`/app/web-app/dist`) не собран. `cd /app/web-app && yarn && yarn build`.
8. ⏸️ **Firebase admin SDK** — заглушка. Для FCM нужен service-account JSON.
9. ⏸️ **NestJS backend (`backend/src`)** — dead code, либо удалить, либо включить.
10. ⏸️ **Supervisor** управляет только `backend + expo + mongodb` — admin/web-app/redis отсутствуют в конфиге.

### Низкий приоритет
11. yarn warnings (uuid<11, rimraf<4, glob<8).
12. Sentry/observability — структурированные логи есть (`app/core/structured_log.py`), внешний sink не подключен.
13. Ruff/eslint cleanup (см. §7).

---

## 9. Чек-лист «pre-live»

Из `PRODUCTION_READINESS.md` (Sprint 9), валидно сейчас:

```bash
# 1. Cменить секреты
echo "JWT_SECRET=$(openssl rand -hex 32)" >> /app/backend/.env
echo "ADMIN_PASSWORD=$(openssl rand -base64 24)" >> /app/backend/.env

# 2. Установить Redis
apt-get install -y redis-server  # либо использовать managed Redis
echo "REDIS_URL=redis://127.0.0.1:6379/0" >> /app/backend/.env

# 3. Загрузить реальные Stripe-ключи через admin
# (UI: /api/admin-panel/ → Integrations → Stripe)

# 4. Зарегистрировать Stripe webhook
# Stripe Dashboard → Webhooks → https://<domain>/api/billing/webhook/connect
# events: account.updated, payment_intent.succeeded/failed,
#         transfer.created/updated/reversed, refund.created/updated,
#         charge.refunded

# 5. Включить Connect:
echo "STRIPE_CONNECT_ENABLED=1" >> /app/backend/.env

# 6. Собрать SPA:
cd /app/admin    && yarn && yarn build
cd /app/web-app  && yarn && yarn build

# 7. Smoke-suite:
cd /app/backend
python test_trust_e2e.py
python test_disputes_e2e.py
python test_stripe_connect_e2e.py
python test_sprint8_ops_e2e.py

# 8. Backup cron:
0 */6 * * * mongodump --uri="$MONGO_URL" --out=/backups/$(date +%Y%m%d_%H%M%S) --gzip
```

---

## 10. Соответствие требованиям Emergent

| Правило | Соблюдено |
|---|:---:|
| `/api` префикс на всех backend-маршрутах | ✅ (637/637) |
| `MONGO_URL` читается из `.env`, не хардкодится | ✅ |
| `EXPO_PUBLIC_BACKEND_URL` / `EXPO_PACKAGER_*` не модифицированы | ✅ |
| Backend на `0.0.0.0:8001` | ✅ |
| ObjectId исключается из ответов | ⚠️ В целом да, есть пара мест с `Pydantic models`; полный аудит требует проверки 489 файлов |
| `datetime.now(timezone.utc)` (не utcnow) | ⚠️ В `server.py` используется `now_utc()` helper; mass-scan требуется |
| MongoDB compound indexes | ✅ (`hot_indexes.py`) |
| Structured logs | ✅ (`app/core/structured_log.py`) |

---

## 11. Что я НЕ трогал

- ❌ Ни одного `.py` / `.tsx` файла не редактировал
- ❌ Не менял `package.json`, `requirements.txt`
- ❌ Не трогал `MONGO_URL`, `EXPO_PACKAGER_*`
- ❌ Не запускал миграции / сидеры (`seed_*.py`)
- ❌ Не собирал `admin/` и `web-app/` SPA
- ❌ Не менял `JWT_SECRET` / `ADMIN_PASSWORD` — остались дефолты
- ❌ Не устанавливал Redis

---

## 12. Артефакты

- **Этот аудит:** `/app/AUDIT_REPORT_2026_05_22.md`
- Предыдущий аудит E1: `/app/AUDIT_E1_DEPLOY_2026_02_22.md`
- Предыдущий аудит E2: `/app/AUDIT_E2_DEPLOY_2026_05_22.md`
- Production runbook: `/app/PRODUCTION_READINESS.md`
- Sprint-постмортемы: `/app/memory/` (127 шт.)

---

## 13. Готов к следующему шагу

Бэкенд (**637 endpoints**) и Expo web-приложение **подняты, отвечают, UI рендерится корректно**. Auth admin работает (`admin@autoservice.com / Admin123!`).

**Скажите, что делаем дальше:**
- **A)** Засеять города/провайдеров (Bonn, regional, stage2) и пройтись по флоу customer → request → bid → escrow → release
- **B)** Собрать admin SPA и web-app SPA (полный stack)
- **C)** Добавить новую фичу / поправить багу (укажите какую)
- **D)** Подключить реальные Stripe-ключи / Redis / webhook (закрыть critical-блокеры §8)
- **E)** Очистка кода (ruff --fix, eslint --fix), вынос остатков monolith из `server.py`
- **F)** Что-то другое — опишите задачу
