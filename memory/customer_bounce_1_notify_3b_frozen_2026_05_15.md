# Sprint Bounce-1 + Notify-3B — FROZEN (2026-05-15)

> Bounce-1 scaffold → Notify-3B email live. Postmark sandbox, no real
> customer delivery. Strict serial completion per Roman 2026-05-15.

---

## 1. Roman invariants — all enforced in code

| #  | Invariant                                                            | Locked in                                                 |
|----|----------------------------------------------------------------------|-----------------------------------------------------------|
| 1  | suppression namespace = append-only event log                        | `suppression.py`: no update/delete; only `insert_one`     |
| 2  | "is blocked?" = computed query, not mutable state                    | `suppression.py::is_blocked` reads latest row by createdAt|
| 3  | Webhook handler ALWAYS returns 200                                   | `webhooks/postmark.py`: all branches → `JSONResponse(200)`|
| 4  | Send-time gate ordering: preferences → suppressions → provider       | `delivery.py::deliver_audit_row` runs gates in this order |
| 5  | suppression NEVER mutates preferences (and vice versa)               | Different functions, no cross-imports                     |
| 6  | preferences NEVER deletes suppression history                        | Suppression collection isolated; preferences = STUB       |
| 7  | HTML wrapper deterministic from {title, body, deepLink} only         | `providers/postmark_email.py::_build_deterministic_html`  |
| 8  | Provider adapter is dumb (no copy/locale/destination/urgency choice) | adapter only does HTTP POST + status normalization        |
| 9  | dryRun forensic namespace preserved at every channel                 | `channel_state.py`: `dryRun: True` for push AND email     |
| 10 | One lifecycle row = one delivery attempt-or-decision                 | Suppressed sends still emit ONE row (providerStatus="suppressed") |

---

## 2. New components

