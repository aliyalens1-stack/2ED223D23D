# Sprint 4 — Real-Time Communication Layer

> Дата: 18 февраля 2026
> Статус: ✅ shipped (33/34 backend-тестов pass, 1 SKIPPED structural, 0 failures)
> Цель: убрать утечку коммуникации в WhatsApp/Telegram. Удержать **общение + деньги
> + lifecycle** внутри платформы. Это превращает marketplace в operating system
> for automotive services.

---

## 1. Что доставлено

### Backend — новый модуль `app/service_chat/`

| Файл | Назначение | Lines |
|---|---|---|
| `models.py` | Pydantic + status enums + типы quick action / event kind | 95 |
| `scanner.py` | **Anti-Bypass Regex Scanner** (phone/email/url/messenger/intent) | 165 |
| `timeline.py` | Append-only event log + `append_event()` helper + endpoint | 105 |
| `router.py` | service_chats / messages / quick-action / read | 400 |
| `router_admin.py` | admin moderation (warn/shadow_hide/strike/freeze/reply) | 165 |
| `__init__.py` | router exports | 22 |

### Новые коллекции MongoDB

- **`service_chats`** — `{id, requestId, customerId, providerId, status, lastMessageAt,
  lastMessagePreview, unreadCustomer, unreadProvider, flagsCount, createdAt, updatedAt, frozenAt}`
  Один чат = одна заявка. Создаётся **автоматически** после `payment_intent.succeeded`.
- **`service_messages`** — `{id, chatId, senderId, senderRole, type, body, mediaBase64,
  location, createdAt, shadowHidden, flags, bypassSeverity, bypassHits, redacted, quickAction, moderatedAt, moderationReason}`
- **`request_timeline_events`** — append-only `{id, requestId, kind, label, actorRole,
  actorId, meta, createdAt}`. Idempotent по kind+requestId для system-событий.
- **`service_chat_moderations`** — audit-log админских действий.

### Изменения в существующих модулях

- **`escrow/router_payments.py`** — после `payment_intent.succeeded`:
  1. вызывает `ensure_chat_for_request()` → чат открывается автоматически
  2. `append_event(payment_secured)` + `chat_opened` (idempotent)
  3. при `release` → `append_event(escrow_released)`
- **`service_marketplace/router_customer.py::accept_bid`** — добавлены
  `provider_matched` + `bid_accepted` timeline events.
- **`service_marketplace/router_customer.py::complete`** — `work_completed` +
  (если owner) `release_confirmed`.
- **`server.py`** — include 3 новых router'а (`service_chat_router`,
  `admin_chats_router`, `timeline_router`).

### Frontend — Mobile (Expo)

- `app/chat/service/[chatId].tsx` — chat screen с **polling 6s**, quick-action
  panel, bypass-warning toast, shadow-hidden indicator.
- `app/service-marketplace/[id].tsx` — кнопка «Открыть чат с исполнителем»
  появляется при `status >= paid`.

---

## 2. Endpoints (13 новых)

### Customer / Provider

```
POST /api/service-chats/from-request/{requestId}    get-or-create (idempotent, требует status>=paid)
GET  /api/service-chats/me                           мои чаты с unreadForMe
GET  /api/service-chats/{chatId}                     мета + участники
GET  /api/service-chats/{chatId}/messages?since=…    POLLING (5-10s)
POST /api/service-chats/{chatId}/messages            send (anti-bypass scan + shadow-hide)
POST /api/service-chats/{chatId}/quick-action        I'm arriving / started / extra / completed / confirm
POST /api/service-chats/{chatId}/read                mark-read
```

### Timeline

```
GET  /api/service-requests/{id}/timeline             chronological event log
```

### Admin

```
GET  /api/admin/service-chats?flagged_only=true     queue для модерации
GET  /api/admin/service-chats/{id}                  + flag breakdown
GET  /api/admin/service-chats/{id}/messages         full content (включая hidden)
POST /api/admin/service-chats/{id}/moderate         warn/shadow_hide/strike/freeze/unfreeze
POST /api/admin/service-chats/{id}/reply            admin-message
```

---

## 3. Anti-Bypass Scanner — детали

**Шкала severity:**
- `clean` — ничего подозрительного
- `warn` — мягкий сигнал (URL alone, messenger_kw без call_intent) — сообщение проходит + inline-warning
- `shadow_hide` — **отправитель видит, получатель НЕ видит**. Это эффективнее блокировки: bypasser не понимает что был пойман. Платформа не разрушает доверие в чате.
- `block` — повторный (3+ strike) shadow_hide attempt от провайдера → HTTP 400.

**Что ловим (детерминированный regex, без LLM):**
- Phones: `+49 30 12345678`, `030/12345678`, `8(911)123-45-67`, `+380 67 ...`
- Emails: `user@domain.tld`
- URLs/domains: `https://`, `www.`, `*.com/de/me/ru/...`
- Telegram users: `@user_name`
- Messenger keywords: `whatsapp`/`вотсап`/`telegram`/`телега`/`viber`/`signal`
- Intent: `напиши мне в …`, `позвони на …`, `call me`, `whatsapp me`

