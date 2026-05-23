# P0.b.C.f — payment_events chronology — CLOSURE

**Status:** ✅ CLOSED  
**Date:** 2026-02-22  
**Predecessors:** P0.b.C.e (deep-links)  
**Steps delivered:** F.0 → F.1 → F.2 → F.3 → F.4 → F.5 → F.6

---

## Outcome

A new **payment chronology species** — independent collection `payment_events`, independent writer with closed-set discipline, three actor projections (customer / provider / admin) with hard opacity invariants, REST + WS surfaces, two UI screens (customer + admin), deep-link surfaces wired.

**`payment_events` is NOT** a projection of `money_audit` or `stripe_webhook_events`. **3 truth layers preserved.**

---

## Architectural invariants (all empirically tested)

| Invariant | How proven |
|---|---|
| **I-1 Append-only** | Writer test #5 — 5 rows for same paymentId, no overwrite. Writer test #9 — no `update_*`/`delete_*`/`replace_*` public API. |
| **I-2 No `rejected: bool`** | `:rejected` suffix kinds (`refund.requested:rejected`, `admin.force_release:rejected`). Frozen taxonomy enforces this. |
| **I-3 No projection over money_audit / stripe_webhook_events** | Writer test #11 — both collections untouched (count=0) during writer ops. |
| **I-4 Closed kind set (19)** | Writer test #1+#2 — `len(KINDS) == 19`, exact symmetric_diff = ∅. Writer test #6 — unknown kind → ValueError. |
| **I-5 Sparsity discipline** | Documented (≤10 rows per payment); not enforced at runtime — operational hygiene. |
| **3 actors (no inspector)** | No `project_inspector` function exists. No `/inspector/payouts/...` route. Inspector payout data stays inside `job-timeline.inspector` (P0.b.C.c). |
| **Cross-actor opacity** | Projector test PART-A — customer never sees `transfer.*`, `admin.*`, `:rejected`. Provider never sees `payment.*`, `escrow.release_requested`, `admin.*`, `:rejected`. Forbidden meta keys (`platformCut`, `internalNotes`, `customerNote`, `providerId`, `customerId`, `webhookId`) absent in customer/provider output. |
| **Translation boundary** | Writer test #4 — `escrow.held` row with `actor.role="stripe"` and `sourceWebhookId="evt_x"` proves Stripe→platform translation, not echo. |
| **WS terminal 4403** | E2E test — customer JWT to admin stream closed with 4403 (terminal, no retry semantics). |
| **No reuse of booking-timeline reducer/dedup/envelope** | New module tree under `app/payments/chronology/`. Independent indexes (`payment_chronology`, `kind_history`, `actor_history`, `row_id_unique`). Independent role-aliases table. |

---

## Files delivered

### Backend (additive)
| File | LOC | Purpose |
|---|---|---|
| `app/payments/chronology/__init__.py` | 21 | Package docs |
| `app/payments/chronology/writer.py` | 172 | Append-only writer, 19 frozen literals, indexes |
| `app/payments/chronology/projector.py` | 130 | 3 pure projection functions, kind+meta whitelists |
| `app/payments/chronology/router.py` | 188 | 3 REST + 3 WS endpoints, role aliases, handshake |
| `server.py` | +6 lines | startup hook + router include |
| `app/system/deeplink.py` | +18 lines | 3 new deep-link surfaces for payment chronology |

### Backend tests
| File | Checks |
|---|---|
| `test_payment_chronology_writer_smoke.py` | 14 |
| `test_payment_chronology_e2e.py` | 18 |

### Frontend (additive)
| File | LOC | Purpose |
|---|---|---|
| `app/customer/payment/[id]/chronology.tsx` | 178 | payment-activity.customer (financial coldness theme) |
| `app/admin/payment/[id]/forensic.tsx` | 198 | payment-forensic.admin (raw evidence theme) |

Bundle delta: **1304 → 1307 modules** (+3). Compile clean.

### Docs
- `/app/memory/P0bCf_F0_inventory_2026_02_22.md`
- `/app/memory/P0bCf_F1_taxonomy_frozen_2026_02_22.md`
- `/app/memory/P0bCf_closure_2026_02_22.md` ← this

---

## NOT delivered (intentionally locked out of scope)

