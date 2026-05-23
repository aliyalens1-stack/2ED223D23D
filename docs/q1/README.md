+# Q1 — Документация Месяцев 1–2 (Auto Search Platform)

> Эта папка содержит **аудит и архитектурное описание** работы, выполненной
> в рамках Месяца 1 (Auth + базовая структура) и Месяца 2 (Гео + поиск).
>
> Создана: 13.05.2026, после клонирования из
> https://github.com/aliyalens1-stack/3423423423.

---

## Структура папки

| Файл                                | Что внутри                                                          |
|-------------------------------------|---------------------------------------------------------------------|
| `README.md`                         | Эта страница — карта документации                                   |
| `01_architecture.md`                | Архитектура проекта, относящаяся к Месяцам 1–2 (слои, модули, БД)   |
| `02_month1_audit.md`                | Месяц 1 — построчная сверка ТЗ vs реальность (✅ что есть в коде)    |
| `03_month2_audit.md`                | Месяц 2 — построчная сверка ТЗ vs реальность (✅ что есть в коде)    |
| `04_project_overview_technical.md`  | Техническое описание всего проекта (для разработчика)               |
| `05_project_overview_simple.md`     | Описание простыми словами (для пользователя / стейкхолдера)         |

---

## TL;DR — Статус Месяцев 1 и 2

**Месяц 1 (Auth + базовая структура): ✅ ВЫПОЛНЕНО НА 100%**

- Backend поднят и работает (FastAPI + MongoDB + Motor).
- Модульная архитектура: `app/core`, `app/system`, `app/marketplace`, `app/auto_requests`, `app/inspector`, `app/customer`, `app/admin`, `app/payments` и др. (≈40 доменов).
- Auth-эндпоинты: `POST /api/auth/login`, `/register`, `/me`, `/forgot-password`, `/reset-password`, `/switch-account` — все работают.
- JWT + bcrypt — `app/core/security.py`.
- Роли: `admin`, `customer`, `provider_owner`, `inspector` (4 роли вместо 3-х из ТЗ — расширено).
- Middleware: `observability_middleware` (логи + метрики) + `prod_readiness_middleware` (rate-limit + идемпотентность) + CORS.
- Frontend (Expo + Web-app + Admin) — экраны `login.tsx`, `register.tsx`, `forgot-password.tsx`; формы подключены к API через axios (`src/services/api.ts`).

**Месяц 2 (Гео + поиск): ✅ ВЫПОЛНЕНО НА 100%**

- Гео-структура: `app/marketplace/cities.py` — каталог из **25 городов** (20 DE Tier 1+2, 2 AT, 3 UA), каждый с `country / lat / lng / timezone / currency`.
- Координаты для СТО: `db.organizations.location = {type:"Point", coordinates:[lng,lat]}` + `city` field.
- Поиск по радиусу: `/api/marketplace/providers?lat&lng&radius` — `haversine()` в `app/core/geo.py`.
- Фильтрация по городу: `/api/marketplace/providers?city=berlin` (см. `app/marketplace/providers.py:49`).
- Frontend выбор города: `app/frontend/app/city-select.tsx` (typeahead, флаги, грouping по странам) + `CityContext`.
- Карта: `web-app/src/components/LiveMap.tsx` (react-leaflet).
- Список СТО: `web-app/src/pages/public/SearchPage.tsx` — связан с картой (общий store + URL params).

**Бонус (вне ТЗ Q1, но уже сделано):**
- Месяц 3 (модель СТО + услуг + CRUD) — также готов. Карточки, страницы провайдеров, фильтры по услугам — есть.

---

## Live-проверка (на момент создания документа)

```bash
$ curl http://localhost:8001/api/health
{"status":"ok","db":"connected","nestjs":"disabled"}

$ curl http://localhost:8001/api/cities | jq '. | length'
25

$ curl "http://localhost:8001/api/marketplace/providers?city=berlin" | jq '.providers | length'
3

$ curl -X POST http://localhost:8001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@autoservice.com","password":"Admin123!"}' | jq .accessToken
"eyJhbGciOiJIUzI1NiIs..."  # ✅ JWT возвращается
```

---

## Тестовые креды

См. `/app/memory/test_credentials.md`:

| Роль     | Email                       | Пароль        |
|----------|-----------------------------|---------------|
| Admin    | admin@autoservice.com       | Admin123!     |
| Customer | customer@test.com           | Customer123!  |
| Provider | provider@test.com           | Provider123!  |
