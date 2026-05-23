# Sprint P0.b.C.d — Realtime Propagation Closure

> 2026-05-20 · status: ✅ DONE
> Realtime = acceleration of projection. REST = source of truth.
> Polling = recovery substrate. **Snapshot equivalence proven** —
> WS push payloads byte-equal to REST `events[]` entries.

---

## What shipped

### 1. Realtime publisher

`app/booking/realtime.py` — 4 in-process scoped hubs + a single
`publish_timeline_event(db, row)` publisher that projects ONE row
per actor and fans out to subscribers.

The wire envelope, identical across scopes:

```json
{
  "type":      "timeline.updated",
  "scope":     "customer" | "provider" | "inspector" | "admin",
  "bookingId": "<request_id>",        // customer / provider / admin
  "jobId":     "<job_id>",            // inspector ONLY (no bookingId)
  "event":     { ...projected... }    // == REST events[i]  (snapshot eq.)
}
```

For admin scope, `event` is the **raw** `booking_timeline` row
(forensic surface). For customer / provider / inspector,
`event` is the **projected** shape — exactly what the matching
`GET /.../timeline` REST endpoint returns inside its `events[]`.

### 2. Sidecar wiring into `observe_transition`

`app/booking/attach.py` calls `publish_timeline_event` immediately
after a successful timeline upsert, wrapped in best-effort
try/except. **Dedup correctly suppresses re-emit** — the publisher
fires once per row, never on duplicate replays.

This means **every existing P0.b.B / P0.b.B+ attach site** (cancel,
accept, depart, arrive, start, complete, dispute open/resolve,
report submit) now auto-propagates realtime — zero changes at the
mutation sites.

### 3. Four WebSocket endpoints

| Endpoint | Scope | Address | Auth |
| --- | --- | --- | --- |
| `/api/customer/bookings/{id}/timeline/stream` | customer | bookingId | user JWT |
| `/api/provider/bookings/{id}/timeline/stream` | provider | bookingId | user JWT |
| `/api/inspector/jobs/{id}/timeline/stream` | inspector | jobId (→requestId at subscribe) | user JWT + job ownership |
| `/api/admin/booking-lifecycle/{id}/stream` | admin | bookingId | admin JWT |

- Token via `?token=<jwt>` query (same dual-transport convention as chat).
- 4401 close on missing/invalid token.
- 4403 close for non-admin tokens on admin channel.
- 4404 close for inspector subscribers attempting foreign jobs
  (same opacity discipline as the REST router).
- Heartbeat: 25s server ping; any client frame triggers a pong.

### 4. e2e test suite

`backend/tests/test_p0bcd_realtime_propagation_e2e.py` — 13 tests:

| # | Test | What it proves |
| --- | --- | --- |
| 1 | snapshot_equivalence_customer | `WS.event == REST.events[0]` byte-equal for customer scope |
| 2 | snapshot_equivalence_provider | Same invariant for provider scope |
| 3 | snapshot_equivalence_inspector | Same invariant for inspector scope; wire has `jobId`, NOT `bookingId`/`requestId` |
| 4 | customer_subscriber_never_sees_admin_internals | Admin actor id, internalNotes, trustScore, platformCut all scrubbed from customer wire |
| 5 | filtered_actions_emit_nothing_to_actor_channels | `mark_matched` row → ZERO customer envelope; provider sees "matched"; inspector sees "assigned"; admin sees raw |
| 6 | foreign_provider_subscriber_gets_nothing | Provider WS subscribed to a non-owned booking gets zero envelopes (server-side opacity at emit time) |
| 7 | subscriber_to_different_booking_id_gets_nothing | bookingA event → bookingB subscriber receives nothing |
| 8 | admin_channel_receives_raw_row | Admin wire preserves admin actor id, internalNotes, trustScore, platformCut, fraudFlag |
| 9 | **observe_transition_triggers_realtime_emit** | Real `observe_transition()` call propagates to all 3 scopes; customer wire matches REST projection (no leak); provider sees `isSelfAction=True`; admin gets raw |
| 10 | observe_transition_dedup_does_not_re_emit | Idempotent upsert short-circuit → realtime fires ONCE, never twice |
| 11 | publisher_continues_when_one_subscriber_fails | One subscriber's `send_text` raises → others still receive; publisher returns cleanly |
| 12 | customer_ws_rejects_missing_token | Live WS handshake against supervisor — missing token rejected |
| 13 | customer_ws_hello_frame_live | Live WS — valid token → `hello` envelope first frame with correct scope |

