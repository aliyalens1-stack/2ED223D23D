# P0.b.C.g — Webhook translator + truth attachment — CLOSURE

**Status:** ✅ CLOSED  
**Date:** 2026-02-22  
**Predecessor:** P0.b.C.f (payment_events chronology substrate)  
**Successor candidate:** P0.b.C.h (live WS push of new rows)

---

## Outcome

`payment_events` chronology substrate is now **truth-attached** to live production endpoints. Stripe webhook events, escrow release flows, and admin refund endpoints all emit chronology rows as **side-effects** of their existing operations.

The chronology stops being a hypothetical surface fed only by tests. It now reflects the actual financial reality of the platform.

---

## Architectural discipline preserved

1. **Side-effect, never blocking.** Every `append_payment_event(...)` call is wrapped in try/except. Chronology append failure logs a warning but does not raise. The original endpoint behaviour (status code, response body, mutations) is unchanged.
2. **No webhook payload echo.** Only fields we own enter `meta`: `amount`, `currency`, `transferRef`, `payoutAmount`, `reason`. Stripe-internal keys (`charges`, `outcome`, `latest_charge`, `payment_method_details`, etc.) never leak.
3. **Translation, not projection.** Stripe event names → platform kind literals are explicitly mapped in `_chron_append_from_pi` / `_chron_append_from_transfer` / `_chron_append_from_refund`. `transfer.reversed` produces no chronology row (deferred per F.1). `refund.created` produces no row (covered by platform-side `refund.requested`).
4. **Append-only causal trust.** A refund correction creates a NEW row (`refund.requested:rejected`), never mutates an earlier one. Tested: double-release emits a second `escrow.release_requested` plus an `escrow.release_rejected` — neither modifies the first.
5. **No reconciliation engine, no replay, no Stripe adapter abstraction.** Exactly what the user asked for.
6. **Cross-actor opacity preserved at the rest layer.** Test #7 verifies: `refund.requested:rejected` and `admin.freeze.applied` rows that the writer creates do NOT leak into the customer projection. The projector contract from P0.b.C.f stays the single point of truth filtering.

---

## Files modified (additive, minimal diffs)

### Backend
| File | Lines added | Lines removed | Nature |
|---|---|---|---|
| `app/integrations/router_connect.py` | +119 | 0 | 3 translation helpers (`_chron_append_from_pi`, `_chron_append_from_transfer`, `_chron_append_from_refund`) + 5 inline call-sites inside existing webhook branches |
| `app/escrow/router_payments.py` | +63 | -2 | `escrow.release_requested` on entry, `escrow.release_rejected` on 3 rejection paths (dispute / not-paid / not-completed), `escrow.released` on success |
| `app/admin/p0d/payments.py` | +29 | 0 | `refund.requested:rejected` on validation fail, `refund.requested` on success |

**No file was rewritten.** All edits are surgical additions inside existing handlers.

### New test
- `test_payment_chronology_attached_e2e.py` (218 LOC) — 7 truth-attachment checks

### NOT touched
- `app/payments/chronology/writer.py` (F.2 frozen)
- `app/payments/chronology/projector.py` (F.3 frozen)
- `app/payments/chronology/router.py` (F.4/F.5 frozen)
- `app/payments/chronology/__init__.py`
- 19-kind closed set
- `money_audit` collection or `app/admin/p0d/audit.py`
- `stripe_webhook_events` collection or its idempotency layer
- WS streams or REST envelopes
- Frontend (writer attachment is backend-only)

---

## Translation matrix (live, post-G)

| Stripe webhook | service_payments status mutation (existing) | payment_events row (NEW) |
|---|---|---|
| `account.updated` | `users.stripeChargesEnabled` etc. | (none — onboarding domain) |
| `payment_intent.succeeded` | `status: paid` | `escrow.held` (actor=stripe, sourceWebhookId set) |
| `payment_intent.payment_failed` | `status: failed` | `payment.failed` (actor=stripe) |
| `transfer.created` | `stripeTransferStatus: created` | `transfer.initiated` (actor=stripe) |
| `transfer.updated` (status=paid) | `stripeTransferStatus: updated` | `transfer.succeeded` (actor=stripe) |
| `transfer.updated` (status=failed) | `stripeTransferStatus: updated` | `transfer.failed` (actor=stripe) |
| `transfer.updated` (other) | (mutation only) | (none — telemetry-only) |
| `transfer.reversed` | `status: transfer_reversed` | (none — deferred per F.1) |
| `refund.created` | `refundStatus: ...` | (none — covered by platform `refund.requested`) |
| `refund.updated` (succeeded) | `refundStatus: succeeded` | `refund.succeeded` (actor=stripe) |
| `refund.updated` (failed) | `refundStatus: failed` | `refund.failed` (actor=stripe) |
| `charge.refunded` | `refundStatus: ...` | `refund.succeeded` (actor=stripe) |

