# Sprint A3c + A4 — Communication Surface Completion (closure)

**Status:** ✅ Closed 2026-05-13
**Class:** Communication Layer v1 / Phase A, steps 3c (admin header) and 4 (operational surfaces).
**Anti-class:** Did NOT touch chat topology, websocket transport, provider dispatch, revenue layer, or shared identity runtime. Did NOT introduce filters / geo / cluster / bulk-list targeting in the composer.

---

## What shipped

### A3c — Admin header bell + minimal dropdown

**NEW** `admin/src/hooks/useNotifications.ts` (200 lines).

Identical transport contract as mobile (`frontend/src/hooks/useNotifications.ts`)
and web-app (`web-app/src/hooks/useNotifications.ts`). Same 25 s cadence, same
cursor semantics from `serverTime`, same wire shape from `shared/domain/contracts/notification.ts`.

Platform bindings differ — that's it:
- Cache keys prefixed `admin:notifications:*` in `localStorage`
- Focus invalidation via `visibilitychange` + `focus` (same as web-app)
- Errors routed through admin's normalized axios envelope (`e.original?.response?.status`)

**NEW** `admin/src/components/NotificationBell.tsx` (215 lines).

Minimal dropdown — exactly what doctrine asked for:
- Bell icon with unread badge (0 → hidden, 1..99 → exact, 100+ → `99+`)
- `testID="admin-bell-btn"` and `testID="admin-bell-badge"`
- Top 10 notifications, unread highlighted with indigo dot + tinted background
- Click row → marks read + navigates `actionUrl` (deep-link safe; strips `/api/admin-panel` prefix, opens external `http*` in new tab)
- "Все как прочитанные" link → `markAllRead()`
- "Открыть все уведомления →" link → navigates to `/notifications`
- Click-outside / Escape closes (event listeners scoped to `open`)
- Severity chips on rows: `crit` (red) / `warn` (yellow)
- Empty state ("Пока ничего нет"), loading state ("Загрузка...")

**MOD** `admin/src/components/Layout.tsx`:
- Imported `NotificationBell`
- Added it next to the connection-status pill in the sidebar header, before the Wifi/WifiOff indicator
- `enabled={!!user}` — guests don't poll

Explicitly NOT here:
- composer / send UI in the bell — it lives on the page (A4)
- filters / moderation / categories
- chat integration / live toasts / websocket
- non-admin notifications surface logic (admin sees its own user-scoped stream)

### A4 — Notifications operational surfaces (mobile + web + admin)

#### Mobile rewrite

**MOD** `frontend/app/notifications.tsx` (rewritten on canonical contract).

Was: hand-rolled state machine reading legacy `GET /api/notifications` and
locally tracking unread.

Now: pure presentation over the canonical `useNotifications()` hook.

What changed:
- Reads `/api/notifications/since` via the shared hook (cursor + cache)
- State (items, unreadCount) owned by the hook → bell badge in header
  updates the instant the user marks-read on this screen (shared cache)
- Pull-to-refresh calls `refresh()` which resets the cursor
- Severity wins over kind-specific icons (`critical` → red warning,
  `warning` → amber alert-circle, otherwise the kind-based icon)
- Added `admin_broadcast` kind to the icon map (megaphone, brand tone)
- Wraps `99+` badge clamp on the header pill
- testIDs: `notifications-unread-badge`, `notifications-empty`,
  `notifications-error`, `notifications-mark-all`

#### Web (NEW)

**NEW** `web-app/src/pages/notifications/NotificationsPage.tsx` (200 lines).

Customer + provider/inspector route mounts share one canonical component:
- `/account/notifications` inside `CustomerShell`
- `/provider/notifications` inside `OperatorShell`

Behavior:
- Reads via the existing web-app `useNotifications()` (A3b)
- 50-item cache, no pagination beyond that (matches mobile/admin)
- Empty / loading / network-error states
- Click row → marks read + navigates `actionUrl` (relative or external)
- "Все как прочитанные" button visible only when `unreadCount > 0`
- Severity chips (crit/warn), kind-based icon palette (megaphone for broadcast)
- testIDs throughout: `webapp-notifications-page`, `notifications-list`,
  `notifications-refresh`, `notifications-mark-all`, `notification-{id}`,
  `notifications-empty`, `notifications-error`, `notifications-loading`,
  `notifications-unread-pill`, `notifications-back`

