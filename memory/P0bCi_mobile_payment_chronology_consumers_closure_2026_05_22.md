# P0.b.C.i — Mobile consumers for payment chronology

**Date:** 2026-05-22
**Sprint:** P0.b.C.i
**Status:** ✅ CLOSED — bundle clean, reducer smoke green (24/24)
**Predecessor:** P0.b.C.h (writer → projector → WS fanout realtime layer)
**Pattern reference:** P0.b.C.d.UI.a / P0.b.C.d.UI.d (booking timeline + forensic consumers)

---

## 1. Scope (what shipped)

Two mobile consumer screens — and nothing else:

* `payment-chronology.customer`
  Route: `/customer/payment/[id]/chronology`
* `payment-forensic.admin`
  Route: `/admin/payment/[id]/forensic`

Provider UI is **deliberately deferred**. The taxonomy says provider
sees `transfer.*`, but until the provider business surface is decided,
shipping a provider-facing chronology screen creates ontology pressure
without product clarity. Better to keep the WS hub open and the data
flowing, and let the provider screen arrive as its own sprint when
the use-case is locked.

## 2. Files

**NEW** — customer surface (`src/customer/payment-chronology/`)

* `types.ts` — closed-set `CustomerPaymentKind` literal type (11 kinds),
  `CustomerPaymentTone` literal type, `CustomerPaymentEvent` shape
  (matches `P.project_customer` output byte-for-byte), REST snapshot
  + WS envelope types.
* `reducer.ts` — surface-local reducer: `hydrate`, `reconcile`, `append`,
  `reset`. Dedup by `event.id`. Stable sort: at ASC, null-last, id
  lex tiebreak.
* `usePaymentChronology.ts` — hook owning HYDRATE → CONNECT → RECONCILE
  every 30 s → RECONNECT backoff (1 s → 2 s → 4 s → 10 s cap).
* `index.ts` — narrow public surface (`useCustomerPaymentChronology`,
  `dedupKey`, types). Importers must come from the customer surface
  only.

**NEW** — admin surface (`src/admin/payment-forensic/`)

* `types.ts` — `ForensicPaymentRow` (raw shape with `actor.id`, full
  meta dict, `sourceWebhookId`, `schemaVersion`). Wire `kind` is a
  plain `string`, not the closed customer literal — admin sees
  `:rejected` and `admin.*` variants verbatim.
* `reducer.ts` — surface-local reducer: `hydrate`, `append`,
  `appendMany`, `reset`. `appendMany` is the burst-tolerant entry-point
  for post-reconnect catch-up. Sort: at ASC, null-last, id lex tiebreak.
* `useAdminPaymentForensic.ts` — hook with same 4-phase lifecycle as
  customer, plus `forbidden` terminal state on 4403/4401 (no retry).
* `index.ts` — admin-surface public exports. No symbol collision with
  the customer-surface package — there is no shared kit.

**NEW** — screens

* `app/customer/payment/[id]/chronology.tsx` — humanized, calm, 11
  closed `KIND_LABEL` entries with tone, optional `вы` self-action
  badge, ISO timestamps, amount in major units, dispute id short ref.
* `app/admin/payment/[id]/forensic.tsx` — terminal/monospace
  aesthetic, raw kind verbatim (including `:rejected` red rows and
  `admin.*` purple rows), expandable JSON meta block, counters
  (rows / rejected / admin-only). 4403 → forbidden terminal state.

**NEW** — pure-unit smoke

* `frontend/test_payment_consumers_reducers_smoke.js` — TypeScript-
  transpiled on-the-fly via the in-tree `typescript` package. 24
  assertions across 3 sections.

## 3. Doctrine carryover (DELIBERATE duplication, not shared code)

The discipline says: **surface-local reducers, no shared chronology kit**.
Both consumers reimplement the same shapes (`hydrate`/`append`/`reset`
+ dedup + sort), but each in its OWN file with its OWN type vocabulary.

Why duplicate? Because the two surfaces speak different ontologies:

| Concern               | `payment-chronology.customer`    | `payment-forensic.admin`           |
|-----------------------|----------------------------------|------------------------------------|
| Visible kinds         | 11 closed literals               | 19 closed literals incl. `:rejected` |
| Kind humanization     | yes, per-screen `KIND_LABEL`     | NEVER — kind shown verbatim        |
| `actor.id`            | redacted by backend              | visible — admin sees who           |
| `meta` whitelist      | 6 keys (amount, currency, …)     | unfiltered — sees internalNotes    |
| Visual psychology     | calm, tone-coloured, friendly    | terminal, monospace, dense         |
| Burst hydration       | not needed (small lists)         | `appendMany` for reconnect catch-up |
| 4403 behavior         | not applicable                   | terminal `forbidden`, no retry     |

The reducers each pick the action set their surface needs. Customer
has `reconcile`; admin has `appendMany`. Cross-action defaults make
them quietly ignore each other's actions — proven by the smoke test's
PART 3.

## 4. Snapshot equivalence carries forward

