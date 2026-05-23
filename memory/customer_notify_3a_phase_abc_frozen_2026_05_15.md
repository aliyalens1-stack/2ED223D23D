# Customer-Notify-3A — Phase A+B+C FROZEN (2026-05-15)

Strict serial completion of Roman's series d):
  **Phase A** Lifecycle UI · **Phase B** Receipt poller · **Phase C** Redis operationalization
No parallel Notify-3B work. No control-plane drift.

---

## 1. Invariant (locked at this commit)

> **one lifecycle row = one delivery attempt**

Receipts enrich the **existing** row in place. A receipt is NOT an event.
This is enforced in code (`receipts._enrich_row` is `update_one` only,
never `insert`) and documented in the inspector pane of the UI.

If a future PR ever changes `_enrich_row` to insert/delete, it
silently rebrands lifecycle into event-sourcing and breaks:
  • idempotent reasoning  • per-attempt inspectability
  • retry clarity         • provider reconciliation simplicity

The function carries explicit comments to that effect.

---

## 2. Phase A — Lifecycle UI

**File:** `/app/admin/src/pages/CustomerNotifyLifecyclePage.tsx`
**Route:** `/customer-notify/lifecycle` (admin SPA)
**Nav:** ANALYTICS → "📡 Notify · Delivery Lifecycle"

Sections:
1. **Channel-flip matrix card** — read from `/api/admin/customer-notify/channel-state`. Three tiles (push/email/sms) with `dryRun` / `liveEnabled` / `provider`. Push is the only live tile.
2. **Roll-up KPI strip** — page-local count of `delivered | sent | failed | pending` verdicts.
3. **Filters** — channel, recipient, verdict (client), limit (50/100/200/500). Apply button only — no live-search to spare rate-limit.
4. **Table** — every row in `notification_delivery_lifecycle`, sorted by createdAt desc. Columns: verdict pill · channel · kind · recipient · provider · providerStatus · projectedAt · sentAt · deliveredAt · failedAt · inspect.
5. **Inspector pane** — split view: transport row (delivery_lifecycle) on the left, grammar row (projection_audit) on the right. Cross-checked via `auditRowId`. UI honours the invariant explicitly in the footer.

Scope guards (visible in the UI itself):
- "Observability surface, not a control plane."
- No buttons for resend / retry / cancel / dead-letter / bulk.
- Inspector pane says: *"Receipts (Phase B) will populate `deliveredAt`
  on the same row, never as a new event."*

---

## 3. Phase B — Receipt poller

**File:** `/app/backend/app/notifications/receipts.py` (270 LOC)
**Loop:** registered in `app/core/lifespan.py` — every 180 s.
**Manual trigger:** `POST /api/admin/customer-notify/receipts/poll-now` (admin-gated).

