# P0.b.C.d.UI.c — Inspector job timeline consumer · CLOSURE

> Third consumer of the realtime fanout. Inspector scope only.
> Surface-local. Manual repetition + ONE new inspector-specific guard.
> Date: 2026-05-21.

## Brief

Implement the inspector's read-only consumer of
`GET /api/inspector/jobs/{jobId}/timeline` plus the WebSocket stream,
following the **same** REST hydrate → WS append → reconciliation
contract as customer + provider, but with an additional local
**stale-WS watchdog** that proactively evicts WS-appended events
which REST never confirms within `STALE_WS_TIMEOUT_MS`.

## Wire identity discipline (most important contract here)

Inspector surface speaks **jobId**. The wire NEVER carries
`bookingId` / `requestId`. Server translates jobId → requestId
internally for chronology lookup. The hook deliberately:

* requires only `jobId` as input;
* renders only `jobId` in the screen header;
* drops any WS frame that does not match `{scope:"inspector", jobId:<self>}`.

If a future field "bookingId" or "requestId" ever appears in either
the REST envelope or a WS payload, this contract is broken and a
snapshot test should catch it.

## Files (additive, all in inspector surface)

| File | Role |
| --- | --- |
| `frontend/src/inspector/booking-timeline/types.ts` | Inspector event/snapshot/envelope — mirror of `backend/app/booking/projections/inspector.py` |
| `frontend/src/inspector/booking-timeline/reducer.ts` | Reducer · actions: `hydrate` / `reconcile` (REST-wins) / `append` (dedup by `at|key`) / **`drop`** (watchdog eviction) / `reset` |
| `frontend/src/inspector/booking-timeline/useInspectorJobTimeline.ts` | Hook · REST hydrate → WS subscribe → **20 s** reconcile (tighter than customer/provider's 30 s) → exponential backoff → **stale-WS watchdog** |
| `frontend/src/inspector/booking-timeline/index.ts` | Public re-export — inspector surface boundary |
| `frontend/app/inspector/jobs/[jobId]/timeline.tsx` | Route screen · inspector tone palette · report pill · *own* payout pill · stale-drop banner |
| `backend/test_inspector_timeline_ws_smoke.py` | Smoke — REST projection + jobId-only wire + meta whitelist + `mark_confirmed` drop + foreign 404 + WS handshake + bad-token close (8 ✓ checks) |

**No file in `src/shared/`. No file imports from `src/customer/` or `src/provider/`.**

## New inspector-specific guard — stale-WS watchdog

```
When a WS frame arrives with a dedup key NOT in any prior REST snapshot,
arm a per-event watchdog timer (45 s).

If reconciliation observes the same key WITHIN that window,
   clear the watchdog (REST has confirmed legitimacy).

If the watchdog fires WITHOUT REST confirmation,
   dispatch {type:'drop', key} and log the eviction.
   Visible to the operator as a "Сброшено N событий" banner.
```

Why inspector specifically:

* **Highest semantic density.** Documentation/checklist flow on the field.
* **Longest workflows.** Drift windows are visible to the operator longer.
* **Most likely surface to hit partial-state bugs first.**

The watchdog is implemented as a `useRef<Map>` of timers and is
strictly local to `useInspectorJobTimeline`. Customer + provider
hooks do NOT have it — those surfaces are content with the existing
30 s reconcile-replace semantics. Each surface decides for itself.

Reconcile interval here is also tighter — **20 s vs customer/provider 30 s** —
acknowledging the operational density of field work.

## Acceptance — backend smoke

```
✓ inspector login · userId=…
✓ customer login (for foreign-token negative test)
✓ seeded inspection_job _id=… → requestId=…
✓ wrote 4 timeline rows (incl. mark_confirmed for drop test)
✓ REST projection OK · keys=['assigned', 'on_route', 'completed'] tones=['ready', 'travel', 'submitted']
  · reportId=RPT-abc12, inspectorPayoutAmount=65.0 surfaced
  · provider payoutAmount, customerNote, platformCut, internalNotes filtered
  · mark_confirmed dropped (provider commitment not in inspector chronology)
  · No requestId/bookingId in envelope or events
✓ Foreign caller (customer) → 404 (job opacity preserved)
✓ WS hello received · scope=inspector jobId=…
  · payload does not echo bookingId or requestId
✓ WS keepalive pong
✓ WS bad-token rejected · InvalidStatus
✓ cleanup done
✅ ALL CHECKS PASSED
```

The smoke pins ALL inspector contract invariants in one run:

1. **jobId-only wire** — REST envelope, REST events, and WS hello payload all checked for absence of `requestId` / `bookingId`.
2. **mark_confirmed drop** — provider commitment row inserted and the projection asserts it does NOT appear.
3. **Inspector meta whitelist** — `reportId`, `inspectorPayoutAmount`, `eta`, `reason` surface; `payoutAmount` (provider's), `customerNote`, `platformCut`, `internalNotes` are filtered.
4. **Tone vocabulary** — `[ready, travel, submitted]` — different from customer (`positive/celebratory`) and provider (`action_required/in_flight/settled`).
5. **isSelfAction discipline** — system-actor row is not self; inspector-actor rows are self.
6. **Foreign caller opacity** — customer token → 404 (not 403, not "exists but forbidden").
7. **WS auth** — bad token → 4401-style close.
8. **WS keepalive** — server pong on any inbound frame.

## Visual acceptance

6 rows seeded (including a `mark_confirmed` for drop assertion).
Screen rendered 5 rows (confirmed correctly dropped):

| Event | Tone | Dot | Self | Inspector-only meta |
| --- | --- | :---: | :---: | --- |
| assigned | ready | 🟣 violet | – | – |
| ~~confirmed~~ | – | – | – | **filtered (not rendered)** |
| on_route | travel | 🔵 sky | ВЫ | ETA · 12 min |
| arrived | on_site | 🟢 teal | ВЫ | – |
| inspecting | documenting | 🟡 yellow | ВЫ | own note box: "Открываю чек-лист, 60 пунктов" |
| completed | submitted | 🟢 green | ВЫ | **Отчёт #RPT-7K2** + **Ваша выплата · €65.00** |

Status pill: `Live`. Header: `Хронология осмотра` + `Job #ui-insp-`.
All expected testIDs present (5 row testIDs, jobId chip, report pill,
payout pill); `inspector-timeline-row-confirmed` deliberately absent;
no `inspector-timeline-stale-banner` (clean state). Screenshot:
`/tmp/inspector_timeline_full.png`.

## Architectural invariants upheld

1. **Surface-local everything**
   - Inspector reducer/hook/screen all under `src/inspector/booking-timeline/` and `app/inspector/jobs/[jobId]/timeline.tsx`. No imports cross surface boundaries.

2. **Realtime informs, REST authorizes**
   - Hook returns `{events, status, lastError, refresh, staleDropCount}` — NO computed action legality (`canDepart`, `canSubmit`, `nextAction`). Screen has NO action CTAs.

3. **Strict envelope guard**
   - Any frame missing `scope:"inspector"` or `jobId === self` is silently dropped before reaching the reducer.

4. **Inspector-only stale-WS watchdog**
   - Local, in-hook, per-event timer. Surface-specific, not abstracted.

5. **Inspector meta whitelist mirrors backend exactly**
   - `eta`, `reason`, `note`, `reportId`, `inspectorPayoutAmount`. Provider's `payoutAmount` / `customerNote` are typed `undefined` and cannot accidentally render.

6. **Inspector tone palette deliberately different**
   - `ready`/`travel`/`on_site`/`documenting`/`submitted`/`closed`/`attention` — field-operation vocabulary, not service-execution.

## What we explicitly did NOT do

| Anti-goal | Decision |
| --- | --- |
| Reuse customer/provider reducer / types / component | ❌ — manually duplicated |
| Generic `Timeline<T>` / `createRealtimeTimelineHook(scope)` | ❌ — even now that the pattern is proven 3×, abstraction pressure still feels artificial |
| Action buttons on this screen | ❌ — no CTAs; future CTAs must read action legality from job REST |
| Cross-surface stale-WS detection | ❌ — kept local to inspector |
| `bookingId` / `requestId` echo anywhere on wire | ❌ — explicit absence tests in smoke |
| Inspector dashboard live counters | ❌ — out of scope; single-job timeline only |

## Order of consumers (status)

| Consumer | Status |
| --- | :---: |
| Customer (UI.a) | ✅ DONE |
| Provider (UI.b) | ✅ DONE |
| **Inspector (UI.c)** | ✅ **DONE** |
| Admin forensic (UI.d) | ⏳ next |

## Pattern observation — three repeats in

After three manual implementations the pattern stays at the same
size (~250 LOC hook, ~80 LOC reducer, ~30 LOC types, ~300 LOC
screen). Surface-specific divergences emerge naturally:

* customer added nothing extra
* provider added `payoutAmount` pill + customer note box
* inspector added the stale-WS watchdog + jobId-only identity model + drop reducer action

At least one inspector-specific concept (`drop` action, `staleDropCount`,
watchdog `Map<key, Timeout>`) does NOT belong in customer/provider.
A premature `Timeline<T>` would have either generalized this away
(losing specificity) or required `if (scope === 'inspector')` branches.

Continue without abstraction.

## Test credentials used

- `provider@test.com / Provider123!` → `userId=6a0e216679a9940011633d8e`
  (this user is the assignee on demo inspection jobs; auth role is
  `provider_owner` but inspector ownership is determined by
  `inspection_jobs.inspectorId`, not the auth role claim)
- `customer@test.com / Customer123!` (foreign-token 404 negative test)

## Route

- New: `GET /inspector/jobs/[jobId]/timeline` (mobile + web)