* Customer screen reads `event.kind` (closed literal) and looks up
  `KIND_LABEL` at the surface. `event.kind` is byte-equal to the WS
  frame's `event.kind`, which is byte-equal to the REST `rows[i].kind`
  — established by P0.b.C.h.
* Admin screen reads the row fields directly. No re-projection client-
  side. Both REST hydrate and WS append flow into the same dedup
  gate and the same sort.

REST stays the source of truth on both surfaces:

* `hydrate` and `reconcile` (customer) **REPLACE** state — any locally
  appended WS event the server's snapshot doesn't include is dropped.
* `hydrate` (admin) **REPLACES** state with the same drop semantics
  (proven in smoke test PART 2: "admin hydrate replaces (REST wins)").

## 5. Acceptance criteria (24/24 reducer smoke green)

PART 1 — customer reducer:
* ✅ initial state empty
* ✅ hydrate sorts ascending by `at`
* ✅ hydrate populates `seenIds`
* ✅ append inserts after hydrate (sorted)
* ✅ append dedup by id (returns same state)
* ✅ reconcile drops local-only WS rows (REST wins)
* ✅ `dedupKey` is `event.id` (stable React list key)
* ✅ reset clears state
* ✅ tiebreak by id lex ASC
* ✅ null `at` goes to tail
* ✅ append with empty id is no-op

PART 2 — admin reducer:
* ✅ admin initial state empty
* ✅ admin hydrate dedups same id
* ✅ admin hydrate sorts asc
* ✅ appendMany dedups internally AND vs state
* ✅ admin retains `:rejected` suffix verbatim
* ✅ admin retains `admin.*` prefix verbatim
* ✅ admin sees internal meta keys unfiltered
* ✅ admin hydrate replaces (REST wins)
* ✅ admin append no-op on known id
* ✅ admin reset clears

PART 3 — surface independence:
* ✅ separate initial state objects (not shared)
* ✅ customer reducer ignores admin-only `appendMany` (default case)
* ✅ admin reducer ignores customer-only `reconcile` (default case)

Also:
* ✅ Metro bundler accepts new files (1311+ modules, clean stderr)
* ✅ `tsc --noEmit` passes for new TypeScript files

## 6. Anti-goals (deliberately not done)

The user spelled them out and we held them:

* ❌ provider UI (defer until provider product story is clear)
* ❌ shared chronology kit (each surface owns its own files)
* ❌ humanized admin labels
* ❌ shared reducer
* ❌ generic ChronologyConsumer component
* ❌ optimistic mutations on either surface
* ❌ subscription manager / connection orchestration framework
* ❌ replay buffer for missed frames (30 s REST reconcile is the
      recovery path, exactly as in booking-timeline)
* ❌ offline mutation queue
* ❌ counters / metrics framework (the F.7 trap, deferred per the
      sprint brief's anti-creep guidance)

## 7. Operational impact

* No new backend changes. No new endpoints. No DB schema work.
* No new dependencies (used existing `axios`, `AsyncStorage`,
  `expo-router`, `@expo/vector-icons`, in-tree `typescript`).
* Two new mobile routes registered automatically by expo-router file-
  system routing — no router-config diff needed.
* Bundle still under previous module count plateau; both screens
  lazy-load only when their route is visited.

## 8. Discoverability

* Customer screen → linked from the customer's payment context (TBD
  by the next sprint that owns customer payment context — booking
  details, escrow ticket, etc.). Direct deep-link works today:
  `/customer/payment/<paymentId>/chronology`.
* Admin screen → admin can deep-link from forensic admin tooling:
  `/admin/payment/<paymentId>/forensic`. Same pattern as the existing
  booking-forensic route (`/admin/booking/<id>/forensic`).

## 9. What is now true after this sprint

`payment_events` substrate now has the full lifecycle:

  taxonomy   (F.1 — 19 kinds)
  → writer   (F.2 — append-only)
  → projector (F.3 — 3 actor projections)
  → REST     (F.4 — actor-scoped endpoints)
  → WS shell  (F.5 — handshake / role-gate)
  → realtime publish (P0.b.C.h — sidecar fanout, snapshot equivalent)
  → mobile consumers (P0.b.C.i — customer humanized + admin forensic)

Provider consumer is the only conspicuously missing piece, and that
absence is doctrinal, not accidental.

## 10. Suggested next steps (not in this sprint)

* **Provider chronology consumer** — once the provider product surface
  decides where chronology fits (payout dashboard? job-level detail?).
  Backend WS hub `HUB_PROVIDER` is already alive and projection-correct,
  so the work is purely mobile-side, mirroring the customer sprint.
* **Deep-link entry points** — wire the customer chronology screen as
  a row inside the booking-timeline screen when a `payments.*` event
  appears. Avoid sharing components — link by route only.
* **Stripe webhook → `append_payment_event`** — translate `account.updated`,
  `payment_intent.succeeded`, `transfer.*`, `refund.*` into chronology
  rows. This is the natural follow-on but is a separate sprint with
  its own taxonomy review against F.1.
