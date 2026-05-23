# P0.b.C.f — F.0: Payment substrate inventory + chronology map

**Status:** F.0 complete, awaiting confirmation on F.1 taxonomy before code  
**Date:** 2026-02-22  
**Predecessor:** P0.b.C.e (deep-links, closed)

---

## 0. Architectural premise (frozen by user)

1. `payment_events` is a **new chronology species**. It is **NOT** a projection over `money_audit`. It is **NOT** translated 1:1 from `stripe_webhook_events`.
2. `money_audit` (existing) remains **forensic admin-mutation evidence** — admin-only governance ledger. Untouched.
3. `stripe_webhook_events` (existing) remains **provider evidence** — Stripe's payload as received. Untouched. No actor-facing projection on top of it.
4. **Explicit translation boundary:** `stripe_webhook_events → payment_events` is a *writer*, not a *view*. Filtered, deduplicated, semantically renamed.
5. Actor count: **3 (customer, provider, admin)** — NOT 4. Inspector projection does not exist in this sprint. Inspector payout info already lives inside `job-timeline.inspector` (P0.b.C.c) and stays there.
6. No payment state-machine framework. Explicit literals. Explicit append rows. Explicit projections. No `PaymentStateMachine`, no `PaymentReducer`, no `ChronologyEngine`.
7. No reuse of booking-timeline reducer, dedup, envelope, or projection taxonomy. Only low-level primitives may be shared (WS auth helper, JWT bearer parser, keepalive utility).

---

## 1. Existing payment-related collections (DO NOT TOUCH)

| Collection | Purpose | Mutability | Notes |
|---|---|---|---|
| `service_payments` | One doc per service-request payment lifecycle | Mutable (status FSM) | Source of platform-side payment truth |
| `payment_transactions` | (40 refs) per-mutation transaction rows | Append-only? TBD | Separate from chronology — finance-ledger granularity |
| `payments` | Generic payment doc (13 refs) | Mutable | Likely subscription/marketplace usage |
| `payouts` | Provider payout state (admin-moderated) | Mutable | P0.d module |
| `package_payments` | Provider subscription payments | Mutable | |
| `stripe_webhook_events` | Raw Stripe payloads + idempotency | Append-only | **provider evidence**, not chronology |
| `money_audit` | Admin moderation actions on money objects | Append-only | **forensic admin evidence**, not chronology |
| `booking_timeline` | Booking operational chronology | Append-only | P0.b.C.a..d substrate |

→ **`payment_events` is the missing chronology species** between `service_payments` (mutable state) and the actor surfaces.

---

## 2. Existing `service_payments` lifecycle statuses (observed)

`pending` → `paid` → `released` (happy path)

Branch statuses already used by code:
- `disputed` (set when dispute opened)
- `in_review` (intermediate dispute state)
- `resolved` / `resolved_partial` (post-dispute terminal)
- `refunded` (full refund terminal)
- `cancelled` (terminal)
- `transfer_reversed` (Stripe-reversed terminal)
- `awaiting_payment` / `pending_payment` / `requires_payment_method` (pre-paid)

This is the **state stream** — but state stream ≠ chronology. Chronology is the *append-only narrative* of how the state arrived.

---

## 3. Existing `structured_log` whitelisted payment events

Already emitted via `app/core/structured_log.py` (operational telemetry, not chronology):

```
escrow.intent.created
escrow.paid
escrow.release.started · escrow.release.succeeded · escrow.release.failed
escrow.release.blocked.{delay, dispute, platform_frozen, provider_frozen}
payment.captured
payout.queued
refund.requested · refund.created · refund.succeeded · refund.failed · refund.updated
transfer.created · transfer.updated · transfer.failed · transfer.reversed
```

→ These are **good naming reference points** but they are *telemetry events* (for grep/observability), not chronology rows. The chronology taxonomy is a smaller, semantically-strict subset.

---

## 4. Existing Stripe webhook types handled

(via `app/integrations/stripe_connect_service.py` + `app/integrations/router_stripe.py`)

```
payment_intent.succeeded
payment_intent.payment_failed
charge.refunded
transfer.created · transfer.updated · transfer.reversed
account.updated
refund.created · refund.updated
```

→ These are **Stripe semantics**, not platform semantics. The translation boundary is in F.2 (writer).

---

## 5. Chronology map (3 surfaces, asymmetric naming)

| Surface key | Actor view | Resource id | Source projection |
|---|---|---|---|
| `payment-activity.customer` | Money outflow narrative ("I paid €X · escrow held · funds released to provider") | `paymentId` | Customer-safe whitelist |
| `payout-activity.provider` | Money inflow narrative ("escrow holding €X · funds released · transferred to your Stripe account") | `paymentId` | Provider-safe whitelist (no platformCut, no customerNote) |
| `payment-forensic.admin` | Raw evidence: every row + :rejected attempts + meta whitelist OFF | `paymentId` | Same admin invariant as P0.b.C.d (raw, ugly, no prettification) |

