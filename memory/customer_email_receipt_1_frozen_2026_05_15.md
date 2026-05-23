# Sprint Email-Receipt-1 — FROZEN (2026-05-15)

> Closes email lifecycle semantically. Postmark Delivery / Bounce /
> SpamComplaint webhooks now enrich the SAME lifecycle row written at
> send time. No new lifecycle rows are ever inserted from a webhook.

---

## 1. The invariant this freeze locks in

> **one lifecycle row = one delivery attempt**

A webhook is **never** an event. A webhook is **enrichment of an
existing attempt**. The send path is the only inserter; the receipt
path only updates.

For the bounce case specifically (Roman 2026-05-15):

> Bounce webhook делает ДВЕ вещи, но в РАЗНЫЕ namespaces:
>   suppression append  + lifecycle enrichment
> Не mutation preferences.

This is now enforced by code structure:

```
webhook handler  ─┬─→ append_suppression_event   (suppression collection)
                  └─→ lifecycle_email.enrich_*   (lifecycle collection)
```

The two functions live in different modules, write to different
collections, and have non-overlapping signatures. They cannot
accidentally drift into mutating preferences (there is no import path
from this freeze to the preferences namespace).

---

## 2. New module: `app/notifications/lifecycle_email.py`

Three functions, all `update_one` only:

```
enrich_delivery(db, *, provider_message_id, delivered_at, detail_raw)
    → sets deliveredAt, providerReceiptStatus="delivered",
            providerReceiptDetail, webhookReceivedAt

enrich_bounce(db, *, provider_message_id, bounce_kind, bounced_at,
              reason, detail_raw)
    → sets bouncedAt, providerReceiptStatus="bounced",
            providerReceiptKind, providerReceiptError,
            providerReceiptDetail, webhookReceivedAt
    NOTE: failedAt is NOT touched (failedAt = send-attempt truth)

enrich_complaint(db, *, provider_message_id, complained_at, detail_raw)
    → sets complainedAt, providerReceiptStatus="complained",
            providerReceiptDetail, webhookReceivedAt
```

All filter on `channel="email" AND providerMessageId=<id>`. If no
matching row exists (test-send, race, garbage MessageID), the
function returns `{ok: True, reason: "no_lifecycle_row"}` — never
raises, never inserts.

---

## 3. Updated webhook routing

`webhooks/postmark.py` now dispatches:

| RecordType        | Suppression           | Lifecycle              |
|-------------------|-----------------------|------------------------|
| Bounce            | append (block)        | enrich_bounce          |
| SpamComplaint     | append (block)        | enrich_complaint       |
| SubscriptionChange| append (block|reactivate) | no-op (no MessageID) |
| Delivery          | NO                    | enrich_delivery        |
| Open              | NO (ignored)          | NO (ignored)           |
| Click             | NO (ignored)          | NO (ignored)           |
| unknown           | NO                    | NO                     |

Delivery is the only RecordType handled before the dispatch table — it
has no suppression side. Bounce / SpamComplaint flow through both:

```python
# 1) suppression append (idempotent via unique index)
result = await append_suppression_event(db, **kwargs)

# 2) lifecycle enrich IF MessageID present
enrich_result = await _enrich_lifecycle_for_event(db, record_type, payload)

return 200 with both verdicts in body
```

Webhook still ALWAYS returns 200 — enrichment failure → log only.

---

## 4. End-to-end verification (2026-05-15 11:44 UTC)

Used the actual lifecycle row written during Notify-3B verification
(`providerMessageId = 93274cab-a97f-424c-ade3-56a8f36ac990`):

### E.1 — Delivery
```
POST /webhooks/postmark/<secret> { RecordType=Delivery, MessageID=..., DeliveredAt=... }
→ 200 { accepted:true, reason:"enriched", matched:1, modified:1 }

row state after:
  sentAt:                "2026-05-15T11:30:21.707..."  (preserved)
  deliveredAt:           "2026-05-15T11:35:12.000Z"    (NEW)
  providerReceiptStatus: "delivered"                    (NEW)
  webhookReceivedAt:     "2026-05-15T11:44:46.877..."  (NEW)
```

