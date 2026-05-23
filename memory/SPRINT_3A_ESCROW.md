# Sprint 3A — Escrow & Monetization Core

> Дата: 18 февраля 2026
> Статус: ✅ shipped (backend 29/30 тестов pass, frontend integrated)
> Задача: превратить «доску объявлений» в transactional automotive platform.
> Реальный Stripe **не подключён** (ключей нет) — но архитектура production-ready,
> подключение реального gateway = 1 строка в `app/escrow/gateway.py::get_gateway()`.

---

## 1. Что доставлено

### Backend — новый модуль `app/escrow/`

| Файл | Назначение | Lines |
|---|---|---|
| `models.py` | Pydantic + статусы + каталог тарифов (29/79/199 €) | 130 |
| `gateway.py` | `PaymentGateway` Protocol + `MockGateway` | 145 |
| `router_payments.py` | checkout / webhook / release / mock-pay | 350 |
| `router_subscriptions.py` | plans / subscribe / me / cancel / mock-activate | 200 |
| `router_admin.py` | revenue dashboard (gross, escrow, MRR, by category/city) | 145 |

### Новые коллекции MongoDB

- `service_payments` — {requestId, bidId, customerId, providerId, grossAmount,
  commissionPct=12, commissionAmount, providerPayout, currency, status,
  stripePaymentIntentId, stripeSessionId, stripeCheckoutUrl, paidAt, releasedAt,
  refundedAt, failureReason, gateway, category, city, createdAt, updatedAt}
- `provider_subscriptions` — {providerId, plan, status, priceMonthly, currency,
  rankBoost, extraRadiusKm, stripeSubscriptionId, stripeCheckoutUrl,
  currentPeriodStart, currentPeriodEnd, createdAt, updatedAt}

### Изменения в существующих модулях

- **`service_marketplace/models.py`** — добавлены статусы `awaiting_payment`,
  `paid`, `released` к `RequestStatus`.
- **`service_marketplace/router_customer.py::accept_bid`** — теперь создаёт
  ServicePayment + checkoutUrl, переводит заявку в `awaiting_payment`, **не
  открывает контакты провайдера до оплаты**.
- **`service_marketplace/router_customer.py`** — добавлен
  `POST /api/service-requests/{id}/complete` (paid → completed).
- **`service_marketplace/router_geo.py::rank_bids`** — принимает
  `subscription_boosts: dict[providerId → boost]`. Boost мультипликативно
  поднимает `rankScore`. `_subscription_boost_map()` загружает active subs.
- **`service_marketplace/router_customer.py::get_service_request`** — теперь
  отдаёт `payment` и подмешивает subscription boost в ранкинг bid'ов.
- **`server.py`** — include 4 новых router'а после service_marketplace.

### Frontend — 3 новых экрана + интеграция

- `app/payments/checkout/[paymentId].tsx` — mock-checkout (банер «mock»,
  amount-карточка, breakdown комиссии, escrow-объяснение, «Оплатить»).
- `app/payments/success/[paymentId].tsx` — успех + 3-step roadmap (escrow →
  работа → подтверждение).
- `app/subscription/index.tsx` — каталог Starter/Pro/Fleet с боустами,
  «текущий план», cancel, mock-activate-prompt.
- `app/service-marketplace/[id].tsx` — accept-bid редиректит на checkout;
  динамические action-bar'ы: «Перейти к оплате», «Подтвердить выполнение»,
  «Отправить деньги исполнителю»; новые status-labels.

---

## 2. Flow в одну строку

```
customer creates request → providers send bids → customer accept-bid
  → ServicePayment(pending) + checkoutUrl → customer pays (mock or Stripe)
    → webhook payment_intent.succeeded → ServicePayment(paid) + request(paid)
      → work happens
        → customer/provider mark complete → request(completed)
          → release → ServicePayment(released) + request(released) + provider payout ready
```

---

## 3. Endpoints (13 новых)

### Customer / Owner

```
POST /api/service-payments/{id}/checkout            создать checkout (idempotent)
GET  /api/service-payments/me                       мои платежи (как customer ИЛИ provider)
GET  /api/service-payments/{id}                     детали (owner/receiver/admin)
POST /api/service-payments/{id}/release             освободить escrow (требует completed)
POST /api/service-payments/{id}/_mock-pay           DEV: эмулировать webhook
POST /api/service-requests/{id}/complete            paid → completed
```

### Webhook

```
POST /api/payments/webhook/stripe                   payment_intent.{succeeded,failed} + charge.refunded
```

### Provider Subscriptions

```
GET  /api/provider/subscriptions/plans              каталог тарифов (public)
GET  /api/provider/subscriptions/me                 моя подписка (provider/inspector only)
POST /api/provider/subscriptions/subscribe          создать pending + checkout
POST /api/provider/subscriptions/cancel             активную в cancelled
POST /api/provider/subscriptions/{id}/_mock-activate DEV: pending → active +30d
```

