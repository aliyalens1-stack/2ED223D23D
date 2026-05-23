# Notifications Unification — Sprint 4 Cleanup

> Дата: 18 февраля 2026
> Проблема: пользователь обнаружил пустой «колокольчик» на экране Уведомления,
> хотя по факту в системе были 7 marketplace-уведомлений (отдельная коллекция).

## Проблема, которую решали

Аудит выявил **3 параллельные системы уведомлений**, не связанные между собой:

| Источник | Коллекция | Endpoint | Реально использовался |
|---|---|---|---|
| Canonical (bell) | `notifications` | `/api/notifications/since` | ✅ mobile колокольчик |
| Marketplace (Sprint 2) | `service_notifications` | `/api/service-notifications/me` | ❌ никем не дёргался |
| Car-selection | `car_selection_notifications` | `/api/car-selection/notifications/me` | ✅ другой domain — оставлен |

Эффект: provider создаёт заявку → matched-уведомления летят в `service_notifications` →
в bell-колокольчике провайдера **пусто**, потому что mobile читает из `notifications`.
Та же проблема была для всех событий Sprint 4 (chat message, escrow paid, payout).

## Что сделано

### 1. Единый emitter `app/notifications/emit.py`
- `emit_notification(...)` — single-row insert в canonical `notifications` коллекцию
- `emit_notifications_bulk(...)` — fanout (marketplace new_request, broadcasts)
- Защищён `try/except` — никогда не роняет основной flow
- Контракт совместим с `notifications.projector` (id/userId/kind/type/title/body/text/severity/metadata/isRead/createdAt/projectedAt/actionUrl)

### 2. Все 4 точки записи переключены на canonical
| Источник | Kind в bell |
|---|---|
| `service_marketplace/router_geo.py::fanout_new_request_notifications` | `service_request_new` |
| `service_chat/router.py::send_message` | `service_chat_message` |
| `service_chat/router.py::quick_action` | `service_request_status` |
| `escrow/router_payments.py::webhook payment_intent.succeeded` | `service_payment_secured` (customer) + `service_payment_received` (provider) |
| `escrow/router_payments.py::release_escrow` | `service_payout_ready` (provider) |

`actionUrl` указывает на конкретный экран в mobile (`/service-marketplace/{id}` или `/chat/service/{chatId}`).

### 3. Legacy aliases `/api/service-notifications/*`
- Оставлены для backward compatibility (старый mobile-клиент может дёргать)
- Теперь читают из canonical `notifications` с фильтром `kind: /^service_/`
- Mapping `isRead → read` + добавляют `_deprecated: "Use /api/notifications/since"` маркер в ответе
- Старая коллекция `service_notifications` больше **никем не пишется** (write-frozen)

### 4. Миграция данных
Перенесено **7 существующих** записей из `service_notifications` в `notifications` с сохранением `id`, статуса прочтения и метаданных. Marker `_migratedFrom: "service_notifications"` оставлен для аудита.

## Verification (live smoke на real flow)

**Provider bell сразу после миграции + create request:**
```
unread: 9
  - service_payment_received | 💰 Клиент оплатил
  - service_request_new       | 🔧 Новая заявка · Ремонт   (×7 мигрированных + 1 новый)
```

**Customer bell после оплаты:**
```
unread: 1
  - service_payment_secured   | ✅ Оплата прошла
```

**Legacy alias** `/api/service-notifications/me` всё ещё работает, возвращает те же данные с `_deprecated` маркером.

## Что mobile теперь видит

Пользователь открывает «Уведомления» → клиентский экран дёргает `/api/notifications/since` → получает все 5 типов событий: новая заявка (provider), новое сообщение, изменение статуса, оплата прошла/получена, payout ready. Каждое — с `actionUrl` для прямого deep-link.

## Не было сделано (намеренно)

- ❌ Удаление коллекции `service_notifications` — оставили для аудита (7 записей доступны через `_migratedFrom`)
- ❌ Удаление legacy endpoint `/api/service-notifications/*` — оставили как deprecated alias на случай если кто-то ещё их дёргает
- ❌ Перевод `car_selection_notifications` — это **другой domain** (car selection, не service marketplace). У него свой UX и свой колокольчик в car-selection-inbox.tsx. Если потребуется — это отдельная задача.

## Файлы изменены

```
backend/app/notifications/emit.py                       NEW · 110 строк
backend/app/service_marketplace/router_geo.py           — fanout + alias rewriting
backend/app/service_chat/router.py                      — send_message + quick_action emit
backend/app/escrow/router_payments.py                   — webhook + release emit
memory/CLEANUP_NOTIFICATIONS_UNIFICATION.md             NEW · этот документ
```

## Принцип на будущее

> **Single Source of Truth**: любое событие, которое должно появиться в bell-колокольчике,
> ОБЯЗАНО пройти через `app/notifications/emit.py`. Прямая запись в коллекцию `notifications`
> или другие domain-specific коллекции — запрещена для новых features.

Для inspector-domain canonical путь — через `app/inspector/timeline.py::append_event()` +
`notifications/projector.py::project_event()`. Для service-domain — через
`notifications/emit.py` напрямую (он проще — у service-domain нет COPY rules и
двух-фазного timeline events → projections).
