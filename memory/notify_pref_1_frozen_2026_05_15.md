# Sprint Notify-Pref-1 — Recipient-intent namespace (2026-05-15)

> "Preferences are recipient agency. Suppression is provider transport.
> They look identical at the gate, but they are different truths."
> — Roman 2026-05-15 invariant

---

## Why this sprint

Bounce-1 gave us **provider truth** ("provider says no" → suppression).
The communication system was missing **recipient truth** ("recipient says no").
SMS would have been the third transport — but a third transport without
recipient agency is just three ways to spam someone.

Notify-Pref-1 closes the last semantic layer **before** any new transport
is added.

The four truths of the communication system after this sprint:

| Truth                                       | Namespace                          |
|---------------------------------------------|------------------------------------|
| what we intended to communicate             | `notification_projection_audit`    |
| what transport attempted                    | `notification_delivery_lifecycle`  |
| what provider learned about recipient       | `notification_suppressions`        |
| what recipient wants                        | `notification_preferences` ← NEW   |

---

## Scope lock (kept narrow on purpose)

✅ IN scope:
- read path: `is_opted_out(user_id, channel, kind)`
- write path: `append_preference_event(...)` (append-only)
- customer self-toggle: `POST /api/customer/notification-preferences`
- customer snapshot read: `GET /api/customer/notification-preferences`
- admin observability: `GET /api/admin/customer-notify/preferences`
- admin snapshot: `GET /api/admin/customer-notify/preferences/snapshot`
- admin override: `POST /api/admin/customer-notify/preferences/manual-append`
- delivery gate ordering: preference check **before** suppression check

❌ OUT of scope (future sprints):
- quiet hours / time-of-day windows
- digest / batching
- per-surface routing
- topic trees
- marketing consent (GDPR layer)
- escalation / priority overrides
- channel-substitution

---

## Roman invariants (locked)

1. **Append-only.** Every toggle is a new row. We never mutate, never
   delete. The latest row by `createdAt` wins at read time. Reactivation
   (opt_in after opt_out) is just another row.

2. **Cross-namespace independence.**
   - Preference opt-out **NEVER** creates a suppression row.
   - Suppression event **NEVER** creates a preference row.
   - Even when the delivery outcome is identical, the truths are
     distinct, the rows live in different collections, the writers
     are different modules, and the readers consult both gates
     independently.

