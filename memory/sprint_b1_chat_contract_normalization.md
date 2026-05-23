# Sprint B1 — Chat Contract Normalization (closure)

**Status:** ✅ Closed 2026-05-13
**Position in plan:** First step of Phase B (Chat). Lands on hardened action substrate from the previous sprint.
**Anti-scope:** Did NOT rewrite chat. Did NOT touch attachments, voice, emoji reactions, typing, disputes, admin support endpoints, websocket, or chat UI.

---

## What shipped

### 1. Shared contract — `shared/domain/contracts/chat.ts`

Canonical wire shape only. No state machines, no runtime utils.

Public types:
- `ChatMessageType = 'text' | 'system'`
- `ChatParticipant` — `{ id, kind: 'user'|'provider'|'admin', displayName?, avatarHint?, providerSlug? }`
- `ChatThreadKind = 'support' | 'provider' | 'admin_user'`
- `ChatThread` — collapses legacy `unreadByUser`/`unreadByOther` into a single caller-perspective `unreadByMe`. Adds `participants[]`, `bookingId`, ISO `lastMessageAt`.
- `ChatMessage` — adds `isMine` (saves clients from re-deriving), `senderKind`, `readAt`.
- `ChatThreadsResponse` / `ChatMessagesResponse` — opaque `nextCursor` strings (surfaces echo verbatim).
- `ChatSendMessageResponse` — `{ message, thread }` so list caches update without refetch.
- `ChatMarkReadResponse` — `{ ok, threadId, unreadByMe: 0, mutated }`. `mutated` lets clients suppress redundant invalidation.
- `ChatUnreadSummary` — `{ totalUnread, perThread[], serverTime }`. Replaces the placeholder `sum(thread.unreadCount)` heuristic from A3b.

Docstring includes the doctrine notes: no shared runtime util across surfaces (same policy as `formatBadgeCount`); clients MUST NOT recompute `unreadByMe` from the message list.

### 2. Backend adapter — `backend/app/chat/canonical.py` (380 lines)

Wraps the existing `chat_threads` / `chat_messages` collections without modifying them. Legacy router (`backend/app/chat/router.py`) keeps working byte-for-byte. New `APIRouter(prefix="/api/chat/v1")` is mounted in `server.py` next to the legacy one.

Endpoints:

```
GET  /api/chat/v1/threads              ?after=<cursor>&limit=N
GET  /api/chat/v1/threads/{id}/messages?after=<iso>&limit=N
POST /api/chat/v1/threads/{id}/messages   body: { body, type? }
POST /api/chat/v1/threads/{id}/read
GET  /api/chat/v1/unread-summary
```

Hardening invariants (enforced inside `_load_thread_or_403`):
- **Participant ownership.** Caller is the participant if EITHER (a) `participantUserId == JWT.sub` OR (b) JWT role==`provider` AND `JWT.providerSlug == thread.providerSlug` OR (c) `JWT.kind == 'admin'`. Anything else → 403. Admin path is read-only at canonical layer; admin SEND still goes through the legacy `/api/admin/chat/threads/{id}/reply` (A1 audit-only constraint).
- **Cross-thread access.** Impossible. Every read/write call passes through `_load_thread_or_403`; the list endpoint filters by the caller's identity in its `$or` clause — no thread that doesn't belong to caller ever appears.
- **Cursor pagination.** Thread list: reverse-chrono by `lastMessageAt`, next page is *older* than cursor. Messages: forward-chrono by `createdAt`, next page is *newer*. Both fetch `limit + 1` to detect more without count() penalty. `nextCursor` is `null` when no more rows.
- **Unread is backend-derived.** `_count_unread_for_viewer(thread, viewer_kind)` counts `chat_messages` where `senderType != viewer perspective` and `readAt is null`. Never computed from a paginated message list.
- **Mark-read idempotent.** `update_many` with `readAt: null` filter; `mutated` reflects `modified_count > 0`. Re-running it is observationally silent.

The legacy fields (`unreadByUser`, `unreadByOther`) are still bumped for compat with surfaces that haven't migrated, but they no longer drive the canonical answer.

### 3. Server wiring — `backend/server.py`

```python
from app.chat.router import router as chat_router
app.include_router(chat_router)
from app.chat.canonical import router as chat_v1_router
app.include_router(chat_v1_router)
```

Two routers coexist. Migration is gradual — surfaces flip URL prefix when ready; no big-bang.

---

## Tests — `backend/tests/test_chat_canonical_b1.py` (7 tests, all passing)

```
test_cannot_read_other_users_thread              PASSED  [14%]
test_cannot_send_to_other_users_thread           PASSED  [28%]
test_send_message_returns_canonical_envelope     PASSED  [42%]
test_mark_read_is_idempotent                     PASSED  [57%]
test_thread_list_excludes_other_participants     PASSED  [71%]
test_unread_summary_matches_per_thread           PASSED  [85%]
test_messages_pagination_cursor                  PASSED [100%]
============================== 7 passed in 0.78s ===============================
```

