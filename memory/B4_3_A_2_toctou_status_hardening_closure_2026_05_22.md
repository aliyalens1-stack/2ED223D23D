# B4.3-A.2 — TOCTOU guard hardening for `service_payments.status`

**Date:** 2026-05-22
**Sprint:** B4.3-A.2
**Status:** ✅ CLOSED — 22/22 TOCTOU smoke assertions green, 0 regressions in P0.b.C.f/g/h/i
**Predecessor:** B4.3-A-recovery (reservation-context audit, confirmed no ledger exists)
**Pattern reference:** existing CAS pattern in `admin/p0d/payments.refund` / `admin/p0d/payouts._apply_transition` / `admin/p0d/payments.retry`

---

## 1. Scope (held narrow)

Harden status transitions on the **EXISTING mutable `service_payments.status`** field. Nothing else.

  Inventory of 10 unsafe write-sites → replace with CAS pattern
  `update_one({"id": x, "status": {"$in": expected_from}}, {"$set": ...})`
  through one small helper `cas_set_payment_status()`.

Anti-goals (held verbatim from the sprint brief):

  * ❌ `ac_reserved` / `ac_hold` / `ac_pending` namespace
  * ❌ boot-time replay
  * ❌ balance ledger
  * ❌ change to projections
  * ❌ new chronology kinds
  * ❌ shared reducer / state machine framework
  * ❌ migration / backfill / data rewrite
  * ❌ Stripe-side rollback

## 2. Files

**NEW** — helper (one function, ~120 LOC including doctrine doc-string):

* `app/payments/status_cas.py` — `cas_set_payment_status(db, *, payment_id, expected_from, next_status, extra_fields)` returns `("modified" | "idempotent" | "forbidden" | "missing", current_status)`.
  - Defensive copy of `extra_fields` (caller cannot inject `status` / `updatedAt`).
  - Never raises on DB errors — logs and returns `("missing", None)`.
  - No new DB collection. No new index. No new state.

**MODIFIED** — 10 write-sites (one CAS pattern, repeated):

| File | Line region | What changed |
|---|---|---|
| `app/escrow/router_payments.py` | release_escrow | CAS `paid → released`; idempotent re-release returns existing doc; forbidden write emits `escrow.release_rejected` chronology |
| `app/escrow/router_payments.py` | mock-gateway webhook | CAS table `paid/failed/refunded`; **post-paid side-effects moved INSIDE the `modified` branch** so duplicate webhooks no longer fire notifications/chat twice |
| `app/integrations/router_connect.py` | Stripe Connect release_escrow | CAS `paid → released`; duplicate / forbidden writes log loudly because Stripe transfer is already created — ops alerts in case of drift |
| `app/integrations/router_connect.py` | webhook `payment_intent.succeeded` | CAS `pending/failed/requires_payment_method → paid`; chronology emit only on `modified` |
| `app/integrations/router_connect.py` | webhook `payment_intent.payment_failed` | CAS `pending/requires_payment_method → failed`; chronology emit only on `modified` |
| `app/integrations/router_connect.py` | webhook `transfer.reversed` | CAS `released → transfer_reversed` |
| `app/disputes/router.py` | open dispute | CAS DISPUTABLE_PAYMENT_STATUSES → `disputed`; forbidden logs but does NOT raise (dispute row already inserted, ops reconciles) |
| `app/disputes/router.py` | resolve `release_to_provider` | CAS `disputed → released`; concurrent resolve returns 409 |
| `app/disputes/router.py` | resolve `full_refund` | CAS `disputed → refunded`; 409 on race |
| `app/disputes/router.py` | resolve `partial_refund` | CAS `disputed → resolved_partial`; 409 on race |

**NEW** — smoke test:

* `test_payment_status_toctou_smoke.py` — three-phase suite, 22 assertions:
  * **Phase 1** (pure unit): 10 cases against the helper — modified / idempotent / forbidden / missing transitions, double-release dedup, paid-after-refunded forbidden, extra_fields injection guard.
  * **Phase 2** (mock webhook integration): direct HTTP calls to `/api/payments/webhook/stripe`. Verifies duplicate webhook → `idempotent: true` in response, no chronology row duplication, out-of-order `payment_intent.succeeded` after `charge.refunded` rejected with `reason: "status_drift_terminal"`.
  * **Phase 3** (release path integration): `POST /api/service-payments/{id}/release` twice, verifies `releasedAt` / `releasedBy` / `releaseNote` not overwritten by second attempt, exactly one `escrow.released` chronology row.

## 3. Acceptance criteria (22/22 green)

PHASE 1 — pure unit:
* ✅ `pending → paid` modified
* ✅ duplicate paid → idempotent
* ✅ out-of-order `paid → failed` forbidden
* ✅ nonexistent id → missing
* ✅ `paid → released` modified
* ✅ double `paid → released` (helper-level idempotent)
* ✅ `released → refunded` modified (legitimate per WEBHOOK_VALID_FROM)
* ✅ **paid after refunded → FORBIDDEN** (the core money-correctness invariant)
* ✅ doc status unchanged after forbidden write (no silent overwrite)
* ✅ `extra_fields={status, updatedAt}` injection cannot bypass helper

