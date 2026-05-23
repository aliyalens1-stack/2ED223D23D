# B4.3-A-recovery — Reservation-context Audit

**Date:** 2026-05-22
**Sprint:** B4.3-A-recovery
**Status:** ✅ AUDIT COMPLETE — no code changes
**Scope:** read-only inventory of money-out / payout / withdrawal flows in current `/app` repo slice
**Predecessor context discarded:** previous `ac_reserved` / `pending_withdrawal` / `D-1…D-4` references confirmed to belong to a different repo slice; **NOT** canonical input here

---

## 1. TL;DR

The current code slice has **NO reservation layer**.
It has three terminal-money truth layers and one escrow status machine.
The semantic concept of "reserve / release / paid lifecycle" is *partially* expressed as a **mutable status field on `service_payments`** plus an **append-only chronology of events**, with **NO independent balance ledger anywhere**.

There is no `ac_reserved`, no `ac_hold`, no `ac_pending`, no `pending_withdrawal`, no `<dev>` actor namespace. There is no boot-time replay logic. There is no negative-reserved guard. None of these constructs exist in this slice.

**This means B4.3-B (canonical reservation model) is greenfield in this slice — there is nothing to repath. Before writing any code, the design must answer: *what business problem does an independent reservation ledger solve that the current 3-truth-layer setup does not?* Until that's answered, B4.3-B remains premature.**

---

## 2. Collections inventory — what physically exists

### 2.1 Mutable status entities (state lives on the document)

| Collection | Writer locations | Status enum | Notes |
|---|---|---|---|
| **`service_payments`** | `escrow/router_payments.py` (create_payment_for_bid, checkout, release), `disputes/router.py` (resolve), `admin/p0d/payments.py` (refund, retry), `integrations/router_connect.py` (Stripe webhook), `service_marketplace/router_customer.py` (cancel) | `pending → paid → released | refunded`, plus `failed`, `disputed`, `resolved_partial`, `disputed_hold` | **THE de-facto escrow ledger.** `paid` is the closest thing to "reserved". Mutable in-place via `$set`. TOCTOU guard via `find_and_modify({"id": x, "status": current})` on critical transitions (refund, retry). |
| **`payouts`** | **No writer found in current code** — only readers + admin FSM transitions. Documents must come from a legacy/external source (seed? migration? sprint not yet shipped?). | `pending → approved → processing → paid | failed`, plus `hold` | **Orphan FSM.** `admin/p0d/payouts.py` ships endpoints to approve/hold/process. `inspector/cabinet.py:513` reads. No insert path in current `/app/backend/**`. |
| **`disputes`** | `disputes/router.py` create/resolve. | `open → in_review → resolved` | Mutates `service_payments.status` as a side-effect of resolution (`released` / `refunded` / `resolved_partial`). |
| **`service_requests`** | many | many | Tangential to money — request lifecycle, not money. |
| **`organizations`**, **`provider_entitlements`** | `billing/router.py` | various boost/promoted/vip flags | Display/ranking concerns — not money-out. |

### 2.2 Append-only evidence layers (immutable, no `$set` on existing rows)

| Collection | Writer | Doctrine docstring | Schema |
|---|---|---|---|
| **`payment_events`** | `app/payments/chronology/writer.append_payment_event()` | "I-3. NO projection over money_audit or stripe_webhook_events." | `{id, paymentId, kind ∈ FROZEN_KINDS_19, at, actor{id,role}, meta, sourceWebhookId, schemaVersion}` |
| **`money_audit`** | `app/admin/p0d/audit.write_money_audit()` | "Append-only discipline: NO update/delete code paths exist in this module." | `{id, entity ∈ {payout,payment,review}, entityId, action, actorId, actorRole, fromStatus, toStatus, meta, timestamp}` |
| **`stripe_webhook_events`** | `app/integrations/stripe_connect_service.py:436` + `app/integrations/router_stripe.py:143` | "provider evidence" | Raw webhook + idempotency key |
| **`booking_timeline`** | `app/booking/timeline.py` (writer) + `app/booking/attach.observe_transition` | "Same discipline as `money_audit`" | per-booking event log |
| **`auction_charges`** | `app/marketplace/auction.py:267` | "per-lead debit ledger (Sprint 27)" | provider money-OUT debit |

### 2.3 View-only projectors (compute on read, no underlying state)

