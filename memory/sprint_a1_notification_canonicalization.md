# Sprint A1 — Notification Canonicalization + Admin Send (closure)

**Status:** ✅ Closed 2026-05-13
**Scope:** Phase A of Communication Layer v1, step 1 (backbone). Strictly limited to backend contract + canonical types. NO mobile/web/admin UI yet — that is A3.

---

## What shipped

### 1. Canonical wire contract

**NEW** `shared/domain/contracts/notification.ts` (typed-only, no runtime code, no React, no Expo).

Exports:
- `Notification` — wire shape every surface reads
- `NotificationSeverity` — `'info' | 'warning' | 'critical'`
- `NotificationRole` — `Extract<AccountKind, 'customer' | 'inspector' | 'admin'>` (guest excluded — no JWT)
- `NOTIFICATION_ROLES` — readonly tuple of the above
- `NotificationTarget` — discriminated union: `{type:'all'} | {type:'role', roles:[]} | {type:'user', userId}`
- `UnreadCountResponse`
- `NotificationSinceResponse`
- `AdminNotificationRequest` / `AdminNotificationResponse`
- Type predicates: `isAllTarget`, `isRoleTarget`, `isUserTarget`

**NOT exported (deliberately deferred):** `NotificationThread` — flat shape until any consumer requires grouping. Adding a placeholder type now would commit us to an unvalidated design.

### 2. Admin broadcast endpoint

**NEW** `POST /api/admin/notifications/send` (in `backend/app/notifications/projector.py`).

Architectural path enforced:
```
admin_send
   ↓ inserts ONE row into timeline_events { kind: "admin_broadcast", metadata: {target, title, body, deepLink?} }
   ↓ calls project_event(event)
   ↓ projector fans out via _resolve_broadcast_recipients()
   ↓ inserts N rows into notifications (idempotent via unique (userId, sourceTimelineId))
```

**The projector remains the SOLE writer of `notifications`.** `admin_send` does NOT touch `notifications` directly. This preserves:
- Dedupe invariants
- Replay/backfill semantics (running `POST /api/admin/notifications/backfill` produces 0 new rows for already-projected events)
- Provenance (every notification row carries `sourceTimelineId` pointing back at one timeline event)

### 3. Targeting semantics (canonical, minimal)

| Target shape | Recipient resolution |
|---|---|
| `{type:"all"}` | union of all legacy roles in BROADCAST_ROLE_TO_LEGACY_ROLES |
| `{type:"role", roles:["customer"]}` | `users.role = "customer"` |
| `{type:"role", roles:["inspector"]}` | `users.role IN ("inspector", "provider_owner")` |
| `{type:"role", roles:["admin"]}` | `users.role IN ("admin", "superadmin", "operator")` |
| `{type:"user", userId:"<hex>"}` | exactly that user, supports both ObjectId and stringified ids |

Anything else (`provider`, `geo`, `cluster`, arbitrary lists) → 400 with the allowed set echoed. This keeps the system from drifting into campaign-engine territory.

### 4. Validation

Server-side caps mirror the contract: title 1..120, body 1..1000. Validation happens BEFORE any DB write, so a 400 is a pure no-op.

---

## Doctrine compliance

| Invariant | Held |
|---|---|
| Projector is sole writer of `notifications` | ✅ |
| Notifications remain a projection of `timeline_events` | ✅ |
| No revenue layer touches | ✅ (no files in `app/revenue/` modified) |
| No websocket / SSE / Redis pubsub added | ✅ |
| No `provider/chat/*` or `admin/chat/*` touched | ✅ |
| No fake seed notifications | ✅ (admin send is the only way to produce broadcasts) |
| `/unread-count` and `/since` contracts unchanged | ✅ (verified by re-running the locked baseline) |

---

## Verification

Live curl against running backend (verbose results in conversation transcript):

```
POST /api/admin/notifications/send  {target:all}                        → 200 {recipients:33, projected:33}
POST /api/admin/notifications/send  {target:role[inspector]}            → 200 {recipients:18, projected:18}
POST /api/admin/notifications/send  {target:role[customer,admin]}       → 200 {recipients:15, projected:15}
POST /api/admin/notifications/send  {target:user, userId:<provider_uid>} → 200 {recipients:1, projected:1}
POST /api/admin/notifications/send  {target:user, userId:<bogus>}       → 200 {recipients:0, projected:0}
POST /api/admin/notifications/send  {target:role[provider]}             → 400 "unknown role 'provider'"
POST /api/admin/notifications/send  (no token)                          → 401
POST /api/admin/notifications/send  (customer token)                    → 401
POST /api/admin/notifications/backfill?kind=admin_broadcast             → 200 {scanned:N, inserted:0} (replay-safe)
```

Test suite: **`tests/test_admin_notifications_send.py` — 16/16 passing.**

Locked baseline: **45/45 still green** (no revenue/projector public contract changed).

Combined for this sprint: **61/61 green.**

---

## Files touched

```
NEW    shared/domain/contracts/notification.ts        (177 lines, typed-only)
MOD    backend/app/notifications/projector.py         (+~210 lines: admin_send, _resolve_broadcast_recipients,
                                                       _list_user_ids_by_roles, admin_broadcast in COPY,
                                                       title/body override in project_event,
                                                       deepLink in _action_url_for)
NEW    backend/tests/test_admin_notifications_send.py (16 cases)
NEW    memory/sprint_a1_notification_canonicalization.md   (this file)
```

Other files: untouched.

---

## What is explicitly NOT done in A1 (saved for A2/A3)

- ❌ Mobile bell wiring (`frontend/app/additional.tsx` still shows fake "2")
- ❌ Web-app bell wiring
- ❌ Admin composer page (`/admin-panel/notifications`)
- ❌ Header layout overflow fix (chat icon clipping on narrow widths)
- ❌ `useNotifications()` shared hook
- ❌ `NotificationThread` shape
- ❌ Chat backbone (Phase B)

These are next, in this order:
1. **A2** — `useNotifications()` polling hook (25s, AsyncStorage cache, focus-invalidate)
2. **A3a** — Mobile header polish + real bell badge + overflow fix
3. **A3b** — Web-app header
4. **A3c** — Admin header
5. **A4** — Notification list pages + admin composer at `/admin-panel/notifications`

Then Phase B (chat canonicalization).

---

## Operational note

Admin can now send broadcasts via curl/HTTP. The composer UI lands in A4, but ops already has an emergency channel — useful for incident comms.

Example one-liner (substitute admin JWT):

```bash
curl -X POST https://<host>/api/admin/notifications/send \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "target": {"type": "all"},
    "title": "Plat maintenance",
    "body": "We will be redeploying at 02:00 UTC. Expect 60s downtime.",
    "deepLink": "/status"
  }'
```
