# Развёртывание + аудит — 2026-05-14

**Источник:** https://github.com/aliyalens1-stack/234y3t4y23
**Subdomain:** `expo-mobile-app-16`

---

## 1. Что сделано в этой сессии

### Развёртывание
1. Клонирован репо в `/tmp/repo_audit`, перенесён в `/app` через `rsync -a` с исключением:
   `.git`, `.emergent`, `.gitconfig`, `backend/.env`, `frontend/.env`,
   `*/node_modules`, `*/dist`, `.metro-cache`, `.expo`, `__pycache__`.
   Существующие контейнерные `.env` файлы сохранены.
2. Установлены зависимости параллельно:
   - `pip install -r /app/backend/requirements.txt`
   - `yarn install` в `/app/frontend`, `/app/admin`, `/app/web-app`
3. Production-билды Vite (параллельно):
   - `admin/dist/`   → 18.3 s
   - `web-app/dist/` → 22.1 s
4. Запущены seed-скрипты:
   - `seed_stage2_cities.py`  → +8 СТО (Munich/Hamburg/Lviv/Odesa)
   - `seed_inspector.py`      → inspector@autoservice.com
   - `seed_inspector_jobs.py` → 4 demo jobs (offered/claimed/inspecting/report_ready)
   - `seed_bonn_providers.py` → 6 providers around Bonn
   - Авто-seed на startup: admin/customer/provider users + 11 demo orgs + zones + bookings
5. Сервисы supervisor: `backend` и `expo` запущены.

### Smoke-тесты (все ✅)
| Endpoint                                | Status |
|-----------------------------------------|--------|
| `GET /api/health`                       | 200 `{"db":"connected"}` |
| `GET /` (Expo web preview)              | 200 — рендер landing "Don't buy a car blind" |
| `GET /api/admin-panel/`                 | 200 — Vite SPA |
| `GET /api/web-app/`                     | 200 — Vite SPA |
| `GET /api/cities`                       | 200 — 25 cities (Berlin, Hamburg, München…) |
| `POST /api/auth/login` (admin)          | 200 + JWT |
| `GET /api/marketplace/providers`        | 200 — 8 providers |

---

## 2. Аудит — структура проекта

```
/app
├── backend/        FastAPI (Motor/MongoDB) — 230+ endpoints, 50+ модулей
│                   prod_readiness (rate-limit + idempotency), orchestrator loop
├── frontend/       Expo Router (RN 0.81 / SDK 54) — 60+ экранов
├── web-app/        Vite + React 18 — operations surface
├── admin/          Vite + React 18 — governance surface
├── shared/         Pure TS (alias @platform/*) — state machines + contracts
├── audit/          5 frozen architecture docs (CUSTOMER_JOURNEY, PROVIDER_SLA, …)
├── docs/q1/        Quarterly review (architecture, month1/2 audits, overviews)
├── memory/         55+ sprint/phase markdown'ов (история всех решений)
├── tests/          guardrail тесты
└── test_reports/   pytest baseline
```

**Stack health:**
- Python: `requirements.txt` 130+ пакетов, всё устанавливается (litellm, stripe, scikit-learn, redis, reportlab, google-genai, emergentintegrations…)
- Node: Expo SDK 54, RN 0.81.5, React 19.1, Vite, react-leaflet, gorhom/bottom-sheet, zustand, i18next
- DB: MongoDB local (port 27017)

---

## 3. Поверхности — какой вопрос отвечает

| Surface  | "Question"                  | Tech                    |
|----------|-----------------------------|-------------------------|
| Expo     | "что я делаю прямо сейчас?" | RN 0.81 / Expo SDK 54   |
| Web-app  | "как работаю глубоко?"      | Vite + React 18         |
| Admin    | "как управляю системой?"    | Vite + React 18         |
| Backend  | "что является истиной?"     | FastAPI + Motor + Mongo |
| Shared   | "как ведёт себя домен?"     | Pure TS (no JSX)        |

---

## 4. Технический долг (TODO, не блокирующий)

| # | Issue                          | Impact                                          | Fix |
|---|--------------------------------|-------------------------------------------------|-----|
| 1 | Redis недоступен (порт 6379)   | orchestrator state ops через no-op fallback     | Включить redis в supervisor (необязательно) |
| 2 | NestJS subprocess disabled     | `NESTJS_ENABLED=0` — legacy, не нужен           | Можно удалить shim полностью |
| 3 | Duplicate OperationID warnings | `stripe_webhook`, `proxy_to_nestjs` в OpenAPI   | Переименовать |
| 4 | Vite builds — manual rebuild   | После изменений `/app/admin` или `/app/web-app` нужен `yarn build` | Опционально: watcher |
| 5 | i18n `insp.*` / `rep.*` keys   | defaultValue стоит, но в `de/en/ru.json` ключей нет | Добавить переводы |
| 6 | Media → base64 в Mongo         | При росте >1 GB деградирует                     | Миграция на S3/MinIO |

---

## 5. Текущие URL-доступы

| Surface       | URL                                                                   |
|---------------|-----------------------------------------------------------------------|
| Mobile (Expo) | https://expo-mobile-app-16.preview.emergentagent.com/                 |
| Web-app       | https://expo-mobile-app-16.preview.emergentagent.com/api/web-app/     |
| Admin panel   | https://expo-mobile-app-16.preview.emergentagent.com/api/admin-panel/ |
| Health        | https://expo-mobile-app-16.preview.emergentagent.com/api/health       |

Креды: `/app/memory/test_credentials.md`

---

## 6. Готовность к следующим итерациям

Платформа поднята полностью и стабильна. Можно сразу приступать к:
- Новым фичам на любой поверхности
- Доработке существующих flow'ов
- Расширению парсеров / каталога городов
- Включению Redis (опционально)
- Прогоны pytest в `/app/backend/tests/`
- Внедрение S3 для медиа

Жду указаний от пользователя.
