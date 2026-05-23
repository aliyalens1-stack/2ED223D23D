# PRD — A | Search Experts (Auto-Service / Pre-Purchase Car Inspection Marketplace)

> Источник истины верхнего уровня. Подробные sprint-постмортемы — в `/app/memory/` (131 шт.).
> Production runbook — `/app/PRODUCTION_READINESS.md`.

## Что это
Маркетплейс **предпокупочной инспекции автомобилей** (TÜV-style 60-point check) + сервис «найти и купить машину под бюджет». Транзакционная платформа с замкнутым economic loop:
```
marketplace → bids → escrow → work → chat → trust → arbitration → real Stripe payouts
                                              ↓
                              admin ops alerts · push-delivered UX
```

## Аудитория
- **Customer** — покупает инспекцию, выбирает машину
- **Inspector** — выполняет осмотры, получает заказы
- **Provider** (workshop) — оказывает услуги: repair, diagnostics, car wash
- **Admin** — операционная панель, диспуты, freeze, integrations

## Стек
- **Mobile/Web:** Expo SDK 54.0.34 (React Native 0.81.5, React 19, expo-router 6, Zustand 5, i18next EN/RU/DE, Reanimated 4)
- **Backend:** FastAPI 0.110, Python 3.11, Motor (Mongo), Pydantic v2, PyJWT, bcrypt, pyotp (2FA), stripe 15
- **DB:** MongoDB (local)
- **Cache:** Redis (опционально, fallback NO-OP)
- **Payments:** Stripe Connect Express (escrow + transfers + refunds + webhooks)
- **LLM/ML:** litellm, openai, google-genai, scikit-learn (DemandPredictor, StrategyOptimizer)

## Структура `/app`
- `backend/` — FastAPI, 53 домена, **700 endpoints**, 9 сидеров, 14 e2e/smoke тестов
- `frontend/` — Expo (mobile + web), 70+ маршрутов expo-router
- `admin/` — Vite + React + shadcn/radix-ui SPA (отдельно)
- `web-app/` — Vite + React + Leaflet (публичный сайт)
- `shared/` — `@platform/*` алиасы (типы, cognition_guardrails)
- `memory/` — 131 sprint-докумнт (Sprint 1–20 + Phase 0–9 closures)
- `audit/` — JSON reconciliation snapshots

## Ключевые домены (endpoints)
- `/api/admin` (196) — governance, ops alerts, integrations, freeze API
- `/api/provider` (98), `/api/inspector` (53), `/api/customer` (42)
- `/api/marketplace` (30), `/api/payments` (22), `/api/chat` (18)
- `/api/inspections` (14), `/api/car-selection` (14), `/api/auth` (13)
- `/api/orchestrator` (12) — demand/supply ML loop
- `/api/pricing` (10), `/api/vehicles` (9), `/api/zones` (9)

## Текущее состояние (2026-02-22 / репо обновлён 2026-05-22)
- ✅ Backend RUNNING, 700 endpoints, MongoDB connected
- ✅ Expo web RUNNING, preview UI рендерится
- ✅ Admin auth работает (seed `admin@autoservice.com / Admin123!`)
- ✅ Sprint 1–9 завершены (см. `PRODUCTION_READINESS.md`)
- ⚠️ Redis NO-OP (orchestrator/rate-limit/idempotency деградированы)
- ⏸ Admin SPA / Web-app SPA не собраны (`dist/` отсутствует)
- ⏸ Stripe в sandbox (`STRIPE_CONNECT_ENABLED=0`, sentinel ключ)

## Заморозки (не трогать)
- `pricing_v2b`, `notify_pref_1`, `Phase 5 i18n EN/RU/DE`, `revenue_semantics_layer`
- `payments_2a_pay_button`, `stripe_1_wired`, `reconciliation_audit_supervisor`

## Roadmap (по `PRODUCTION_READINESS.md`)
- Phase A (Sprint 1–9) — ✅ done
- Phase B — Pilot Users (10 providers, 100 jobs, 10 real disputes)
- Phase C — Liquidity tuning, response time, rematch heuristics

## Что НЕ делать
- ❌ AI dispatch / ML pricing (premature)
- ❌ Microservices / Kafka / event sourcing
- ❌ GraphQL / CQRS / blockchain
- ❌ Параллельные реализации поверх существующих доменов
