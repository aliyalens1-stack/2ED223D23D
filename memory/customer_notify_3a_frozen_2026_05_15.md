# Customer-Notify-3A — FROZEN (2026-05-15)

**Декларация:** push live; email/sms остаются dry-run-only.
Это deterministic transport execution, НЕ engagement system.

---

## 1. Spec (Roman, 2026-05-14 → 2026-05-15)

Notify-3 был размещён в roadmap'e только ПОСЛЕ закрытия Deep-Link-1. До
этого pipeline не был continuity-полон, и any send был бы premature.
Сейчас continuity-chain полная:

```
event → grammar projection → destination projection → audit row →
previewability → deterministic landing → transport send
```

5 принципов rollout'a:
1. **Flip one channel only** — push first (shortest lifecycle, no bounce,
   no carrier variability, no HTML, no SPF/DKIM/DMARC, no telecom edge-cases).
2. **DryRun must remain first-class** — НЕ replace, а coexist. Audit
   layer — forensic asset, не temporary mode.
3. **Provider adapters must stay dumb** — payload in → provider format
   out. Никакого выбора copy / locale / destination / urgency / prose.
4. **Delivery lifecycle as separate namespace** — НЕ смешивать с audit.
   Grammar = policy-controlled; delivery = operational.
5. **Quiet-hours / batching / digest / ranking / resend — НЕ сейчас.**
   Иначе accidental complexity explosion.

---

## 2. Что есть в коде на момент freeze

### 2.1. Channel-flip kill switch
`/app/backend/app/notifications/channel_state.py`:

```python
CHANNEL_STATE = {
    "push":  {"dryRun": True, "liveEnabled": True,  "provider": "expo"},
    "email": {"dryRun": True, "liveEnabled": False, "provider": None},
    "sms":   {"dryRun": True, "liveEnabled": False, "provider": None},
}
```

Hard policy — change requires a deploy. Не в env, не в БД, не overridable
at runtime. dryRun ВСЕГДА true (forensic asset).

### 2.2. Delivery lifecycle (separate namespace)
`/app/backend/app/notifications/delivery.py`:

- Collection: `notification_delivery_lifecycle` (отдельная от
  `notification_projection_audit`)
- Unique index: `(auditRowId, deviceToken)` — idempotent re-delivery
- `deliver_audit_row()` — single entry; gated by `is_live(channel)`
- Fields: `providerMessageId`, `providerStatus`, `providerError`,
  `projectedAt`, `sentAt`, `failedAt`, `deliveredAt` (последнее — для
  будущего receipt-poller'a)

### 2.3. Dumb provider adapter
`/app/backend/app/notifications/providers/expo_push.py`:

- HTTP POST к `https://exp.host/--/api/v2/push/send`
- Optional `EXPO_ACCESS_TOKEN` env (Enhanced Security)
- НЕТ retry, batching, copy selection, locale resolution
- Возвращает `{ok, providerMessageId, providerStatus, providerError}`

### 2.4. Audit → delivery hook (non-blocking)
`/app/backend/app/notifications/audit.py:191-202`:

```python
try:
    await db.notification_projection_audit.insert_one(doc)
    inserted += 1
    channels_produced.append(channel)
    try:
        from app.notifications.delivery import deliver_audit_row
        await deliver_audit_row(doc)
    except Exception as exc:
        logger.warning(f"cnotify delivery hook failed ...")
```

Audit row — authoritative. Delivery — soft-fail. Если provider упал,
audit row остаётся, lifecycle row не пишется, narrative не теряется.

### 2.5. Endpoints (полный contract)

| Endpoint                                          | Auth     | Purpose                                |
|---------------------------------------------------|----------|----------------------------------------|
| `GET  /api/admin/customer-notify/channel-state`   | admin    | Read kill-switch matrix                |
| `GET  /api/admin/customer-notify/lifecycle`       | admin    | List delivery rows (with filters)      |
| `GET  /api/admin/customer-notify/audit`           | admin    | List audit rows (grammar layer)        |
| `GET  /api/admin/customer-notify/meta`            | admin    | Surfaces, deepLinkMap, channelState    |
| `POST /api/admin/customer-notify/preview`         | admin    | Synthesize (kind, lang) without DB     |
| `POST /api/admin/customer-notify/project`         | admin    | Manual project one event (backfill)    |
| `POST /api/admin/customer-notify/test-send`       | admin    | Provider probe (no lifecycle written)  |
| `POST /api/customer/push-tokens/register`         | user     | Idempotent (userId,token) upsert       |

### 2.6. Index hooks
`/app/backend/app/core/lifespan.py:139-147` — startup вызывает
`ensure_lifecycle_indexes()` и `ensure_audit_indexes()`. Идемпотентно.

---

## 3. End-to-end verification (2026-05-15 10:39 UTC)

### Setup
```bash
# 1) Customer регистрирует push token
POST /api/customer/push-tokens/register
  body {token: "ExponentPushToken[customer-demo-aaa]", platform: "ios"}
  → {ok: true}
# token landed in mongo:push_device_tokens

# 2) Fake auto_request, linking job → customer
db.auto_requests.insertOne({
  id: "ar-notify3a-smoke",
  customerId: "<customer userId>",
  inspectionJobs:[{id:"job-notify3a-smoke"}],
})
```

### Trigger
```bash
POST /api/admin/customer-notify/project
  body {event:{id:"evt-notify3a-smoke-1", kind:"inspection.started",
               metadata:{jobId:"job-notify3a-smoke"}}}
  → {ok: true, inserted: 3, channels: [push,email,sms], lang: de}
```

### Outcome — grammar layer (audit)
3 строки в `notification_projection_audit`:
- `channel=push, dryRun=true, lang=de`
- `channel=email, dryRun=true, lang=de`
- `channel=sms, dryRun=true, lang=de`

### Outcome — delivery layer (lifecycle)
**1 строка** в `notification_delivery_lifecycle` (только push):
```json
{
  "channel": "push",
  "kind": "inspection.started",
  "provider": "expo",
  "providerStatus": "error",
  "sentAt": null,
  "failedAt": "2026-05-15T10:39:18.225175+00:00"
}
```

Email и SMS lifecycle row'ов **не получили** (их `is_live=False` →
`deliver_audit_row` short-circuited с `reason: dry_run_only`).

