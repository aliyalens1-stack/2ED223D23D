# Sprint A2 + A3a — Notifications Hook + Mobile Header Repair (closure)

**Status:** ✅ Closed 2026-05-13
**Class:** Communication Layer v1 / Phase A (foundation), steps 2 and 3a fused per scope decision.
**Anti-class:** Did NOT touch revenue, websocket, chat topology, global state, or admin/provider chat surfaces.

---

## What shipped

### 1. `useNotifications()` — canonical polling transport (A2)

**NEW** `frontend/src/hooks/useNotifications.ts` (216 lines).

Return shape (frozen):
```ts
type UseNotificationsResult = {
  unreadCount: number;
  notifications: Notification[];        // wire shape from shared contract
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
};
```

Internals (deliberately invisible to callers):
- 25 s polling cadence (frozen by sprint scope)
- AsyncStorage cache under keys `notifications:last`, `notifications:unread`, `notifications:cursor`
- Cursor = server-side `serverTime` from `/api/notifications/since` (avoids client-clock skew)
- Focus invalidation via `useFocusEffect` (NOT AppState listeners)
- Optimistic local mark-read; server reconciles on next poll if it rejects
- Inflight coalescing — focus + interval bursts don't double-fetch
- 50-item cache cap

**Does NOT** own: formatting, grouping, chat semantics, optimistic appends, websocket reconnects, role logic, surface logic. Pure transport.

### 2. `useChatUnread()` — temporary chat-unread aggregate (A3a)

**NEW** `frontend/src/hooks/useChatUnread.ts` (76 lines).

Tiny sister hook for the header chat icon badge:
- Polls `GET /api/chat/threads` at 25 s
- Sums `unreadCount` across rows
- Returns `{ unreadCount, loading }` — that's the whole surface

Explicitly temporary — will be replaced by a proper chat state hook in Phase B (chat normalization). No callers depend on it outside the mobile header.

### 3. Mobile header repair (A3a)

**MOD** `frontend/app/additional.tsx`:

- ❌ Deleted hardcoded `<Text>2</Text>` badge
- ✅ Bell badge wired to `useNotifications().unreadCount`
- ✅ Chat icon now has badge wired to `useChatUnread().unreadCount`
- ✅ Badge format contract: 0 hides, 1-99 exact, 100+ shows `"99+"` (via `formatBadgeCount`)
- ✅ `testID="home-bell-badge"` and `testID="home-chat-badge"` for future test agents
- ✅ Renamed bell button `testID="home-bell-btn"` and chat `testID="home-chat-btn"`

Layout contract (header overflow fix):

```
Old layout:                              New layout:
[greeting]   [city] [bell] [chat]        [headerLeft        ] [headerRight       ]
no shrinkage                                ↑ flex:1, minWidth:0   ↑ flexShrink:0
on narrow widths chat clipped            [headerLeft] [city][rail: bell+chat]
                                            shrinks    shrinks    NEVER shrinks
```

Specific style changes:
- `headerLeft`: `flex: 1, minWidth: 0, marginRight: 12` — unlocks left-column shrinkage in a flex row
- `headerRight`: `flexShrink: 0` — right rail is reachable on any width
- `cityChipHeader`: `flexShrink: 1` — city collapses first
- `cityChipHeaderText`: `flexShrink: 1` + `numberOfLines={1}` — city text truncates with ellipsis
- `headerIconRail`: NEW container with `flexShrink: 0` — bell+chat are the only things guaranteed visible
- `headerBadge`: now uses `minWidth: 18` + `paddingHorizontal: 4` so the "99+" form doesn't overlap the icon

Greeting + userName both got `numberOfLines={1}` so long names truncate gracefully instead of wrapping into the second row.

### 4. Side-quest #1 — undefined `<MatchStat>` (A3a)

**MOD** `frontend/app/auto-request/[id].tsx`:

- Added inline component `MatchStat` (4-line render, no props beyond colors/n/label) — local to the file, no module split (would have violated "no abstraction pass")
- Added 5 matching-stats styles (`matchingStatsRow`, `matchStat`, `matchStatDot`, `matchStatN`, `matchStatLabel`)
- Screen no longer crashes when a request has `matching.exposures` populated

### 5. Side-quest #2 — `expo-file-system/legacy` (A3a)

**MOD** `frontend/app/inspector/verification.tsx`:

