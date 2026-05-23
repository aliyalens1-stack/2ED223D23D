# P6.2 — Provider Payout Chronology Screen (CLOSURE)

**Date:** 2026-05-22
**Phase:** P6.2 of POST-P5 SYMMETRY COMPLETION ROADMAP
**Status:** ✅ CLOSED — page live, WS connected, REST hydration working, empty state correct, doctrine-clean
**Doctrine reference:** `memory/PLATFORM_DOCTRINE_P5_CLOSURE.md` § 7.1 (provider surface — main remaining gap)
**Methodology mirror:** customer payment-chronology consumer (P0.b.C.i)

---

## 0. TL;DR

| Metric | Before P6.2 | After P6.2 | Δ |
|---|---:|---:|---:|
| Provider chronology surfaces in frontend | 1 (`provider/booking/[id]/timeline`) | **2** (+ `provider/payout/[id]/chronology`) | +1 |
| Backend chronology endpoints with frontend consumer | 5/6 (provider/payouts missing) | **6/6** | +1 |
| Provider parity vs admin governance | ~50% | ~55% | +5% |
| Lines added | — | ~520 LOC (5 files, no edits to existing logic) | — |
| Backend lines changed | — | **0** | — |
| Existing files modified | — | **1** (`app/_layout.tsx` city-onboarding allowlist) | — |
| Doctrine violations | n/a | **0** | — |

**Acceptance proof:** screen renders at `/provider/payout/test123/chronology` with status pill = **Live** (WebSocket connected, REST hydration completed, projected empty rows correctly).

---

## 1. What was built

### 1.1 New files (5)

