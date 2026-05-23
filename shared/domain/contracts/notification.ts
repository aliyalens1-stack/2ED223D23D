/**
 * Notification — canonical wire contract.
 *
 * Scope (Sprint A1):
 *   - Wire shape of a notification row, identical across mobile / web-app /
 *     admin surfaces.
 *   - Request/response shapes for the public read endpoints
 *     (`GET /api/notifications/unread-count`,
 *      `GET /api/notifications/since?after=&unread=&limit=`).
 *   - Request/response shapes for the admin broadcast endpoint
 *     (`POST /api/admin/notifications/send`).
 *
 * Architectural invariants honored here:
 *   - `notifications` is a PROJECTION of `timeline_events`. This contract
 *     declares only the projected fields surfaces are allowed to read.
 *     Surfaces MUST NOT depend on any field not declared here. Anything
 *     surface-specific belongs in `metadata` (server-side serialized).
 *   - The projector remains the sole writer of `notifications`. Admin send
 *     emits a timeline event of kind `admin_broadcast`; the projector then
 *     fans out into notification rows. Surfaces never see this seam.
 *   - Threading / grouping ("notification_threads") is deliberately NOT
 *     declared here. It is a future Phase A2+ concern; until a concrete
 *     consumer requires it, the wire shape stays flat. Adding a
 *     placeholder type now would either (a) be empty and useless, or
 *     (b) commit us to a design we have not validated. Both are worse
 *     than declaring nothing.
 *
 * Sister files:
 *   - Backend projection rules: `backend/app/notifications/projector.py`
 *   - Existing endpoints:
 *       GET  /api/notifications              (legacy listing, in chat/router.py)
 *       POST /api/notifications/{id}/read    (idempotent mark-read)
 *       POST /api/notifications/read-all
 *       GET  /api/notifications/unread-count
 *       GET  /api/notifications/since
 *       POST /api/admin/notifications/send   (NEW, Sprint A1)
 *       POST /api/admin/notifications/backfill
 */

import type { AccountKind } from '../identity/account';

// ─────────────────────────────────────────────────────────────────────
// Targeting — admin broadcast only
// ─────────────────────────────────────────────────────────────────────

/**
 * Roles an admin broadcast can target.
 *
 * Subset of `AccountKind` with `'guest'` excluded — guests carry no JWT
 * and have no `userId` against which a notification can be projected.
 *
 * Mapping to legacy `users.role` (until full account-runtime migration):
 *   - 'customer'  → users.role = 'customer'
 *   - 'inspector' → users.role IN ('inspector', 'provider_owner')
 *                   (both perform inspection work)
 *   - 'admin'     → users.role IN ('admin', 'superadmin', 'operator')
 */
export type NotificationRole = Extract<AccountKind, 'customer' | 'inspector' | 'admin'>;

export const NOTIFICATION_ROLES: readonly NotificationRole[] = [
  'customer',
  'inspector',
  'admin',
] as const;

/**
 * Admin broadcast target — discriminated union.
 *
 * Three explicit shapes only. No segments, no filters, no geo, no cluster
 * targeting. If a fourth shape is ever needed, add it here first and
 * thread it through `_resolve_broadcast_recipients` on the backend.
 */
export type NotificationTarget =
  | { readonly type: 'all' }
  | { readonly type: 'role'; readonly roles: readonly NotificationRole[] }
  | { readonly type: 'user'; readonly userId: string };

// ─────────────────────────────────────────────────────────────────────
// Notification row — projected shape surfaces read
// ─────────────────────────────────────────────────────────────────────

/** Severity hint for UI rendering. Surfaces decide visual treatment. */
export type NotificationSeverity = 'info' | 'warning' | 'critical';

export interface Notification {
  readonly id: string;
  readonly userId: string;
  /**
   * High-level category bucket. Used for icon selection / grouping on
   * surfaces. Examples: 'verification', 'report', 'customer', 'job',
   * 'assignment', 'payout', 'broadcast'.
   */
  readonly type: string;
  /**
   * Originating timeline kind (e.g. 'report_submitted', 'admin_broadcast').
   * Surfaces may key behavior off `kind` for kind-specific UI flows.
   */
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  /**
   * Long-form body. Today equal to `body`; reserved for richer copy
   * (multi-line, markdown, etc.) once any surface needs it. Surfaces
   * SHOULD render `body` for compact UIs (bell drawer) and `text` for
   * full-page listings.
   */
  readonly text?: string;
  readonly severity: NotificationSeverity;
  /**
   * Free-form event data carried from the timeline event. Surfaces MAY
   * read it for deep-link parameters but MUST NOT depend on any specific
   * key being present.
   */
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly isRead: boolean;
  readonly readAt: string | null;
  readonly createdAt: string;
  /** Set when row was inserted by the projector. */
  readonly projectedAt?: string;
  /** Points back at the originating timeline event. */
  readonly sourceTimelineId?: string;
  /** Best-effort actor metadata, if the originating event carried one. */
  readonly actorType?: string | null;
  readonly actorLabel?: string | null;
  /**
   * Best-effort deep-link path. Surface decides whether to honor it.
   * `null` means "no specific destination — open the bell drawer".
   */
  readonly actionUrl?: string | null;
}

// ─────────────────────────────────────────────────────────────────────
// Read endpoints — response envelopes
// ─────────────────────────────────────────────────────────────────────

export interface UnreadCountResponse {
  readonly unread: number;
}

export interface NotificationSinceResponse {
  readonly items: readonly Notification[];
  readonly unread: number;
  /** Server-side ISO timestamp; clients pass it back as `after=` on next poll. */
  readonly serverTime: string;
}

// ─────────────────────────────────────────────────────────────────────
// Admin broadcast — request/response
// ─────────────────────────────────────────────────────────────────────

export interface AdminNotificationRequest {
  readonly target: NotificationTarget;
  /** Human-facing title. Length contract: 1..120 chars. */
  readonly title: string;
  /** Human-facing body. Length contract: 1..1000 chars. */
  readonly body: string;
  /**
   * Optional deep-link the recipient client SHOULD navigate to on tap.
   * Format: surface-agnostic path (`/inspector/jobs/ij_123`, `/dispute/d_42`).
   * If absent, the surface opens the bell drawer detail card.
   */
  readonly deepLink?: string;
}

export interface AdminNotificationResponse {
  readonly ok: true;
  /** Timeline event id; same id appears as `sourceTimelineId` on every projected row. */
  readonly eventId: string;
  /** Number of users resolved by the target. Includes already-projected duplicates. */
  readonly recipients: number;
  /** Notifications actually inserted (`projected <= recipients` when re-issuing). */
  readonly projected: number;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers — pure type-narrowing predicates
// ─────────────────────────────────────────────────────────────────────

export function isAllTarget(t: NotificationTarget): t is { type: 'all' } {
  return t.type === 'all';
}

export function isRoleTarget(
  t: NotificationTarget,
): t is { type: 'role'; roles: readonly NotificationRole[] } {
  return t.type === 'role';
}

export function isUserTarget(
  t: NotificationTarget,
): t is { type: 'user'; userId: string } {
  return t.type === 'user';
}