PHASE 2 — webhook idempotency:
* ✅ first mock-pay → status paid
* ✅ second mock-pay → 409 (mock-pay route's own guard)
* ✅ duplicate webhook → response carries `idempotent: true`
* ✅ no chronology row duplication for `escrow.held`
* ✅ `charge.refunded` → refunded
* ✅ out-of-order `payment_intent.succeeded` AFTER refunded → REJECTED
* ✅ webhook response carries `reason: "status_drift_terminal"`

PHASE 3 — release path:
* ✅ first release → released
* ✅ double release → `releasedAt` / `releasedBy` preserved
* ✅ `releaseNote: "second-evil"` not overwritten by second attempt
* ✅ exactly one `escrow.released` chronology row
* ✅ `escrow.release_requested` = 2 (both attempts audited — request-side evidence preserved even though resolution side-effect ran once)

## 4. Sprint brief mapping

> double release не переписывает state

✅ Phase 3.2, 3.3 — second release sees `idempotent`, returns existing doc without mutating any field.

> paid после refunded не проходит

✅ Phase 1.8, 1.9, 2.5b — both at helper-level AND through the live webhook handler. Refunded stays refunded.

> webhook duplicate/idempotent path не делает second mutation

✅ Phase 2.3, 2.4 — duplicate webhook returns 200 with `idempotent: true`, no chronology row duplication, post-paid side-effects (notifications/chat) gated by `modified` outcome.

> chronology/audit side-effects остаются best-effort

✅ All chronology emits remain wrapped in `try/except` — `escrow.release_rejected` written on `forbidden` outcome only where the local pattern already exists (escrow router release path). No new `:rejected` literal introduced.

> existing P0.b.C.f/g/h/i suites green

✅ Re-ran all 4 suites:
  * `test_payment_chronology_writer_smoke.py` — 19 kinds frozen
  * `test_payment_chronology_e2e.py` — F.3+F.4+F.5 projector opacity + 3 REST projections + WS handshake
  * `test_payment_chronology_realtime_smoke.py` — in-process snapshot equivalence + over-the-wire handshake
  * `test_payment_consumers_reducers_smoke.js` — REST wins, dedup, surface independence

## 5. Doctrinal discipline preserved

* **Three truth layers untouched.** `payment_events`, `money_audit`, `stripe_webhook_events` unmodified. Each still writes independently.
* **No new namespace.** `service_payments.status` already had the literals `pending / paid / released / refunded / failed / disputed / disputed_hold / resolved_partial / transfer_reversed / requires_payment_method` — we did not add a single new value.
* **Projectors untouched.** `provider/earnings.py`, `payment_events/projector.py`, `inspector/cabinet.py` not modified.
* **No DB schema migration.** No new index, no field-level migration, no backfill.
* **TOCTOU pattern matches existing P0.d discipline.** The CAS shape mirrors `admin/p0d/payments.py:167` (refund) and `admin/p0d/payouts.py:118` (transition) — same `{"id": x, "status": current}` filter, same `modified_count == 0` branch, same `:rejected` chronology row pattern at the same surface where it already existed.
* **Side-effect ordering corrected as a byproduct.** The escrow webhook handler previously ran notifications/chat-init BEFORE the status write. Refactored so the CAS runs FIRST; side-effects only fire on `modified`. This fixes a latent duplicate-notification bug on webhook redelivery without changing what the side-effects are.

## 6. Operational impact

* **Behavioural change visible to clients:**
  - Double-release: previously second call would 200 OK and silently overwrite timestamps. Now: second call sees the row in `released`, gets idempotent 200 with the EXISTING doc — no overwrite of `releasedAt`/`releasedBy`/`releaseNote`.
  - Duplicate webhook: previously caused duplicate notifications + duplicate chronology rows. Now: returns 200 with `idempotent: true`, side-effects suppressed.
  - Out-of-order webhook (succeeded after refunded): previously would silently overwrite `refunded` back to `paid` (money corruption). Now: rejected with 200 + `reason: "status_drift_terminal"` so Stripe stops retrying, status preserved.
  - Concurrent dispute resolution: previously last-write-wins. Now: 409 to the loser with `"Another resolution may have already completed."` message.

* **No client API contract break.** All endpoints still return 200/4xx/5xx per existing spec. Response shapes augmented with `idempotent`/`skippedStatus`/`reason` keys where helpful — additive only.

* **No DB migration.** Existing documents continue to work without backfill.

## 7. What this sprint did NOT close (deliberately)

These are real gaps but explicitly out of scope per the sprint brief:

* **Chronology row dedup by `sourceWebhookId`** — `payment_events` still writes a fresh row per call. CAS-guarding the status mutation indirectly reduces duplicates (we skip chronology when CAS is idempotent), but doesn't prevent them at the writer level. If/when needed, a `unique` index on `(paymentId, sourceWebhookId, kind)` is the right shape — separate sprint.
* **Stripe transfer rollback on CAS forbidden** — in the Stripe Connect release path, the Stripe transfer is created BEFORE the CAS write. If CAS fails, we log loudly but do NOT roll back the transfer. This is correct per the 3-truth-layer doctrine (Stripe is provider evidence; platform is operational state). Manual reconciliation via `stripe_webhook_events` is the recovery path.
* **`payouts` collection FSM hardening** — `admin/p0d/payouts.py:118` already has `{"id": x, "status": current}` CAS. No change needed.
* **`auction_charges` debit ledger** — append-only; no status mutation; not in TOCTOU scope.
* **Reconciliation invariant (`Σ paid - Σ refunded - Σ released`)** — this is the natural follow-on (B4.3-A.1). Deferred.

## 8. Next pickable steps (not in this sprint)

* **B4.3-A.1 — Reconciliation audit.** Read-only script asserting `Σ outstanding-escrow == Σ paid - Σ refunded - Σ released - Σ resolved_partial`. Surfaces any historical drift introduced before this CAS was in place. Could now safely run on a stable write-surface.
* **Chronology dedup index** (separate sprint). Unique `(paymentId, sourceWebhookId, kind)` index on `payment_events` to make duplicate-row emission structurally impossible.
* **TOCTOU smoke as CI gate.** Wire `test_payment_status_toctou_smoke.py` into the existing P0.b.C suite invocation.