### 2.1. `app/notifications/suppression.py`
- Collection: `notification_suppressions` (NEW)
- Row schema documented in module header; immutable after insert
- 4 indexes (each in own try/except so one failure doesn't kill rest):
  - `sup_channel_address_createdAt` (read path)
  - `sup_idempotency` UNIQUE `(provider, providerEventId, kind)` w/ partial `{providerEventId: $exists: true}`
  - `sup_providerMessageId` (lifecycle correlation)
  - `sup_createdAt_desc`
- API:
  - `append_suppression_event(...)` — single writer, idempotent
  - `is_blocked(channel, address) → (bool, latestRow)`  — computed
  - `list_suppressions(...)` — admin observability

### 2.2. `app/notifications/webhooks/postmark.py`
- Single endpoint: `POST /api/notifications/webhooks/postmark/{path_secret}`
- Path secret check via `hmac.compare_digest` (constant time)
- RecordType dispatch:
  - `Bounce` → `_normalize_bounce` → append `hard_bounce`/`soft_bounce` (effect=block)
  - `SpamComplaint` → append `spam_complaint` (effect=block)
  - `SubscriptionChange` → append `subscription_unsubscribe`/`subscription_reactivate`
    based on `SuppressSending` flag
  - `Delivery`/`Open`/`Click` → ACK with `ignored` reason (lifecycle territory, not suppression)
  - unknown / malformed → 200 + log warning
- Best-effort `recipientUserId` resolution from `users.email` lookup (read-only)

### 2.3. `app/notifications/providers/postmark_email.py`
- Function: `send_email(to_address, subject, body, lang, deep_link_href, cta_text, metadata)`
- Dumb: pure transport adapter; no DB writes; no policy access
- POST to `https://api.postmarkapp.com/email` with `X-Postmark-Server-Token`
- Builds deterministic HTML from inputs only (no template engine):
  - Heading = subject
  - Body = `<div white-space:pre-wrap>` with HTML-escaped text
  - CTA button only if `deep_link_href` is provided
  - Footer = single line "Transactional notification."
- TextBody twin auto-generated (deterministic)
- Track opens / track links explicitly OFF (transactional)
- Metadata constrained to Postmark limits (≤10 keys, key≤20 chars, value≤80)
- Returns normalized `{ok, providerMessageId, providerStatus, providerError}`

### 2.4. Updated `app/notifications/delivery.py`
- Added `_resolve_email_addresses(db, user_id)` — primary email lookup
- Added preferences gate STUB `_preference_opted_out` (Notify-Pref-1 will replace)
- Replaced `deliver_audit_row` body with full gate ordering:
  1. `is_live(channel)` — channel-state kill switch (was already there)
  2. preferences gate (STUB, always allows)
  3. destination resolution (push tokens OR email addresses)
  4. per-destination: suppression gate (computed `is_blocked`) → either
     write `providerStatus="suppressed"` row OR call dumb adapter
- Added `_dispatch_email` (new) + `_dispatch_push` (refactored from old body)
- Lifecycle row shape extended with `recipientAddress`, `addressKind`, `suppressedAt`
  (push rows keep `deviceToken`, `devicePlatform`); never both populated

### 2.5. New admin endpoints (in `customer_pipeline.py`)
- `GET  /api/admin/customer-notify/suppressions` — list rows (filter by channel/recipient)
- `POST /api/admin/customer-notify/suppressions/manual-append` — admin override
  block/reactivate; still APPENDS, never deletes

### 2.6. `channel_state.py` flip
```python
"email": {"dryRun": True, "liveEnabled": True, "provider": "postmark"},
```
SMS remains `liveEnabled: False`.

### 2.7. Server wiring (`server.py`)
- `from app.notifications.webhooks.postmark import router as postmark_webhook_router`
- `app.include_router(postmark_webhook_router)`

### 2.8. Lifespan hook
- `ensure_suppression_indexes` added to `core/lifespan.py` startup phase

### 2.9. `.env` (already injected)
```
POSTMARK_SERVER_TOKEN=POSTMARK_API_TEST
POSTMARK_WEBHOOK_PATH_SECRET=e292f3b15c04b3fd7c3af3cf5cacfacddac31c60680a6ad559c1267e88115cd5
POSTMARK_FROM_EMAIL=noreply@example.com
POSTMARK_FROM_NAME=Inspection Service
POSTMARK_MESSAGE_STREAM=outbound
POSTMARK_API_BASE=https://api.postmarkapp.com
```

---

## 3. End-to-end verification (2026-05-15 11:30 UTC)

### 3.1. Webhook auth gate
| Request                          | Response                                                                |
|----------------------------------|-------------------------------------------------------------------------|
| wrong-secret POST                | `200 {"accepted": false, "reason": "bad_secret"}`                       |
| valid-secret + Bounce            | `200 {"accepted": true, "reason": "appended", "rowId": "..."}`          |
| valid-secret + same Bounce (retry)| `200 {"accepted": true, "reason": "duplicate"}` ✓ idempotency works   |
| valid-secret + SpamComplaint     | `200 {"accepted": true, "reason": "appended"}`                          |
| valid-secret + SubscriptionChange `SuppressSending=false` | `200 ... reactivate row appended` ✓     |

### 3.2. Chronology preserved (append-only)
After 1 bounce + 1 reactivate + 1 second bounce, `notification_suppressions` carries:
```
1. hard_bounce        block       customer@test.com  T0
2. subscription_reactivate reactivate  customer@test.com  T1  ← latest at T1
3. hard_bounce        block       customer@test.com  T2  ← latest at T2
```
At any point in time, `is_blocked(email, customer@test.com)` returns the
effect of the latest row by createdAt. Forensic chronology intact.

### 3.3. Send-time gate (Notify-3B project event)

**Scenario A** — recipient not blocked (latest row = reactivate):
```
audit row       : email row inserted (dryRun=true, forensic)
lifecycle row   : ONE row written for email channel
                  provider=postmark, providerStatus="ok",
                  providerMessageId=93274cab-a97f-424c-ade3-56a8f36ac990,
                  sentAt=<now>, suppressedAt=null
```
Real HTTP POST to `api.postmarkapp.com/email` succeeded (sandbox mode,
returned MessageID).

**Scenario B** — recipient blocked (new hard_bounce row appended just before):
```
audit row       : email row inserted (forensic narrative intact)
lifecycle row   : ONE row written for email channel
                  provider=postmark, providerStatus="suppressed",
                  providerError="hard_bounce:HardBounce/1",
                  sentAt=null, failedAt=null, suppressedAt=<now>
                  providerMessageId=null  ← provider was NEVER called
```

Total email lifecycle rows after both scenarios: **2** (not 4, not 1 — exactly two attempts, one allowed, one suppressed).

### 3.4. Three-namespace separation honoured
| Collection                           | Writers                                            |
|--------------------------------------|----------------------------------------------------|
| `notification_projection_audit`      | only `audit.py::project_audit`                     |
| `notification_delivery_lifecycle`    | only `delivery.py::_dispatch_*` and `receipts.py`  |
| `notification_suppressions`          | only `webhooks/postmark.py` + `admin manual-append`|
| `notification_preferences` (future)  | only customer settings UI (Notify-Pref-1)          |

Each writer touches exactly one collection. Readers cross-reference by
foreign keys (`auditRowId`, `providerMessageId`).

---

## 4. Three communication-truth verdicts now exist

Before this freeze, the system could distinguish:
- "we sent" / "we didn't send" — single dimension

After this freeze, the system distinguishes:
1. **"we decided not to send"** — recipient intent (preferences STUB, real in Notify-Pref-1)
2. **"provider rejected recipient"** — append in `notification_suppressions`, `effect=block`, lifecycle row `providerStatus="suppressed"`
3. **"recipient no longer accepts channel"** — same suppression row but `kind=subscription_unsubscribe`
4. **"sent and delivered"** — `lifecycle.sentAt` + future `lifecycle.deliveredAt` (push receipts already, email post-3B)
5. **"sent but provider failed"** — `lifecycle.failedAt` + `providerError`

This is **reversible communication transport** in the literal sense:
every "we decided" is auditable, every "we tried" is observable,
every "they refused" is forensic, and every "they changed their mind"
is a new append (never a delete).

---

## 5. Anti-scope (explicitly NOT in this freeze)

- ❌ Real customer delivery — `POSTMARK_API_TEST` sandbox only
- ❌ Verified sender domain configuration (still `noreply@example.com`)
- ❌ Notify-Pref-1 — preferences namespace + customer settings UI
- ❌ Quiet hours, batching, digest, smart timing
- ❌ Email receipt enrichment (Delivery webhook is ACKed-and-ignored)
- ❌ Lifecycle email-row UI in admin (existing lifecycle table handles
     it automatically since it's data-driven; no UI changes needed)
- ❌ Suppression list UI in admin (endpoint exists; future sprint)
- ❌ Bounce rate alerting / monitoring
- ❌ Retry / dead-letter / resend logic
- ❌ List-Unsubscribe header (post-3B)

---

## 6. What enables next

- **Email receipt enrichment** — same poller pattern as push receipts but
  reading Postmark Delivery webhook payloads → enrich existing lifecycle
  rows with `deliveredAt`. Trivial because lifecycle namespace and email
  send path are already wired.
- **Notify-3C (SMS, Twilio)** — same shape as 3B: dumb adapter, idempotent
  webhook, suppression rows with `channel="sms"` (already a valid value).
- **Notify-Pref-1 (preferences)** — slot into `_preference_opted_out`
  STUB without touching any other code.
- **Verified domain production flip** — change ONE env var
  `POSTMARK_SERVER_TOKEN` to a real token, point DNS for SPF/DKIM/DMARC.
  Code stays unchanged.

---

## 7. Files touched

```
NEW:
  /app/backend/app/notifications/suppression.py
  /app/backend/app/notifications/webhooks/__init__.py
  /app/backend/app/notifications/webhooks/postmark.py
  /app/backend/app/notifications/providers/postmark_email.py
  /app/memory/customer_bounce_1_notify_3b_frozen_2026_05_15.md

CHANGED:
  /app/backend/app/notifications/channel_state.py
      email.liveEnabled = True, provider = "postmark"
  /app/backend/app/notifications/delivery.py
      Replaced deliver_audit_row body with gate ordering + email dispatch
  /app/backend/app/notifications/customer_pipeline.py
      + admin suppressions endpoints; restored _compute_projection_version
  /app/backend/app/core/lifespan.py
      + ensure_suppression_indexes startup hook
  /app/backend/server.py
      + include_router(postmark_webhook_router)
  /app/backend/.env
      + POSTMARK_* configuration block
```

---

## 8. The wider arc

```
event → grammar projection → destination projection → audit truth
       → preferences (intent)
       → suppression (provider truth)
       → lifecycle (transport truth)
            → send attempt
            → suppressed decision
            → receipt (push live; email queued for 3B-receipts)
       → observability surface
```

Every step has its own write namespace. Every step has its own reader.
No step mutates a sibling's truth. **This is now communication infrastructure.**