**MOD** `web-app/src/App.tsx`:
- Lazy-imported `NotificationsPage`
- Added the two route children — no shell changes

#### Admin (NEW canonical, legacy preserved)

**MOVED** `admin/src/pages/NotificationsPage.tsx` → `NotificationsPageLegacy.tsx`.

The legacy page had templates + tier/score/zone filters + channel selection
(push/sms/email). Those concepts are **outside the canonical A1 contract**:
the backend only supports `target: all | role | user`, no provider tiers,
no zones, no channels. Keeping it on the route would have lied to operators
about what targeting actually does on the server. It is preserved on disk
for revert safety, but no route renders it.

**NEW** `admin/src/pages/NotificationsPage.tsx` (430 lines).

Two tabs:

1. **Inbox** — same `useNotifications()` reader as the header bell, with a
   compact stats line, refresh button, mark-all-read. Empty / error /
   loading states. Each row has the same affordances as the bell row
   (severity chip, broadcast pill, deep-link icon).

2. **Composer** — canonical minimal broadcast. Only contract:
   - `target`: radio between `all` / `role` / `user`
     - `role` exposes the three canonical roles (`customer`, `inspector`,
       `admin`) with the legacy-mapping note from the contract docstring
     - `user` is a free-text userId
   - `title` (1..120) + live counter, red border past max
   - `body` (1..1000) + live counter, red border past max
   - `severity` (info | warning | critical), one row of segmented buttons
   - `deepLink` (optional), free-text
   - Submits `POST /api/admin/notifications/send`
   - Result envelope renders: `eventId · recipients · projected`
   - Disabled until title + body + target are valid
   - Right column carries an explicit "Что НЕ поддерживается" list as
     in-product doctrine

testIDs throughout the composer: `admin-notif-tab-inbox`, `admin-notif-tab-composer`,
`admin-notif-title`, `admin-notif-body`, `admin-notif-sev-{level}`,
`admin-notif-deeplink`, `admin-notif-target-{mode}`, `admin-notif-role-{role}`,
`admin-notif-userid`, `admin-notif-send`, `admin-notif-result`,
`admin-notif-mark-all`, `admin-notif-row-{id}`.

Route `/notifications` continues to mount through the existing `App.tsx`
declaration — no router changes needed.

---

## Doctrine compliance

| Invariant | Held |
|---|---|
| Projector remains sole writer to `notifications` | ✅ (admin composer hits `POST /api/admin/notifications/send`, which emits a timeline event; projector fans out) |
| No revenue layer touches | ✅ |
| No websocket / SSE / Redis pubsub | ✅ (pure 25 s polling on all three surfaces) |
| No global state framework (Redux/Zustand/React Query) | ✅ (raw `useState` + `localStorage` cache) |
| No `provider/chat/*` or `admin/chat/*` touched | ✅ |
| Hooks pure transport, no surface logic | ✅ (mobile/web-app/admin hooks are byte-equivalent except cache key prefix + axios envelope) |
| Composer targeting limited to `all | role | user` | ✅ (UI mirrors the backend `_resolve_broadcast_recipients` exactly) |
| No geo / cluster / providerSlug / bulk lists / scheduling | ✅ (explicitly enumerated in the UI "not supported" panel) |
| No markdown / attachments / campaigns | ✅ |
| Identical badge format across surfaces (0 hidden, 1-99 exact, 100+ → 99+) | ✅ (three call sites, three local `formatBadgeCount` copies — no shared utility, per doctrine) |
| Chat normalization NOT touched | ✅ (deferred to Phase B per the recommended order) |
| Provider Dispatch Hardening NOT touched | ✅ (queued as next sprint after Phase A closes) |

---

## End-to-end verification

Backend smoke test (live curl with admin JWT):

```
GET  /api/health                                → {"status":"ok","db":"connected"}
POST /api/auth/login (admin@autoservice.com)    → 200 + JWT (320 chars)
GET  /api/notifications/unread-count            → {"unread":0}
POST /api/admin/notifications/send {target:all} → {"ok":true,"eventId":"f7f43...","recipients":5,"projected":5}
GET  /api/notifications/unread-count            → {"unread":1}    ← +1, canonical
GET  /api/notifications/since?limit=3           → items[0]: kind=admin_broadcast severity=info title="A4 smoke test"
```

