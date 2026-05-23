# Sprint: Provider Dispatch Hardening + Action Idempotency (closure)

**Status:** ✅ Closed 2026-05-13
**Position in plan:** After Phase A (Communication Surface Completion) and BEFORE Phase B (Chat Normalization). The action substrate is now safe to build chat on top of.
**Anti-scope:** Did NOT touch chat topology, websocket transport, dispute/escalation, attachments, marketing/revenue, or admin booking-action endpoints.

---

## What was unsafe before

The previous `POST /api/provider/booking/{id}/action` did:

```python
async def provider_booking_action(booking_id, request):
    body = await request.json()
    action = body.get("action")
    booking = await db.bookings.find_one({"id": booking_id})
    await db.bookings.update_one({"id": booking_id}, {"$set": {"status": new_status}, ...})
    # always: realtime emit, performance record, referral award, push hooks
```

Concretely broken:

1. **No auth.** Any process — including unauthenticated clients — could mutate any booking.
2. **No ownership check.** Even with auth, any provider could close any other provider's booking.
3. **No transition guard.** `confirmed` jumped straight to `completed`, skipping `in_progress`. Earnings, referrals and customer push fired on a state that was never actually reached.
4. **Race window.** Two parallel `complete` calls both ran `update_one` with no status filter, both fanned out side-effects, both recorded a `completedAt`, both granted referral rewards.
5. **No replay protection.** Retries (network blip, double-tap, browser back+forward) wrote duplicate `statusHistory` entries and re-fired customer push notifications.

Bottom line: action substrate was operationally unsafe. Building richer comms on top of it would have made the blast radius larger, not smaller.

---

## What ships now

### Backend — `app/provider/router.py`

The endpoint is now a thin HTTP wrapper. The real work lives in a pure
function `apply_booking_transition(...)`, also exported for internal callers.

```
POST /api/provider/booking/{booking_id}/action
Headers:
  Authorization: Bearer <JWT>           — REQUIRED
  Idempotency-Key: <opaque string>      — OPTIONAL, see below
Body:
  { "action": "depart" | "arrive" | "start" | "complete" }
```

Hardening invariants (all enforced):

| Invariant | Mechanism |
|---|---|
| **Auth** | Bearer JWT decode → caller_user_id. Missing/invalid → 401. |
| **Ownership** | `_resolve_caller_provider_slugs(user_id)` queries `organizations` for `ownerId == user_id` OR `managerIds ∋ user_id`. Booking's `providerSlug` MUST be in that set. Otherwise 403 — same code whether the booking exists for someone else or doesn't exist *for caller* (no info leak). |
| **Diagnostics** | 400 unknown verb · 401 auth · 403 foreign · 404 missing · 409 invalid transition / race / collision |
| **State machine** | Forward-only graph:<br>`confirmed,accepted ─depart→ on_route`<br>`confirmed,accepted,on_route ─arrive→ arrived`<br>`confirmed,accepted,on_route,arrived ─start→ in_progress`<br>`in_progress ─complete→ completed` |
| **Atomic transition guard** | `find_one_and_update({ id, providerSlug, status: {$in: allowed_from} }, {$set, $push: statusHistory})`. Two concurrent callers cannot both win — the loser sees `updated is None`. |
| **Lost-race diagnostics** | After a `None` result, re-read fresh status. If it equals `new_status`, report idempotent replay; otherwise 409 with explicit "now X, expected one of Y" detail. |
| **Same-state replay = silent** | If `current_status == new_status` before the update attempt: return envelope with `replayed: true` and **skip every side effect** (no realtime emit, no `performance.record_completed`, no referral awards, no push notification, no `completedAt` mutation). |
| **Side-effects only on real transition** | Performance hook, referral hook, realtime emit, customer push, earnings-trend dopamine push — gated behind a successful `find_one_and_update`. |
| **Idempotency-Key cache** | Optional header. On first call with key K: persist `{key, scope, userId, bookingId, action, response}` to `idempotency_keys` collection. On retry with same K: return the cached envelope verbatim, no DB writes, no side-effects. If the same K is sent with a *different* (userId, bookingId, action) tuple → 409 "Idempotency-Key reuse mismatch" — catches buggy retry clients early. |
| **Cache is best-effort** | Cache write failure does NOT crash the request — the real mutation already happened, the client got its 2xx. Retry without cache = graceful degradation, not data loss. |

Response envelope:

```json
{
  "ok": true,
  "bookingId": "bk-...",
  "from": "confirmed",
  "to": "in_progress",
  "earnedNow": 0,
  "replayed": false
}
```

`earnedNow` is non-zero only on `complete` transitions; `replayed: true` is the contract for "I observed your intent but nothing changed."

### Backend — `app/provider/work_items.py`

`dispatch_action` now accepts `idem_key: Optional[str] = None` and calls
`apply_booking_transition(...)` directly — no more HTTP shim through a fake
`_Req` wrapper that didn't pass auth headers (which would have started 401-ing
after this sprint regardless of the rest of the change).

The work-items endpoint scope is `provider_work_item_action`, distinct from
the raw booking scope `provider_booking_action`, so the same physical key
sent to both endpoints cannot collide.

### Backend — work-items HTTP endpoint

`POST /api/provider/work-items/{item_id}/action` now reads the optional
`Idempotency-Key` header and threads it through. Body shape unchanged:
`{ "verb": "depart" | "arrive" | "start" | "complete" | ... }`.

