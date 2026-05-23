# P0.b.C.d.UI.a — Customer timeline realtime consumer · CLOSURE

> First consumer of the realtime fanout. Surface-local, scope-limited.
> Date: 2026-05-20.

## Brief

Implement the customer's read-only consumer of `GET /api/customer/bookings/{id}/timeline`
plus the corresponding WebSocket stream, following the
**REST hydrate → WS append acceleration → periodic REST reconciliation**
contract. Customer scope ONLY. Provider/Inspector/Admin consumers deferred.

## Files (additive only, all surface-local)

| File | Role |
| --- | --- |
| `frontend/src/customer/booking-timeline/types.ts` | Event/snapshot/envelope types — duplicated from backend `projections/customer.py`, not shared with other surfaces |
| `frontend/src/customer/booking-timeline/reducer.ts` | Pure reducer · actions: `hydrate` / `reconcile` (REST-wins) / `append` (WS, dedup by `at|key`) / `reset` |
| `frontend/src/customer/booking-timeline/useCustomerBookingTimeline.ts` | Hook that owns: REST hydrate → WS connect → 30s reconcile → exponential backoff (1s→10s) → unmount cleanup |
| `frontend/src/customer/booking-timeline/index.ts` | Public re-export — customer surface boundary |
| `frontend/app/customer/booking/[id]/timeline.tsx` | Route screen — renders the timeline with a `Live/Reconnecting/Offline` pill, FlatList of rows, RefreshControl, empty state |
| `backend/test_customer_timeline_ws_smoke.py` | Out-of-process smoke validating REST + WS handshake + bad-token close — 5/5 checks |

## Architectural invariants upheld

1. **Snapshot equivalence preserved at consumer**
   - Hook never invents events. WS frames go through `dedupKey(at + '|' + key)`; if REST snapshot doesn't include an appended WS row at next reconciliation, it is dropped (REST always wins via `reconcile` action).

2. **No framework gravity**
   - Hook + reducer + types live in `src/customer/booking-timeline/`. No file in `src/shared/`.
   - Provider/inspector/admin will get their own folders (`src/provider/booking-timeline/`, …) with their own duplicated reducers when their UI consumers land.

3. **REST is source of truth, WS is acceleration**
   - First paint is REST hydrate. WS connects AFTER hydrate completes — no empty-while-connecting paint.
   - Every 30 s a fresh REST snapshot REPLACES local state (`reconcile`). Drift window ≤ 30 s.
   - On WS close, exponential backoff (1s, 2s, 4s, 8s, 10s cap). REST reconciliation continues independent of WS state.

4. **No optimistic updates, no offline queue, no shared subscription registry**
   - Hook only consumes; never writes.
   - WS lifecycle is hook-instance-local. Unmount closes the socket. No multiplexing across screens.

5. **Customer opacity preserved end-to-end**
   - Hook accepts only `{type:"timeline.updated", scope:"customer", bookingId}` frames. Any other envelope is silently ignored, so a future server bug that accidentally cross-fanouts (provider envelope to customer socket) would not surface in the customer UI.

## Acceptance — out-of-process smoke

```
✓ logged in as customer
✓ seeded service_request id=test-ts-… customerId=…
✓ wrote 2 booking_timeline rows
✓ REST snapshot OK · keys=['confirmed', 'on_route'] eta=15 min
✓ WS hello received · scope=customer bookingId=…
✓ WS keepalive pong received
✓ WS bad-token rejected · InvalidStatus
✓ cleanup done
✅ ALL CHECKS PASSED
```

`backend/test_customer_timeline_ws_smoke.py` proves the consumer-relevant contract:
- REST returns projected events with `eta` meta surviving the projection whitelist.
- WS subscribe with valid JWT yields `hello` with `scope:"customer"`.
- Server pongs on any inbound frame (keepalive).
- Bad token closes with 4401 — consumer's `onclose` will run, switch to `reconnecting`, retry with backoff.

> NOTE: end-to-end **realtime fanout** (publish → frame arrives at client) was already proven in P0.b.C.d (13/13 e2e). That test runs in-process to access `HUB_CUSTOMER`. This UI smoke validates only what the new consumer depends on at the contract surface.

## Visual acceptance

| Screen state | Verified |
| --- | --- |
| Empty timeline · `Live` pill green | ✅ — `customer-timeline-empty` testID + clock icon + RU copy |
| 4 events list · `Live` pill green | ✅ — `customer-timeline-row-{confirmed,on_route,arrived,in_progress}`, `ETA · 15 min` rendered, ISO timestamps formatted |

Both screenshots at `/tmp/customer_timeline_empty.png` and `/tmp/customer_timeline_full.png` from the preview pod.

## What we explicitly did NOT do

| Anti-goal | Decision |
| --- | --- |
| Global websocket manager / subscription registry | ❌ — hook owns its own WebSocket instance |
| Optimistic updates | ❌ — reducer only accepts server-delivered events |
| Offline queue | ❌ — drop-on-disconnect, reconcile on next REST window |
| Shared reducer in `src/shared/` | ❌ — surface-local under `src/customer/booking-timeline/` |
| Provider / inspector / admin consumers | ❌ — each surface gets its own folder + own reducer + own hook later |
| Reconnect orchestration abstraction | ❌ — backoff is 5 lines of `setTimeout` inside the hook |
| Cross-surface theming / animation library | ❌ — plain React Native + StyleSheet |

## Next slice

`P0.b.C.d.UI.b — Provider realtime consumer`. Mirror this folder structure under
`src/provider/booking-timeline/` with provider projection types. Do NOT
generalize. Then inspector. Admin forensic last (highest throughput / noise).

## Test credentials used

- `customer@test.com / Customer123!` → `userId=6a0e216679a9940011633d8d`
- Booking created at runtime in `service_requests` collection

## Route

- New: `GET /customer/booking/[id]/timeline` (mobile + web)