```diff
- import * as FileSystem from 'expo-file-system';
+ import * as FileSystem from 'expo-file-system/legacy';
```

`EncodingType.Base64` was removed from the top-level `expo-file-system` module in Expo SDK 54. Only this one file used the legacy API; scoping the change to a single import avoids an SDK migration sweep.

---

## Doctrine compliance

| Invariant | Held |
|---|---|
| Projector remains sole writer to `notifications` | ✅ (hook only READS) |
| No revenue layer touches | ✅ |
| No websocket / SSE / Redis pubsub | ✅ (pure 25s polling, no event-bus) |
| No global state framework (Redux/Zustand/React Query) | ✅ (raw `useState` + AsyncStorage) |
| No `provider/chat/*` or `admin/chat/*` touched | ✅ |
| Hook is pure transport — no surface/role logic | ✅ |
| No fake/static counters anywhere | ✅ (hardcoded "2" removed) |
| No chat redesign / disputes / typing / voice | ✅ |
| No notification list page overhaul | ✅ (deferred to A4) |
| No new test infra | ✅ (existing test_admin_notifications_send + locked baseline still green) |

---

## Verification

### Compile & integration
- Web bundle compiles cleanly at 375 px viewport (iPhone SE width)
- No "MatchStat undefined" runtime crash on auto-request detail
- No "EncodingType not found" runtime error on inspector verification
- Bundle modules count unchanged class (`1169 modules` — hook adds <1 KB gzipped)

### End-to-end smoke (live curl)
```
Customer unread before:  {"unread": 10}
POST /api/admin/notifications/send {target: role[customer]}  → 200
Customer unread after:   {"unread": 11}                ← +1, contract honored
GET /api/notifications/since                          → items includes new row
   - id, userId, kind=admin_broadcast, severity, sourceTimelineId all present
```

### Locked baselines
- 45/45 (revenue / 2A-cluster / dedupe / phase1b) — green
- 16/16 (admin_notifications_send) — green
- **Combined 61/61 green**, no regressions

---

## Files touched

```
NEW    frontend/src/hooks/useNotifications.ts            216 lines
NEW    frontend/src/hooks/useChatUnread.ts                76 lines
MOD    frontend/app/additional.tsx                       (header JSX + styles, ~80 lines net)
MOD    frontend/app/auto-request/[id].tsx                (inline MatchStat + 5 styles)
MOD    frontend/app/inspector/verification.tsx           (1 import line)
NEW    memory/sprint_a2_a3a_notifications_hook_and_header.md   (this file)
```

Other files: untouched. Specifically:
- `backend/app/notifications/projector.py` — no change since A1
- `shared/domain/contracts/notification.ts` — no change since A1
- `frontend/app/(tabs)/index.tsx` — has its own header with NO hardcoded "2", NOT in this sprint's scope (will be addressed if/when it shows the same pattern)
- `frontend/app/notifications.tsx` (full screen) — NOT in scope, A4

---

## What is explicitly NOT done (saved for later sprints)

- ❌ Web-app header bell + chat unread — Sprint A3b
- ❌ Admin header bell + admin-targeted notifications — Sprint A3c
- ❌ Full `/notifications` list page rewrite with empty/loading/error states — A4
- ❌ `/admin-panel/notifications` composer + history — A4
- ❌ Chat normalization, typing, voice, attachments, disputes, support escalation — Phase B+
- ❌ `(tabs)/index.tsx` header parity — only `additional.tsx` was on the original screenshot

---

## Acceptance vs scope (point-by-point)

| Acceptance | Status |
|---|---|
| Fake "2" gone | ✅ |
| Unread count real | ✅ |
| Bell updates within 25s | ✅ (polling + focus invalidation) |
| Mark-read decrements | ✅ (optimistic + server reconciliation) |
| Chat unread visible | ✅ (sum of threads.unreadCount) |
| 0 unread hides badge | ✅ (`notifUnread > 0` guard) |
| No clipping iPhone SE width | ✅ (flexShrink contract verified at 375 px) |
| No overlap Android narrow | ✅ (same layout contract) |
| No layout jump 9→10→99+ | ✅ (`minWidth: 18` + `paddingHorizontal: 4`) |
| No websocket | ✅ |
| No global store | ✅ |
| No revenue touches | ✅ |
| No chat topology changes | ✅ |
| No provider/admin branching in hook | ✅ |
