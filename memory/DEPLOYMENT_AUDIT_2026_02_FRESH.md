# Auto Search Platform — Deployment Audit (Fresh Sync)
**Date:** 2026-02 · **Source:** `github.com/aliyalens1-stack/e22323e2e2e` · **Container:** `/app`

---

## 1. Deployment — DONE ✅

Repo fully synced to `/app` (preserved `.git`, `.emergent`, `backend/.env`, `frontend/.env`). All 4 surfaces live.

### Steps
1. Cloned repo to `/tmp/repo_audit` (~14k files, 97 MB)
2. Backed up & preserved framework env vars (`MONGO_URL`, `EXPO_PACKAGER_*`, `EXPO_PUBLIC_BACKEND_URL`)
3. `rsync` to `/app` (excluding `.git`, `.emergent`, `node_modules`, caches)
4. `pip install -r backend/requirements.txt` → 136 packages OK
5. `yarn install` in `frontend/`, `web-app/`, `admin/`
6. `yarn build` web-app → `web-app/dist/` (13 chunks, 12.0s)
7. `yarn build` admin → `admin/dist/` (17 chunks, 10.5s)
8. `supervisorctl restart backend expo`

### Live status
| Service | Port | Status |
|---|---|---|
| backend (uvicorn FastAPI) | 8001 | ✅ RUNNING |
| expo (metro+tunnel) | 3000 | ✅ RUNNING (tunnel ready) |
| mongodb | 27017 | ✅ RUNNING |
| nginx-code-proxy | 80 | ✅ RUNNING |
| redis | 6379 | ⚠️ DOWN → NO-OP fallback (non-blocking) |

### Smoke tests (all ✅)
```
GET  /api/health                       → {status:ok, db:connected, nestjs:disabled}
POST /api/auth/login admin             → 200 + JWT
POST /api/auth/login customer          → 200 + JWT
POST /api/auth/login provider          → 200 + JWT
GET  /api/cities                       → 25 cities (Berlin, Hamburg, …)
GET  /api/web-app/                     → 200 (Vite SPA)
GET  /api/admin-panel/                 → 200 (Vite SPA)
GET  /                                 → 200 (Expo web bundle, title="frontend")
OpenAPI endpoint count                 → 571
```

Preview URL (`https://mobile-expo-app-2.preview.emergentagent.com`) — все маршруты HTTP 200, мобильный лендинг рендерится: "Don't buy a car blind" + CTA "Find & inspect a car" / "Become an inspector", тёмная тема, EN.

---

## 2. Architecture — 4 surfaces

```
/app
├── backend/      FastAPI 0.110 + Motor + MongoDB · 571 endpoints, ~90 sub-routers
├── frontend/     Expo SDK 54.0.34 + RN 0.81.5 + React 19 + expo-router · 106 screens
├── web-app/      Vite + React 18 + Leaflet → /api/web-app/
├── admin/        Vite + React 18 + Radix + Recharts → /api/admin-panel/
├── shared/       TS domain contracts (state machines, validators, lexicon)
├── memory/       ~90 MD docs: doctrine, sprint logs, audits, phase plans
├── audit/        prior architecture audits
└── tests/        chaos e2e + targeted scripts
```

Routing (Kubernetes ingress → uvicorn `/api/*` mount points):
- `/api/*` (кроме web-app/admin-panel) → FastAPI handlers
- `/api/web-app/` → static Vite SPA (`web-app/dist`)
- `/api/admin-panel/` → static Vite SPA (`admin/dist`)
- `/` → Expo metro web bundle (port 3000 via packager proxy)

---

## 3. Backend audit

- **571 endpoints** in `/openapi.json`, ~90 `include_router` in `server.py` (single 117 KB file)
- 4 user roles: `admin` / `customer` / `provider_owner` / `inspector` (JWT HS256, TTL 7d, bcrypt)
- Middleware chain: CORS → rate-limit + Idempotency → observability → unified error envelope
- Seed-on-boot: 3 demo accounts, 25 cities, 11 СТО + 56 reviews + 20 bookings + 10 quotes, 8 service categories + 12 services, 4 demand zones, 30 audit logs, 5 feature flags
- Background workers: `provider_ranking_optimizer_loop`, `orchestrator_cycle` (~60s), `feedback_processor`, `vehicle_refresh_loop`
- Domain modules under `backend/app/`: admin, assignments, auto_requests, billing, car_selection, chat, customer, geo, growth, inspection, intelligence, marketplace, matching_v2, media, ml, notifications, observatory, offer_packages, ops_map, orchestrator, packages, parsers, payments, performance, pricing, provider, push, referrals, reports, reputation, retention, revenue, runtime_ledger, system, two_factor, vehicles, workers
- Endpoint buckets (approx): admin 119 · provider 56 · inspector 47 · customer 32 · marketplace 23 · payments 15 · chat 15 · inspections 14 · auth 12