| Platform endpoint | service_payments status mutation (existing) | payment_events row (NEW) |
|---|---|---|
| `POST /api/service-payments/:id/release` (entry) | — | `escrow.release_requested` (actor=customer/provider/admin) |
| `POST /api/service-payments/:id/release` (dispute block) | (raises 409) | `escrow.release_rejected` (reason=`dispute_open`, disputeId set) |
| `POST /api/service-payments/:id/release` (status != paid) | (raises 400) | `escrow.release_rejected` (reason=`validation_failed`, currentStatus set) |
| `POST /api/service-payments/:id/release` (request not completed) | (raises 400) | `escrow.release_rejected` (reason=`validation_failed`, requestStatus set) |
| `POST /api/service-payments/:id/release` (success) | `status: released` | `escrow.released` (actor=customer/provider/admin) |
| `POST /api/admin/payments/:id/refund` (validation fail) | (raises 409) | `refund.requested:rejected` (actor=admin, reason+currentStatus) |
| `POST /api/admin/payments/:id/refund` (success) | `status: refunded` | `refund.requested` (actor=admin, reason+amount+currency) |

---

## Empirical proof points (verified by `test_payment_chronology_attached_e2e.py`)

1. **Release happy path** → rows `[escrow.release_requested, escrow.released]` accumulate. Both have `actor.role="customer"`.
2. **Release with open dispute** → 409 from endpoint AND `escrow.release_rejected` row with `meta.reason="dispute_open"`, `meta.disputeId` populated.
3. **Double release attempt** (payment already `released`) → 400 from endpoint AND `escrow.release_rejected` row with `meta.reason="validation_failed"`, `meta.currentStatus="released"`. Prior 2 rows from happy path are untouched (append-only verified).
4. **Admin refund happy path** → 200 from endpoint AND `refund.requested` row with `actor.role="admin"`.
5. **Double admin refund** (already refunded) → 409 from endpoint AND `refund.requested:rejected` row with `actor.role="admin"`.
6. **Admin forensic surface** sees `refund.requested` AND `refund.requested:rejected` (all variants visible).
7. **Customer surface** sees `refund.requested` but NOT `:rejected` AND NOT `admin.*` (opacity preserved through projector despite new live rows).

---

## What this sprint did NOT do (still locked)

- ❌ Live WS push (consumers still REST-reload — P0.b.C.h scope)
- ❌ Reconciliation engine / replay / webhook recovery
- ❌ Stripe adapter abstraction
- ❌ Backfill of historical service_payments
- ❌ Provider UI (deferred since F.1)
- ❌ `transfer.reversed` kind (deferred since F.1)
- ❌ `admin.note.attached` kind (deferred since F.1)
- ❌ Ownership-tight customer REST gate (still TBD)
- ❌ Cross-domain chronology unification (forbidden by design)
- ❌ Any modification to writer/projector/router signatures (F.2/F.3/F.4/F.5 are FROZEN)

---

## Test matrix (final)

12/12 suites green:

| Suite | Status |
|---|---|
| `test_trust_e2e.py` (Sprint 5) | ✅ |
| `test_disputes_e2e.py` (Sprint 6) | ✅ |
| `test_stripe_connect_e2e.py` (Sprint 7) | ✅ |
| `test_sprint8_ops_e2e.py` (Sprint 8) | ✅ |
| `test_customer_timeline_ws_smoke.py` (P0.b.C.a) | ✅ |
| `test_provider_timeline_ws_smoke.py` (P0.b.C.b) | ✅ |
| `test_inspector_timeline_ws_smoke.py` (P0.b.C.c) | ✅ |
| `test_admin_forensic_ws_smoke.py` (P0.b.C.d) | ✅ |
| `test_deeplink_resolver_smoke.py` (P0.b.C.e) | ✅ |
| `test_payment_chronology_writer_smoke.py` (P0.b.C.f.F.2) | ✅ |
| `test_payment_chronology_e2e.py` (P0.b.C.f.F.3-F.5) | ✅ |
| `test_payment_chronology_attached_e2e.py` (P0.b.C.g) | ✅ NEW |

Zero regressions across 11 prior baselines after attachment.

---

## What this sprint says about the architecture

The system now has **3 chronology species (booking / payment / money governance) fed by live production events**, with no shared substrate, no shared reducer, no shared writer, no shared projector — only **shared principles**: closed-set kinds, `:rejected` suffix, append-only causality, actor-aware projections.

The pressure point now shifts from "can we model this?" to "can we propagate this in real time?" — i.e. P0.b.C.h (live WS push of new rows). That sprint can reuse the existing handshake/keepalive primitive but MUST NOT introduce a shared pub/sub bus that crosses domains.

Truth attachment is the inflection point at which chronology becomes **operationally true**, not just **semantically modelled**. That has happened today.
