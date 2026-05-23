# P0.b.C.f — F.1: Payment chronology taxonomy (FROZEN)

**Status:** ✅ FROZEN — taxonomy is now immutable for this sprint  
**Date:** 2026-02-22  
**Predecessor:** F.0 inventory  
**Successor:** F.2 writer

---

## Hard invariants (frozen, will NEVER change in P0.b.C.f)

### I-1. APPEND-ONLY DISCIPLINE
`payment_events` rows MUST NOT be rewritten or deleted.  
Even if:
- A Stripe webhook is corrected,
- A payout is retried,
- A release is cancelled,
- A dispute is reopened.

**Only `insert_one`. Never `update_one`, `update_many`, `replace_one`, `delete_one`, `delete_many`, `find_one_and_update`, `find_one_and_replace`, `find_one_and_delete`.**

Corrections come as **new rows**, never as overwrites. This is the foundation of causal trust.

### I-2. NO ORTHOGONAL `rejected: bool` AXIS
Rejection is encoded in the **kind literal itself** via the `:rejected` suffix (consistent with `mark_completed:rejected` from P0.b.C.d booking chronology).

Rationale:
- rows are self-describing
- append-only semantics clearer
- no hidden interpretation layer
- admin forensic simpler

### I-3. NO PROJECTION OVER `money_audit` OR `stripe_webhook_events`
- `money_audit` is admin governance evidence — untouched.
- `stripe_webhook_events` is provider evidence — untouched.
- `payment_events` is platform chronology — new species, independent collection.

### I-4. CLOSED KIND SET
The 19 kinds below are the **complete** set. The writer **MUST reject** unknown kinds with `ValueError`. No "open extension" via metadata, no `kind: "custom"`, no string templates.

### I-5. SPARSITY DISCIPLINE
Payment chronology is **low-volume, high-finality**. Targets ≤ 10 rows per payment lifecycle. If we ever start writing >15 rows per payment, that signals overinstrumentation — STOP and audit, do not "scale the framework".

---

## The 19 frozen kinds

### Customer-visible (11)

| Kind | Meaning | Written by |
|---|---|---|
| `payment.initiated` | PaymentIntent created; customer can pay | platform (POST /billing/intent) |
| `payment.failed` | PaymentIntent failed before capture | webhook → translation |
| `escrow.held` | Funds captured into platform escrow | webhook (`payment_intent.succeeded`) → translation |
| `escrow.release_requested` | Customer or system requested funds released | platform (POST escrow/release) |
| `escrow.release_rejected` | Platform formally refused the release (with `meta.reason ∈ {dispute_open, platform_frozen, provider_frozen, delay_gate, validation_failed}`) | platform (rejection path of release endpoint) |
| `escrow.released` | Funds left escrow (platform-side state change) | platform (release success) |
| `refund.requested` | Refund initiated by customer or admin | platform (POST refund) |
| `refund.succeeded` | Refund landed in customer bank | webhook (`charge.refunded`, `refund.updated:status=succeeded`) |
| `refund.failed` | Refund attempt did not land | webhook (`refund.updated:status=failed`) |
| `dispute.linked` | Payment associated with an open dispute (`meta.disputeId`) | platform (dispute open hook) |
| `dispute.resolved` | Dispute closed; payment status updated (`meta.resolution ∈ {release_payout, partial_refund, full_refund}`) | platform (dispute resolve hook) |

### Provider-visible (3)

| Kind | Meaning | Written by |
|---|---|---|
| `transfer.initiated` | Stripe Transfer to provider started | webhook (`transfer.created`) → translation |
| `transfer.succeeded` | Transfer arrived in provider's Stripe balance | webhook (`transfer.updated:status=paid`) → translation |
| `transfer.failed` | Transfer did not land | webhook (`transfer.updated:status=failed`) → translation |

### Admin-only forensic (3 + 2 `:rejected` variants)

