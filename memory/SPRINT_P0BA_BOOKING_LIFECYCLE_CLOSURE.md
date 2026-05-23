# Sprint P0.b.A — Booking Lifecycle Freeze

**Closed:** 2026-02-20 · 11/11 e2e tests passed · sidecar discipline preserved.

## Framing

P0.d закрыл `historical financial truth`.
P0.b.A делает то же для `operational chronology`:

> what happened → explicit · append-only · auditable · semantically frozen

Это не **BookingEngine**, не "central orchestration", не registry.
Это **freeze**: канонические состояния + явные переходы + append-only timeline.

## Canonical states (frozen)

```
   requested → matched → confirmed → on_route → arrived → in_progress → completed (T)
        ↓        ↓          ↓                                ↓
      ───── cancel ─────► cancelled (T)              open_dispute
                                                          ↓
                                                      disputed → resolve_dispute → resolved (T)
                                                          ↑
                                                          └── (completed → disputed allowed)
```

Terminal: `completed`, `cancelled`, `resolved`.

## Transition legality (frozen)

| action | from | to |
|---|---|---|
| `mark_matched` | `{requested}` | `matched` |
| `mark_confirmed` | `{matched}` | `confirmed` |
| `mark_on_route` | `{confirmed}` | `on_route` |
| `mark_arrived` | `{on_route}` | `arrived` |
| `mark_in_progress` | `{arrived}` | `in_progress` |
| `mark_completed` | `{in_progress}` | `completed` |
| `cancel` | `{requested, matched, confirmed}` | `cancelled` |
| `open_dispute` | `{in_progress, completed}` | `disputed` |
| `resolve_dispute` | `{disputed}` | `resolved` |

No graph engine. No DSL. Adding a state = editing `fsm.py`. That's the point.

## Append-only timeline (`booking_timeline`)

Same discipline as `money_audit`:
- accepted **and** rejected attempts → one row each
- TOCTOU guard: `update_one({"id": ..., "status": raw_status_at_read}, ...)` →
  concurrent state change ⇒ 409 + rejected audit row
- Indexes: `(bookingId, timestamp DESC)`, `(actorId, timestamp DESC)`,
  `(action, timestamp DESC)`, `(bookingScope, timestamp DESC)`

Row shape: `{ id, bookingId, bookingScope, action, actorId, actorRole,
fromStatus, toStatus, meta, timestamp }`.

## Actor projections

Same truth → different vocabulary + visibility:

| state | customer | provider | inspector | admin |
|---|---|---|---|---|
| `on_route` | «В пути» | «Вы в пути» | «В пути» | `on_route` |
| `in_progress` | «Работа идёт» | «Работа идёт» | «Осмотр идёт» | `in_progress` |
| `disputed` | «Спор открыт» | «Открыт спор» | «Спор по отчёту» | `disputed` |

Visibility flags (informational; gating in endpoint layer):
- customer: never sees `platformCut`, `internalNotes`, `providerCost`, other party id
- provider/inspector: sees own cost + other party id, not `platformCut`
- admin: sees everything

## Endpoints (admin only — `verify_admin_token`)

```
GET   /api/admin/booking-lifecycle/states
GET   /api/admin/booking-lifecycle/{id}?scope=&actor=
POST  /api/admin/booking-lifecycle/{id}/transition   {scope, action, reason, note}
```

Sidecar — existing booking flows (marketplace/providers, escrow, auto_requests,
service_marketplace…) are **untouched**. The lifecycle module only adds:
- read-side normalization (legacy `pending → requested`, `released → completed`, …)
- admin transition endpoint for manual intervention
- append-only evidence

## Critical acceptance test ✅

> Operational chronology cannot be silently rewritten

`test_completed_is_terminal_rejects_all_transitions`: 4× attempted forward
moves on a `completed` booking return **409**, on-disk `status` unchanged,
all four `*:rejected` rows present in `booking_timeline` with attacker reason
captured.

Same coverage for `cancelled` and `resolved`.

## Files

```
backend/app/booking/
├── __init__.py        # public surface (router + helpers)
├── fsm.py             # state enum + transition predicates (one file)
├── timeline.py        # append-only writer + ensure_indexes + read_timeline
├── projections.py     # actor labels + visibility flags
└── router.py          # 3 endpoints (states / get / transition)

backend/tests/
└── test_p0ba_booking_lifecycle_e2e.py   # 11/11 pass

backend/server.py
└── include_router(booking_lifecycle_router) + ensure_indexes startup hook
```

## Deferred (deliberately)

- **P0.b.B** — wire existing in-place mutations to call `record_transition()`
  so the timeline becomes complete for new bookings (no retro backfill).
- **P0.b.C** — realtime convergence: emit lifecycle events from the timeline
  insert (single source of truth for push/socket).
- **No automation, no SLA engine, no escalation, no DSL.** Per brief.

## Cumulative invariants now in force

| Layer | Invariant | Surface |
|---|---|---|
| Financial | released/paid/refunded immutable | `money_audit` |
| Operational | terminal lifecycle states immutable | `booking_timeline` |
| Forensic | every rejected mutation logged | both collections |
| Concurrency | TOCTOU on every mutation | both collections |