### E.2 — Bounce on SAME MessageID
```
POST /webhooks/postmark/<secret> { RecordType=Bounce, MessageID=<same>, Type=HardBounce, ... }
→ 200 {
    accepted:true, reason:"appended", rowId:"...",   # suppression namespace
    lifecycle: { ok:true, reason:"enriched", matched:1, modified:1 }
  }

row state after:
  sentAt:                "2026-05-15T11:30:21.707..."  (preserved from E.1)
  deliveredAt:           "2026-05-15T11:35:12.000Z"    (preserved from E.1)
  bouncedAt:             "2026-05-15T11:40:00.000Z"    (NEW)
  failedAt:              null                           (preserved — send attempt did NOT fail)
  providerReceiptStatus: "bounced"                      (overwrote "delivered")
  providerReceiptKind:   "hard_bounce"                  (NEW)
  providerReceiptError:  "HardBounce/1"                 (NEW)
```

Row count for this MessageID = **1** (not 2 — enrichment, not event).
This is "we sent it, mailbox accepted it, recipient mail filter later
rejected it" expressed as ONE row, preserving full chronology.

### E.3 — Webhook for unknown MessageID
```
POST /webhooks/postmark/<secret> { RecordType=Delivery, MessageID=non-existent-mid-xyz }
→ 200 { accepted:true, reason:"no_lifecycle_row", matched:0, modified:0 }

verification:
  rows with providerMessageId=non-existent-mid-xyz: 0   ← no insert
  total email lifecycle rows: 2                          ← unchanged
```

Invariant holds: webhook never inserts.

---

## 5. Email lifecycle is now SEMANTICALLY COMPLETE

Same shape as push, achieved via different mechanism:

| Channel | Send insert   | Receipt enrich            | Reconciler              |
|---------|---------------|---------------------------|-------------------------|
| push    | delivery.py   | receipts.py (poller)      | 180 s loop pulls Expo   |
| email   | delivery.py   | lifecycle_email.py        | Postmark push webhooks  |
| sms     | (3C)          | (3C-receipts)             | (later)                 |

Push uses poll because Expo doesn't push receipts. Email uses webhooks
because Postmark does. Either way: **one row enriched in place**.

---

## 6. Anti-scope (deliberately NOT in this freeze)

- ❌ Open / Click — engagement namespace, not lifecycle (still ignored)
- ❌ Retry / dead-letter / resend on bounce
- ❌ Bounce-rate alerts / monitoring dashboards
- ❌ Lifecycle row UI showing bounce vs delivery vs complaint side-by-side (existing UI shows the fields; richer pills can come later)
- ❌ Notify-3C SMS
- ❌ Notify-Pref-1 preferences
- ❌ Recompute "is user reachable?" from lifecycle history (that is a
     suppression namespace question, not lifecycle)

---

## 7. Files touched

```
NEW:
  /app/backend/app/notifications/lifecycle_email.py
  /app/memory/customer_email_receipt_1_frozen_2026_05_15.md

CHANGED:
  /app/backend/app/notifications/webhooks/postmark.py
      - removed Delivery from _IGNORED_RECORD_TYPES
      - added Delivery short-circuit handler (lifecycle enrich only)
      - added _enrich_lifecycle_for_event for Bounce / SpamComplaint
      - updated module docstring (invariants #3/#4)
```

---

## 8. Email channel state — what it now distinguishes

For the same recipient + same MessageID, the lifecycle row now expresses:

```
projectedAt    : grammar layer wrote this attempt
sentAt         : Postmark /email API accepted it
deliveredAt    : Postmark Delivery webhook fired (mailbox accepted it)
bouncedAt      : recipient rejected (delivery-time)  OR mailbox bounced later
complainedAt   : recipient marked as spam
suppressedAt   : we decided not to send because address was previously blocked
failedAt       : Postmark /email API call itself returned an error
providerReceiptStatus : final state ("delivered" | "bounced" | "complained" | ...)
```

These are not states in a state machine — they are TIME STAMPS of
specific provider-truth events, all on the same row. The "current
state" is computed from `providerReceiptStatus` (latest wins). Earlier
truths are never erased. This is what reversibility looks like at the
data layer.

Next channel (SMS) will reuse this exact shape — `deliveredAt`,
`bouncedAt` (failed receipt), `complainedAt` (carrier-blocked), etc.
The model is now channel-shape-stable.