### Selection criteria
A lifecycle row is checked iff ALL hold:
- `channel = push` (Phase B scope; 3B/3C will widen)
- `provider = expo`
- `sentAt` not null AND `failedAt` null AND `providerMessageId` not null
- `deliveredAt` null AND `providerReceiptStatus != "ok"`
- `createdAt` within `[15min, 24h]` (Expo's receipt availability window)
- `receiptCheckedAt` absent OR > 5 min old (per-row backoff)

Oldest tickets reconciled first so they don't age out of Expo's 24h window.

### Provider call (DUMB)
`POST https://exp.host/--/api/v2/push/getReceipts` with batched ids (≤100).
Optional `EXPO_ACCESS_TOKEN` from env. Adapter has zero policy.

### Enrichment (UPDATE-ONLY)

| Expo receipt status   | lifecycle row mutation                                                           |
|-----------------------|----------------------------------------------------------------------------------|
| `ok`                  | `deliveredAt = nowUtc`, `providerReceiptStatus = "ok"`, error=null               |
| `error`               | `providerReceiptStatus = "error"`, `providerReceiptError = msg \| details.error` |
| unknown / missing     | `providerReceiptStatus = <status> \| "not_yet_available"` — row stays pending    |

**`deliveredAt` is ONLY ever populated on `ok`.** Error from receipt does NOT
write `failedAt` — `failedAt` belongs to the SEND attempt (different lifecycle
phase). This is the discipline Roman called out: send-attempt truth and
receipt truth coexist in the same row, but don't overwrite each other's fields.

### End-to-end verification (2026-05-15 10:52 UTC)
Seeded one row with fake `providerMessageId`, age 20 min.

```
poll-now → { checked: 1, delivered: 0, errored: 0, stillPending: 1, tookMs: 95 }

after poll, row count = 1 (NO new row inserted)
row.providerReceiptStatus = "not_yet_available"
row.receiptCheckedAt      = "2026-05-15T10:52:36.177622+00:00"
row.deliveredAt           = null
row.sentAt                = unchanged
```

✅ Invariant holds: enrichment, not insertion.

---

## 4. Phase C — Redis operationalization

**Installed:** `redis-server 7.0.15`
**Supervisor conf:** `/etc/supervisor/conf.d/supervisord_redis.conf`
**Bind:** `127.0.0.1:6379` (loopback only)
**Save:** RDB snapshots every 60s if ≥10 keys changed (no AOF)
**Memory:** 256 MB, `allkeys-lru` eviction
**Status:** `RUNNING`, `redis-cli PING → PONG`

### Backend reconnect
Backend's `app/core/redis_state.py` detects a live Redis on next request.
After restart: `INFO:server:Redis connected: redis://127.0.0.1:6379/0`.
Post-reconnect `Redis unavailable` warning count = **0**.

What now talks to real Redis instead of NO-OP:
- `prod_readiness.py::check_rate_limit` (60 req/min/IP)
- idempotency lookup/commit
- `redis_state` operational caches
- pre-engagement zone hash
- orchestrator transient state

Scope guard: this is operationalization only. Not streams, not pub/sub,
not event bus. We use redis as kv + counter, nothing else.

---

## 5. Observability you can now actually look at

| Surface                                                    | What it shows                                          |
|------------------------------------------------------------|--------------------------------------------------------|
| `/api/admin-panel/customer-notify`                         | Grammar layer (audit projection, copy preview)         |
| `/api/admin-panel/customer-notify/lifecycle`               | Transport layer (this freeze)                          |
| `POST /api/admin/customer-notify/receipts/poll-now`        | Manual reconcile trigger                               |
| `GET  /api/admin/customer-notify/channel-state`            | Kill-switch matrix                                     |
| `GET  /api/admin/customer-notify/lifecycle`                | Raw rows (paginated by `limit`, `after`)               |
| `GET  /api/admin/customer-notify/audit`                    | Raw audit (grammar)                                    |
| backend logs                                                | `cnotify receipts poll: checked=… delivered=…`         |

---

## 6. What is NOT in this freeze (anti-scope)

- ❌ resend / retry / dead-letter
- ❌ bounce handling (post-3B)
- ❌ recipient preferences / opt-out
- ❌ quiet hours / smart timing
- ❌ digest / batching
- ❌ Notify-3B (email live) — gated by completion of this freeze
- ❌ Notify-3C (sms live) — gated by 3B
- ❌ Lifecycle UI write actions (only inspect)
- ❌ Redis streams / pub-sub / distributed orchestration

Each is named in the corresponding module's docstring so future work
cannot drift in by accident.

---

## 7. What this enables next

Now that observability + reconciliation + redis are live, **Notify-3B
(email)** becomes a pure additive operation:

1. Implement a dumb SendGrid (or Resend) adapter under
   `app/notifications/providers/sendgrid_email.py`.
2. Flip `email.liveEnabled = True` in `channel_state.py`.
3. Add `_resolve_email_recipients()` analogous to `_resolve_push_tokens()`.
4. (Receipt-equivalent for email is bounce/spam-report webhooks — that
   is a separate sprint, not 3B itself.)

No grammar changes, no audit changes, no UI changes (lifecycle table
already shows email rows side-by-side with push).

---

## 8. Files touched in this freeze

```
NEW:
  /app/backend/app/notifications/receipts.py
  /app/admin/src/pages/CustomerNotifyLifecyclePage.tsx
  /etc/supervisor/conf.d/supervisord_redis.conf
  /app/memory/customer_notify_3a_phase_abc_frozen_2026_05_15.md

CHANGED:
  /app/backend/app/notifications/customer_pipeline.py
      + POST /api/admin/customer-notify/receipts/poll-now
  /app/backend/app/core/lifespan.py
      + receipts_poll_loop background task
  /app/admin/src/App.tsx
      + /customer-notify/lifecycle route
  /app/admin/src/components/Layout.tsx
      + nav entry
```

---

## 9. Roman-style closing note

The platform now has:
  semantics (grammar)
  → observability (UI + audit listing)
  → lifecycle completeness (sent → delivered, in-place enriched)
  → operational scaling (real Redis)

Before this freeze: push live but blind, audit-only forensics, no infra under it.
After this freeze: **fully inspectable live transport** for one channel.

Notify-3B is now ready to be a *new adapter*, not a *new operational unknown*.
