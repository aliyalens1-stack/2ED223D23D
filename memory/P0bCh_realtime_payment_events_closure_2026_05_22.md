# P0.b.C.h — Live WS push for payment_events

**Date:** 2026-05-22
**Sprint:** P0.b.C.h
**Status:** ✅ CLOSED — passes both smoke suites
**Predecessor:** P0.b.C.f (taxonomy F.1, writer F.2, projector F.3, REST F.4, WS shell F.5)
**Pattern reference:** P0.b.C.d (booking chronology realtime — `app/booking/realtime.py`)

---

## 1. Scope (what changed)

P0.b.C.f shipped the WS shell — three streams that accepted tokens and
kept the connection alive with `hello`/`ping`/`pong`, but emitted NO
actual payment events. P0.b.C.h fills exactly that gap:

  `append_payment_event()` → project per actor → emit to existing
  payment WS hubs (customer/provider/admin) → REST remains truth.

That's it. **Propagation, not new semantics.**

## 2. Files

**NEW**

* `app/payments/chronology/realtime.py` (322 LOC)
  * `_ScopedHub` — lock-protected in-process subscriber registry.
  * `HUB_CUSTOMER`, `HUB_PROVIDER`, `HUB_ADMIN` — 3 singletons.
    Inspector deliberately absent (per F.3 — payments have no
    inspector surface).
  * `publish_payment_event(db, row)` — sidecar. Best-effort fanout.
    Projects via SAME `P.project_customer/provider/admin` functions
    used by REST, passing single-element lists.
  * `_resolve_payment_owners(db, payment_id)` — `service_payments`
    lookup for `customerId`/`providerId` (plus legacy aliases).
  * `session_loop(ws, hub, ctx, surface, payment_id)` — accepts
    pre-accepted ws, registers in hub, sends hello, runs the same
    25 s ping/pong as before, removes from hub on disconnect.

**NEW**

* `test_payment_chronology_realtime_smoke.py` — two-phase test:
  * **Phase A** in-process: registers `FakeWS` subscribers in the live
    hubs, drives `append_payment_event()`, asserts byte-equal snapshot
    equivalence vs `P.project_X()` AND vs live REST endpoint.
  * **Phase B** over-the-wire: real `websockets.connect()` to verify
    customer/provider/admin handshakes succeed, cross-role tokens
    close 4403 (no retry), no-token closes 4401.

**MODIFIED — narrow surgery only**

* `app/payments/chronology/writer.py`: after `insert_one()`, fire-and-
  forget `publish_payment_event(db, doc)` wrapped in try/except. WARN
  on failure. **Writer never raises into the calling business flow.**
* `app/payments/chronology/router.py`: WS handlers now use
  `session_loop` (which registers into the hub) instead of the
  pure-keepalive `_ws_keepalive_loop`. Auth/handshake logic untouched.
  Removed dead `_ws_keepalive_loop`. Added `_extract_viewer_ids()`
  helper for provider ctx.

## 3. Wire format (uniform)

```json
{
  "type":     "payment.chronology.updated",
  "scope":    "customer" | "provider" | "admin",
  "paymentId": "<service_payments.id>",
  "event":    { ...projected row, BYTE-EQUAL to REST rows[i]... }
}
```

Single literal `type`. Single envelope shape across all 3 actors.
`event` field uses the same projector as REST — no parallel impl.

## 4. Snapshot equivalence — the code-level guarantee

REST projection path:
```python
P.project_customer(rows)        # list-in, list-out
→ rows[i] == event_i
```

WS projection path (in `realtime._project_one_customer`):
```python
P.project_customer([row])       # single-element list
→ [event][0] == event
```

**Same function. Same closed kind set. Same meta whitelist. Same
actor.id redaction.** A drift between REST and WS is impossible
without modifying the projector, which would simultaneously break
both paths in the same way. This is the deliberate "snapshot
equivalence at the code level" design.

The smoke test asserts byte equality at runtime as belt-and-suspenders.

## 5. Acceptance criteria (✅ all met)

Phase A (in-process):

* ✅ projector customer/provider/admin kinds correct
* ✅ WS frames captured for 3 visible kinds (customer), 3 (provider),
  6 (admin)
* ✅ Snapshot equivalence — WS.event == project([row])[0] == REST rows[i]
  byte-equal across all 3 actors
* ✅ Forbidden meta keys never leak to customer/provider
* ✅ `actor.id` redacted for customer/provider (only `role`)
* ✅ Customer never receives `transfer.*` / `admin.*` / `*:rejected`
* ✅ Provider never receives `payment.initiated` / `payment.failed` /
  `escrow.release_*` / `refund.requested` / `admin.*` / `*:rejected`
* ✅ Foreign subscriber (wrong viewerId) receives ZERO frames
* ✅ Misbehaving subscriber (`raise_on_send=True`) doesn't sabotage
  fanout to healthy peers
* ✅ Envelope shape stable (top-level keys: `type`, `scope`,
  `paymentId`, `event`)
* ✅ `type` literal uniform
* ✅ Live REST admin == WS admin event byte-equal
* ✅ `append_payment_event()` succeeds even when `service_payments`
  owner doc is missing (best-effort sidecar)

Phase B (over-the-wire):

* ✅ customer / provider / admin handshake → `op:"hello"` received
* ✅ Cross-role tokens closed 4403 (terminal, no retry)
* ✅ No-token / invalid token closed 4401

Also re-ran:

* ✅ `test_payment_chronology_writer_smoke.py` — all 11 checks green
  (no regression in F.2 contract)

## 6. Anti-goals (deliberately NOT done)

The user spelled out the negative scope and we held it:

* ❌ provider UI / mobile consumer code
* ❌ replay buffer / late-subscriber backfill
* ❌ Stripe reconciliation engine
* ❌ Stripe retry processor / webhook dispatcher
* ❌ unified chronology infra (booking + payment merged)
* ❌ shared reducer / state machine
* ❌ Stripe adapter layer
* ❌ money_audit replacement
* ❌ payment workflow controller
* ❌ generic projection dispatcher
* ❌ new envelope semantics (mirrors booking shape literally)

P0.b.C.h adds: 1 file (`realtime.py`), 1 test, ~30 LOC of edits
inside writer.py + router.py. That's the entire diff surface.

## 7. Doctrine carryover from P0.b.C.d / F.1..F.5

* REST is source of truth — realtime is acceleration. Dropping a frame
  never loses state because REST polling/refresh remains the recovery
  substrate.
* In-process broadcaster only. No Redis, no Kafka, no replay.
* Server-side filtering at emit time. No client-side permission logic.
* Wire format mirrors booking — same envelope keys, same dispatch
  pattern, same 25 s ping/pong cadence, same 4401/4403 handshake codes.
* Writer is append-only with closed-set kinds. Untouched.

## 8. Operational impact

* No new dependencies.
* No DB schema change.
* No migration.
* No `service_payments` writes.
* No supervisor / requirements changes.
* Backend boot time unchanged.
* No effect on REST endpoints (they were already serving correctly
  per F.4 — only the WS shell got a body).

## 9. Next pickable steps (not in this sprint)

Suggested by the natural shape of what's now real-time:

* **F.6 mobile consumer wiring** — customer/provider screens
  subscribe to `payment.chronology.updated`. Independent scope.
* **F.7 admin observability** — counters for hub sizes + emit rates.
  Trivial via existing `app/core/metrics`.
* **Stripe → payment_events translator** — drive `escrow.held`,
  `transfer.*`, `refund.*` from webhook handlers. Separate sprint.

None of those required for P0.b.C.h closure.
