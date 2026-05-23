# Sprint P0.b.B — Observability Attachment

**Closed:** 2026-02-20 · 11/11 e2e tests passed · sidecar discipline preserved · zero existing-flow breakage.

## Framing

> attach, don't rewrite — observe, don't orchestrate — record, don't control

P0.b.A создал canonical sidecar. P0.b.B подключает к нему **3 реальных production
mutation paths** так, чтобы timeline начал наполняться без изменения бизнес-семантики.

## Inventory of booking mutation sites

(Found via `grep '$set.*"status"' app/`.)

| # | Path | File | Site | Wired? |
|---|---|---|---|---|
| 1 | cancel | `marketplace/providers.py:430` | customer cancel | ✅ |
| 2 | accept | `marketplace/providers.py:546` | provider accept | ✅ |
| 3 | job action | `marketplace/providers.py:624` | provider depart/arrive/start/complete | ✅ |
| 4 | create booking | `marketplace/providers.py:285` | initial insert | deferred (creation, not transition) |
| 5 | simulate progress | `marketplace/providers.py:485` | demo/test endpoint | deferred (demo) |
| 6 | PATCH status | `marketplace/providers.py:686` | admin direct PATCH | deferred (use admin lifecycle endpoint instead) |
| 7 | car_request complete | `reports/service.py:177` | inspector report submission | deferred (separate domain — wait for P0.e) |
| 8 | dispute open/resolve | `disputes/router.py:249,400` | dispute domain | deferred (own audit already exists, see disputeaudits) |

**3 of 8 sites wired this sprint — covering the most user-visible operational truth:
cancel, accept, work execution.**

## Helper module — `app/booking/attach.py`

Single function: `observe_transition(...)`.

Contract:
1. **BEST-EFFORT** — never raises. Existing flow continues even if Mongo fails.
2. **IDEMPOTENT** — atomic `update_one(filter, $setOnInsert=..., upsert=True)`.
   Dedup key:
   - With `X-Request-Id`: `(bookingId, source, sourceRequestId, action)` — exact replay safety.
   - Without: `(bookingId, source, action, fromStatus, toStatus)` — content-based.
3. **LEGACY-AWARE** — maps raw legacy status (`pending`, `accepted`, `released`,
   `refunded`) to canonical FSM (`requested`, `confirmed`, `completed`, `cancelled`)
   ONLY in the recorded row's `fromStatus`/`toStatus`. The existing flow's own
   writes are untouched. Raw status preserved in `rawFromStatus`/`rawToStatus`.
4. **ACCEPTED + REJECTED** — same writer for both kinds. Rejected attempts use
   `action` suffix `:rejected` (mirror of `money_audit` discipline).

## Wired call sites (3)

### 1. `POST /api/marketplace/bookings/{id}/cancel`

- **Accepted path** (status was `pending|confirmed`): writes `action="cancel"`,
  `fromStatus=requested|confirmed`, `toStatus=cancelled`, `actorRole=customer`,
  `source="marketplace.bookings.cancel"`.
- **Rejected path** (status was anything else): writes `action="cancel:rejected"`
  with `meta.error="status_not_cancellable"` BEFORE raising 400.

### 2. `POST /api/marketplace/provider/requests/{id}/accept`

- **Accepted path** (`pending → confirmed`): writes `action="mark_confirmed"`,
  `actorRole=provider`, `source="marketplace.provider.accept"`.
- **Rejected path** (status was not `pending`): writes `action="mark_confirmed:rejected"`
  with `meta.error="already_handled"` BEFORE raising 400.

### 3. `POST /api/marketplace/provider/current-job/{id}/action`

Wired for all four sub-actions: `depart → mark_on_route`, `arrive → mark_arrived`,
`start → mark_in_progress`, `complete → mark_completed`.
- `actorRole=provider`, `source="marketplace.provider.job_action.<action>"`.

## Timeline row shape (P0.b.B-extended)

```json
{
  "id": "uuid-hex",
  "bookingId": "bk_xxx",
  "bookingScope": "web_booking",
  "action": "mark_confirmed" | "cancel:rejected" | ...,
  "actorId": "...",
  "actorRole": "customer" | "provider" | "inspector" | "admin" | "system",
  "fromStatus": "requested",      // canonical
  "toStatus": "confirmed",         // canonical
  "rawFromStatus": "pending",      // legacy literal as actually on disk
  "rawToStatus": "confirmed",
  "source": "marketplace.provider.accept",
  "sourceRequestId": "X-Request-Id header value or null",
  "meta": { "reason": "...", ... },
  "timestamp": "ISO8601 UTC"
}
```

## Acceptance criteria — all met

| # | Criterion | Result |
|---|---|---|
| 1 | Inventory doc with mutation sites | ✅ above |
| 2 | At least 3 mutation paths write timeline | ✅ cancel + accept + job action (4 sub-actions) |
| 3 | Timeline entries carry bookingId/action/from/to/actorId/source/timestamp/accepted | ✅ |
| 4 | Existing e2e green | ✅ 34/34 (P0.d + P0.b.A + P0.b.B) |
| 5 | Idempotent: same request_id → one row; same content → one row | ✅ proven |
| 6 | Terminal immutability (P0.b.A) preserved | ✅ admin endpoint test still passes |
| 7 | Existing endpoint contract unchanged | ✅ proven (response shape + status codes) |
| 8 | Timeline write failure does NOT break business flow | ✅ proven via monkeypatch |

## Files

```
backend/app/booking/attach.py             NEW — observe_transition helper
backend/app/booking/__init__.py           +1 line — export observe_transition
backend/app/marketplace/providers.py      +3 endpoints instrumented
backend/tests/test_p0bb_attach_observability_e2e.py  11/11 pass
```

## Deferred to follow-ups

Per sprint brief — explicitly OUT of P0.b.B scope:

❌ Force all booking mutations through FSM endpoint
❌ Normalize legacy status writes (raw `pending` keeps being written)
❌ Change customer/provider UI
❌ Change payment semantics
❌ Realtime events from timeline (P0.b.C)
❌ Build BookingService
❌ Make timeline mandatory for transaction success

The other 5 inventoried mutation sites stay unwired this sprint — they will be
attached one at a time as their domains stabilize (reports, disputes own audit,
admin PATCH should redirect to lifecycle endpoint).

## Cumulative invariants now in force

| Layer | Invariant | Surface |
|---|---|---|
| Financial | `released/paid/refunded` immutable | `money_audit` |
| Operational FSM | Terminal lifecycle states immutable | `booking_timeline` (P0.b.A) |
| Operational observability | Cancel / accept / work-execute write timeline | `booking_timeline` (P0.b.B) |
| Forensic | Every rejected mutation logged (both accept & cancel paths) | both |
| Concurrency | TOCTOU on every controlled mutation | both |
| Resilience | Timeline write failure never breaks existing flow | best-effort observe_transition |