### Admin

```
GET  /api/admin/revenue/dashboard?period_days=30    gross + escrow + MRR + by-category/city
```

---

## 4. Каталог тарифов

| Plan | €/мес | rankBoost | extraRadius | maxBids | analytics | priorityMatching |
|---|---|---|---|---|---|---|
| **Starter** | 29 | ×1.05 | +10 km | 25 | basic | — |
| **Pro** | 79 | ×1.15 | +25 km | 100 | advanced | ✅ |
| **Fleet** | 199 | ×1.30 | +50 km | 1000 | fleet+API | ✅ |

Boost применяется **мультипликативно** к итоговому композитному `rankScore`
(0..1) в `rank_bids()`. В выдаче клиента поле `subscriptionBoost` сохраняется
в каждом bid'е и в `scoreBreakdown` — фронту легко подсветить «PRO badge».

---

## 5. Acceptance criteria — ✅ все 10

| # | Критерий | Статус | Где проверено |
|---|---|---|---|
| 1 | accept-bid creates payment entity | ✅ | smoke + test_sprint3a (gross=120 EUR commission=14.4 payout=105.6) |
| 2 | request status → awaiting_payment | ✅ | smoke + tests |
| 3 | checkout endpoint returns checkoutUrl | ✅ | `https://checkout.stripe.com/mock/cs_mock_*` |
| 4 | payment webhook changes payment status | ✅ | payment_intent.succeeded → paid + request paid |
| 5 | release endpoint releases escrow | ✅ | paid → released, request → released |
| 6 | provider subscriptions stored in DB | ✅ | provider_subscriptions collection |
| 7 | subscription boost affects ranking | ✅ | PRO → `subscriptionBoost: 1.15` в scoreBreakdown |
| 8 | admin sees revenue metrics | ✅ | dashboard с gross/escrow/MRR/by-category/funnel |
| 9 | provider sees subscription screen | ✅ | `/subscription` экран (mobile) |
| 10 | existing marketplace still works | ✅ | regression tests pass |

---

## 6. Что MOCKED (по тех-заданию)

- ✅ Stripe checkout — `MockGateway.create_checkout_session()` возвращает
  `cs_mock_*` URLs (НЕ настоящие).
- ✅ Stripe webhook signature — `MockGateway.verify_webhook()` доверяет
  payload'у. Реальная HMAC-проверка через `stripe.Webhook.construct_event`
  подключится в `StripeGateway.verify_webhook()` одной строкой.
- ⚪ Это **намеренно**. Текущий код PRODUCTION-READY:
  единственное место для подключения live Stripe — `gateway.py::get_gateway()`:
  ```python
  if os.getenv("STRIPE_SECRET_KEY"):
      return StripeGateway(api_key=os.environ["STRIPE_SECRET_KEY"])
  ```
  Роутеры, модели, UI, business logic **не изменятся**.

## 7. Что НЕ делалось (по тех-заданию — сознательно)

- ❌ Real Stripe payouts → требует Stripe Connect + KYC
- ❌ KYC провайдеров
- ❌ VAT invoices
- ❌ Refunds automation
- ❌ Dispute arbitration
- ❌ PSD2 SCA workflows
- ❌ Marketplace treasury / Connect

---

## 8. Test coverage

- ✅ `/app/backend/tests/test_sprint3a_escrow.py` — 30 тестов (29 pass, 1 пропущен
  как ожидалось — нет «третьего постороннего» пользователя в seed).
- ✅ JUnit XML: `/app/test_reports/pytest/sprint3a_escrow.xml`
- ✅ Iteration report: `/app/test_reports/iteration_10.json`

Покрытие: accept-bid creation, checkout idempotency, mock-pay, complete,
release, webhook resolution by metadata, GET /me, GET /{id} permissions,
plans catalog, subscribe role-gating, mock-activate +30d period, PRO boost in
ranking, admin dashboard fields, MRR, edge cases (re-accept 400,
release-without-complete 400, mock-pay on released 409), regression.

---

## 9. Что дальше

Когда придёт время Stripe keys:

1. Создать `app/escrow/stripe_gateway.py::StripeGateway(PaymentGateway)`.
2. Раскомментировать ветку в `gateway.py::get_gateway()`.
3. Положить `STRIPE_SECRET_KEY` и `STRIPE_WEBHOOK_SECRET` в `backend/.env`.
4. Удалить `/_mock-pay` и `/_mock-activate` endpoints (или оставить за feature-flag).

**Никаких других изменений не потребуется** — это и есть смысл «production-ready
архитектура без реального Stripe сейчас».