### Test credentials (`/app/memory/test_credentials.md`)
```
admin@autoservice.com    Admin123!     admin
customer@test.com        Customer123!  customer
provider@test.com        Provider123!  provider_owner
```

---

## 4. Mobile (Expo SDK 54)

- 106 screens in `frontend/app/` (expo-router file-based)
- Route groups: `(tabs)`, `customer/`, `provider/`, `inspector/`, `admin/`, `auto-request/`, `booking/`, `inspection-report/`, `vehicles/`, `quote/`, `chat/`, `notifications/`, `payment/`, `profile/`, `packages/`, `delivery/`, `repair/`, `selection/`, `zones/`, `organization/`, `operator/`, `request/`, `review/`, `dashboard/`, `car-selection/`, `invite/`
- Stack: Expo 54.0.34, RN 0.81.5, React 19.1.0, expo-router 6.0.22 (typedRoutes), @gorhom/bottom-sheet 5.2.9, reanimated 4.1.1, i18next, zustand, axios
- Permissions in `app.json`: camera, location, image-picker, localization
- Web bundle renders (verified via screenshot at preview URL)

---

## 5. Web-app (Vite)

- React 18 + react-leaflet + react-router-dom + socket.io-client + i18next + Tailwind
- 13 chunks (5 domain + 8 vendor); largest: `vendor-react` 300 KB, `web-public` 239 KB, `vendor-leaflet` 154 KB
- Lazy domains: `web-public`, `web-customer`, `web-provider`, `web-inspector`, `web-auth`, `Chat`

---

## 6. Admin panel (Vite + Radix)

- ~30 страниц, полный Radix UI (~25 компонентов), recharts 2.10.3, react-hook-form + zod, sonner, cmdk, date-fns, embla-carousel
- 17 chunks; largest: `admin-ops` 482 KB · `vendor-charts` 338 KB · `vendor-misc` 148 KB

---

## 7. Integrations matrix

| Integration | Status |
|---|---|
| Stripe / PayPal | **MOCKED** (no keys provisioned) |
| Firebase Push | **MOCKED** |
| mobile.de / autoscout24 / kleinanzeigen parsers | demo fallback |
| Google Maps / OAuth | not configured |
| Postmark bounce webhook | code path active, no key |
| Redis (state ops) | **DOWN** → NO-OP fallback |

---

## 8. Known gaps / risks

1. **Redis is DOWN** — non-blocking but background state ops degrade to NO-OP; rate-limit & idempotency are weakened.
2. **All commercial integrations MOCKED** (Stripe / PayPal / Firebase / Postmark / Google) — no real keys present in env.
3. **`server.py` is monolithic** (117 KB) — refactor candidate but stable.
4. **Two parallel package managers** in each JS project (npm `package-lock.json` + yarn lockfile) — minor warning, recommend committing only yarn.lock.
5. **Repo carries 7+ prior audit files at root** (`AUDIT_*.md`, `DEPLOY*_*.md`) — historical; not blocking.
6. **No `.env.example`** anywhere — onboarding friction.
7. **No CI/CD workflow files** under `.github/`.

---

## 9. Recommendations (priority-ranked)

| # | Priority | Item |
|---|---|---|
| 1 | HIGH | Start Redis (`redis-server`) or wire to a managed instance to restore rate-limit + idempotency guarantees |
| 2 | HIGH | Provision real keys for Stripe, Postmark, Firebase before any production demo |
| 3 | MED  | Add `.env.example` for `backend/` and `frontend/` |
| 4 | MED  | Split `backend/server.py` into routers per domain (~90 routers already exist as Python modules) |
| 5 | LOW  | Remove `package-lock.json` files (yarn is the canonical PM) |
| 6 | LOW  | Add GitHub Actions: lint + pytest + expo prebuild dry-run |
| 7 | LOW  | Collapse legacy audit MD files under `audit/` subfolder |

---

## 10. Next-step menu (awaiting user input)

Please pick what to do next:
- **A.** Fix HIGH-priority gap: enable Redis & wire real integration keys
- **B.** Refactor `server.py` into domain routers (mechanical, low-risk)
- **C.** Build a new feature on top of the existing platform (specify)
- **D.** Run the full `testing_agent_v3_expo` regression sweep across the 571 endpoints + Expo flows
- **E.** Something else — tell me
