# P0.b.C.d.UI.d — Admin Booking Forensic Stream · CLOSURE

> Fourth and final realtime consumer. Deliberately NOT a timeline.
> Operational evidence surface. Different namespace, different
> reducer name, different visual species.
> Date: 2026-05-21.

## Brief

Implement the admin's read-only consumer of
`GET /api/admin/booking-lifecycle/{bookingId}` (the `timeline` field)
plus the WebSocket stream
`/api/admin/booking-lifecycle/{bookingId}/stream`, following the
same REST-hydrate → WS-append → reconciliation contract — but with
admin-specific psychology:

  * RAW rows (no projection)
  * `:rejected` attempts visible
  * Activity-feed rows (`provider_viewed_booking`, `customer_opened_page`) visible
  * Unfiltered `meta` (`platformCut`, `internalNotes`, `trustScore`, …) all surface
  * Console/terminal aesthetic — monospace, dense rows, JSON expand-on-tap
  * Role-gated WS — non-admin tokens closed with code 4403, no retry

## Three admin-specific invariants (per architectural review)

| # | Invariant | How upheld |
| --- | --- | --- |
| **A** | **Ordering = append order, never semantic grouping** | Reducer sorts strictly by `timestamp` ASC with `id` tiebreak. No collapsing, no merging, no "newest first inversion". Each raw row is its own line. |
| **B** | **No projection prettification** | Reducer stores `ForensicRow` exactly as received from REST/WS. Screen renders the raw `action` string (`mark_completed:rejected`, `provider_viewed_booking`) verbatim. NO label lookup table, NO tone palette derivation from action. |
| **C** | **Throughput — burst + duplicate + out-of-order** | Reducer state carries `seenIds: Set<string>` for O(1) dedup. `appendMany` action batches inserts with one sort. Same row from REST hydrate + WS append is a no-op via `id` dedup. Stable sort guarantees deterministic order even if WS frames arrive out of timestamp order. |

## Files (additive, all under admin surface, **new namespace**)

| File | Role |
| --- | --- |
| `frontend/src/admin/booking-forensic/types.ts` | `ForensicRow` (raw), `ForensicSnapshot`, `ForensicWsEnvelope` |
| `frontend/src/admin/booking-forensic/reducer.ts` | `forensicStreamReducer` · actions: `hydrate` / `append` / **`appendMany`** / `reset`. No `drop`, no projection helpers. Dedup via `seenIds: Set<string>`. |
| `frontend/src/admin/booking-forensic/useAdminBookingForensicStream.ts` | Hook · REST hydrate → WS connect → 30 s reconcile → role-gated retry (4403 → permanent `forbidden` status, no retry loop) |
| `frontend/src/admin/booking-forensic/index.ts` | Public re-export — admin surface boundary |
| `frontend/app/admin/booking/[id]/forensic.tsx` | Route screen · **monospace terminal aesthetic**, dense rows, JSON expand-on-tap, rejected counter, no actor badges, no celebration colors |
| `backend/test_admin_forensic_ws_smoke.py` | Smoke — RAW timeline + `:rejected` visibility + meta unfiltered + WS role-gate (4403 for non-admin) + bookingId filter + keepalive (8 ✓ checks) |

**Namespace fingerprint** (the most important psychological signal):
| Surface | Folder name | Reducer name | Hook name |
| --- | --- | --- | --- |
| Customer | `booking-timeline` | `timelineReducer` | `useCustomerBookingTimeline` |
| Provider | `booking-timeline` | `providerTimelineReducer` | `useProviderBookingTimeline` |
| Inspector | `booking-timeline` | `inspectorTimelineReducer` | `useInspectorJobTimeline` |
| **Admin** | **`booking-forensic`** | **`forensicStreamReducer`** | **`useAdminBookingForensicStream`** |

The naming itself makes accidental cross-surface code reuse syntactically obvious.

## Acceptance — backend smoke (8/8)

```
✓ admin login · role=admin
✓ provider login (for role-gate negative test)
✓ seeded service_request id=…
✓ wrote 3 rows (incl. :rejected + activity-feed)
✓ REST raw timeline OK · 3 rows, actions=['provider_viewed_booking', 'mark_completed:rejected', 'mark_matched']
  · :rejected row PRESENT (admin invariant B — no prettification)
  · provider_viewed_booking PRESENT (no semantic filtering)
  · meta unfiltered: customerNote, platformCut, internalNotes, trustScore all visible
  · all rows carry unique `id` for client-side dedup
✓ WS admin hello received · scope=admin bookingId=…
✓ WS keepalive pong
✓ WS non-admin (provider role) closed · InvalidStatus
✓ WS bad-token rejected · InvalidStatus
✓ cleanup done
✅ ALL CHECKS PASSED
```

Critical assertions pinned:

* **REST returns the same `:rejected` row that customer/provider/inspector projections drop** — admin invariant B verified end-to-end.
* **`provider_viewed_booking` activity-feed row reaches admin** — would be filtered everywhere else.
* **`meta.platformCut`, `meta.internalNotes`, `meta.trustScore`** all surface unfiltered — admin sees ALL meta keys.
* **Each row carries unique `id`** — required for client-side `seenIds: Set<string>` dedup under burst + reconnect hydration.
* **WS auth is role-gated**: provider token (valid JWT, valid role for other endpoints) → 4403 close. Server treats admin scope as a privilege, not just an authentication gate.

## Visual acceptance

9 rows seeded, screen rendered all 9 in append order. Observable invariants:

| Visual element | Confirms |
| --- | --- |
| Monospace `Menlo / monospace` throughout | Not a timeline psychology |
| Header `FORENSIC · booking_timeline` (caps + collection name) | Audit console framing |
| Header sub `service_request / ui-admin-forensic-demo` | Raw scope + raw id, no aggregate label |
| Counts bar `rows: 9  rejected: 1` (yellow when > 0) | Invariant B observable at a glance |
| `mark_completed:rejected` row in red-on-dark-red | Rejected attempts visible, not hidden |
| `provider_viewed_booking`, `customer_opened_page` | Activity feed visible, not filtered |
| Tap-to-expand JSON shows `platformCut: 1234`, `internalNotes: "do not show users"`, `customerNote: "Buzzer 4B"`, `trustScore: 0.91` | Meta unfiltered |
| `LIVE` pill in monospace caps | No celebratory styling |
| No `ВЫ` badge anywhere | Admin is observing, not participating |
| All 9 `forensic-row-*` testIDs present + `forensic-meta-*` on click | Throughput dedup not interfering |

Screenshot: `/tmp/admin_forensic_full.png`.

## What we explicitly did NOT do

| Anti-goal | Decision |
| --- | --- |
| Reuse customer/provider/inspector reducer | ❌ — new namespace, new reducer name, dedup-by-id strategy not present in any timeline reducer |
| Generic `Timeline<T>` after 4 repeats | ❌ — admin invariants (raw, ordered, dedup-by-id) are structurally incompatible with timeline reducers |
| Per-action color palette / label dictionary | ❌ — admin reads raw strings |
| `:rejected` filtering | ❌ — admin sees them with red-bg row |
| Activity-feed filtering | ❌ — `provider_viewed_booking`, `customer_opened_page` all surface |
| Meta whitelist | ❌ — admin gets full row.meta verbatim |
| Wildcard (`*`) subscription across all bookings | ❌ — backend hub keyed by bookingId. Fleet observability would need a separate `bookingId: "*"` ctx and a different consumer; not in scope |
| Retry on 4403 | ❌ — permanent `forbidden` status. Operator must re-authenticate |
| Action CTAs | ❌ — read-only, like every other consumer |

## Pattern observation after 4 repeats

| Surface | LOC: hook | LOC: reducer | LOC: screen | Surface-specific concepts |
| --- | ---: | ---: | ---: | --- |
| Customer | ~220 | ~80 | ~290 | — |
| Provider | ~230 | ~80 | ~300 | payout pill, customer-note box |
| Inspector | ~280 | ~95 | ~310 | stale-WS watchdog, `drop` action, jobId-only identity, 20 s reconcile, report pill |
| **Admin** | ~265 | ~115 | ~365 | dedup-by-id, `appendMany`, raw row type, `forbidden` status, role-gate, JSON expand, terminal aesthetic |

Code size stays bounded. The reducers and hooks are CLEARLY NOT
the same module written four times — they share a recipe but
their action sets and state shapes diverge by reality.

If we had built `Timeline<T, S>` after UI.a it would now be carrying:
* tone palette dictionary per-scope
* meta whitelist per-scope
* keyed-by-{booking,job} variants
* watchdog opt-in flag
* drop opt-in flag
* dedup strategy enum (timestamp+key vs id-only)
* projection-vs-raw flag
* role-gate vs ownership-gate behavior
* reconcile interval per-scope
* retry-vs-fail-permanently on 4403
* burst-tolerant `appendMany` action

…and would be approaching 600 LOC of abstraction overhead for 0
shared logic. Manual duplication remains the cheaper option.

## Order of consumers (FINAL)

| Consumer | Status |
| --- | :---: |
| Customer (UI.a) | ✅ DONE |
| Provider (UI.b) | ✅ DONE |
| Inspector (UI.c) | ✅ DONE |
| **Admin forensic (UI.d)** | ✅ **DONE** |

**P0.b.C.d realtime UI consumer cycle is now COMPLETE.**

One immutable chronology substrate (`booking_timeline` Mongo collection)
→ four simultaneously valid operational realities
→ four surface-local reducers with naturally divergent semantics
→ four route screens with intentionally distinct visual languages
→ no shared framework, no projection dispatcher, no event-bus

## Test credentials used

- `admin@autoservice.com / Admin123!` (role=`admin`)
- `provider@test.com / Provider123!` (role-gate negative test)

## Route

- New: `/admin/booking/[id]/forensic?scope=web_booking|service_request|car_request`
