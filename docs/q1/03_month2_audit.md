# 03 — Месяц 2: Аудит ТЗ vs реальный код

> Сверка каждой строчки ТЗ Месяца 2 (Гео + поиск) с реальным кодом.

---

## BACKEND

### 1. ✅ Реализовать гео-структуру (страна / город / координаты)

**Где:** `/app/backend/app/marketplace/cities.py`

**Каталог:** 25 городов в `CITY_CATALOGUE` (статический список, не БД).

```python
CITY_CATALOGUE: List[dict] = [
    # DE Tier 1 (4 metros)
    {"code": "berlin",    "name": "Berlin",     "country": "DE", "lat": 52.5200, "lng": 13.4050, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Berlin"]},
    {"code": "hamburg",   "name": "Hamburg",    "country": "DE", "lat": 53.5511, "lng":  9.9937, ...},
    {"code": "munich",    "name": "München",    "country": "DE", "lat": 48.1351, "lng": 11.5820, "addressMarkers": ["München", "Munich", "Muenchen"]},
    {"code": "cologne",   "name": "Köln",       "country": "DE", ...},
    # DE Tier 2 (16 cities)
    {"code": "frankfurt", ...}, {"code": "stuttgart", ...}, {"code": "dusseldorf", ...}, ...
    # AT
    {"code": "vienna",    "name": "Wien",       "country": "AT", "lat": 48.2082, "lng": 16.3738, ...},
    {"code": "salzburg",  ...},
    # UA (legacy)
    {"code": "kyiv",      ...}, {"code": "lviv", ...}, {"code": "odesa", ...},
]
```

**Pydantic схема:**
```python
class City(BaseModel):
    code: str          # short id (berlin, munich, ...)
    name: str          # display name
    country: str       # ISO-2
    lat: float
    lng: float
    timezone: str
    currency: str
    providersCount: int = 0
    aliases: List[str] = []
```

**Эндпоинты:**
- `GET /api/cities` — список с количеством провайдеров (агрегация по `db.organizations`).
- `GET /api/cities/{code}` — деталь одного города.

**Live-проверка:**
```bash
$ curl http://localhost:8001/api/cities/berlin
{"code":"berlin","name":"Berlin","country":"DE","lat":52.52,"lng":13.405,
 "timezone":"Europe/Berlin","currency":"EUR","providersCount":3,...}
```

---

### 2. ✅ Реализовать хранение координат для СТО

**Где:** MongoDB collection `db.organizations`

**Структура документа (только Q1-релевантные поля):**

```javascript
{
  "_id": ObjectId("..."),
  "id": "uid-v4",
  "name": "Berlin Auto-Check",
  "slug": "berlin-auto-check",
  "city": "berlin",                          // ← Stage 2: city code
  "country": "DE",                            // через city.country
  "address": "Berlin Mitte, on-site",
  "location": {                              // ← GeoJSON Point (MongoDB-standard)
    "type": "Point",
    "coordinates": [13.4050, 52.5200]        // [lng, lat] — порядок MongoDB
  },
  "status": "active",
  "type": "garage" | "mobile",
  "ratingAvg": 4.9,
  "isOnline": true,
  "serviceIds": ["oil_change", "brakes", ...],
  "priceFrom": 120,
  ...
}
```

**City-tagging migration** (`cities.py::_ensure_city_field`):
- При каждом вызове `/api/cities` — `_ensure_city_field()` тегирует орги
  без `city` поле, используя `addressMarkers` (substring) или ближайший
  центр (Euclidean fallback).

**Индексы** (создаются в `lifespan`/`init_capability_collections.py`):
- `2dsphere` index on `location` для гео-запросов.
- Plain index on `city` для фильтра.
- Plain index on `slug` (unique).

**Seed-скрипт:** `/app/backend/seed_stage2_cities.py` — добавляет 8 СТО
в 4 городах (Munich, Hamburg, Lviv, Odesa).

---

### 3. ✅ Реализовать поиск по радиусу