| Kind | Meaning | Written by |
|---|---|---|
| `admin.freeze.applied` | Payment frozen by admin (platform or single-provider) | platform (POST /admin/payments/freeze) |
| `admin.freeze.lifted` | Freeze lifted | platform (POST /admin/payments/unfreeze) |
| `admin.force_release` | Admin bypassed 12h gate / blocker | platform (admin release path) |
| `refund.requested:rejected` | Refund request refused by platform (amount > available, etc.) | platform (rejection path of refund endpoint) |
| `admin.force_release:rejected` | Admin force-release refused (validation failed) | platform (rejection path of admin release) |

**Total: 19 kinds.**

---

## Deliberately deferred (NOT in P0.b.C.f)

These were considered and **explicitly excluded** per user directive. They may appear in future sprints, but their absence here is a feature, not an oversight.

| Deferred kind | Reason for exclusion |
|---|---|
| `intent.created` / `intent.failed` | Stripe-internal ontology leakage. Replaced by `payment.initiated` / `payment.failed`. |
| `escrow.release.blocked` (generic) | "Blocked" is a smell — requires explanation engine, policy-coupling. Replaced by explicit `escrow.release_rejected` with structured `meta.reason`. |
| `transfer.reversed` | Reversal semantics are exceptional-governance; accounting divergence risk; customer/provider trust issues. Admin can still see the underlying webhook in `stripe_webhook_events`. Will revisit if/when reversal becomes a real operational scenario. |
| `admin.note.attached` | Slippery slope toward "timeline as comments". Notes belong in `money_audit` (already exists) or a future annotation surface. |
| `account.updated`, `payout.batched`, `webhook.received` | Observability telemetry, not chronology. Live in `structured_log` and `stripe_webhook_events`. |
| Generic `status_changed` | Explicit-literals discipline. |
| Any `rejected: true` orthogonal flag | I-2 invariant. Use `:rejected` suffix instead. |

---

## Row schema (frozen)

```python
{
    "id": "uuid hex 32",                 # unique row id, used by admin dedup
    "paymentId": "service_payments id",  # immutable FK
    "kind": "<one of the 19 frozen literals>",
    "at": "ISO8601 UTC",
    "actor": {
        "id": "user id | 'platform' | 'stripe'",
        "role": "customer | provider | admin | platform | stripe",
    },
    "meta": {
        # kind-specific. Loose dict — projector decides what to surface per actor.
        # Common keys: amount (minor units int), currency, reason, disputeId,
        #              resolution, transferRef, refundRef, freezeKind, …
    },
    "sourceWebhookId": "stripe_webhook_events id | null",
    "schemaVersion": 1,
}
```

Indexes:
- `(paymentId, at DESC)` — chronology fetch for a single payment
- `(kind, at DESC)` — kind-wide queries (admin ops dashboards)
- `(actor.id, at DESC)` — by-actor queries (audit trail per user)

---

## Translation boundary (Stripe → payment_events)

Filtered, deduplicated, semantically renamed.

| Stripe event | → payment_events kind | Notes |
|---|---|---|
| `payment_intent.created` | (none) | Platform-written via `payment.initiated` from intent endpoint |
| `payment_intent.succeeded` | `escrow.held` | 1:1 |
| `payment_intent.payment_failed` | `payment.failed` | renamed for platform semantics |
| `charge.refunded` | `refund.succeeded` | |
| `transfer.created` | `transfer.initiated` | |
| `transfer.updated` (status=paid) | `transfer.succeeded` | filtered |
| `transfer.updated` (status=failed) | `transfer.failed` | filtered |
| `transfer.updated` (other) | (none) | telemetry-only |
| `transfer.reversed` | (none) | deferred — admin sees raw `stripe_webhook_events` row |
| `account.updated` | (none) | onboarding domain, separate |
| `refund.created` | (none) | covered by platform-side `refund.requested` |
| `refund.updated` (status=succeeded) | `refund.succeeded` | |
| `refund.updated` (status=failed) | `refund.failed` | |