---

## Architectural invariants proven

| Invariant | Mechanism |
| --- | --- |
| **I1 — Snapshot equivalence** (the heart of C.d) | Tests #1/#2/#3 compute the REST projection AND the WS push for the same row, then assert `WS.event == REST.events[0]`. If projections ever diverge from realtime, this breaks immediately. |
| **I2 — No raw row broadcast to actors** | Tests #4, #5, #6 confirm projection is applied server-side per actor. Admin (test #8) is the ONLY scope that receives raw. |
| **I3 — Channel == projection scope** | Test #5 demonstrates `mark_matched` produces 0 customer envelopes (hidden by customer projection), 1 provider, 1 inspector, 1 admin — each via the right channel with the right labels. |
| **I4 — Opacity at emit time** | Test #6 — foreign provider WS gets nothing without an error; cannot enumerate competitor bookings via WS subscription. |
| **I5 — REST remains source of truth** | Test #11 — best-effort fanout, one bad subscriber doesn't sabotage others, and most importantly doesn't break the calling business mutation. Polling/refresh recovers any missed frame. |
| **I6 — observe_transition dedup respected** | Test #10 — idempotent replay produces ONE WS frame, not two. Without this guarantee, every retry would show duplicate "Provider arrived" on customer screens. |
| **I7 — Inspector wire has no bookingId leak** | Test #3 — inspector envelope contains `jobId` only; `bookingId` and `requestId` deliberately NOT echoed. |

---

## Discipline notes — what we deliberately did NOT do

- ❌ No EventBus / Kafka / Redis pubsub — in-process broadcaster only
- ❌ No replay engine
- ❌ No global subscription registry
- ❌ No generic projection dispatcher (the 4 publishers each call
   `project_timeline_for_<actor>([row], ...)` and take `[0]` —
   reusing the EXACT same code path as REST, which is what makes
   snapshot equivalence a structural guarantee, not a coincidence)
- ❌ No client-side permission filtering — server emits only what the
   actor is allowed to see
- ❌ No raw row broadcast on actor channels
- ❌ No bidirectional WS (read-only stream — mutations remain HTTP)
- ❌ No "realtime as mandatory" — frontend can ignore WS entirely
   and still get correct state from REST polling
- ❌ No WebSocket framework rewrite — the chat hub pattern is
   replicated, not abstracted

---

## How each prior sprint now propagates automatically

Because the sidecar lives inside `observe_transition`, **every
attach site shipped earlier now emits realtime without further code
changes**:

| Source | Action | Auto-emits to |
| --- | --- | --- |
| `marketplace.bookings.cancel` | `cancel` | C / P / I / A |
| `marketplace.bookings.cancel` (race) | `cancel:rejected` | A only |
| `marketplace.provider.accept` | `mark_confirmed` | C / P / A (not I — provider event) |
| `marketplace.provider.accept` (race) | `mark_confirmed:rejected` | A only |
| `marketplace.provider.job_action` ×4 | `mark_on_route/arrived/in_progress/completed` | C / P / I / A |
| `disputes.open` | `open_dispute` | C / P / I / A |
| `disputes.resolve` | `resolve_dispute` | C / P / I / A |
| `auto_requests.reports.submit` (full completion) | `mark_completed` | C / P / I / A |

---

