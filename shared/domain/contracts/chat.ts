/**
 * Chat — canonical wire contract.
 *
 * Sprint B1 — Chat Contract Normalization. First pass.
 *
 * SCOPE NOTES (frozen for B1):
 *   - `MessageType = 'text' | 'system'`. Attachments, voice notes,
 *     emoji reactions, typing, disputes — all OUT.
 *   - `ChatThread.unreadByMe` is BACKEND-DERIVED. Clients MUST NOT
 *     recompute it from the message list — clock skew + pagination =
 *     wrong number.
 *   - `participants` is a flat array of canonical `ChatParticipant`
 *     records. The legacy `participantUserId` / `providerSlug` /
 *     hydrated `provider` triad lives on at the storage layer; this
 *     contract is what wire surfaces (mobile/web/admin) consume.
 *   - Cursor pagination via opaque `nextCursor`. Surfaces MUST pass it
 *     back verbatim; do not parse it.
 *
 * Three call sites (mobile/web/admin chat hooks) will eventually each
 * carry a thin local mapper from server response → these types. No
 * shared runtime util — same doctrine as `formatBadgeCount`.
 */

/** Discriminates message bodies. `system` covers join/leave, escalation
 *  hand-off, dispute notes, etc. — anything the user typed is `text`.
 *  Sprint B4a — `attachment` carries a `ChatAttachment` payload alongside
 *  an optional caption-as-body.
 *  Sprint B4b — `voice` carries a `ChatVoice` payload (no body).
 *  Future B4c adds `reaction`. */
export type ChatMessageType = 'text' | 'system' | 'attachment' | 'voice';

/** Sprint B4a — attachment kinds. Tightly bounded:
 *  - `image`  → jpeg / png / webp / heic
 *  - `pdf`    → application/pdf
 *  - `file`   → generic documents (zip / txt / docx / xlsx / etc)
 *  Anything else server-rejects. No streaming, no transcoding. */
export type ChatAttachmentKind = 'image' | 'pdf' | 'file';

/** Sprint B4a — canonical attachment payload. URL is server-relative
 *  (`/api/chat/v1/attachments/{id}`) and requires the caller's JWT to
 *  serve bytes. Surfaces fetch via authenticated `<img src>` proxy or
 *  blob-loader. */