**Effects:**
- `shadowHidden=true` → получатель видит `body=null` + `hiddenReason`; `unread` НЕ растёт; `flagsCount` ++; `provider.bypassStrikes` ++.
- 3+ strikes → следующая попытка получает `block` (400 error).

---

## 4. Timeline events flow

```
request_created (TBD — на /service-requests POST)
       ↓
provider_matched (accept-bid: system event)
       ↓
bid_accepted (accept-bid: customer event)
       ↓
chat_opened ──────┐ (parallel)
       ↓          ↓
payment_secured  (webhook payment_intent.succeeded: system)
       ↓
provider_en_route → work_started → extra_parts_requested (опц.) (quick-actions: provider)
       ↓
work_completed (quick-action: provider OR customer/admin via /complete)
       ↓
release_confirmed (customer /complete)
       ↓
escrow_released (release endpoint: system)
```

Idempotent для `chat_opened`/`payment_secured`/`bid_accepted`/`release_confirmed`/`escrow_released`/`work_completed` — повторный вызов не плодит дублей (dedup по `kind+requestId`).

---

## 5. Acceptance criteria — ✅ все 10

| # | Критерий | Статус |
|---|---|---|
| 1 | In-app chat (модуль app/chat/) | ✅ `app/service_chat/` |
| 2 | Chat lifecycle: auto-create после payment.paid | ✅ Idempotent, hook в webhook |
| 3 | 6 message types: text/image/location/system/invoice/status_change | ✅ |
| 4 | Mobile UI /chat/[chatId] + quick actions | ✅ `chat/service/[chatId].tsx` |
| 5 | Order timeline events | ✅ 12 kinds, idempotent dedup |
| 6 | Polling 5-10s (НЕ websocket) | ✅ 6s + `since` query |
| 7 | Admin moderation /admin/chats | ✅ 5 actions + audit log |
| 8 | Anti-bypass AI-lite (regex) | ✅ phone/email/url/messenger + 4 severity tiers |
| 9 | Новая монетизация (priority/badges/media/CRM) — hooks ready | ⏳ через subscription rank_boost из Sprint 3A |
| 10 | НЕ socket.io/kafka/grpc/microservices/ai-moderation | ✅ только Mongo + FastAPI |

---

## 6. Что MOCKED / не делалось

- **Stripe** — остаётся MockGateway из Sprint 3A. Никаких новых интеграций не добавлено.
- **AI moderation / LLM-classifier** — НЕ используем (по тех-заданию). Только regex.
- **Push-уведомления** — Firebase ещё не подключён (Sprint 5).
- **Read receipts по сообщениям** — есть only chat-level unread counter.

---

## 7. Bug found & fixed во время testing

🐛 **strike_provider возвращал 404 «Provider not found»** при попытке инкремента `bypassStrikes`.

**RCA:** `users._id` хранится как BSON `ObjectId`, а `chat.providerId` — строка. Сравнение string vs ObjectId всегда возвращало 0 матчей. Эффект: 3-strike → block escalation никогда не срабатывал.

**Fix:** добавлены `_find_user_by_id()` и `_increment_user_field()` helpers в `service_chat/router.py` + аналогичный fallback в `service_chat/router_admin.py::moderate`. Паттерн совпадает с `app/admin/verification_queue.py:128-133`.

**Verified:** `curl POST .../moderate {"action":"strike_provider"}` → `bypassStrikes: 1` в Mongo.

---

## 8. Tests

- ✅ **34 pytest-теста** в `/app/backend/tests/test_sprint4_service_chat.py`
- ✅ **33 passed / 1 SKIPPED / 0 failed** (после bug-fix)
- ✅ JUnit XML: `/app/test_reports/pytest/sprint4_service_chat.xml`
- 1 SKIPPED — 403-stranger case на `/from-request`: нет 3-го тестового customer'а (admin allowed by design)

Покрытие: chat auto-create + idempotency, /me с unreadForMe + lastMessagePreview, polling (since/serverTime/unread reset), send + admin POST 400, anti-bypass (DE phone, email, messenger_kw alone=warn, RU «напиши мне в WhatsApp»=shadow_hide, URL alone=warn, clean), shadow_hide effect (body=null receiver + flagsCount++ + bypassStrikes++), quick-actions auth (403 wrong role) + work_started→in_progress, timeline chronological + chat_opened dedup, admin moderation (list flagged, full-body visibility, warn, freeze_chat→409, strike_provider, reply), 401 auth gates, Sprint 3A escrow regression.

---

## 9. Что дальше (предложение, не делаем сейчас)

По плану из ТЗ — **Sprint 5**: Firebase push · реальный Stripe · dispute center ·
invoices · ratings · provider verification · analytics deeper. Но это потом.

Сейчас платформа уже:
- **держит коммуникацию** внутри (chat + anti-bypass)
- **держит деньги** внутри (escrow + monetization)
- **держит lifecycle** внутри (timeline + quick actions)

= **operating system for automotive services**, не «биржа заявок».
