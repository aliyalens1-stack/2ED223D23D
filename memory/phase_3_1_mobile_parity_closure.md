# Phase 3.1 — Provider Mobile Parity (FULL closure)

## Goal (verbatim)
Provider on mobile sees the same operational and money perception as
provider on web, without mobile inventing its own statuses.

## Scope (соблюдено полностью)

✅ Mobile Provider Workbench screen
✅ Mobile Provider Earnings Clarity screen
✅ Reuse `GET /api/provider/work-items`
✅ Reuse `POST /api/provider/work-items/{id}/action`
✅ Reuse `GET /api/provider/earnings/items`
✅ Reuse `@platform/domain/contracts/provider-work-item`
✅ Reuse `@platform/domain/contracts/provider-earnings-item`
✅ No new backend / no new collections / no payout pipeline
✅ No AI / no orchestration / no permissions extraction
✅ No mobile-local status vocabulary

## Что было сделано в эту сессию

### 1. Bug fixes
- `app/provider/earnings-clarity.tsx`: добавлен отсутствовавший
  `import { useAuth } from '../../src/context/AuthContext'` —
  иначе экран крашился на cold mount.
- `app/_layout.tsx` (`CityOnboardingGate`): добавлены
  `/provider/workbench` и `/provider/earnings-clarity` в `passThrough`,
  чтобы гость не редиректился на `/city-select`.

### 2. Navigation entry points
- `app/(tabs)/index.tsx` (`InspectorHome`):
  - Earnings hero card → `TouchableOpacity`, ведёт на
    `/provider/earnings-clarity` (label «Где мои деньги →»).
  - Новая Workbench CTA-карточка над «Available jobs»,
    ведёт на `/provider/workbench`.

### 3. Demo seed (architectural — НЕ substrate)
Создан **idempotent** модуль `app/core/seed_provider_demo.py`
и подключён в конце `seed_data()`:

  - `provider@test.com` (org slug `avtomaster-pro`) получает
    7 demo bookings, 6 inspection_jobs (+reports), 1 quick_request
    с pending offer, 3 auction_charges.
  - Все docs префиксированы `demo-wb-*` / `demo-er-*` / `demo-qr-*` —
    upsert по id, легаси-данные не трогаются.
  - **Никаких новых коллекций.** Используются существующие
    `bookings / inspection_jobs / inspection_reports / payments /
    auction_charges / quick_requests / quick_request_offers`.
  - Doctrine: «change understanding, not substrate» — seed только
    создаёт truths, которые projector уже умеет читать.

## End-to-end verification

### Backend
GET /api/provider/work-items (provider@test.com):
- 14 items
- by state: needs_response=1, blocked=1, report_required=1,
  in_progress=2, on_site=1, en_route=1, awaiting_review=1,
  scheduled=2, completed=4
- by kind: inspection=6, booking=8

GET /api/provider/earnings/items:
- 7 items, summary EUR bucket
- pending: 2 (230 EUR), payable: 1 (120 EUR),
  disputed_hold: 1 (240 EUR), deducted: 3 (-24 EUR)
- processing/paid_out: 0 (Phase 3.3 reserved — projector never emits)

### Mobile UI (screenshots verified)
Mobile **Workbench** renders:
- KPI bar 1 / 4 / 1.
- needs_response group with QR offer 90 EUR · x1.20, countdown,
  primary «Принять» + secondary «Отклонить».
- blocked group with `blockedReason` panel + contact-CTA «Связаться с админом».
- in_progress group with primary actions «Завершить работу» / «Завершить осмотр».
- Per-card kind-pill (Сервис / Осмотр), customer name, distance.

Mobile **Earnings Clarity** renders:
- EUR per-currency card with 4 tiles (Удержано 240, К выплате 120,
  Ждём оплаты 230, Списано −24).
- Sections per state with row-level breakdown.
- Lead fees displayed as negative (red), with kind pill «Лид».
- Disputed item shows contact-CTA «Написать в поддержку».
- expectedSettlementBy («ожидается через 7 дн») on payable item.
- Currencies are NEVER summed.

### Contract parity
- `STATE_GROUPS`, `STATE_COLOR`, `SUMMARY_TILES`, `CONTACT_LABEL`
  on mobile match web character-for-character (different `style`
  decisions are surface-specific and allowed).
- `lead_fee → state='deducted'` (NEVER `paid_out`) preserved.
- `submit_report` for kind=`inspection` routes to mobile-native
  inspector report screen (web routes to web form). This is the
  only allowed surface-specific routing — semantics identical.

## Test credentials (preview)
- Admin: `admin@autoservice.com` / `Admin123!`
- Provider: `provider@test.com` / `Provider123!`
- Customer: `customer@test.com` / `Customer123!`

## Status
Phase 3.1 fully closed. UI/backend architecture is end-to-end
operable on demo data without any real keys (Stripe / PayPal /
external auth). Ready for next decision:
  - Payment 3.2,
  - Payment 3.3,
  - Provider permissions / account-switch cleanup.