3. **Fail-open.** Any DB error in the gate returns `False` ("not opted
   out"). Recipient agency must never be silently inverted by an
   infrastructure outage. The suppression gate (next in the chain) is
   the second line of defence.

4. **Precedence: kind-specific overrides channel-wide.**
   - Step 1: latest row for `(user, channel, kind=<requested>)`. If found → its effect decides.
   - Step 2: latest row for `(user, channel, kind=None)`. If found → its effect decides.
   - Step 3: default `opt_in` (not opted out).

   This preserves the recipient-agency loop where a user can opt out
   of channel-wide email but explicitly opt IN to `report.ready` — even
   if the channel-wide row is newer.

5. **Self vs admin source separation.**
   - `source="self"` is set automatically on the customer endpoint and
     cannot be set from the admin endpoint.
   - `source="admin"|"system"` can only be set through
     `manual-append` (admin-gated).
   - Future GDPR DSAR pipeline plugs in here cleanly via `source="system"`.

---

## Delivery gate ordering (deliver_audit_row)

```
audit row arrives
    ↓
(a) channel must be live          channel_state.is_live(channel)
    ↓
(b) preferences.opted_out?        preferences.is_opted_out(...)
    → YES: return preference_opted_out — NO lifecycle row, NO send
    → NO:  continue
    ↓
resolve destinations
    ↓
per destination:
    (c) suppression.is_blocked?   suppression.is_blocked(...)
    → YES: ONE lifecycle row, providerStatus="suppressed", provider NEVER called
    → NO:  provider send + ONE lifecycle row
```

Gate (b) is **module-scoped** — `_preference_opted_out` lives in
`delivery.py` and is the ONLY function in the delivery module that
touches `notification_preferences`. The preference module itself has
zero awareness of lifecycle or suppression. Strict directional dependency:

```
delivery  →  preferences  (read-only)
delivery  →  suppression  (read-only)
preferences  ⊥  suppression  (no edge in either direction)
```

---

## Verified end-to-end (2026-05-15)

### Test 1: `/tmp/test_notify_pref_1.py` — 25 assertions, all green

- Default snapshot: all channels `opt_in`, no kind overrides
- Customer toggles `push` channel-wide → `opt_out`
- Customer toggles `push` kind=`report.ready` → `opt_in` (kind-specific override)
- Snapshot reflects precedence correctly
- Admin list + snapshot endpoints work
- Admin `manual-append` works with `source="admin"`
- `source="self"` via admin endpoint → 400 BAD_SOURCE
- Validation: bad channel, bad effect, empty kind → all 400
- Reactivation: latest opt_in at same granularity flips truth
- Auth: no token → 401; customer on admin endpoint → 403
- **Cross-namespace lock: `notification_suppressions` and `notification_delivery_lifecycle` untouched**

### Test 2: `/tmp/test_gate_ordering.py` — direct delivery probe

```
baseline: suppressions=0, lifecycle=0
append opt_out: {'ok': True, 'reason': 'appended', 'rowId': '7eef56a...'}
deliver result: {'ok': True, 'reason': 'preference_opted_out',
                 'sent': 0, 'failed': 0, 'suppressed': 0}
after deliver: suppressions=0, lifecycle=0

=== GATE ORDERING PASS ===
  preference_opted_out → no lifecycle row → no suppression row
  cross-namespace lock confirmed at delivery boundary
```

---

## Collection shape

```
notification_preferences   (append-only)
{
  id:              uuid hex
  recipientUserId: <string>          required — preferences keyed by identity
  channel:         "push" | "email" | "sms"
  kind:            str | null        kind-specific or channel-wide
  effect:          "opt_out" | "opt_in"
  source:          "self" | "admin" | "system"
  reason:          str | null        ≤128 chars
  metadata:        dict | null       ≤2 KB serialised
  createdAt:       ISO 8601 UTC
}
```

Indexes:
- `pref_user_channel_kind_createdAt` — read path (precedence walk)
- `pref_createdAt_desc` — admin listing
- `pref_user_createdAt` — per-user listing

No unique index. Every toggle is a fresh row.

---

## Endpoints

| Method | Path                                                       | Who      |
|--------|------------------------------------------------------------|----------|
| GET    | `/api/customer/notification-preferences`                   | customer |
| POST   | `/api/customer/notification-preferences`                   | customer |
| GET    | `/api/admin/customer-notify/preferences`                   | admin    |
| GET    | `/api/admin/customer-notify/preferences/snapshot`          | admin    |
| POST   | `/api/admin/customer-notify/preferences/manual-append`     | admin    |

---

## What is now possible (and what is still deferred)

After Notify-Pref-1, the foundation is ready for SMS.
SMS becomes **adapter work only** — same audit projector, same
lifecycle namespace, same suppression namespace, same preference gate.
The semantic layers are done.

Still deferred — and intentionally so:
- Quiet hours / digest batching → after we see real send volume signals.
- Topic trees → only if customer feedback demands sub-kind groupings.
- GDPR DSAR pipeline → plugs in as `source="system"`, no architecture work needed.

---

## Files touched

- **NEW** `backend/app/notifications/preferences.py` (266 lines, lint-clean)
- **MOD** `backend/app/notifications/delivery.py` — stub replaced with real gate
- **MOD** `backend/app/core/lifespan.py` — `ensure_preference_indexes` hook
- **MOD** `backend/app/notifications/customer_pipeline.py` — 4 new endpoints (customer + admin)

No changes to: `audit.py`, `suppression.py`, `lifecycle.py`,
`webhooks/postmark.py`, `providers/*`. The cross-namespace lock is
preserved by file isolation alone.
