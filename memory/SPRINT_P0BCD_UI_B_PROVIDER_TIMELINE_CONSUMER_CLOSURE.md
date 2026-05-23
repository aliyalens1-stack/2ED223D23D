# P0.b.C.d.UI.b — Provider timeline realtime consumer · CLOSURE

> Second consumer of the realtime fanout. Provider scope only.
> Surface-local. Manual repetition of the customer pattern — NOT
> abstracted.
> Date: 2026-05-20.

## Brief

Implement the provider's read-only consumer of
`GET /api/provider/bookings/{id}/timeline` plus the WebSocket stream,
following the **same** REST hydrate → WS append → 30s reconciliation
contract proven by UI.a — but with NO shared reducer/hook/component
with the customer surface.

## Doctrine repeated manually (per architectural review)

> Customer realtime proved **safe delivery**.
> Provider realtime must prove **operational usefulness** without
> becoming a state authority.

Concretely: this surface renders execution-oriented chronology
(`action_required` / `in_flight` / `settled` / `alert` tones) plus
provider-only meta (`payoutAmount`, `customerNote`, own `note`). It
exposes NO action CTAs. If/when CTAs are added later, action
legality MUST come from the booking REST snapshot — never from the
arrival of a WS frame.

## Files (additive, all in provider surface)

| File | Role |
| --- | --- |
| `frontend/src/provider/booking-timeline/types.ts` | Provider event/snapshot/envelope types — duplicated from `backend/app/booking/projections/provider.py` |
| `frontend/src/provider/booking-timeline/reducer.ts` | Pure reducer (hydrate / reconcile / append / reset). Near-copy of customer reducer but lives in its own module |
| `frontend/src/provider/booking-timeline/useProviderBookingTimeline.ts` | Hook — REST hydrate → WS subscribe → 30s reconcile → exponential backoff (1s → 10s) |
| `frontend/src/provider/booking-timeline/index.ts` | Public re-export — provider surface boundary |
| `frontend/app/provider/booking/[id]/timeline.tsx` | Route screen — Live/Reconnecting/Offline status pill (provider colour palette), FlatList of events, RefreshControl, empty state, **NO action CTAs** |
| `backend/test_provider_timeline_ws_smoke.py` | Smoke proving REST projection + meta whitelist + foreign-caller 404 + WS handshake + bad-token close (7 ✓ checks) |

**Important: NO file in `src/shared/`, NO file imported across customer↔provider boundaries.**

## Acceptance — smoke

```
✓ provider login · userId=…
✓ customer login (for foreign-token negative test)
✓ seeded service_request id=… providerId=…
✓ wrote 2 timeline rows with whitelisted+forbidden meta
✓ REST projection OK · keys=['matched', 'completed'] tones=['action_required', 'settled']
  · customerNote surfaced, payoutAmount=87.5
  · platformCut/internalNotes/commission filtered
✓ Foreign caller (customer) → 404 (opacity preserved)
✓ WS hello received · scope=provider bookingId=…
✓ WS keepalive pong
✓ WS bad-token rejected
✓ cleanup done
✅ ALL CHECKS PASSED
```

The smoke deliberately seeds rows carrying BOTH whitelisted
(`customerNote`, `payoutAmount`, `note`, `eta`) and forbidden
(`platformCut`, `internalNotes`, `commission`) meta. The projection
must surface the first set and drop the second set in the same call.
This pinning prevents future regressions where someone "just adds one
more field" to projection output without auditing.

## Visual acceptance

Provider timeline screen (`/provider/booking/ui-provider-demo/timeline`)
rendered all 6 milestones with correct semantics:

| Event | Tone | Dot color | Self badge | Meta |
| --- | --- | :---: | :---: | --- |
| matched | action_required | 🟠 | – | customerNote box |
| confirmed | neutral | ⚪ | ВЫ | – |
| on_route | in_flight | 🔵 | ВЫ | ETA · 20 min |
| arrived | in_flight | 🔵 | ВЫ | – |
| in_progress | in_flight | 🔵 | ВЫ | – |
| completed | settled | 🟢 | ВЫ | own note box + **Выплата · €142.50** |

All 6 row testIDs + payout testID present. Status pill = `Live`.
Screenshot: `/tmp/provider_timeline_full.png`.

## Architectural invariants upheld

1. **Surface-local reducer / hook / component**
   - Provider files live in `src/provider/booking-timeline/`. No file imports from `src/customer/`. Hook + reducer are near-copies of customer's, deliberately so — divergence pressure is the test.

2. **Realtime informs, REST authorizes**
   - Hook returns ONLY `{events, status, lastError, refresh}`. There is no `canConfirm`, `canDepart`, `nextAction`, or any computed action legality. The screen renders no CTAs at all in UI.b. Future CTA additions must query the booking REST resource for legality.

3. **Strict client-side envelope guard**
   - Provider hook silently drops any frame where `scope !== 'provider'` or `bookingId` does not match. Even if a future server bug sent a customer-projected envelope over the provider socket, the provider UI would not surface it.

4. **Provider meta whitelist mirrors backend exactly**
   - `eta`, `reason`, `payoutAmount`, `customerNote`, `note` — anything else is `undefined` in the type, so a future leaked field cannot accidentally render.

5. **Tone palette deliberately different from customer**
   - `action_required` (orange), `in_flight` (blue), `settled` (green), `alert` (red), `neutral` (gray). Customer uses celebratory yellow/green. Same chronology, different operational emotion.

## What we explicitly did NOT do

| Anti-goal | Decision |
| --- | --- |
| Provider dashboard realtime counters | ❌ — out of scope |
| Payout live bridge | ❌ — payout amount surfaces only as embedded meta on `completed` row |
| Action auto-enabling from WS frame | ❌ — no CTAs on this screen at all |
| Global provider event hook | ❌ — hook is per-screen, per-booking |
| Reuse of customer reducer / types / component | ❌ — manually duplicated, never imported |
| Shared timeline component (`Timeline<T>`) | ❌ — rejected even as a temptation |
| Optimistic mutation echo | ❌ — provider mutations route through their own REST endpoints; timeline reflects only what server says happened |

## Order of consumers (status)

| Consumer | Status |
| --- | :---: |
| Customer (UI.a) | ✅ DONE |
| **Provider (UI.b)** | ✅ **DONE** |
| Inspector (UI.c) | ⏳ pending |
| Admin forensic (UI.d) | ⏳ pending |

Each remaining consumer follows the same recipe: own folder, own
reducer, own hook, own component, own smoke. No abstraction yet.
The repetition is intentional pressure testing.

## Test credentials used

- `provider@test.com / Provider123!` → `userId=6a0e216679a9940011633d8e`
- `customer@test.com / Customer123!` (negative test for foreign-token 404)