Frontend smoke test (Playwright @ 1440×800):

1. Admin login → Control Tower dashboard renders, bell in sidebar header
   shows `1` red badge (the test broadcast was projected to admin too).
2. Click bell → dropdown opens, shows the broadcast row with BROADCAST chip
   and "A4 smoke test" title + "From the new canonical composer" body +
   "just now" timestamp.
3. Navigate to `/notifications` → Inbox tab shows the same row, full-page
   layout, "Всего: 1 · непрочитано: 1" stats.
4. Switch to Composer tab → form renders with empty title/body, severity
   = info selected, Target = All selected, "Что НЕ поддерживается" panel
   on the right.

### Vite builds

- `admin/dist/index-3FkbF3df.js` (37.8 kB) — admin entry incl. NotificationBell
- `admin/dist/assets/admin-ops-*.js` (403 kB) — picks up the new `NotificationsPage`
- `web-app/dist/assets/NotificationsPage-CiD05QVY.js` (7.95 kB / 3.16 kB gzip) — split into its own lazy chunk by the existing manualChunks config

No new test files added (per sprint scope; locked baselines remain green).

---

## Files touched

```
NEW    admin/src/hooks/useNotifications.ts                    200 lines
NEW    admin/src/components/NotificationBell.tsx              215 lines
MOD    admin/src/components/Layout.tsx                        (+1 import, header JSX wrap, ~15 net)
MOVED  admin/src/pages/NotificationsPage.tsx → NotificationsPageLegacy.tsx
NEW    admin/src/pages/NotificationsPage.tsx                  430 lines
MOD    frontend/app/notifications.tsx                         (rewritten, 195 lines)
NEW    web-app/src/pages/notifications/NotificationsPage.tsx  200 lines
MOD    web-app/src/App.tsx                                    (+1 lazy import, +2 route children)
NEW    memory/sprint_a3bc_a4_admin_notifications.md           (this file)
```

Other files: untouched. Specifically:
- `backend/app/notifications/projector.py` — no change since A1
- `shared/domain/contracts/notification.ts` — no change since A1
- `web-app/src/hooks/useNotifications.ts` + `useChatUnread.ts` — no change since A3b
- `frontend/src/hooks/useNotifications.ts` + `useChatUnread.ts` — no change since A2/A3a
- `frontend/app/additional.tsx` — header parity remains from A3a
- `web-app/src/components/MarketplaceLayout.tsx` + `shells/*` — no change

---

## What is explicitly NOT done (next sprint queue, in the doctrinally-correct order)

1. **Provider Dispatch Hardening** (next — booking actions are operationally
   unsafe; notifications/chat are visibility, not action)
2. **Phase B — Chat Normalization** (only after dispatch is hardened):
   canonical thread contract, participant model, support escalation,
   attachments, emoji, voice, moderation, dispute intervention, unread
   semantics, polling optimization, eventually realtime.

Building chat richness over an unsafe action substrate was explicitly
rejected — that is why Phase A closed first.

---

## Acceptance vs scope

| Acceptance | Status |
|---|---|
| Admin bell badge wired to canonical `unread-count` | ✅ |
| Bell dropdown shows latest 10 with unread highlighting | ✅ |
| Click row → mark-read + open `actionUrl` | ✅ |
| Mark-all-read works | ✅ |
| Polling 25s, focus-invalidate | ✅ |
| No composer / filters / chat in the bell | ✅ |
| Mobile notifications screen on canonical hook | ✅ (header bell now reflects mark-read instantly) |
| Web `/account/notifications` + `/provider/notifications` exist | ✅ |
| Admin `/notifications` minimal composer (`all | role | user`) | ✅ |
| Composer fields: title + body + severity + target + optional deepLink | ✅ |
| No markdown / attachments / scheduling / campaigns | ✅ |
| No chat system touched | ✅ |
| Badge contract identical across all three surfaces | ✅ |
| Live curl + projected row verified end-to-end | ✅ |