Coverage vs sprint acceptance list:

| Acceptance | Test |
|---|---|
| User cannot read thread where not participant | `test_cannot_read_other_users_thread` |
| Send only by participant | `test_cannot_send_to_other_users_thread` + `test_send_message_returns_canonical_envelope` |
| Mark-read idempotent | `test_mark_read_is_idempotent` |
| Thread list returns only participant threads | `test_thread_list_excludes_other_participants` |
| Unread backend-derived | `test_unread_summary_matches_per_thread` (counts admin msgs only, ignores caller's own sent msgs) |
| Cursor pagination | `test_messages_pagination_cursor` (bonus — covers the `+` URL-encoding gotcha) |

Regression: full prior suite still green:
```
tests/test_provider_dispatch_hardening.py  9 passed
tests/test_chat_canonical_b1.py            7 passed
tests/test_admin_notifications_send.py    16 passed
─────────────────────────────────────────────────
                                          32 passed in 2.67s
```

---

## Doctrine compliance

| Invariant | Held |
|---|---|
| Did NOT rewrite legacy `app/chat/router.py` | ✅ (untouched; canonical adapter is a sibling file) |
| Did NOT introduce websocket / SSE / Redis pubsub | ✅ (existing polling pattern preserved) |
| Did NOT add attachments / voice / emoji / typing | ✅ (explicitly out per spec) |
| Did NOT touch admin support intervention surface beyond audit | ✅ (admin path still uses legacy endpoint) |
| Did NOT modify chat UI on any surface | ✅ (no mobile/web/admin client touched) |
| Participant ownership enforced server-side | ✅ (`_load_thread_or_403`) |
| Cross-thread access impossible by construction | ✅ |
| Cursor pagination opaque + monotonic | ✅ |
| Unread strictly backend-derived | ✅ |
| Mark-read idempotent with explicit `mutated` flag | ✅ |
| No global state framework introduced | ✅ |
| Three-call-site doctrine respected for future hooks | ✅ (no shared client util — type contract only) |
| Side-effects gated to real mutations | ✅ (legacy `unreadBy*` flags only flip when needed) |

---

## Files touched

```
NEW    shared/domain/contracts/chat.ts                    160 lines
NEW    backend/app/chat/canonical.py                      380 lines
MOD    backend/server.py                                  (+2 lines: include_router)
NEW    backend/tests/test_chat_canonical_b1.py            330 lines, 7 tests
NEW    memory/sprint_b1_chat_contract_normalization.md    (this file)
```

Other files: untouched. Specifically:
- `backend/app/chat/router.py` — legacy endpoints unchanged
- `frontend/src/hooks/useChatUnread.ts`, `web-app/src/hooks/useChatUnread.ts` — still on the temporary `sum(thread.unreadCount)` shape; migration is B2 scope, not B1
- All chat surfaces (`frontend/app/chat/*`, `web-app/src/pages/.../messages`, admin) — untouched

---

## Migration path forward

The canonical envelope is the new source of truth. Future sprints peel surfaces over to it:

- **B2 (next):** Migrate mobile + web chat hooks (`useChatUnread`, plus the chat screen's thread+message hooks) to `/api/chat/v1/*`. Replace `sum(thread.unreadCount)` with `unread-summary.totalUnread`. UI redesign comes with B2.
- **B3+:** Once both client hooks consume canonical, the legacy router can shed its hydrated `provider` / `user` payloads (still kept today for admin/legacy compat).
- **Later phases:** attachments (B-attachments), voice (B-voice), realtime (B-realtime) all stand on the same `ChatMessage` discriminator.

The contract is intentionally narrow: `MessageType = 'text' | 'system'`. Every richer kind enters by EXTENDING the discriminator with a NEW value, never by mutating existing ones — surfaces can hold the existing union as exhaustive and switch on it.

---

## Acceptance vs scope checklist

| Item | Status |
|---|---|
| `shared/domain/contracts/chat.ts` created | ✅ |
| `ChatThread`, `ChatMessage`, `ChatParticipant`, `ChatUnreadSummary` defined | ✅ |
| `MessageType = 'text' \| 'system'` (no files/voice/emoji) | ✅ |
| Backend wrap, not rewrite | ✅ |
| Participant ownership checked | ✅ |
| Cursor pagination fixed | ✅ |
| Cross-thread access denied by test | ✅ |
| Unread thread count backend-derived | ✅ |
| `useChatUnread()` future migration target ready (`/v1/unread-summary`) | ✅ |
| User cannot read non-participant thread (test) | ✅ |
| Send-message participant only (test) | ✅ |
| Mark-read idempotent (test) | ✅ |
| Thread-list filters to participant (test) | ✅ |
| Admin support endpoints unchanged | ✅ |
| No attachments / voice / emoji / typing / disputes / admin intervention / websocket / UI | ✅ |