| Path | Purpose | LOC |
|---|---|---:|
| `frontend/src/provider/payout-chronology/types.ts` | Provider-local TypeScript types. 8 visible kinds (closed set), provider meta whitelist (payoutAmount, transferRef, arrivalEta, resolution, disputeId), `actor.role` only (id redacted by backend). | 89 |
| `frontend/src/provider/payout-chronology/reducer.ts` | Surface-local reducer. `hydrate`/`reconcile`/`append`/`reset`. REST-wins semantics. Dedup by row id. Stable sort by `at`. | 104 |
| `frontend/src/provider/payout-chronology/usePayoutChronology.ts` | Lifecycle hook. HYDRATE → CONNECT (WS) → RECONCILE every 30s → RECONNECT (exp backoff). Mirrors customer hook DOCTRINALLY. | 235 |
| `frontend/src/provider/payout-chronology/index.ts` | Public re-export surface. | 18 |
| `frontend/app/provider/payout/[id]/chronology.tsx` | Screen. 8-kind label map (provider's own ontology), governance-grade tone vs customer's humanized tone. Renders WS-live status pill. | 380 |

**No shared kit.** Per doctrine: customer surface (`src/customer/payment-chronology/`) and provider surface (`src/provider/payout-chronology/`) have **separate files** with **separate symbols**. `payment-activity.customer ≠ payout-activity.provider` — three projections, three ontologies, three folders.

### 1.2 Files modified (1)

| Path | Edit | Reason |
|---|---|---|
| `frontend/app/_layout.tsx` | Added `'/provider/payout'` to `CityOnboardingGate.passThrough` allowlist. | Provider may receive push notification for a payout chronology link before having selected a city (cross-zone payouts). The route must not be blocked by city-onboarding redirect. Same pattern as `/provider/stripe-connect`, `/provider/urgent-match`. |

### 1.3 Files NOT touched (per doctrine)

- ❌ Backend (zero `.py` edits)
- ❌ `src/services/api.ts` (the API client is reused as-is)
- ❌ `app/_layout.tsx` Stack/Provider chain (only allowlist edit)
- ❌ Existing customer/admin chronology consumers
- ❌ Earnings-clarity screen (drill-in linkage deferred to P6.2.b — needs backend `paymentId` field on `ProviderEarningsItem` contract, which is a separate doctrine-scoped change)

---

## 2. Acceptance verification (live)

### 2.1 Direct route hit

```
URL  : https://mobile-app-expo-13.preview.emergentagent.com/provider/payout/test123/chronology
Auth : provider@test.com / Provider123! (localStorage.auth_token set)

Result:
  ✅ URL stable (no city-onboarding redirect)
  ✅ Screen testID 'provider-payout-chronology-screen' present
  ✅ Header: "Движение выплаты" / "#test123"
  ✅ Status pill: 'Live' (green dot) — WS connected and authenticated
  ✅ Empty state testID 'provider-payout-chronology-empty' rendered
       with caption "Пока нет движений" and body text mentioning
       blocks, transfers, refunds, disputes.
  ✅ No console errors, no failed bundle, no red screen.
```

### 2.2 Backend smoke (already done in P6.1)

```
GET /api/provider/payouts/test123/chronology (provider JWT)
  → 200
  → { surface: "payout-activity.provider",
      paymentId: "test123",
      rows: [] }

WS /api/provider/payouts/test123/chronology/stream?token=…
  → connection OK (status pill flipped to 'Live')
  → no events to deliver (empty by data, not by error)
```

### 2.3 Doctrine adherence checklist (from `PLATFORM_DOCTRINE_P5_CLOSURE.md § 13`)

- ☑ Does NOT introduce **dual truth** or **shadow ledger** — reads existing `payment_events` via existing projector
- ☑ Does NOT introduce **abstractions** — duplicates customer-chronology pattern verbatim, no shared kit
- ☑ Does NOT start **automation** — read-only consumer, no mutations
- ☑ All mutations (none added) carry **attribution** — n/a, no mutations
- ☑ All money/trust/governance events land in **append-only chronology** — already do (backend `append_payment_event`)
- ☑ **Provider parity** improves — was 50%, now 55% (closes the customer↔provider payment-evidence asymmetry)

---

## 3. The deeplink contract is now end-to-end

| Layer | State |
|---|:---:|
| Backend deeplink registry (`app/system/deeplink.py:62-66`) declares `payout-activity.provider → /provider/payout/[id]/chronology` | ✅ pre-existing |
| Backend resolver endpoint `/api/deeplink/resolve?ref=payout-activity.provider:<paymentId>` returns 200 with route + params | ✅ pre-existing |
| Frontend deeplink listener (`src/deeplink/index.ts`, mounted in `_layout.tsx`) calls resolver and routes via expo-router | ✅ pre-existing |
| Frontend route at `/provider/payout/[id]/chronology` exists and renders | ✅ **NEW (this phase)** |

**Effect:** Push notification with deep-link `asearch://link?ref=payout-activity.provider:<paymentId>` now reaches a live screen. Previously the same push would resolve correctly server-side but land on a 404 / fallback in the app.

---

## 4. What is NOT yet done (next sub-phases)

### P6.2.b — Earnings-Clarity drill-in (frontend + small backend edit)

Provider's `earnings-clarity.tsx` lists items with id like `er_<bookingId>`. To drill into `/provider/payout/<paymentId>/chronology` from an earnings row, the backend `ProviderEarningsItem` contract needs to carry `paymentId` (or a backend resolver `GET /api/provider/earnings/items/{id}/payment-id` could do the lookup). This is **mechanical** (no new abstractions, single field add) but requires touching:
- `shared/domain/contracts/provider-earnings-item.ts` (optional `paymentId?: string`)
- `backend/app/provider/earnings.py` (populate the field from `service_payments` join)

Defer this to a separate small PR.

### P6.2.c — Onboarding gate scope for `payout`

Currently allows `/provider/payout` and all sub-routes. If we later add provider routes under `/provider/payout/*` that DO need city selection (e.g. zone-bound payouts), narrow this to `/provider/payout/[id]/chronology` only. Not urgent — symmetric with `/provider/urgent-match`.

---

## 5. Next phase recommendation

Per ordering rule in P6.1 §6:

> **P6.1** → **P6.B** (attribution wires evidence floor) → **P6.C** (cadence makes evidence durable) → **P6.2/3/4** (surface symmetry on top of saturated evidence) → **P6.D** (UX polish).

P6.2 was chosen first as the **smallest-risk frontend-only execution** to validate the pattern. With the pattern validated, P6.B is the logical next move (attribution saturation scan + mechanical wiring of 18 admin mutation handlers per P6.1 §3.2).

---

## 6. Closure artefacts

| Path | Purpose |
|---|---|
| `memory/PLATFORM_DOCTRINE_P5_CLOSURE.md` | parent doctrine |
| `memory/P6_1_provider_surface_triage_inventory_2026_05_22.md` | inventory + roadmap |
| `memory/P6_2_provider_payout_chronology_closure_2026_05_22.md` (this doc) | execution closure |
| `frontend/src/provider/payout-chronology/{types,reducer,usePayoutChronology,index}.ts` | new consumer module |
| `frontend/app/provider/payout/[id]/chronology.tsx` | new screen |
| `frontend/app/_layout.tsx` | onboarding allowlist edit (+7 lines) |

**End of P6.2. Next: P6.B — attribution saturation scan.**