Provider вернул `error` потому что демо-токен `customer-demo-aaa`
неваляден — но это **expected**: транспорт работает, Expo HTTP
endpoint достижим, normalised failure заносится в lifecycle correctly.

---

## 4. Что НЕ входит в Notify-3A (намеренно)

| Feature                  | Sprint        | Причина                                    |
|--------------------------|---------------|--------------------------------------------|
| Email live               | **Notify-3B** | HTML rendering, SPF/DKIM/DMARC, bounce mgmt |
| SMS live                 | **Notify-3C** | carrier variability, telecom edge-cases    |
| Delivery lifecycle UI    | post-3C       | observability surface                      |
| Recipient preferences    | Notify-Pref   | opt-in/opt-out, per-channel/per-kind       |
| Quiet hours              | future        | engagement system class of work            |
| Smart timing / urgency   | future        | engagement system class of work            |
| Resend / retry policy    | future        | not deterministic transport                |
| Digest / batching        | future        | not deterministic transport                |
| Bounce handling          | future        | per-provider, post-3B                      |
| Receipt poller           | future        | populates `deliveredAt` field              |

---

## 5. Что осталось технически дотянуть (low priority)

1. **Receipt poller** — Expo выдаёт ticket с `id`, через ~30 минут можно
   получить delivery receipts (delivered / dropped). Сейчас
   `deliveredAt` всегда null. Добавляется в Notify-3-Receipts.
2. **Admin lifecycle UI** в web-app/admin — endpoint готов
   (`/api/admin/customer-notify/lifecycle`), таблицу можно нарисовать.
3. **`/api/admin/customer-notify/audit` filter UX** — добавить filter
   по `dryRun` / по `liveEnabled-channel` для side-by-side сравнения.
4. **Expo Enhanced Security** — `EXPO_ACCESS_TOKEN` env не задан;
   sandbox-mode OK для preview, для prod рекомендуется.
5. **Push token TTL** — нет cleanup для stale tokens. Future Notify-Pref.

---

## 6. Ключевое достижение

Построена **policy-controlled customer continuity infrastructure**, не
"notifications feature". Grammar kernel, destination projection, audit
lineage, channel-flip kill switch и delivery lifecycle живут в
discrete namespaces — provider mechanics never drift into narrative.

Notify-3A — последняя insertion в этот substrate. Дальше — только
расширение по тем же контрактам (3B/3C — лишь снять `liveEnabled=False`
flag + поставить dumb adapter в `providers/`).
