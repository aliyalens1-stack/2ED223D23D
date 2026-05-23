# Sprint P0.b.C.c — Inspector Projection Closure

> 2026-05-20 · status: ✅ DONE
> Final projection in the actor triad. Inspection-centric labels,
> dedicated tone vocabulary, separate file. No inheritance, no
> shared utility. Now all 3 actor projections + admin raw surface
> are live; realtime (next) becomes propagation, not semantics
> invention.

---

## What shipped

### 1. New endpoint

```
GET /api/inspector/jobs/{job_id}/timeline
```

**Endpoint keyed by `jobId`, not `bookingId`** — inspector mental
model is "this is MY inspection job", not "this booking in some
marketplace state". Server resolves `jobId → job.requestId →
booking_timeline rows` internally; `requestId` / `bookingId` are
deliberately NOT echoed in the response.

- Auth: `verify_user_token`.
- Ownership: `inspection_jobs.inspectorId` /
  `inspectorAccountId` / `inspectorUserId` must intersect the
  caller's identity claims (`sub` / `userId` / `accountId` /
  `inspectorId` / `inspectorAccountId`).
- **404 for missing OR unassigned OR foreign-owned jobs** — same
  opacity discipline as provider router. No competitor topology
  leakage.
- 200 with empty `events` is a valid response (no rows or no
  upstream `requestId` link).

### 2. New projection module

`app/booking/projections/inspector.py`

- **Separate file.** Zero shared code with `customer.py` or
  `provider.py`. Even though some underlying actions overlap, the
  rendered semantics diverge fundamentally.

- **Inspection-centric labels** — same canonical row produces
  different surface text:

  | underlying action | inspector label | provider label |
  | --- | --- | --- |
  | `mark_matched` | Осмотр назначен | Назначено вам |
  | `mark_in_progress` | Осмотр начат | Работа идёт |
  | `mark_completed` | Отчёт отправлен | Работа завершена |
  | `open_dispute` | Открыт спор по осмотру | Открыт спор |

- **`mark_confirmed` deliberately HIDDEN** from inspector —
  that's the provider's accept event. Inspector chronology jumps
  straight from `assigned` to `on_route`.

- **New tone vocabulary** (DIFFERENT from customer + provider):

  ```
  ready          — assignment received, action awaited
  travel         — on the move
  on_site        — at the location, pre-work
  documenting    — actively inspecting
  submitted      — report dispatched
  closed         — terminal / resolved
  attention      — alert, intervention required
  ```

- **Whitelist meta keys** (different from customer + provider):

  ```
  eta                      — own ETA on on_route
  reason                   — cancel / dispute reason
  note                     — own milestone note
  reportId                 — primary deliverable, surfaces on completion
  inspectorPayoutAmount    — own payout (NOT provider's payoutAmount)
  ```

  Provider's `payoutAmount` and `customerNote` are intentionally
  NOT on the inspector whitelist — those are notes / money signals
  belonging to a different surface.

- **Contextual `cancel` renderer** — 4 cases, all with admin
  identity scrubbed:

  ```
  own cancel        → "Вы отменили выезд"        / tone=closed
  customer cancel   → "Клиент отменил"           / tone=attention
  provider cancel   → "Провайдер отменил"        / tone=attention
  admin cancel      → "Отменено администрацией"  / tone=attention
  ```

### 3. e2e test suite

`backend/tests/test_p0bcc_inspector_timeline_e2e.py` — 18 tests:

| # | Test | What it proves |
| --- | --- | --- |
| 1 | endpoint_requires_auth | 401 without token |
| 2 | 404_for_missing_job | 404 path |
| 3 | 404_for_unassigned_job | No inspectorId → opaque 404 |
| 4 | 404_for_other_inspectors_job | Foreign owner → opaque 404 (not 403) |
| 5 | empty_timeline_returns_empty_events | 200 + no `bookingId`/`requestId` in response |
| 6 | job_without_request_link_returns_empty | Defensive — empty list, no crash |
| 7 | inspection_centric_chronology | `mark_confirmed` HIDDEN; jump assigned→on_route; correct labels + tones; isSelfAction |
| 8 | **never_sees_pricing_internals** | platformCut, providerCost, payoutAmount (provider's), customerNote, internalNote(s), trustScore, fraudFlag, rankingScore, admin id, competitor inspector id, rejected — ALL scrubbed |
| 9 | sees_eta_and_payout_and_reportid | inspector whitelist surfaces; nothing else |
| 10 | unknown_actions_silently_dropped | inspector_opened_page, system_heartbeat, **mark_confirmed** → all dropped |
| 11 | own_cancel_marked_self | "Вы отменили выезд" + tone=closed + isSelfAction=True |
| 12 | customer_cancel_labelled_correctly | "Клиент отменил" + tone=attention + internalNotes hidden |
| 13 | provider_cancel_labelled_correctly | "Провайдер отменил" + tone=attention |
| 14 | admin_cancel_hides_admin_identity | "Отменено администрацией" + admin id scrubbed |
| 15 | dispute_lifecycle_visible | dispute_opened/resolved labels; disputeId + payoutAmount + adminNote + resolution + refundAmount all scrubbed |
| 16 | **full_payload_snapshot** | Full rendered event list compared to inline expected — primary architectural invariant |
| 17 | events_returned_chronologically | Ascending timestamps |
| 18 | ownership_matches_via_account_id | `inspectorAccountId` ownership works |

### 4. Wiring

- `app/booking/projections/__init__.py` re-exports
  `project_timeline_for_inspector` + `HIDDEN_FROM_INSPECTOR`.
- `app/booking/__init__.py` re-exports `inspector_router`.
- `server.py` includes inspector router alongside customer + provider
  + admin lifecycle routers (1-line addition).

---

## Architectural invariants proven

| Invariant | Mechanism |
| --- | --- |
| **I1 — Inspection-centric labels** | Test #7 + snapshot test #16 — same underlying row produces "Осмотр начат" for inspector, "Работа идёт" for provider, "Работа началась" for customer. Three different files, three different vocabularies. |
| **I2 — `mark_confirmed` HIDDEN from inspector** | Test #10 plants `mark_confirmed` row from provider → silently dropped. Inspector chronology never includes provider-domain events. |
| **I3 — Whitelist meta keys are NOT shared** | Test #8 plants `payoutAmount` (provider's) + `customerNote` (provider's) → both scrubbed. Inspector sees `inspectorPayoutAmount` (own, different field). |
| **I4 — `disputeId` scrubbed** | Inspector whitelist does NOT include `disputeId` — it's a cross-aggregate id. Test #15 verifies it disappears. |
| **I5 — 404 opacity** | Tests #2/3/4 — missing, unassigned, foreign-owned all return 404. Inspector cannot enumerate competitor jobs. |
| **I6 — Endpoint keyed by jobId, not bookingId** | Tests #1-#6 use `jobId` URL pattern; response echoes `jobId` only. No `requestId` / `bookingId` ever surfaces to the inspector. |
| **I7 — Snapshot guard** | Test #16 — full payload compared to inline literal. Any future meta field landing on `booking_timeline` will break this until explicitly whitelisted. |

---

## Discipline notes — what we deliberately did NOT do

- ❌ No inheritance from `provider.py` (zero shared base / mixin)
- ❌ No `_SHARED_PROJECTION_HELPER` between customer/provider/inspector
- ❌ No `project_timeline(rows, actor=...)` dispatcher
- ❌ No `mark_confirmed` surfaced to inspector — it's a provider event
- ❌ No `requestId` / `bookingId` echoed to inspector response
- ❌ No `disputeId` on inspector's safe-meta whitelist
- ❌ No payout join across `money_audit` — cross-aggregate coupling
  deferred until realtime sprint (deliberate)

---

## Test results

```
$ pytest tests/test_p0bcc_inspector_timeline_e2e.py
18 passed in 1.10s

$ pytest tests/test_p0ba_*.py tests/test_p0bb_*.py \
         tests/test_p0bca_*.py tests/test_p0bcb_*.py \
         tests/test_p0bcc_*.py
71 passed in 5.19s — zero regression
```

Coverage in booking-chronology domain:
- P0.b.A lifecycle freeze     — 11/11 ✅
- P0.b.B observability attach — 11/11 ✅
- P0.b.B+ chronology coverage — 6/6   ✅
- P0.b.C.a customer projection — 9/9   ✅
- P0.b.C.b provider projection — 16/16 ✅
- P0.b.C.c inspector projection — 18/18 ✅

---

## Files

```
app/booking/projections/inspector.py        265 lines  (new)
app/booking/projections/__init__.py          +9 lines
app/booking/inspector_router.py             140 lines  (new)
app/booking/__init__.py                      +2 lines
server.py                                    +2 lines
tests/test_p0bcc_inspector_timeline_e2e.py  490 lines  (new)
memory/SPRINT_P0BCC_INSPECTOR_PROJECTION_CLOSURE.md (this file)
memory/CHRONOLOGY_COVERAGE.md                updated  (visibility column now reflects C.c live)
```

---

## What this completes

All three actor projections + admin raw surface are live:

```
┌──────────────────────────────────────────────────────────────────┐
│                       booking_timeline                           │
│                  (append-only, single truth)                     │
└──────────────────────────────────────────────────────────────────┘
        ↓                ↓                ↓               ↓
   customer.py      provider.py     inspector.py     admin (raw)
   calm trust       execution       inspection       full forensic
   surface          surface         surface          surface
   tones:           tones:          tones:           (no projection)
   positive/        action_req/     ready/travel/
   neutral/         in_flight/      on_site/
   celebratory/     settled/        documenting/
   alert            neutral/alert   submitted/
                                    closed/attention
```

**Same chronology. Different semantic realities.** The architecture
that B+ pressure-tested by attaching chronology coverage is now
fully exercised across four distinct actor surfaces.

---

## Next sprint — realtime propagation

Per the architect's brief: **P0.b.C.d realtime propagation** is now
the correct next move because all three actor projections are
stable and snapshot-tested. Realtime becomes a *propagation*
problem (push the same projected rows to subscribed clients), not
a *semantic invention* problem.

Anticipated discipline for realtime:
- Push the SAME projected payload that REST returns (no parallel
  realtime-only fields).
- Per-actor channels — customer's channel never carries provider's
  payload, inspector's channel never carries provider's payload.
  Channel = projection scope.
- Best-effort delivery, REST remains source of truth.
- No "subscribe to all" admin firehose for non-admin actors.
- Snapshot-equivalence test: realtime payload for action X MUST
  equal REST GET payload for the same row.

Deferred (post-realtime):
- Tier-2 payout visibility bridge (`payout_pending` /
  `payout_released` from `money_audit` into booking chronology)
- Admin operator projection (P0.b.C.d-admin) — permissive but
  still curated; admin should see internalNotes but never raw
  stripe payload ids