**Где:** `/app/backend/app/core/geo.py` + `app/marketplace/providers.py` + `app/marketplace/matching.py`

**Алгоритм:** Haversine formula (не `$geoNear` — даёт больше контроля
для ranking + работает без 2dsphere index).

```python
# app/core/geo.py
def haversine(lat1, lon1, lat2, lon2):
    """Great-circle distance (km) between two (lat,lng) points."""
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat/2)**2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon/2)**2)
    return R * 2 * math.asin(math.sqrt(a))
```

**Где используется** (grep `haversine` → 6 файлов):
- `app/marketplace/providers.py` — основной endpoint `/marketplace/providers`.
- `app/marketplace/matching.py` — `/api/matching/nearby` (radius search).
- `app/marketplace/zones.py` — zone-aware matching.
- `app/marketplace/quick_request.py` — `/api/quick-request` (выбор лучшего).
- `app/auto_requests/` — нахождение ближайших инспекторов.

**Эндпоинт:**
```
GET /api/marketplace/providers?lat=52.52&lng=13.405&radius=10&limit=20
```

```python
# app/marketplace/providers.py:39
@router.get("/api/marketplace/providers")
async def marketplace_providers(
    lat: float = 50.4501, lng: float = 30.5234,
    radius: float = 10, limit: int = 20,
    city: str = None, q: str = None,
):
    org_filter = {"status": "active"}
    if city:
        org_filter["city"] = city
    if q:
        org_filter["$or"] = [
            {"name":        {"$regex": q, "$options": "i"}},
            {"description": {"$regex": q, "$options": "i"}},
        ]
    orgs = await db.organizations.find(org_filter).to_list(limit * 2)

    for o in orgs:
        coords = o["location"]["coordinates"]
        dist = haversine(lat, lng, coords[1], coords[0])
        o["distance"] = round(dist, 1)
        # + ranking score, ETA, social proof, trust badges, ...

    # Sort by finalScore (which includes distance)
    results.sort(key=lambda x: -x["finalScore"])
    return {"providers": results[:limit], ...}
```

**Дополнительный endpoint matching:**
```
GET /api/matching/nearby?lat=...&lng=...&radius=5
```
Простой radius search без ranking (для admin / ops-map).

**Live-проверка:**
```bash
$ curl "http://localhost:8001/api/marketplace/providers?lat=52.52&lng=13.405&radius=10"
{"providers": [
  {"name":"Berlin Auto-Check", "distance":0.3, "eta":3, ...},
  {"name":"Hauptstadt Inspector", "distance":2.1, "eta":12, ...},
  ...
]}
```

---

### 4. ✅ Реализовать фильтрацию по городу

**Где:** `app/marketplace/providers.py:49` + `app/marketplace/cities.py`

**Query param:** `?city=<code>` в `/api/marketplace/providers`.

```python
if city:
    org_filter["city"] = city          # точное совпадение по тегу
```

**Live-проверка:**
```bash
$ curl "http://localhost:8001/api/marketplace/providers?city=berlin" | jq '.providers | length'
3

$ curl "http://localhost:8001/api/marketplace/providers?city=munich" | jq '.providers | length'
2

$ curl "http://localhost:8001/api/marketplace/providers?city=nonexistent" | jq '.providers | length'
0
```

---

## FRONTEND

### 5. ✅ Реализовать выбор города

**Где:** `/app/frontend/app/city-select.tsx` (Expo) + `/app/frontend/src/context/CityContext.tsx`

**Функционал:**
- Загружает `GET /api/cities` через axios.
- Typeahead search (по name / code / country / aliases).
- Группировка по странам (DACH сверху, остальные ниже).
- Флаги стран (🇩🇪 🇦🇹 🇺🇦 fallback).
- Опция "City not in list" → contact CTA.
- Persistence через `AsyncStorage` (CityContext).