**Asymmetric naming is intentional:**
- Customer says "payment" (outflow)
- Provider says "payout" (inflow)
- Same chronology substrate (`payment_events` collection)
- Different *semantic frame* per actor

No `inspector` surface. No symmetry forced.

---

## 6. Proposed F.1 taxonomy — explicit literals (need confirmation)

### Schema of one `payment_events` row

```json
{
  "id": "uuid hex",
  "paymentId": "service_payments._id reference (immutable across row lifetime)",
  "kind": "<literal — see below>",
  "at": "ISO8601 UTC",
  "actor": {
    "id": "user id or 'platform' or 'stripe'",
    "role": "customer | provider | admin | platform | stripe"
  },
  "meta": {
    "amount": <minor units int>,
    "currency": "EUR",
    "...kind-specific fields..."
  },
  "rejected": false,             // true → attempt that did not succeed (admin sees, others don't)
  "rejectionReason": null,       // populated only when rejected=true
  "sourceWebhookId": null,       // FK into stripe_webhook_events when translated
  "schemaVersion": 1
}
```

### Proposed kind literals (closed set, alphabetical for stability)

Lifecycle events:
- `intent.created` — PaymentIntent created (escrow setup)
- `intent.failed` — PaymentIntent failed before capture
- `escrow.held` — funds captured into platform escrow (= `payment_intent.succeeded`)
- `escrow.release.requested` — customer / system asked for release
- `escrow.release.blocked` — release blocked (dispute / freeze / delay) — `meta.reason`
- `escrow.released` — funds released from escrow (platform-side)
- `transfer.initiated` — Stripe Transfer to provider initiated
- `transfer.succeeded` — Transfer landed in provider's Stripe balance
- `transfer.failed` — Transfer failed
- `transfer.reversed` — Transfer reversed
- `refund.requested` — admin/customer requested refund
- `refund.succeeded` — refund landed
- `refund.failed` — refund attempt failed
- `dispute.linked` — payment marked as part of a dispute (`meta.disputeId`)
- `dispute.resolved` — dispute settled, payment status updated (`meta.resolution` in {release_payout, partial_refund, full_refund})

Admin-only intervention events (visible only in forensic projection):
- `admin.freeze.applied` — platform or provider freeze affected this payment
- `admin.freeze.lifted` — freeze released
- `admin.force_release` — admin bypassed 12h gate
- `admin.note.attached` — admin added internal note (`meta.note` redacted from non-admin projections)

Rejected attempts (rows with `rejected: true`, visible only to admin):
- `escrow.release.requested` + `rejected:true` (e.g. blocked by dispute → row exists with `rejectionReason: "dispute_open"`)
- `refund.requested` + `rejected:true` (e.g. amount > available)
- `admin.force_release` + `rejected:true` (validation failed)

### Closed-set count: **15 kind literals**, plus the orthogonal `rejected: bool` flag.

### What we DELIBERATELY do NOT include

- ❌ `payment.processing` — not a meaningful platform state, comes from Stripe wash
- ❌ `account.updated` — not payment chronology, belongs to provider onboarding
- ❌ `webhook.received` — observability telemetry, not chronology
- ❌ `payout.batched` — finance-side detail, not actor-facing
- ❌ Generic `status_changed` event — explicit-literals-only discipline
- ❌ Any field that wraps Stripe payload verbatim (would leak `stripe_webhook_events` semantics into chronology)

---

## 7. Projection contracts (proposed)

### Customer projection (`payment-activity.customer`)

VISIBLE kinds: `intent.created, escrow.held, escrow.release.requested, escrow.released, refund.requested, refund.succeeded, refund.failed, dispute.linked, dispute.resolved`

**FILTERED out:**
- All `rejected: true` rows
- All `transfer.*` rows (provider concern, not customer)
- All `admin.*` rows
- `meta`: only `amount`, `currency`, `releaseEta` exposed. NO `platformCut`, `providerId`, `internalNotes`, `stripeRef`, `webhookId`.
- `actor`: redacted to `{role}` only (no userId of admin/provider visible)

### Provider projection (`payout-activity.provider`)

VISIBLE kinds: `escrow.held, escrow.released, transfer.initiated, transfer.succeeded, transfer.failed, transfer.reversed, refund.succeeded (impacts payout), dispute.linked, dispute.resolved`

**FILTERED out:**
- All `rejected: true` rows
- `intent.created` / `intent.failed` (pre-capture, customer concern)
- All `admin.*` rows
- `meta`: only `amount`, `currency`, `payoutAmount`, `transferRef`, `arrivalEta` exposed. NO `platformCut`, `customerId`, `customerNote`, `internalNotes`.
- `actor`: redacted to `{role}` only.

### Admin forensic projection (`payment-forensic.admin`)