### Frontend — both workbench clients

Both clients now mint:

```ts
const idemKey = `wb_${item.id}_${verb}_${Math.floor(Date.now() / 60000)}`;
api.post(`/provider/work-items/${id}/action`, { verb }, {
  headers: { 'Idempotency-Key': idemKey },
});
```

The `epoch-minute` denominator means:
- Same physical tap retried within 60 s ⇒ same key ⇒ cached envelope, no double side-effect.
- User intentionally re-issuing the same verb in the *next* minute ⇒ new key ⇒ backend re-evaluates (will hit the same-state branch if state already at target — still silent on the server side).

This is the doctrinally-correct boundary: client-side dedup is for nervous-finger retries; server-side same-state replay is for any retry that escapes the minute window.

**Files touched:**
- `frontend/app/provider/workbench.tsx` — 1 idem key + 1 header property
- `web-app/src/pages/provider/ProviderWorkbench.tsx` — same

The two workbench screens are now byte-equivalent in their action contract,
which is the same property the hooks have on the comms side. Three surfaces,
three local copies, no shared utility — same doctrine as `formatBadgeCount`.

---

## Tests — `tests/test_provider_dispatch_hardening.py`

9 tests, all passing:

```
test_action_requires_auth                            PASSED  [11%]
test_action_missing_booking_404                      PASSED  [22%]
test_action_foreign_booking_forbidden                PASSED  [33%]
test_action_invalid_transition_409                   PASSED  [44%]
test_action_invalid_verb_400                         PASSED  [55%]
test_action_happy_path_start_then_complete           PASSED  [66%]
test_same_state_replay_is_silent                     PASSED  [77%]
test_idempotency_key_replay_returns_cached_envelope  PASSED  [88%]
test_idempotency_key_collision_mismatch_409          PASSED [100%]
============================== 9 passed in 0.97s ===============================
```

Each test seeds its own organization + booking with a UUID-suffixed id and
cleans up in `finally`. Tests are independent (parallel-safe) and assert
*observational* invariants, not implementation details:

- **`replay_is_silent`** doesn't assert "no push call was made" — it asserts that `statusHistory` length and `startedAt` timestamp are unchanged after the second call. Same property, server-internal-mechanism-agnostic.
- **`idempotency_key_replay_returns_cached_envelope`** mutates the booking back to `confirmed` between the two calls. If the backend re-ran the transition, history would grow; if the cache returned the stored envelope verbatim, the DB stays at the reverted state. Distinguishes cache hit from same-state branch.
- **`idempotency_key_collision_mismatch`** reuses the same key for a different booking → 409. Catches clients that hash their key wrong.

Regression: `tests/test_provider_workbench.py` — 14 passed / 1 pre-existing teardown bug (unrelated event-loop issue in legacy fixture, not in my code path).

End-to-end smoke through the work-items endpoint (live curl with provider JWT):

```
POST /api/provider/work-items/bk_demo-.../action  +Idem-Key  →  state:"completed", enteredCurrentStateAt:T1
POST /api/provider/work-items/bk_demo-.../action  +Idem-Key  →  same envelope, enteredCurrentStateAt:T1 (cache hit)
POST /api/provider/work-items/bk_demo-.../action  no key     →  state:"completed", enteredCurrentStateAt:T1 (same-state branch)
```

Three callers, one mutation. That's the contract.

---

## Doctrine compliance

| Invariant | Held |
|---|---|
| No chat / disputes / attachments / typing surfaces touched | ✅ |
| No new websocket / SSE pubsub introduced | ✅ |
| No global state framework (Redux/Zustand/React Query) | ✅ |
| Projector remains sole writer of `notifications` (referrals, push, performance gated, not removed) | ✅ |
| Same-state replays observationally silent | ✅ |
| Auth + ownership enforced server-side, never client-side | ✅ |
| Atomic transition guard via filtered `find_one_and_update` | ✅ |
| Workbench client contract identical across mobile + web (Idempotency-Key shape, body shape) | ✅ |
| 401/403/404/409/400 surfaces match doctrine table | ✅ |
| Side-effects only on real transition | ✅ |
| Identical hook/utility byte-policy: three call sites, three copies, no shared abstraction | ✅ (workbench idem key minted inline on each surface) |

---

## Files touched

```
MOD    backend/app/provider/router.py                          (~310 lines added / removed → net +120; legacy duplicate purged)
MOD    backend/app/provider/work_items.py                      (+15 lines: idem_key param + direct apply_booking_transition call)
MOD    frontend/app/provider/workbench.tsx                     (+4 lines: idem key + header)
MOD    web-app/src/pages/provider/ProviderWorkbench.tsx        (+5 lines: idem key + header)
NEW    backend/tests/test_provider_dispatch_hardening.py       (315 lines, 9 tests)
NEW    memory/sprint_provider_dispatch_hardening.md            (this file)
```

Other files: untouched.

---

## Next sprint queue (recommended order)

Phase A and the unsafe-action substrate are now closed. The next step is
**Phase B — Chat Normalization** as planned:

1. Canonical thread contract
2. Participant model
3. Support escalation
4. Attachments
5. Emoji
6. Voice
7. Moderation
8. Dispute intervention
9. Unread semantics
10. Polling optimization
11. (eventually) realtime transport

Building any of this *now* lands on a hardened action substrate: a chat
escalation can safely fire a booking transition because the transition
endpoint can no longer be tricked by a stale/foreign/duplicate request.