| Module | Reads | Emits | Status |
|---|---|---|---|
| **`app/provider/earnings.py`** | `bookings`, `inspection_jobs`, `inspection_reports`, `payments`, `auction_charges` | `ProviderEarningsItem` (`pending` / `payable` / `disputed_hold` / `deducted`) | Phase 3.1, deliberately READ-ONLY. States `processing` / `paid_out` are **reserved literal placeholders for future Phase 3.3** — currently never emitted. |
| **`app/inspector/cabinet.py`** | `inspection_jobs`, `payouts` | `{ earningsMonth, pendingPayout, currency }` | Computed projection — `pendingPayout` is a derived sum, not a stored balance. |
| **`app/auto_requests/router_inspector_profile.py:240`** | `payouts` | same | same |

---

## 3. The "three truth layers" doctrine — what it says, what it actually means

`app/payments/chronology/__init__.py` declares (P0.b.C.f closure):

```
3 truth layers preserved:
  - payment_events       (operational chronology)
  - money_audit          (admin governance evidence)
  - stripe_webhook_events (provider evidence)
```

What this **does** give us:
* Three independent write paths, each append-only, each with its own schema and indices.
* No layer projects from another (writer test #11 in `P0bCf` confirms zero leakage).
* Forensic replay can reconstruct *what happened* from any of the three.

What this **does NOT** give us:
* No layer maintains a current *balance* per provider, per customer, per platform.
* No layer is queried as "what is the platform's reserved liability right now".
* No layer is queried at boot to reconstruct a runtime in-memory balance.
* No invariant of the form `Σ reserved = Σ committed - Σ released - Σ paid_out` exists anywhere — neither computed nor asserted nor monitored.

**These are three evidence streams, not three ledgers.** They tell us the story; they don't sum the books.

---

## 4. Where reserve/hold/pay/release semantics live (de-facto)

### 4.1 Reserve (= "money entered escrow")

* **Trigger:** `service_payments.status` transitions to `paid` via either:
  - `app/integrations/router_connect.py:481-529` — Stripe `payment_intent.succeeded` webhook handler
  - `app/escrow/router_payments.py` (checkout completion / mock gateway)
* **Evidence emitted:**
  - `service_payments.status = "paid"` + `paidAt`, `stripePaymentIntentId` (mutable status)
  - `payment_events` row `kind="escrow.held"` (immutable)
  - `stripe_webhook_events` row (immutable, idempotent by webhook id)
* **NO** balance increment anywhere. The "reserved amount" is implicit in `count_documents({"status": "paid"})` + `aggregate sum grossAmount`. Computed on demand only (e.g. `escrow/router_admin.py:51-117`).

### 4.2 Hold (= "money frozen pending arbitration")

* **Trigger:** dispute created (`disputes/router.py`) — flips `service_payments.status` to `disputed`, marks request as `disputed_hold`.
* **Evidence emitted:** dispute doc, booking_timeline row, ops alert. No `payment_events` row currently exists for `dispute.opened` — only `dispute.linked` (admin-only) per F.1 taxonomy.
* **NO** independent hold-balance. The hold is just `service_payments.status ∈ {"disputed", "disputed_hold"}`.

### 4.3 Release (= "money committed to provider")

* **Trigger:** `POST /api/service-payments/{id}/release` (`escrow/router_payments.py:205-340`) OR dispute resolution `release_to_provider` (`disputes/router.py:478-487`).
* **Effect:** `service_payments.status = "released"` (mutable), `payment_events` row `escrow.released` (immutable).
* **NO** provider-balance increment. The provider's "released earnings" is a projector sum over `service_payments` filtered by `{status: "released", providerId: X}`.
* Stripe-side, `release_to_provider` (in `disputes/router.py:661-684`) optionally creates a real Stripe `Transfer` if `provider.stripeAccountId` exists. Otherwise marked for "manual payout" — but no separate doc is created tracking that manual debt.

### 4.4 Paid out (= "money left platform → provider bank")

* **Reserved as a literal** in `provider/earnings.py:42` (`S_PAID_OUT = "paid_out"`) — **deliberately never emitted in Phase 3.1**.
* `payouts` collection exists with a paid terminal state, but:
  - No writer creates `payouts` rows in current code.
  - `payouts.status = "paid"` does NOT cross-reference back to `service_payments.released` rows.
  - Two independent FSMs (`service_payments` ledger of escrow, `payouts` ledger of admin operations) coexist without reconciliation.

### 4.5 Refund (= "money returned to customer")

* **Trigger:** `POST /api/admin/payments/{id}/refund` (admin only, `admin/p0d/payments.py:126-222`) OR dispute resolution `full_refund` / `partial_refund` (`disputes/router.py:498-544`).
* **Effect:** `service_payments.status = "refunded"` or `"resolved_partial"`, `money_audit` row, `payment_events` row `refund.requested`, optionally real Stripe refund via `stripe_connect_service.create_refund()`.
* `refund.succeeded` is reserved for Stripe webhook `charge.refunded` — **handler exists conceptually but not yet wired** (per F.1 taxonomy comment in `admin/p0d/payments.py:204-206`).

---

## 5. Gap matrix — what does NOT exist in current slice

| Concept | Asked about | Actually present? | Where it would logically live if added |
|---|---|---|---|
| `ac_reserved` / `ac_hold` / `ac_pending` namespace | yes | **NO** — no namespaced reservation key anywhere | a new collection `reservations` or a sub-schema on `service_payments` |
| `pending_withdrawal` | yes | **NO** | likely `withdrawals` or `provider_balance_movements` (also absent) |
| `<dev>` actor (developer-withdrawal) | yes | **NO** — no developer-as-actor anywhere. `auction_charges` is provider-IN-debit (lead-fee), unrelated. | unclear — no obvious home |
| Independent reservation ledger | yes | **NO** — only implicit aggregations | new collection (greenfield) |
| Boot-time replay of "requested" rows | yes | **NO** — `lifespan` does only DB ping + ML hydration + `offline_replay` (inspector-only, unrelated) | `app/core/lifespan.py` |
| Hard guard on negative reserved | yes | **NO** — there is no `reserved` field to guard | DB schema validator OR writer-level pre-check |
| D-1 → D-4 removal order | yes | **NO** — no doc in `memory/` or root `*.md` defines these | the audit doc itself would have to define them |
| Reconciliation `Σ reserved = Σ paid_in - Σ released - Σ refunded - Σ paid_out` | implied | **NO** — never asserted, never measured | a periodic worker + ops alert |
| Provider balance row | yes | **NO** — `pendingPayout` is computed view, not stored | new collection (greenfield) |
| Customer escrow balance | implicit | **NO** — same | same |

---

## 6. Why the existing setup works *operationally* (and why that hides the gap)

* Every individual money mutation has at least one append-only evidence row (`payment_events` or `money_audit` or both).
* Stripe is the external source of truth for actual cash movement; `stripe_webhook_events` mirrors it.
* Aggregations (`escrow/router_admin.py` revenue dashboard) compute totals at query time.
* TOCTOU guards on `service_payments.status` transitions prevent the worst races on a single document.

This is **sufficient for a forensic platform** — given any payment id, you can reconstruct what happened. It is **insufficient for any of the following**, which would benefit from a real reservation ledger:

1. **Cross-payment invariants.** "Platform must never owe more than it holds" — currently not computable without scanning every `service_payments` row.
2. **Live treasury observability.** "How much is reserved RIGHT NOW" requires an aggregate query, not a row read.
3. **Negative-balance prevention at write time.** Today, a buggy update path could theoretically `$set status="released"` on a `pending` row; only the TOCTOU guard catches it, and only on certain paths.
4. **Boot-time recovery.** If the platform restarted mid-payout, no replay logic re-derives the in-flight state. Stripe webhooks will redeliver (idempotency stored), but the platform-internal "what intent had we declared" is only on the mutable doc.
5. **Reservation expiry.** "Hold money for N hours then auto-release" — there is no scheduler over reservation lifetimes.
6. **Multi-currency / FX-safe accounting.** Money is stored in cents per-payment with `currency`. No platform-wide currency-normalised view.

---

## 7. Naming sanity check — `ac_reserved` vs alternatives

If a reservation layer **is** built, the namespace choice matters. Observations from the current slice:

| Candidate | Verdict in this slice |
|---|---|
| `ac_reserved` | **Does not appear anywhere.** Adopting it would be a new convention without precedent. |
| `ac_hold` | **Does not appear.** `payouts.status="hold"` exists, but as a state, not a balance prefix. |
| `ac_pending` | **Does not appear.** `pending` appears as a status on many docs, never as a balance namespace. |
| `escrow.held` | **Exists as a `payment_events` kind literal.** Would be the closest natural extension. |
| `reservedPayout` / `pendingPayout` | **`pendingPayout` exists as a derived field on inspector profile.** Adopting it as the canonical reservation name would conflict with current view-only semantics. |

Recommendation if/when reservation layer is built: **avoid `ac_*` prefix entirely** unless a separate accounting taxonomy is being seeded with multiple `ac_*` literals. Otherwise it looks like a hanging convention. Prefer naming that aligns with the existing chronology: e.g. `reservation` collection with `kind ∈ {escrow.held, escrow.released, escrow.refunded, transfer.committed, transfer.paid_out}`.

---

## 8. What B4.3-B should have answered before being a sprint

Three questions, none of which the original B4.3-B framing made explicit:

1. **What's the actual business question that needs a reservation ledger?**
   * Treasury observability? → admin dashboard sprint.
   * Negative-balance prevention? → schema-level validator sprint.
   * Boot-time recovery? → orphan-detection sprint.
   * Reservation expiry? → scheduler sprint.
   These are four different sprints, not one.

2. **Which actor's balance is being reserved?**
   * Customer's funds in escrow? → already implicit in `service_payments.status="paid"`.
   * Provider's pending earnings? → already implicit in same, filtered.
   * Platform's float? → does not exist as a concept yet.
   * Developer / inspector withdrawals? → no such role-money relationship in this slice.

3. **What does "canonical" mean — replacing or augmenting?**
   * If replacing `service_payments.status`: this is a multi-sprint migration with strong backwards-compat constraints (632 endpoints reference it).
   * If augmenting (a parallel reservation collection): risk of dual-writes, drift, and reconciliation cost — exactly what the 3-truth-layer doctrine warned against.

---

## 9. Recommendation (non-binding)

**Do not start B4.3-B yet.** The reservation layer in the current slice is implicit and works for the things the platform currently does. Building a canonical reservation model now would:

* Re-encode information already in `service_payments` + `payment_events` + `money_audit`.
* Force a fourth truth layer, contradicting the "3 layers preserved" doctrine.
* Without a clear business question, it would mostly mirror existing aggregations.

**If a money-correctness sprint is the next priority, two narrower options are pickable from the current code:**

* **B4.3-A.1 — Reconciliation audit** (read-only): build a one-shot script that asserts `Σ paid - Σ refunded - Σ released - Σ resolved_partial == current outstanding escrow`. Identify gaps. Decide based on findings whether a ledger is actually needed.
* **B4.3-A.2 — TOCTOU guard hardening** (small, targeted): the existing TOCTOU guards on `service_payments` cover refund/retry but not `release`/`webhook → paid`. Audit + patch each transition with `find_and_modify({status: current})` discipline. Append `:rejected` rows on conflict.

Either is a real sprint with a measurable acceptance criterion and a clear non-goal list, drawn directly from facts in this slice.

**If despite this audit B4.3-B is still chosen, the minimum contract before any code:**

1. Decide which of §8.1's four sprints it actually is.
2. Decide whether it replaces or augments `service_payments.status`.
3. Define the invariant explicitly (in math, not prose).
4. Define the actor (customer? provider? platform float?).
5. Decide whether boot-time replay is from Stripe webhooks (already idempotent) or from `payment_events` (already canonical chronology).
6. Define the naming taxonomy WITHOUT inventing an `ac_*` prefix unless explicitly justified.

---

## 10. Artefacts

* This audit: `/app/memory/B4_3_A_recovery_reservation_context_audit_2026_05_22.md`
* Three-truth-layer doctrine: `/app/memory/P0bCf_closure_2026_02_22.md` §14
* Provider earnings projector: `/app/backend/app/provider/earnings.py`
* Escrow router: `/app/backend/app/escrow/router_payments.py`
* Payouts FSM (orphan): `/app/backend/app/admin/p0d/payouts.py` + `payout_fsm.py`
* money_audit writer: `/app/backend/app/admin/p0d/audit.py`
* payment_events writer: `/app/backend/app/payments/chronology/writer.py`
* P0.b.C.h closure (realtime publisher): `/app/memory/P0bCh_realtime_payment_events_closure_2026_05_22.md`
* P0.b.C.i closure (mobile consumers): `/app/memory/P0bCi_mobile_payment_chronology_consumers_closure_2026_05_22.md`

---

**Audit complete. Awaiting your decision on the next move (B4.3-A.1 reconciliation audit, B4.3-A.2 TOCTOU hardening, defer money work and pick a different domain, or proceed with B4.3-B under the §9 minimum contract).**
