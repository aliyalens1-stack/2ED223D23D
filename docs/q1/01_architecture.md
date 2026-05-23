# 01 — Архитектура (Месяцы 1–2)

Документ описывает архитектуру **только тех частей системы**, которые
были реализованы в Q1 (Месяцы 1 и 2). Полная картина всей платформы —
в `04_project_overview_technical.md`.

---

## 1. Общая картина (Q1 scope)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          КЛИЕНТЫ (3 поверхности)                          │
├─────────────────────────┬──────────────────────┬────────────────────────┤
│  📱 Mobile (Expo)         │  🌐 Web-app (Vite)    │  🛡 Admin (Vite)        │
│  /app/frontend/          │  /app/web-app/        │  /app/admin/           │
│  - login.tsx             │  - SearchPage.tsx     │  - login + dashboards  │
│  - register.tsx          │  - LiveMap.tsx        │  - city/provider mgmt  │
│  - city-select.tsx       │  - city picker        │                        │
└──────────┬───────────────┴──────────┬────────────┴─────────────┬──────────┘
           │ axios (EXPO_PUBLIC_BACKEND_URL)    │ axios (relative)     │
           ▼                          ▼                          ▼
       ┌────────────────────────────────────────────────────────────┐
       │            🐍 BACKEND — FastAPI (/api/*)                    │
       │            /app/backend/server.py + app/                    │
       └──────┬─────────────────────────────────────────────────────┘
              │
              ▼
        ┌──────────────────┐
        │ 🍃 MongoDB         │
        │  test_database    │
        │  - users          │
        │  - accounts       │
        │  - organizations  │ ← STO + location (GeoJSON Point)
        │  - cities (static)│ ← каталог в коде
        └──────────────────┘
```

---

## 2. Backend (Месяц 1 — слои)

### 2.1. Структура папок (только Q1-релевантные)

```
/app/backend/
├── server.py                     # ENTRY POINT — собирает 50+ роутеров
├── prod_readiness.py             # rate-limit / idempotency / circuit-breaker
├── requirements.txt
└── app/
    ├── core/                     # БАЗОВЫЕ ПРИМИТИВЫ
    │   ├── config.py             # env vars: MONGO_URL, JWT_SECRET, ADMIN_EMAIL
    │   ├── db.py                 # Motor client (proxy через ctx.db)
    │   ├── security.py           # hash_pw, verify_pw, verify_admin_token (JWT)
    │   ├── utils.py              # now_utc, uid (UUID v4)
    │   ├── geo.py                # haversine, resolve_zone — гео-математика
    │   ├── context.py            # AppContext (db + emitters)
    │   ├── lifespan.py           # startup hooks
    │   ├── metrics.py            # request/error counters
    │   ├── proxy.py              # opt-in proxy → NestJS (отключён)
    │   └── redis_state.py        # rate-limit + публичный rate-limit dep
    │
    ├── system/                   # СИСТЕМНЫЕ ЭНДПОИНТЫ
    │   ├── auth.py               # ⭐ /api/auth/login + /register + /me + /forgot/reset-password
    │   ├── health.py             # /api/health
    │   ├── system.py             # /api/system/errors, /api/system/health
    │   ├── compat.py             # legacy endpoints
    │   └── telemetry.py          # client-side telemetry sink
    │
    └── marketplace/              # МАРКЕТПЛЕЙС (часть Месяца 2)
        ├── router.py             # агрегатор marketplace
        ├── cities.py             # ⭐ /api/cities + /api/cities/{code}
        ├── providers.py          # ⭐ /api/marketplace/providers (с ?city + ?lat&lng)
        ├── matching.py           # /api/matching/nearby (radius search)
        ├── zones.py              # /api/zones/* (demand zones)
        └── ...
```

### 2.2. Слои внутри запроса (FastAPI middleware stack)

```
HTTP Request
   │
   ▼
┌─────────────────────────────────────┐
│ CORS middleware (Starlette)          │  ← всегда первый
├─────────────────────────────────────┤
│ prod_readiness_middleware            │  ← rate-limit + idempotency-key cache
│   • Rate limit (60 req/min per IP)   │
│   • Idempotency-Key (24h cache)      │
│   • Hard-gate UNGUARDED_ADMIN_PATHS  │
├─────────────────────────────────────┤
│ observability_middleware             │  ← логи + метрики + slow-req detection
│   • metrics.request_counter++        │
│   • write to db.system_logs (4xx/5xx)│
│   • response.headers['x-duration-ms']│
├─────────────────────────────────────┤
│ Route handler (APIRouter)            │  ← бизнес-логика
│   • Depends(verify_admin_token)       │
│   • Pydantic validation               │
│   • Motor (async MongoDB)             │
├─────────────────────────────────────┤
│ exception_handler                    │
│   • HTTPException → unified envelope │
│   • RequestValidationError → 422     │
│   • Exception → 500 + log            │
└─────────────────────────────────────┘
   │
   ▼
HTTP Response (JSON {error, code, message, details})
```

### 2.3. Auth-поток (Месяц 1)

```
                        POST /api/auth/register
                              │
                              ▼
        ┌──────────────────────────────────────┐
        │ app/system/auth.py :: register()     │
        │   1. body = {email, password, name,  │
        │              role}                   │
        │   2. role ∈ {customer, provider_owner}│
        │   3. hash_pw(password)  ← bcrypt     │
        │   4. db.users.insert_one({...})      │
        │   5. db.accounts.insert_one({...})   │
        │   6. JWT.encode({sub, email, role,   │
        │                  accountId, kind})   │
        └────────────────┬────────────────────┘
                         │
                         ▼ {accessToken, user}

                        POST /api/auth/login
                              │
                              ▼
        ┌──────────────────────────────────────┐
        │ app/system/auth.py :: login()         │
        │   1. db.users.find_one({email})       │
        │   2. verify_pw(password, user.hash)   │
        │   3. JWT.encode(...)                  │
        └────────────────┬────────────────────┘
                         │
                         ▼ {accessToken, user}

                        GET /api/auth/me
                              │   Authorization: Bearer <jwt>
                              ▼
        ┌──────────────────────────────────────┐
        │ Depends(verify_token)                 │
        │   1. JWT.decode(token, JWT_SECRET)    │
        │   2. user = db.users.find_one({_id})  │
        │   3. return {user, account, kind}     │
        └──────────────────────────────────────┘
```

**JWT payload:**
```json
{
  "sub": "<userId>",
  "email": "...",
  "role": "admin|customer|provider_owner",
  "caps": ["inspect"],
  "accountId": "<accountId>",
  "kind": "admin|customer|inspector",
  "iat": 1778681800,
  "exp": 1779286600
}
```

**Защищённые endpoint'ы:**
- `Depends(verify_admin_token)` — нужен JWT с `role: "admin"` (см. `app/core/security.py:25`).
- `Depends(rate_limit_public)` — публичные endpoint'ы.
- Hard-gate `UNGUARDED_ADMIN_PATHS` в `prod_readiness_middleware` (для proxy-маршрутов).

---

## 3. Backend (Месяц 2 — гео)

### 3.1. Каталог городов (`app/marketplace/cities.py`)

**25 городов** в статическом коде (не в БД — потому что меняется редко и нужен предсказуемый список):

```python
CITY_CATALOGUE = [
    {"code": "berlin",    "name": "Berlin",    "country": "DE", "lat": 52.52, "lng": 13.41, ...},
    {"code": "munich",    "name": "München",   "country": "DE", "lat": 48.14, "lng": 11.58, ...},
    {"code": "hamburg",   "name": "Hamburg",   "country": "DE", "lat": 53.55, "lng": 9.99,  ...},
    # ... +17 DE городов
    {"code": "vienna",    "name": "Wien",      "country": "AT", "lat": 48.21, "lng": 16.37, ...},
    {"code": "kyiv",      "name": "Київ",      "country": "UA", "lat": 50.45, "lng": 30.52, ...},
    # ...
]
```

**API:**
- `GET /api/cities` — список + кол-во провайдеров на город.
- `GET /api/cities/{code}` — деталь города.

**Side-effect:** на каждый вызов `_ensure_city_field()` тегирует существующие
`db.organizations` поле `city` (по `addressMarkers` или ближайшему центру).

### 3.2. Гео-данные на СТО (`db.organizations`)

```javascript
{
  "_id": ObjectId(...),
  "id": "uid-string",
  "name": "Berlin Auto-Check",
  "slug": "berlin-auto-check",
  "city": "berlin",                          // ← теггировано _ensure_city_field
  "address": "Berlin Mitte, on-site",
  "location": {                              // ← GeoJSON Point
    "type": "Point",
    "coordinates": [13.405, 52.52]           //   [lng, lat] — MongoDB-style
  },
  "ratingAvg": 4.9,
  "isOnline": true,
  "serviceIds": ["...", "..."],              // ← FK к db.services
  ...
}
```

### 3.3. Радиус-поиск + фильтр по городу (`app/marketplace/providers.py`)

```python
@router.get("/api/marketplace/providers")
async def marketplace_providers(
    lat: float = 50.45, lng: float = 30.52,
    radius: float = 10,
    city: str = None,                       # ← Stage 2: city filter
    q: str = None,                          # ← Stage 2: text search
    limit: int = 20,
):
    org_filter = {"status": "active"}
    if city:
        org_filter["city"] = city           # точное совпадение city.code
    if q:
        # safe regex search by name + description
        org_filter["$or"] = [
            {"name": {"$regex": q, "$options": "i"}},
            {"description": {"$regex": q, "$options": "i"}},
        ]
    orgs = await db.organizations.find(org_filter).to_list(limit * 2)

    for o in orgs:
        coords = o["location"]["coordinates"]
        dist = haversine(lat, lng, coords[1], coords[0])    # km
        o["distance"] = round(dist, 1)
        o["eta"]      = max(3, int(dist * 4))               # min
        # ... + ranking engine ...

    return {"providers": [...], "total": ..., "promotedCount": ...}
```

**Гео-функция** (`app/core/geo.py`):

```python
def haversine(lat1, lon1, lat2, lon2):
    """Great-circle distance (km) between two (lat,lng) points."""
    R = 6371
    ...
```

Используется в 6+ местах (providers, matching, zones, quick_request).

### 3.4. Demand zones (бонус из Месяца 2)

`app/marketplace/zones.py` — bounding-box зоны (Berlin Mitte, Berlin Neukölln, Munich Zentrum, Hamburg Altona, Kyiv Center и т.д.) для распределения спроса.

---

## 4. Frontend — Mobile (Expo)

### 4.1. Структура (Q1-релевантные файлы)

```
/app/frontend/
├── app/
│   ├── _layout.tsx                  # root layout + providers
│   ├── index.tsx                    # onboarding screen
│   ├── login.tsx                    # ⭐ Месяц 1 — форма логина
│   ├── register.tsx                 # ⭐ Месяц 1 — форма регистрации
│   ├── forgot-password.tsx          # Месяц 1 — восстановление
│   ├── city-select.tsx              # ⭐ Месяц 2 — выбор города
│   ├── (tabs)/                      # таб-навигация (после login)
│   └── ...
└── src/
    ├── services/
    │   └── api.ts                   # axios client (baseURL = EXPO_PUBLIC_BACKEND_URL + /api)
    ├── context/
    │   ├── AuthContext.tsx          # хранит JWT в AsyncStorage
    │   ├── CityContext.tsx          # ⭐ выбранный город (persistent)
    │   └── ThemeContext.tsx
    └── stores/
        └── (zustand stores)
```

### 4.2. Auth-flow на клиенте

```
login.tsx → api.post('/auth/login', {email, password})
         → AuthContext.setToken(jwt) + AsyncStorage
         → router.replace('/(tabs)')

register.tsx → api.post('/auth/register', {...})
            → AuthContext.setToken(jwt)
            → router.replace('/city-select')

forgot-password.tsx → api.post('/auth/forgot-password', {email})
                   → confirm screen
```

### 4.3. City-select flow

```
city-select.tsx → api.get('/cities')
               → FlatList с typeahead + флаги + grouping по странам
               → onSelect → CityContext.setCity(city) + AsyncStorage
               → router.back() или router.replace('/(tabs)')
```

---

## 5. Frontend — Web-app (Vite + React)

### 5.1. Структура (Q1-релевантные)

```
/app/web-app/
├── src/
│   ├── main.tsx, App.tsx
│   ├── pages/
│   │   ├── public/
│   │   │   ├── SearchPage.tsx          # ⭐ Месяц 2 — список + карта
│   │   │   ├── LiveForecastMapPage.tsx
│   │   │   └── ...
│   │   ├── customer/
│   │   └── provider/
│   ├── components/
│   │   └── LiveMap.tsx                  # ⭐ react-leaflet map с СТО-маркерами
│   ├── services/
│   │   └── api.ts                       # axios (relative /api)
│   └── stores/                          # zustand
└── dist/                                # ← Vite build, serve через FastAPI
```

### 5.2. Связка карта ↔ список

`SearchPage.tsx`:
1. `useEffect` → `api.get('/marketplace/providers', {city, lat, lng})`.
2. Сохраняет результат в локальный state.
3. Список (`<ProviderCard />`) и карта (`<LiveMap providers={...} />`) рендерятся из одного источника.
4. Hover/click на маркере → выделяет карточку (общий `selectedId`).

---

## 6. Inventory — что куда смапилось из ТЗ

| Требование ТЗ (Месяц 1)                             | Реализация в коде                                    |
|-----------------------------------------------------|------------------------------------------------------|
| развернуть проект (архитектура, слои, модули)       | `app/{core, system, marketplace, ...}` — 40+ модулей |
| настроить базовую API-структуру                     | `FastAPI APIRouter`, prefix `/api`, 100+ endpoints   |
| реализовать авторизацию (login/register, токены)    | `app/system/auth.py` — JWT + bcrypt                  |
| реализовать роли (user/provider/admin)              | `customer / provider_owner / inspector / admin`      |
| настроить базовые middleware (auth, access control) | `prod_readiness`, `observability`, `verify_admin_token` |
| Frontend поднять (Next.js → Expo)                   | Expo SDK 54 + expo-router (file-based)               |
| базовая структура страниц                           | `app/{login, register, city-select, (tabs)}`         |
| формы авторизации                                   | `app/login.tsx`, `app/register.tsx`                  |
| подключить API                                      | `src/services/api.ts` (axios + interceptors)         |

| Требование ТЗ (Месяц 2)                          | Реализация в коде                                       |
|--------------------------------------------------|---------------------------------------------------------|
| гео-структура (страна / город / координаты)      | `app/marketplace/cities.py::CITY_CATALOGUE`             |
| хранение координат для СТО                       | `db.organizations.location: {Point, [lng,lat]}` + `city`|
| поиск по радиусу                                 | `haversine()` + `/marketplace/providers?lat&lng&radius` |
| фильтрация по городу                             | `/marketplace/providers?city=berlin`                    |
| Frontend: выбор города                           | `app/frontend/app/city-select.tsx` + `CityContext`      |
| Frontend: базовая карта                          | `web-app/src/components/LiveMap.tsx` (react-leaflet)    |
| Frontend: список СТО                             | `web-app/src/pages/public/SearchPage.tsx`               |
| Frontend: связать карту и список                 | Общий store + sync `selectedId` + URL params            |

---

## 7. Что НЕ относится к Q1-Месяцам 1–2 (но уже сделано)

Эти модули в коде есть, но они вне области Q1-Месяцев 1–2 (это уже Q2+ или
параллельные треки):

- `app/inspector/` — кабинет инспектора
- `app/auto_requests/` — заявки клиентов на инспекцию
- `app/payments/`, `app/billing/` — Stripe + PayPal
- `app/orchestrator/`, `app/intelligence/` — авто-действия / ML
- `app/parsers/` — mobile.de / autoscout24 / kleinanzeigen
- `app/chat/`, `app/notifications/`, `app/reputation/`
- `app/runtime_ledger/`, `app/observatory/`

Они выполняют свои функции независимо. Q1-Месяцы 1–2 покрывают
**фундамент** (auth + гео + базовый маркетплейс), на котором всё остальное
выстроено.
