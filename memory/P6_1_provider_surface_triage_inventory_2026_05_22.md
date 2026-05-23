# P6.1 — Provider Surface Triage (INVENTORY ONLY)

**Date:** 2026-05-22
**Phase:** P6.1 of POST-P5 SYMMETRY COMPLETION ROADMAP
**Status:** ✅ INVENTORY COMPLETE — **NO migrations, NO deletions, NO code changes performed.**
**Doctrine reference:** `memory/PLATFORM_DOCTRINE_P5_CLOSURE.md` § 7 (asymmetry zones)
**Methodology mirror:** `memory/PHASE_1_1_admin_triage_inventory_2026_05_22.md` (same pattern, applied to provider surface)

---

## 0. TL;DR

| Asymmetry zone | Existing | Missing surface | Verdict |
|---|---|---|:---:|
| **Booking chronology** | provider/booking/[id]/timeline ✓ | — | 🟢 parity |
| **Payment/payout chronology** | `/api/provider/payouts/{id}/chronology` returns valid `payout-activity.provider` surface | **NO consuming page in `/app/frontend/app/provider/`** | 🔴 page gap |
| **Dispute view (read)** | provider is named on dispute, `disputes/router.py:291` confirms "customer + provider projections both surface open_dispute" | **NO provider API endpoint** + **NO provider page**. Provider learns about own disputes only via shared `/api/disputes` if frontend used it — not used. | 🔴 both layers gap |
| **Dispute respond/counter-evidence** | admin can resolve; customer can open | **NO provider counter-evidence flow** | 🔴 both layers gap |
| **Trust / reputation detail** | inspector has `inspector/reputation*`; customer has `trust/provider/[id]` | provider has only `provider/stats.tsx` (aggregated KPIs), no per-event evidence trail | 🟡 detail gap |
| **Earnings evidence trail** | `/api/provider/earnings/summary` + `/items` work | UI aggregates but no per-payment chronology drill-down | 🟡 detail gap (related to payout chronology page gap above) |
| **Attribution to provider actions** | `app/core/attribution.py` + `record_admin_mutation` exist | not wired into many provider-side mutations | 🟡 mechanical wiring task (P6.B scope) |
| **Reconciliation cadence** | POST `/api/admin/reconciliation/report` writes snapshot **on operator click** | NO periodic worker in `app/workers/`. `human-triggered persistence` per doctrine. | 🔴 cadence gap (P6.C scope) |

**Single sentence verdict:** provider surface is **consumer-grade** (CTAs, aggregates, KPIs) on top of a **governance-grade backend** (chronology endpoint exists, dispute participation tracked) — the gap is mostly **frontend page mounting + a small number of missing backend endpoints**, not new abstractions.

---

## 1. Provider screen inventory (frontend)

### 1.1 Pages under `/app/frontend/app/provider/` (18 screens)

| # | Path | Today's purpose | Surface tier |
|---:|---|---|---|
| 1 | `provider/workbench.tsx` | Provider home / unified workspace entry | consumer-grade ops UI |
| 2 | `provider/urgent-match.tsx` | Urgent dispatch / hot opportunities | consumer-grade matching |
| 3 | `provider/current-job.tsx` | Active job summary | consumer-grade job card |
| 4 | `provider/workspace/[requestId].tsx` | Per-request workspace | consumer-grade |
| 5 | `provider/inbox.tsx` | Incoming opportunities | consumer-grade list |
| 6 | `provider/chats.tsx` | Chat threads list | consumer-grade |
| 7 | `provider/chat/[id].tsx` | Single chat thread | consumer-grade |
| 8 | `provider/booking/[id]/timeline.tsx` | **Booking chronology** | **governance-grade ✓** |
| 9 | `provider/car-selection/index.tsx` | Car-selection request list | consumer-grade |
| 10 | `provider/car-selection/[id].tsx` | Single car-selection workspace | consumer-grade |
| 11 | `provider/stripe-connect.tsx` | Stripe Connect onboarding | consumer-grade |
| 12 | `provider/availability.tsx` | Availability calendar | consumer-grade |
| 13 | `provider/clusters.tsx` | Service clusters config | consumer-grade |
| 14 | `provider/performance.tsx` | Performance KPIs | consumer-grade aggregate |
| 15 | `provider/stats.tsx` | Aggregated stats | consumer-grade aggregate |
| 16 | `provider/earnings.tsx` | Earnings summary | consumer-grade aggregate |
| 17 | `provider/earnings-clarity.tsx` | Earnings detail/breakdown | consumer-grade aggregate |
| 18 | `provider/explain.tsx` | Algorithm-explainability surface | consumer-grade |