export interface ChatAttachment {
  readonly id: string;
  readonly kind: ChatAttachmentKind;
  readonly url: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

/** Sprint B4b — canonical voice payload. URL is server-relative
 *  (`/api/chat/v1/voice/{id}`) with the same dual-auth (Authorization
 *  header OR `?token=` query) as attachment serve. `durationMs` is
 *  client-reported AND server-enforced (max 120 s — over that → 422).
 *  No waveform, no transcript — those are explicitly post-B4b. */
export interface ChatVoice {
  readonly id: string;
  readonly audioUrl: string;
  readonly durationMs: number;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

/** Sprint B4c — tiny emoji whitelist for reactions. Six glyphs, no skin
 *  tones, no composed sequences. The narrow set is a doctrine choice:
 *  Unicode emoji normalization (skin tones, ZWJ joiners, variation
 *  selectors) is a known operational hazard for DB equality and
 *  notification taxonomy. We don't open that box in B4c.
 *
 *  Adding to this set requires conscious review of:
 *    - storage key collation (we key by raw glyph; new glyphs must be
 *      unique under simple `==`, no normalization tricks)
 *    - per-emoji notification semantics (still none in B4c)
 *    - mobile keyboard discoverability (which emojis are reachable
 *      without the IME picker on Android/iOS).
 */
export type ChatReactionEmoji =
  | '👍'
  | '❤️'
  | '😂'
  | '😮'
  | '😢'
  | '👎';

/** Sprint B4c — canonical reaction projection.
 *
 *  Decoration on top of an existing message. Reactions are metadata,
 *  NOT messages: they do NOT bump unread, do NOT bump `thread.lastMessageAt`,
 *  do NOT fan out notifications, do NOT generate system messages.
 *  See `/api/chat/v1/messages/{id}/reactions` server contract.
 *
 *  Clients never see the underlying user-id arrays (storage holds
 *  `{ "👍": ["u1","u2"] }`); the server projects to the abstraction
 *  below per viewer. `reactedByMe` is the caller's perspective.
 */
export interface ChatReaction {
  readonly emoji: ChatReactionEmoji;
  readonly count: number;
  readonly reactedByMe: boolean;
}

/** A participant in a thread. `kind` mirrors the existing senderType
 *  vocabulary so adapters don't have to translate. `id` is whatever
 *  the surface needs to dedupe (user-id, provider-slug, or the literal
 *  string 'admin' for the support persona). */
export interface ChatParticipant {
  readonly id: string;
  readonly kind: 'user' | 'provider' | 'admin';
  /** Display name for the surface to render. Optional because the
   *  legacy admin participant is anonymous; surfaces should fall back
   *  to "Поддержка" / "Support" on absence. */
  readonly displayName?: string;
  /** Optional avatar URL or initials hint. Surfaces decide rendering. */
  readonly avatarHint?: string | null;
  /** For provider participants only. Lets surfaces deep-link without
   *  re-parsing the thread shape. */
  readonly providerSlug?: string | null;
}

export type ChatThreadKind = 'support' | 'provider' | 'admin_user';

/** Canonical thread envelope. The legacy `unreadByUser` / `unreadByOther`
 *  pair is collapsed into `unreadByMe` — the caller's perspective. The
 *  server computes this against the JWT's caller id. */
export interface ChatThread {
  readonly id: string;
  readonly kind: ChatThreadKind;
  readonly title: string;
  readonly participants: readonly ChatParticipant[];
  /** Provider slug for `kind === 'provider'`, else null. Convenience so
   *  surfaces don't have to re-find it in `participants`. */
  readonly providerSlug: string | null;
  /** Set when the thread is anchored to a booking — surfaces can show
   *  the booking card alongside the chat. */
  readonly bookingId: string | null;
  /** Last message preview — truncated server-side to ~140 chars. */
  readonly lastMessagePreview: string;
  /** ISO-8601 UTC. `null` for empty threads. */
  readonly lastMessageAt: string | null;
  /** Backend-derived count of messages NOT authored by the caller and
   *  not yet marked-read. Never recompute on the client. */
  readonly unreadByMe: number;
  /** Sprint B3.3 — dispute flag. `true` once any participant has invoked
   *  `POST /api/chat/v1/threads/{id}/dispute`. Surfaces render a badge;
   *  the projector fans out a notification to admins on transition.
   *  Resolution workflow is NOT in B3 — clearing this flag lands later. */
  readonly disputeOpen: boolean;
  /** ISO-8601 UTC when `disputeOpen` flipped to true. `null` while
   *  `disputeOpen` is false. */
  readonly disputeOpenedAt: string | null;
  /** Sprint B3.2 — true once an admin has invoked `/support/join`. The
   *  admin participant appears in `participants` from that moment. Once
   *  set, never clears within B3 (admin leave is a future sprint). */
  readonly adminJoined: boolean;
  /** ISO-8601 UTC. */
  readonly createdAt: string;
}

/** Sprint B3.1 — system message body codes. Surfaces translate to the
 *  user's language. Free-form bodies remain valid; this enum lists the
 *  codes the backend emits today so clients can render localised copy.
 */
export type ChatSystemCode =
  | 'support_joined'
  | 'dispute_opened';

/** Canonical message envelope. `senderId` is the raw id from storage
 *  (user-id / provider-slug / 'admin'); use `senderKind` to interpret. */
export interface ChatMessage {
  readonly id: string;
  readonly threadId: string;
  readonly senderKind: 'user' | 'provider' | 'admin';
  readonly senderId: string;
  /** Display name for "the other side" rendering. Surfaces fall back to
   *  participant lookup on absence. */
  readonly senderDisplayName?: string;
  readonly type: ChatMessageType;
  /** For `type='text'`: the typed body. For `type='system'`: a stable
   *  machine-readable code like `"escalated_to_support"` — surfaces
   *  translate it to the user's language. */
  readonly body: string;
  readonly createdAt: string;
  /** ISO-8601 when the recipient marked-read. Null until then. */
  readonly readAt: string | null;
  /** True iff `senderKind/senderId` matches the caller. Saves clients
   *  from re-deriving "is this mine" for left/right rendering. */
  readonly isMine: boolean;
  /** Sprint B4a — present iff `type === 'attachment'`. Surfaces render
   *  a thumbnail (kind='image') or a file row (kind='pdf' | 'file').
   *  `body` may still carry an optional caption typed alongside the
   *  upload. */
  readonly attachment?: ChatAttachment;
  /** Sprint B4b — present iff `type === 'voice'`. Surfaces render a
   *  play/pause control with duration; the body is always empty for
   *  voice (the spec explicitly excludes captions on voice messages). */
  readonly voice?: ChatVoice;
  /** Sprint B4c — reactions decoration. Present (possibly empty) on
   *  every message type EXCEPT `system` (admin-system messages cannot
   *  carry user feedback). Surfaces render a row of `{emoji, count,
   *  reactedByMe}` pills underneath the bubble. The array is naturally
   *  ordered by `count desc, emoji asc` server-side.
   *
   *  Invariants (enforced server-side):
   *    - reactions DO NOT bump `thread.lastMessageAt` / preview
   *    - reactions DO NOT increment `unreadByMe` on the peer
   *    - reactions DO NOT generate system messages or notifications
   *  Mutate via:
   *    POST   /api/chat/v1/messages/{id}/reactions     body `{ emoji }`
   *    DELETE /api/chat/v1/messages/{id}/reactions/{emoji}
   *  Both are atomic (`$addToSet` / `$pull`) and idempotent. */
  readonly reactions?: readonly ChatReaction[];
}

/** Paginated thread list response. */
export interface ChatThreadsResponse {
  readonly threads: readonly ChatThread[];
  /** Opaque cursor; pass to subsequent `?after=...` calls. `null` when
   *  the last page has been served. */
  readonly nextCursor: string | null;
}

/** Paginated messages response. Messages are returned OLDEST FIRST
 *  within a page; clients append. The cursor advances forward in time. */
export interface ChatMessagesResponse {
  readonly thread: ChatThread;
  readonly messages: readonly ChatMessage[];
  readonly nextCursor: string | null;
}

/** Send-message envelope: just the new message, plus the (already
 *  bumped) thread snapshot so the caller can update its list without
 *  refetching. */
export interface ChatSendMessageResponse {
  readonly message: ChatMessage;
  readonly thread: ChatThread;
}

/** Mark-read response. `mutated` is the contract for "did this actually
 *  do anything" — surfaces use it to suppress redundant cache invalidation. */
export interface ChatMarkReadResponse {
  readonly ok: true;
  readonly threadId: string;
  readonly unreadByMe: 0;
  readonly mutated: boolean;
}

/** Global unread summary across all of the caller's threads.
 *  This is the wire shape the (future) canonical `useChatUnread()` hook
 *  will replace its naïve `sum(thread.unreadCount)` placeholder with. */
export interface ChatUnreadSummary {
  /** Sum across all threads — what the bell-style chat badge renders. */
  readonly totalUnread: number;
  /** Per-thread breakdown so a chat-list page can decorate without a
   *  second roundtrip. */
  readonly perThread: readonly { readonly threadId: string; readonly unread: number }[];
  /** Server clock at the moment of the query. Cursor for cache freshness. */
  readonly serverTime: string;
}
