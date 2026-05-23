# P4.1 — Vehicle Linkage Bridge · Strategic Milestone

**Status:** locked. This document is institutional memory, not a sprint
log. Update only when the architectural meaning of P4.1 changes — not
when downstream features ship.

---

## What actually happened

Before P4.1 the system had a process model:

```
request · quote · inspection · payment · booking
```

…living side-by-side. The center of gravity was the `request` — a
short-lived, transactional object.

After P4.1 the system has a **persistent object graph around the
vehicle**.

```
vehicle  ──┐
           ├── requests    (vehicleId)
           ├── quotes      (vehicleId)
           ├── inspections (vehicleId)
           ├── payments    (vehicleId)
           └── bookings    (vehicleId)
```

The anchor entity moved from a **transient transaction** to a
**durable real-world object**. That is the milestone.

---

## Why this is a maturity step (not a feature)

| Thing                  | `request` as anchor       | `vehicle` as anchor                 |
|------------------------|---------------------------|-------------------------------------|
| Lifecycle              | seconds–days              | months–years                        |
| Identity               | platform-internal         | real-world (plate / VIN / listing)  |
| Memory                 | none — disposable         | accumulates across sessions         |
| Cross-session continuity | no                      | yes                                 |
| User mental model      | "task I asked for"        | "thing I own / am buying"           |
| Re-engagement potential | weak                     | strong                              |
| AI context quality     | flat list of events       | history of a single object          |

The same data, the same collections — re-anchored. That is what makes
this a model change, not a CRUD feature.

---

## What was deliberately NOT built (negative space)

These were considered, named, and **rejected**:

- ❌ `vehicle_events` collection / activity stream
- ❌ Event sourcing / CQRS
- ❌ Graph database
- ❌ Universal timeline engine
- ❌ Polymorphic activity stream
- ❌ Generic relationship graph
- ❌ Runtime registries
- ❌ Dynamic projections
- ❌ Plugin / extension framework

Each of these would replace explicit, greppable linkage with implicit
runtime behavior. They look elegant on diagrams and destroy velocity in
practice. P4.1's posture: **explicit fields + indexes + projections,
nothing else.**

---

## What was built (canonical reference)

### Backend — `/app/backend/app/vehicles/`

- `timeline.py`
  - `_INDEXED_COLLECTIONS` — exhaustive list of 7 collections that
    carry `vehicleId`.
  - `ensure_indexes()` — idempotent, sparse compound
    `(vehicleId asc, createdAt desc)`. Called from
    `app/core/lifespan.py`.
  - `build_timeline_payload(vehicle_id)` — joins by indexed lookup,
    returns `{ reports[], quotes[], payments[], bookings[] }` already in
    `LinkedXxxRef` wire shape.
  - Translators (`_to_report_ref` / `_to_quote_ref` / `_to_payment_ref`
    / `_to_booking_ref`) — only place where backend status sets are
    mapped onto the shared `QuoteStatus` / `PaymentStatus` /
    `BookingStatus` unions.

- `router.py`
  - `GET /api/customer/vehicles/{id}/timeline` — auth-scoped to owning
    customer; 404 (not 403) for foreign vehicles by design.

### Backend — write paths that propagate `vehicleId`

- `app/marketplace/requests.py` — `customer_requests` and the 3
  generated `request_quotes` (denormalised from parent request).
- `app/auto_requests/service.py` — `car_requests` + `inspection_jobs`
  (denormalised onto every job).
- `app/auto_requests/reports.py` — `inspection_reports` (denormalised
  from job).
- `app/payments/router.py` — `payment_transactions` (carries forward
  from quote/request).

### Web-app — `/app/web-app/src/`

- `services/api.ts` — `vehiclesAPI.getTimeline(id)`.
- `pages/customer/CustomerVehicleDetail.tsx` — single round-trip;
  feeds `reports/quotes/payments/bookings` directly into
  `projectVehicleMemory` / `projectVehicleTimeline` from
  `@platform/domain/state-machines/vehicle`.

### Shared — UNCHANGED

- `/app/shared/` was not modified. The behavioral truth (perception
  / stage / timeline projections) was already in place from P4. P4.1
  is a graph layer underneath, not a semantic layer change.

---

## What this unlocks (does NOT mean "do these next")

These are now **architecturally possible**. Whether and when to build
them is a product decision, not an architectural one:

1. **Ownership continuity** — re-engagement on price drops, abandoned
   inspection chains, returning buyers.
2. **Memory-driven re-engagement** — "you saw this BMW 3 months ago,
   price dropped €1,200" — based on real history, not marketing
   gimmicks.
3. **AI assistant context** — instead of "list of cars" pass "history
   of user × this car" — radically better context quality.
4. **Provider intelligence** — provider sees "this vehicle already had
   an inspection", "customer rejected similar repair scope" without a
   new analytics pipeline.
5. **Lifecycle products** — warranty, maintenance, resale, financing,
   trade-in, ownership history. Each becomes a projection, not a new
   subsystem.

---

## Architectural property to preserve at all costs

> _Semantic consistency across surfaces._
> Explicit domains + explicit projections + explicit consumers.
> NO universal timeline engine, NO graph orchestration layer,
> NO generic projection registry, NO event sourcing migration.

If a future sprint proposes any of those — re-read this document
first. The temptation will be high (it always is, around month 6 of a
fast-growing graph). The answer is the same: **copy and project, do
not generalise.**

---

## Maturity scoreboard (post-P4.1)

| Layer                              | Status |
|------------------------------------|--------|
| Semantic isolation                 | ✅ |
| Shared behavioral rules            | ✅ |
| Multi-surface boundaries           | ✅ |
| Realtime isolation                 | ✅ |
| Analytics isolation                | ✅ |
| Institutional guardrails (lint)    | ✅ |
| **Durable vehicle graph**          | ✅ (P4.1) |
| **Explicit linkage model**         | ✅ (P4.1) |
| Mobile parity on vehicle memory    | ✅ (P4.2) |
| Optimistic memory cache            | ✅ (P4.3) |
| Operational intelligence layer     | ⏳ (next era) |

**Foundation phase: closed.**
After P4.3 the platform has every property needed for the
intelligence era:
- a durable graph anchored on the vehicle (P4.1),
- a single semantic kernel proven across surfaces (P4.2),
- an optimistic memory state layer with reconciliation invariants (P4.3).

The next sprint should not be more substrate. It should be a real
product surface that EXERCISES this substrate (Provider Workbench,
Payment 0C, AI assistant memory feed, lifecycle product, etc.).

Foundation work is done. From here forward the work is product-driven:
operational intelligence, lifecycle products, provider workflows,
payout maturity. The substrate they need is now in place.