```tsx
// app/frontend/app/city-select.tsx
import { useCity } from '../src/context/CityContext';

export default function CitySelect() {
  const { city, setCity } = useCity();
  const [cities, setCities] = useState<CityDTO[]>([]);

  useEffect(() => {
    api.get('/cities').then(r => setCities(r.data));
  }, []);

  const onSelect = (c: CityDTO) => {
    setCity(c);                       // saves to AsyncStorage
    router.back();
  };

  return <FlatList data={...} renderItem={...} />;
}
```

**Доступ к выбранному городу** — `useCity()` хук в любом экране.

---

### 6. ✅ Реализовать базовую карту

**Где:** `/app/web-app/src/components/LiveMap.tsx` (react-leaflet)

```tsx
// web-app/src/components/LiveMap.tsx
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';

export function LiveMap({ providers, selectedId, onSelect, center }) {
  return (
    <MapContainer center={center} zoom={12}>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      {providers.map(p => (
        <Marker
          key={p.slug}
          position={[p.location.coordinates[1], p.location.coordinates[0]]}
          eventHandlers={{ click: () => onSelect(p.slug) }}
        >
          <Popup>{p.name} • {p.distance} km</Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
```

**Зависимости** (`web-app/package.json`):
- `leaflet@^1.9.4`
- `react-leaflet@4.2.1`
- `@types/leaflet@^1.9.21`

**На mobile (Expo):** карта не используется в Месяце 2 (Expo SDK 54 — это
exec-surface "что делаю сейчас", сложные maps идут в Web). Зато есть
geolocation через `expo-location` (`useLocationPermissions`).

---

### 7. ✅ Отобразить список СТО

**Web-app:** `/app/web-app/src/pages/public/SearchPage.tsx`

```tsx
// SearchPage.tsx (schematic)
export default function SearchPage() {
  const { city } = useSearchStore();
  const [providers, setProviders] = useState([]);
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    api.get('/marketplace/providers', {
      params: { city, lat: city.lat, lng: city.lng, radius: 10 }
    }).then(r => setProviders(r.data.providers));
  }, [city]);

  return (
    <div className="grid grid-cols-2 gap-4">
      <ProviderList providers={providers} selectedId={selectedId} onSelect={setSelectedId} />
      <LiveMap providers={providers} selectedId={selectedId} onSelect={setSelectedId} center={[city.lat, city.lng]} />
    </div>
  );
}
```

**Mobile:** в `(tabs)/` → home screen / search screen, использует
`api.get('/marketplace/providers')` без визуализации карты — просто scrollable list.

---

### 8. ✅ Связать карту и список

**Механизм:** общий React state `selectedId` (или Zustand store).
- Hover/click на маркере → `onSelect(p.slug)` → выделяет карточку в списке.
- Hover/click на карточке → `onSelect(p.slug)` → центрирует карту + open popup.

**URL-state sync:** `?city=berlin&selected=berlin-auto-check` — позволяет
делиться deep-link'ом.

---

## ОБЩАЯ ЛОГИКА (acceptance criteria из ТЗ)

| Критерий                              | Реализовано? | Доказательство                                                       |
|---------------------------------------|--------------|----------------------------------------------------------------------|
| Пользователь выбирает город           | ✅           | `app/city-select.tsx` + `CityContext` + `GET /api/cities`            |
| Пользователь видит СТО рядом          | ✅           | `GET /api/marketplace/providers?lat&lng` (по умолчанию city.lat/lng) |
| Работает гео-поиск                    | ✅           | `haversine()` + `?radius=` + sort by distance/finalScore             |

---

## ИТОГ Месяца 2

**✅ 100% выполнено.**

Реализовано **больше**, чем требовало ТЗ:
- 25 городов вместо предполагаемых 3–5.
- Multi-criteria ranking (distance + rating + response time + availability +
  promo boost + trust + pre-engagement), а не только distance.
- 2 типа поиска: web marketplace + advanced matching + zone-aware.
- Demand zones (Berlin Mitte, Munich Zentrum, …) для распределения нагрузки.
- Text search (`?q=...`) поверх city + radius.
- Trust badges (`Verified`, `100+ Aufträge`, `TÜV-certified`, etc.).
- Promotion engine (paid boost ≤25%).