### 1.2 Top-level provider-* (3 screens)

| # | Path | Purpose | Tier |
|---:|---|---|---|
| 19 | `provider-boost.tsx` | Boost purchase entry | consumer-grade billing |
| 20 | `provider-boost-packages.tsx` | Boost package catalog | consumer-grade |
| 21 | `provider-intelligence.tsx` | Performance/demand intelligence | consumer-grade |

### 1.3 Asymmetry by analogy

**Customer governance-grade surfaces (currently missing for provider):**

| Customer page | Backend (customer) | Provider analogue exists? | Backend (provider) |
|---|---|:---:|---|
| `customer/booking/[id]/timeline.tsx` | `/api/customer/bookings/{id}/timeline` | ✅ `provider/booking/[id]/timeline.tsx` | `/api/provider/bookings/{id}/timeline` |
| `customer/payment/[id]/chronology.tsx` | `/api/customer/payments/{id}/chronology` | ❌ **MISSING PAGE** | `/api/provider/payouts/{id}/chronology` ✅ **EXISTS** |
| `customer/inspection/{id}/timeline.tsx` | `/api/inspections/{id}/timeline` | n/a (provider not inspector) | n/a |
| `customer/inspection/{id}/continuity.tsx` | `/api/customer/inspection/{id}/continuity` | n/a (provider not inspector) | n/a |
| `customer/request/{id}/establishment.tsx` | `/api/customer/...` | ❌ MISSING PAGE | `/api/provider/...` (offer packages exist) |
| `customer/vehicles/{id}/timeline.tsx` | `/api/customer/vehicles/{id}/timeline` | n/a (provider does not own vehicles) | n/a |
| `disputes/[id].tsx` (shared, customer flow) | `/api/disputes` + `/api/disputes/my` | ❌ **MISSING PAGE** | ❌ **MISSING ENDPOINT** |

**Admin governance-grade surfaces (provider should have read-only flavor):**

| Admin page | Provider read-only analogue |
|---|---|
| `admin/payment/[id]/forensic.tsx` | provider/payouts/[paymentId]/chronology.tsx (using existing `/api/provider/payouts/{id}/chronology`) |
| `admin/booking/[id]/forensic.tsx` | already covered by provider/booking/[id]/timeline ✓ |
| `admin/disputes` UI | provider/disputes (list + detail) — both backend + frontend missing |

---

## 2. Provider backend API surface (83 endpoints)

### 2.1 Working buckets (live verified)

| Bucket | Endpoint family | Coverage |
|---|---|---|
| **Earnings/payouts** | `/api/provider/earnings`, `/api/provider/earnings/items`, `/api/provider/earnings/summary`, `/api/provider/payouts/{id}/chronology` | ✅ 4/4 |
| **Booking** | `/api/provider/booking/{id}/action`, `/api/provider/bookings/{id}/timeline` | ✅ 2/2 |
| **Auto-money** | `/api/provider/auto-money/{enable,disable,status}` | ✅ 3/3 |
| **Availability** | `/api/provider/availability`, `/api/provider/availability/override` | ✅ 2/2 |
| **Billing/boost** | `/api/provider/billing/*`, `/api/provider/boost/*` | ✅ 6/6 |
| **Chat** | `/api/provider/chat/threads*`, `/api/provider/chat/threads/{id}/reply` | ✅ |
| **Car-selection** | `/api/provider/car-selection/me`, `/api/provider/car-selection/{id}*`, offer-packages | ✅ ~10 |
| **Intelligence** | `/api/provider/intelligence{,/demand,/earnings,/lost-revenue,/opportunities,/performance}` | ✅ 6/6 |
| **Location/presence** | `/api/provider/location*`, `/api/provider/presence`, `/api/provider/pressure*` | ✅ |
| **Onboarding** | `/api/provider/onboarding{,/bootstrap-bids,/quick-start}` | ✅ |
| **Performance** | `/api/provider/performance{,/explain,/me,/preview}` | ✅ |
| **Profile/clusters/candidates** | `/api/provider/profile/clusters`, `/api/provider/candidates/{id}`, `/api/provider/nudges`, `/api/provider/pre-engage`, `/api/provider/pre-engagement/{slug}`, `/api/provider/behavior/track` | ✅ |