VISIBLE kinds: **all 15**, including `rejected: true` rows.

**NO filtering. NO prettification. Raw `meta` passthrough.**

Each row carries unique `id` for client-side dedup (admin invariant from P0.b.C.d).

---

## 8. Frequency / finality characteristics (per user directive)

| Property | Booking chronology | Payment chronology |
|---|---|---|
| Event volume per booking | ~5–30 rows | ~3–10 rows |
| Finality | Soft (states overwritable until terminal) | Hard (refund, transfer.reversed are irreversible) |
| Retry behavior | Allowed (status churn fine) | Forbidden on terminal rows |
| Dedup policy customer/provider | `(at, kind)` | `(paymentId, kind, at)` — payment-id-scoped |
| Dedup policy admin | `row.id` | `row.id` (consistent with P0.b.C.d) |
| Reconnect-on-disconnect | Yes | Yes |
| Retry on 4403 | No (P0.b.C.d invariant) | No (same invariant) |
| UI tone | Operational warmth | Financial coldness — ids, refs, timestamps, fewer colors |

---

## 9. Translation boundary table (F.2 contract preview)

Stripe webhook → payment_events translation rules:

| Stripe event | payment_events row(s) | Notes |
|---|---|---|
| `payment_intent.created` | (none) | Intent.created emitted by platform writer, not by webhook |
| `payment_intent.succeeded` | `escrow.held` | 1:1 translation |
| `payment_intent.payment_failed` | `intent.failed` | |
| `charge.refunded` | `refund.succeeded` | |
| `transfer.created` | `transfer.initiated` | |
| `transfer.updated` (status=paid) | `transfer.succeeded` | filter by status change |
| `transfer.updated` (other) | (none) | telemetry-only, not chronology |
| `transfer.reversed` | `transfer.reversed` | |
| `account.updated` | (none) | onboarding chronology, separate domain |
| `refund.created` | (none) | covered by `refund.requested` from platform side |
| `refund.updated` | `refund.succeeded` OR `refund.failed` per status | |

Platform-initiated writes (NOT from webhook):
- `intent.created` — written when `/billing/intent` endpoint creates PI
- `escrow.release.requested` — written when customer/admin POSTs release
- `escrow.release.blocked` — written when release endpoint rejects
- `escrow.released` — written after Transfer initiation succeeds
- `refund.requested` — written when admin/customer POSTs refund
- `dispute.linked` / `dispute.resolved` — written by disputes module
- `admin.*` — written by admin endpoints

---

## 10. Out-of-scope (locked for P0.b.C.f)

- ❌ Migration / backfill of historical `service_payments` into `payment_events`. Chronology starts now. Old payments have no chronology rows.
- ❌ Generic chronology framework / shared kit
- ❌ Inspector projection
- ❌ Customer/provider UI screens (F.6 may pick one or two; full UI rollout is later)
- ❌ Push integration
- ❌ Deep-link surfaces for payment chronology (will be added in P0.b.C.f+1 ONCE the chronology is stable)
- ❌ Inter-domain chronology unification (booking + payment + dispute → one stream). Locked forbidden per user.

---

## 11. F-step sequence

| Step | Deliverable | Code? | Tests? |
|---|---|---|---|
| F.0 | This doc — inventory + taxonomy proposal | no | no |
| F.1 | Taxonomy frozen by user confirmation | no | no |
| F.2 | `app/payments/chronology/writer.py` — append-only writer, translation boundary from webhook | yes | unit |
| F.3 | `app/payments/chronology/projector.py` — 3 projections (customer/provider/admin) | yes | unit |
| F.4 | REST endpoints: `GET /api/customer/payments/:id/chronology`, `GET /api/provider/payouts/:id/chronology`, `GET /api/admin/payments/:id/chronology` | yes | integration |
| F.5 | WS streams (mirror P0.b.C.a..d pattern for handshake, keepalive, role-gate) | yes | smoke |
| F.6 | UI: customer payment-activity screen + admin payment-forensic screen ONLY. Provider UI deferred. | yes | manual |

Each F-step ends with: re-run all 8 baseline + P0.b.C.e suite → must stay green.

---

## ✋ AWAITING CONFIRMATION

Before I write any code (F.2 and beyond), please confirm or amend:

1. **15 kind literals** in §6 — any to add / remove / rename?
2. **Naming**: `payment-activity.customer`, `payout-activity.provider`, `payment-forensic.admin` — keep these exact surface keys?
3. **3 actors (no inspector)** — confirmed?
4. **Dedup keys** in §8 — `(paymentId, kind, at)` for customer/provider, `row.id` for admin — agreed?
5. **Translation boundary table** in §9 — any Stripe events that should map differently?
6. **No backfill** — chronology starts at deploy time, old `service_payments` have no rows. OK?
7. **F.6 scope** — UI only for customer + admin in this sprint; provider UI later. OK?