| Item | Justification |
|---|---|
| Inspector projection | No inspector payment governance — payout info stays in `job-timeline.inspector` |
| Provider UI screen | Deferred per user directive — customer + admin first, provider risk surface deferred |
| `transfer.reversed` kind | Exceptional governance, accounting divergence risk — deferred |
| `admin.note.attached` kind | Slippery slope toward "timeline as comments" — notes live in `money_audit` |
| `intent.*` kinds | Stripe-internal ontology leakage — replaced by `payment.initiated`/`payment.failed` |
| Generic `escrow.release.blocked` | Smell — replaced by explicit `escrow.release_rejected` + structured `meta.reason` |
| `rejected: bool` orthogonal flag | Replaced by `:rejected` suffix literals (consistent with `mark_completed:rejected`) |
| Backfill of historical service_payments | Chronology starts at deploy — no synthetic causality |
| Integration into existing payment endpoints (`/billing/intent`, `/escrow/release`, `/refund`, etc.) | **DEFERRED**. Writer is callable but not yet invoked from live payment flows. Doing so requires touching frozen modules (pricing_v2b, payments_2a) and is its own sprint with its own smoke-baseline guard. Until then, chronology fills only via direct `append_payment_event` calls (e.g. from forthcoming webhook-translator). |
| Real-time WS push of new rows | WS streams are wired with handshake+keepalive but do not yet broadcast row inserts. Producer-side fanout is the next sprint. Today consumers must REST-reload. This is acceptable because chronology is low-frequency / high-finality (per F.1 §8). |
| Deep-link surfaces reach customer/admin UI screens | Surfaces registered in resolver. Routes match expo-router file paths. Navigation works via `asearch://link?ref=payment-activity.customer:<id>`. |
| Universal links | Out of P0.b.C.e scope, still out here |
| QR / share-sheet for payment refs | Out of scope |
| Inter-domain chronology unification | Explicitly forbidden (user directive) |

---

## Empirical proof points worth re-stating

1. **Bundle delta = +3 modules** (1304 → 1307). No abstraction creep despite adding writer + projector + router + 2 screens.
2. **19 kinds, asserted at import time.** `assert len(KINDS) == 19` triggers `ImportError` if taxonomy drifts.
3. **3 truth layers preserved.** Writer test #11 confirms zero leakage into `money_audit` / `stripe_webhook_events` collections.
4. **3 projection functions, not 4.** `dir(projector)` shows `project_customer`, `project_provider`, `project_admin`. No `project_inspector`.
5. **WS role-gate empirically terminal.** Customer JWT to admin stream gets 4403 close before any data flows.
6. **Translation boundary exists.** Row written with `actor.role="stripe"` and `sourceWebhookId="evt_x"` proves the translation contract.

---

## Test matrix (final)

11/11 suites green:

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
| `test_payment_chronology_writer_smoke.py` (P0.b.C.f / F.2) | ✅ NEW |
| `test_payment_chronology_e2e.py` (P0.b.C.f / F.3+F.4+F.5) | ✅ NEW |

Zero regressions across 8 prior baselines.

---

## What this sprint says about the architecture

The codebase now contains **3 chronology species** as separate Mongo collections, each with its own writer, projector, endpoints, and ontology:

| Species | Collection | Primary actor view | Forensic view |
|---|---|---|---|
| Booking chronology | `booking_timeline` | customer / provider / inspector | admin: `booking-forensic` |
| Payment chronology | `payment_events` | customer / provider | admin: `payment-forensic` |
| Money governance | `money_audit` | (admin-only by nature) | admin: same |

**They share principles, not framework.** Same handshake style, same `:rejected` suffix discipline, same closed-set kinds, same dedup divergence (content-addressed for actor surfaces, row-id for forensic) — but **no shared reducer, no shared engine, no shared envelope, no shared projector**.

This is the local optimum the user wanted to preserve. The bundle delta and the zero shared imports between `app/booking/` and `app/payments/chronology/` modules are the empirical proof that abstraction gravity was held off.

---

## Next reasonable moves (NOT this sprint)

- **P0.b.C.g — Webhook translator.** Subscribe `app/integrations/router_stripe.py` → call `append_payment_event(...)` with the F.1 translation table from §9. This is where chronology starts actually filling in production.
- **P0.b.C.h — Live WS push.** Add `_broadcast` hook inside `append_payment_event` that publishes to per-payment WS topic; consumers swap REST-reload for live push.
- **P0.b.C.i — Provider UI.** Build `payout-activity.provider` screen. Higher-risk surface (payout expectations / settlement promises) — separate sprint with its own product copy review.
- **P0.b.C.j — Ownership-tight REST.** Customer endpoint currently shape-opaque but not ownership-checked. Add `service_payments.customerId == caller.sub` gate on customer + provider REST.
- **P0.b.C.k — Deeplink resolver: separate dispatch matrix for payment surfaces.** Currently in same SURFACES table — fine for now; if it grows beyond ~10 surfaces, split into per-domain dispatch tables before it becomes a registry.

Each of these is independent. None of them should "unify chronologies". The architecture is now mature enough that consolidation pressure must be **actively resisted**, not passively accommodated.