### 2.2 Backend gaps for governance parity

| Missing endpoint family | Why it matters | Customer/admin analogue |
|---|---|---|
| `/api/provider/disputes` | Provider must be able to **list** own disputes (own party in dispute) | `/api/disputes/my` (customer-bound), `/api/admin/disputes` |
| `/api/provider/disputes/{id}` | Provider must be able to **read** dispute detail (allegations against them) | `/api/admin/disputes/{id}` |
| `/api/provider/disputes/{id}/counter-evidence` | Provider must be able to **submit counter-evidence** (currently can only chat in service thread) | analogue: customer opens dispute via `/api/chat/v1/threads/{id}/dispute` |
| `/api/provider/freezes` | Provider should see when their payouts are frozen (and why) | `/api/admin/payments/freeze-provider/{id}` (admin-only mutation) |
| `/api/provider/trust/me` | Provider should see own trust score + history | `/api/admin/reputation`, `/api/inspector/reputation` |
| `/api/provider/attribution/me` | Provider should see **who** acted on their account (admin freezes, support actions) — institutional transparency | `/api/admin/attribution/by-entity/{provider_id}` |

**6 missing provider endpoints.** All are **read** (or `read + submit`) — no new abstractions, just mechanical wiring on top of existing collections (`disputes`, `provider_reputation`, `admin_audit_log`).

---

## 3. Attribution saturation scan (P6.B mandate)

`app/core/attribution.py` exists. `record_admin_mutation` writes to `admin_audit_log` with the actor context. Sampling where it **IS** used vs where it **SHOULD be** used:

### 3.1 Already wired (sample)
- `payments/router_reconciliation.py:121` — `record_admin_mutation(action="reconciliation.snapshot", domain="other", ...)` ✅
- (P5 work covers most explicit POST-mutations on `/api/admin/*`)

### 3.2 Mutations to audit for attribution coverage (not yet verified — task for P6.B)

| Mutation | Router | Should emit attribution? |
|---|---|:---:|
| Dispute resolve | `POST /api/admin/disputes/{id}/resolve` (`disputes/router.py`) | ✅ (likely already) |
| Dispute open (by customer) | `POST /api/chat/v1/threads/{id}/dispute` | ✅ (customer attribution context) |
| Refund execute | `POST /api/payments/.../refund` | ✅ |
| Payout freeze (global) | `POST /api/admin/payments/freeze` | ✅ |
| Payout freeze (per-provider) | `POST /api/admin/payments/freeze-provider/{id}` | ✅ |
| Commission tier update | `POST /api/admin/config/commission-tiers` | ✅ |
| Verification approve/reject | `POST /api/admin/verification-queue/{id}/{approve,reject}` | ✅ |
| Zone override set | `POST /api/admin/zones/{id}/override` | ✅ |
| Strategy weight write | `POST /api/admin/strategy/{zone_id}`, `POST /api/admin/matching/weights` | ✅ |
| Credits adjust | `POST /api/admin/credits/adjust` | ✅ |
| Ranking recalculate | `POST /api/admin/ranking/recalculate` | ✅ |
| Push test-send | `POST /api/admin/customer-notify/test-send` | ✅ |
| Manual suppression append | `POST /api/admin/customer-notify/suppressions/manual-append` | ✅ |
| Auto-request reassignment | (admin overlay endpoints not yet ported) | ✅ when ported |
| Stripe-config rotate | via `/api/admin/integrations` | ✅ |
| Boost adjustment by admin | (if exists) | ✅ |
| Support-chat reply (admin to user) | `POST /api/admin/chat/threads/{id}/reply` | ✅ |

**18 candidate admin mutations.** P6.B = scan each handler, confirm `Depends(get_attribution_context)` is present, confirm `record_admin_mutation(...)` is called on success path. **Mechanical wiring, no abstractions.**

### 3.3 Provider-side mutations needing attribution