## Test results

```
$ pytest tests/test_p0bcd_realtime_propagation_e2e.py
13 passed in 1.02s

$ pytest tests/test_p0ba_*.py tests/test_p0bb_*.py \
         tests/test_p0bca_*.py tests/test_p0bcb_*.py \
         tests/test_p0bcc_*.py tests/test_p0bcd_*.py
84 passed in 5.61s — zero regression across booking-chronology domain
```

Coverage by sprint:
- P0.b.A lifecycle freeze       — 11/11 ✅
- P0.b.B observability attach   — 11/11 ✅
- P0.b.B+ chronology coverage   —  6/6  ✅
- P0.b.C.a customer projection  —  9/9  ✅
- P0.b.C.b provider projection  — 16/16 ✅
- P0.b.C.c inspector projection — 18/18 ✅
- **P0.b.C.d realtime           — 13/13 ✅**
- TOTAL                          — **84/84 ✅**

---

## Files

```
app/booking/realtime.py                          385 lines  (new)
app/booking/attach.py                            +12 lines  (sidecar)
app/booking/customer_router.py                   +18 lines  (WS endpoint)
app/booking/provider_router.py                   +19 lines  (WS endpoint)
app/booking/inspector_router.py                  +21 lines  (WS endpoint)
app/booking/router.py                            +16 lines  (admin WS)
tests/test_p0bcd_realtime_propagation_e2e.py     500 lines  (new)
memory/SPRINT_P0BCD_REALTIME_PROPAGATION_CLOSURE.md (this file)
memory/CHRONOLOGY_COVERAGE.md                    updated
```

---

## What this closes — the full booking governance model

```
            ┌──────────────────────────────────────────┐
            │  Business mutation (cancel/accept/etc.)  │
            └────────────────────┬─────────────────────┘
                                 │
                                 ▼
            ┌──────────────────────────────────────────┐
            │  observe_transition()  — append-only     │
            │  booking_timeline.upsert + dedup         │
            └────────────────────┬─────────────────────┘
                  ┌──────────────┴──────────────┐
                  ▼                             ▼
        ┌─────────────────────┐      ┌──────────────────────┐
        │  REST projection    │      │  WS realtime sidecar │
        │  (per-actor file)   │      │  (same projection,   │
        │                     │      │   per-actor fanout)  │
        └─────────────────────┘      └──────────────────────┘
                  │                             │
                  ▼                             ▼
              REST GET                    WS push
              (truth)                     (acceleration)
                  │                             │
                  └──────────────┬──────────────┘
                                 ▼
                       Same projected event
                  (snapshot-equivalence proven)
```

This is the mature model:

- **Append-only operational truth** (booking_timeline)
- **Per-actor semantic projection** (4 separate files, no shared logic)
- **REST as recovery** (idempotent reads, complete state)
- **Realtime as acceleration** (single-row push, byte-equal to REST)
- **Best-effort discipline at every step** (each layer can fail
  without breaking the layer above)

Not event sourcing. Not CQRS. Just **governed operational memory
with accelerated delivery**.

---

## Backlog (post-C.d)

- **First UI consumer** (per architect's recommendation: customer
  timeline, strictest leakage requirements). Wire `EventSource`-like
  WS reader, append to local state, fall back to REST poll on
  disconnect. Existing REST endpoint already provides the
  reconciliation path.
- **Tier-2 payout visibility bridge** — `payout_pending` /
  `payout_released` from `money_audit` projected into booking
  chronology. Now safer to do because realtime infra is in place;
  but still scoped narrowly (no full money_audit join).
- **Admin operator projection (C.d-admin)** — turn the raw forensic
  admin surface into a curated admin projection (currently admin
  sees full raw row; the curated version would still permit
  `internalNotes` but never raw stripe payload ids / webhook bodies).
- **WS subscriber metrics** — count active subscribers per scope
  per booking. Pure observability; no behavioural impact.
