/**
 * P0.b.C.d.UI.d — Admin booking forensic stream types.
 *
 * THIS IS NOT A TIMELINE.
 *
 * Customer / Provider / Inspector consume *projections* of the
 * `booking_timeline` collection — surface-specific semantic lenses.
 * Admin consumes the RAW row, exactly as it landed in Mongo,
 * minus the `_id` field. There is no `key`, no `label`, no `tone`,
 * no `description` — just the operational evidence.
 *
 * Three admin-specific invariants this surface upholds:
 *
 *   A. ORDERING — append order (chronological by `timestamp`), NEVER
 *      semantic grouping. Each row is its own line; rejected attempts,
 *      retries, heartbeats, rollbacks all appear verbatim.
 *
 *   B. NO PRETTIFICATION — admin sees rows like `mark_in_progress`,
 *      `mark_completed:rejected`, `provider_viewed_booking`, etc.
 *      These are deliberately NOT translated to operator-friendly
 *      labels. The admin surface is operational evidence, not a UX.
 *
 *   C. THROUGHPUT — reducer must tolerate burst inserts, duplicate
 *      reconnect hydration, and out-of-order frame arrival without
 *      losing rows or showing them twice.
 *
 * Wire identity:
 *   REST `GET /api/admin/booking-lifecycle/{bookingId}` returns the
 *   raw `timeline` array. WS frame `event` field is the same raw row
 *   (stripped of `_id` only).
 */

/** Raw `booking_timeline` row as the admin surface sees it. */
export interface ForensicRow {
  /** Row identifier — used as the dedup key. */
  id: string;
  bookingId: string;
  /** Raw action, possibly with `:rejected` suffix. */
  action: string;
  actorRole: string;
  actorId: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  /** ISO-8601 timestamp string. */
  timestamp: string | null;
  /** Raw meta dictionary — UNFILTERED. May contain ANY internal field. */
  meta?: Record<string, unknown>;
  /** Any other field the row carries — admin sees everything. */
  [extra: string]: unknown;
}

/** REST envelope: `GET /api/admin/booking-lifecycle/{bookingId}`. */
export interface ForensicSnapshot {
  bookingId: string;
  scope: string;
  rawStatus: string;
  canonicalState: string;
  terminal: boolean;
  /** `projection`, `legalActions` are also present but irrelevant
   * for the forensic stream surface. */
  timeline: ForensicRow[];
  /** Tolerated for forward-compat. */
  [extra: string]: unknown;
}

/** WS envelope on the admin hub. Event is the raw row. */
export interface ForensicWsEnvelope {
  type: 'timeline.updated';
  scope: 'admin';
  bookingId: string;
  event: ForensicRow;
}

export type ForensicConnectionStatus =
  | 'idle'
  | 'hydrating'
  | 'live'
  | 'reconnecting'
  | 'offline';