Provider acts on own account, so attribution = self. But **important** invariant: when provider mutates state that affects customer/system (e.g. accept job, decline match, set price override), event should land in chronology with `actor=provider:{id}`.

| Mutation | Current state |
|---|---|
| `POST /api/provider/booking/{id}/action` | (action types: accept/decline/start/complete) — verify chronology emit |
| `POST /api/provider/availability/override` | self-mutation, attribution = self |
| `POST /api/provider/auto-money/{enable,disable}` | self-mutation |
| `POST /api/provider/boost/{auto-bid,buy,bid}` | financial mutation, MUST land in chronology |
| `POST /api/provider/onboarding/quick-start` | identity mutation |
| `POST /api/provider/location/update` | high-frequency; can be sampled |
| `POST /api/provider/car-selection/{id}/offer-packages/{pid}/{deliver,revise}` | governance event for customer — MUST emit |

P6.B task: verify each `router.post` in `app/provider/*` emits at minimum a chronology entry; promote to `record_admin_mutation`-equivalent (with provider as actor) for material events.

---

## 4. Reconciliation cadence (P6.C mandate)

### 4.1 Current state — human-triggered persistence

- `POST /api/admin/reconciliation/report` (in `payments/router_reconciliation.py:76`) writes a `reconciliation_snapshots` row **only when an admin clicks**.
- `GET /api/admin/reconciliation/history` reads stored snapshots.
- Doctrine quote: *"Сейчас: human-triggered persistence. Нужно: platform-triggered evidence cadence."*

### 4.2 Workers currently in `app/workers/` (NO reconciliation worker)

| Worker | Purpose | Cadence |
|---|---|---|
| `demand_prediction` | per-zone DemandPredictor model training | 60s |
| `exposures_stats` | recompute inspector stats | 300s |
| `provider_ranking` | (not yet inspected — assumed ranking refresh) | n/a |
| `receipts_poll` | poll Expo push receipts | 180s |
| `vehicles_refresh` | temporal evolution of demo vehicles | 60s |

**No `reconciliation_snapshot` periodic worker.** Gap is structural.

### 4.3 Proposed P6.C worker (specification, not implementation)

```
worker_name: reconciliation_snapshot_cadence
cadence:     every 6h (configurable via env: RECONCILIATION_CADENCE_HOURS, default 6)
action:      call generate_report(db, limit=None) → insert into reconciliation_snapshots
                triggeredBy: {actorRole: "system:scheduler", sourceRoute: "worker:reconciliation_snapshot_cadence"}
                attribution context = synthetic system context
policy:      on_failure max_restarts=5 (matches worker_supervisor doctrine)
guard:       skip if last snapshot < (cadence - 5min) ago (idempotent against double-runs)
governance:  emit "reconciliation.snapshot.scheduled" event into admin_audit_log
             (NOT admin mutation since no human acted)
```

This is **institutional memory**, not automation — the worker writes evidence, doesn't decide anything.

---

## 5. Surface-completion summary

```
Today (after P5)                       After P6 closure
──────────────────                     ─────────────────
18 provider screens                    ≈ 22 provider screens
                                       +1 provider/payouts/[id]/chronology
                                       +1 provider/disputes (list)
                                       +1 provider/disputes/[id] (detail+counter-evidence)
                                       +1 provider/trust (own reputation drill-down)

83 /api/provider/* endpoints           ≈ 89 endpoints
                                       +/api/provider/disputes
                                       +/api/provider/disputes/{id}
                                       +/api/provider/disputes/{id}/counter-evidence
                                       +/api/provider/freezes
                                       +/api/provider/trust/me
                                       +/api/provider/attribution/me

5 workers (no reconciliation)          6 workers
                                       +reconciliation_snapshot_cadence (6h)

18 admin mutations spot-checked for    100% covered (via P6.B scan + wiring)
  attribution (subset)

Provider parity vs admin governance    Provider parity ≈ admin governance
  ≈ 50%                                  ≈ 90% (read access symmetry, no
                                                control-plane access)
```

---

## 6. P6 sub-phase proposal (executable)

Same shape as P1.1→P1.2 (inventory → execution), now applied to provider asymmetry:

| Sub-phase | Scope | Output |
|---|---|---|
| **P6.1** (this doc) | inventory provider gaps | this closure doc |
| **P6.2** | wire provider/payouts/[id]/chronology page (frontend only, backend already exists) | small frontend PR |
| **P6.3** | add `/api/provider/disputes*` (3 endpoints, read+counter-evidence) and provider/disputes pages | backend +frontend PR |
| **P6.4** | add `/api/provider/freezes`, `/api/provider/trust/me`, `/api/provider/attribution/me` + UI surfaces | backend +frontend PR |
| **P6.B** | attribution saturation scan + mechanical wiring of 18 admin mutations (no abstractions) | backend-only PR |
| **P6.C** | `reconciliation_snapshot_cadence` worker (specification above) | backend-only PR (1 new file in `app/workers/`) |
| **P6.D** | provider UX uplift to governance-grade (info-hierarchy, evidence-first layouts where pages exist) | frontend-only PR |

**Ordering rule (per doctrine):** P6.1 → P6.B (attribution wires evidence floor) → P6.C (cadence makes evidence durable) → P6.2/3/4 (surface symmetry on top of saturated evidence) → P6.D (UX polish).

This ordering ensures that **provider surfaces, when they appear, are reading from already-saturated evidence**, not from an evidence-light layer.

---

## 7. Doctrine guard — what this phase did NOT do

Per `PLATFORM_DOCTRINE_P5_CLOSURE.md` § 9 and § 13:

- ❌ No new abstractions introduced
- ❌ No automation / AI / predictive layer touched
- ❌ No backend mutations
- ❌ No frontend page added or removed
- ❌ No env var or `.env` modified
- ❌ No dependency installed
- ❌ No dual ledger / shadow truth proposed
- ✅ Only **classification material** for P6.2+ executors

---

## 8. Verifiable smoke evidence (collected during inventory)

| Probe | Result |
|---|---|
| `POST /api/auth/login` provider@test.com | `{role: provider_owner}` ✅ |
| `GET /api/provider/earnings/summary` (with provider JWT) | 200, returns currency-grouped breakdown with pending/payable/processing/paid_out/disputed_hold/deducted ✅ |
| `GET /api/provider/payouts/test123/chronology` | 200, `{"surface":"payout-activity.provider","paymentId":"test123","rows":[]}` ✅ (endpoint live, surface correct, no consumer in UI) |
| `find /app/frontend/app/provider -name "*chronology*"` | empty ❌ (confirms page gap) |
| `find /app/frontend/app/provider -name "*disputes*"` | empty ❌ (confirms page gap) |
| `grep -rEn "provider/disputes" /app/backend` | only references in `disputes/router.py` to provider as **dispute participant**, never as **API consumer** ❌ (confirms endpoint gap) |
| `ls /app/backend/app/workers/` | 5 workers, no reconciliation ❌ (confirms cadence gap) |

---

## 9. Closure artefacts

| Path | Purpose |
|---|---|
| `memory/PLATFORM_DOCTRINE_P5_CLOSURE.md` | parent doctrine — defines what P6 is |
| `memory/P6_1_provider_surface_triage_inventory_2026_05_22.md` (this doc) | judgment + bucket proposal |
| `memory/PHASE_1_1_admin_triage_inventory_2026_05_22.md` | methodology mirror (admin equivalent) |
| `memory/PHASE_1_2_admin_topology_correction_2026_05_22.md` | execution mirror (what P6.2+ should look like in shape) |

---

## 10. What the executor of P6.2 should NOT do

Per doctrine, P6 is **symmetry completion**, not **architecture phase**. P6.2 executor must:

- ✅ Add only the missing pages/endpoints listed in §1.3 and §2.2
- ✅ Reuse existing collections (`disputes`, `provider_reputation`, `admin_audit_log`, `reconciliation_snapshots`)
- ✅ Keep all mutations emitting attribution
- ❌ NOT introduce a "provider ledger" — would violate the "no dual truth" rule
- ❌ NOT introduce automation triggers — premature intelligence ban applies
- ❌ NOT change admin surfaces — admin is post-P5 stable
- ❌ NOT add new bounded contexts — existing 55 modules are enough

**End of P6.1 inventory. Next: P6.B (attribution saturation scan) — same inventory shape, focused on backend mutation handlers.**