Platform-initiated writes (no source webhook):
- `payment.initiated` — when PaymentIntent created by `/billing/intent`
- `escrow.release_requested` — when client/admin POSTs release
- `escrow.release_rejected` — rejection path of release endpoint
- `escrow.released` — release endpoint success
- `refund.requested` / `refund.requested:rejected` — refund endpoint paths
- `dispute.linked` / `dispute.resolved` — dispute module hooks
- `admin.freeze.applied` / `admin.freeze.lifted` — admin freeze endpoints
- `admin.force_release` / `admin.force_release:rejected` — admin force-release endpoint

---

## Projection contracts (preview for F.3)

### Customer (`payment-activity.customer`)
- ALLOWED kinds (11): all customer-visible from §"Customer-visible (11)" table.
- HIDDEN kinds: all `transfer.*`, all `admin.*`, all `:rejected` variants.
- `meta` whitelist (per kind): `{amount, currency, releaseEta, disputeId, resolution}`. NO `platformCut`, `providerId`, `internalNotes`, `stripeRef`, `webhookId`.
- `actor`: redacted to `{role}` only.

### Provider (`payout-activity.provider`)
- ALLOWED kinds (3 core + escrow.held + escrow.released + refund.succeeded + dispute.{linked,resolved}): provider's narrative.
  - escrow.held (informational — "funds being held for your job")
  - escrow.released (informational — "platform released to your account")
  - transfer.initiated / transfer.succeeded / transfer.failed
  - refund.succeeded (informational — "this job had a refund, affecting payout")
  - dispute.linked / dispute.resolved
- HIDDEN: `payment.*`, `escrow.release_requested`, `escrow.release_rejected`, all `refund.requested.*`, all `admin.*`, all `:rejected` variants.
- `meta` whitelist: `{amount, currency, payoutAmount, transferRef, arrivalEta, resolution}`. NO `customerId`, `customerNote`, `platformCut`, `internalNotes`.
- `actor`: redacted to `{role}` only.

### Admin (`payment-forensic.admin`)
- ALLOWED kinds: **all 19**, including `:rejected` variants.
- NO filtering. NO `meta` whitelisting. Raw passthrough.
- Each row carries unique `id` for client-side dedup (P0.b.C.d invariant).
- `actor` field intact, including userId.

---

## Dedup policy (frozen)

| Surface | Dedup key |
|---|---|
| `payment-activity.customer` | `(paymentId, kind, at)` |
| `payout-activity.provider` | `(paymentId, kind, at)` |
| `payment-forensic.admin` | `row.id` |

Mirrors P0.b.C.d divergence — customer/provider get cleaned, content-addressed dedup; admin gets row-id dedup so duplicate-by-content (e.g. retry of same fact) is still preserved as separate evidence.

---

## Forbidden patterns (re-stated for the writer)

- ❌ `PaymentStateMachine`, `PaymentReducer`, `ChronologyEngine`, `EventStore`
- ❌ Generic `emit_event(kind, ...)` that accepts any string
- ❌ `update_one` / `delete_one` / `find_one_and_*` on `payment_events`
- ❌ `orthogonal rejected: bool` field
- ❌ Webhook payload echo into `meta` (only fields we own)
- ❌ Reuse of `booking_timeline` writer / reducer / dedup logic
- ❌ Backfill of historical `service_payments` into `payment_events`

---

## F.2 next steps

F.2 = writer module.

Deliverable:
- `/app/backend/app/payments/chronology/__init__.py`
- `/app/backend/app/payments/chronology/writer.py` — `append_payment_event(db, **kwargs)` + `KINDS` frozen set + `ensure_indexes(db)`
- Unit test: `/app/backend/test_payment_chronology_writer_smoke.py` — validates closed-set rejection, append-only behaviour, schema shape, index creation.
- Wire `ensure_indexes` into server.py startup.

NO endpoint, NO projector, NO UI in F.2. Pure writer + unit test.
