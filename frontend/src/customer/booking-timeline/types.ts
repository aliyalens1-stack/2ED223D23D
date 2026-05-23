/**
 * P0.b.C.d.UI.a — Customer booking timeline types.
 *
 * These types describe what the CUSTOMER surface sees. They are NOT
 * imported by provider / inspector / admin code. Each surface owns
 * its own projection shape (parity guaranteed at the backend, not
 * at the frontend type level).
 *
 * Wire equivalence: every field below comes verbatim from
 * `project_timeline_for_customer()` in
 * `backend/app/booking/projections/customer.py`. If that projection
 * changes, this file must change. There is no schema generator and
 * no shared contract — the duplication is the point.
 */

export type CustomerTimelineTone =
  | 'neutral'
  | 'positive'
  | 'celebratory'
  | 'alert';

export type CustomerTimelineKey =
  | 'cancelled'
  | 'confirmed'
  | 'on_route'
  | 'arrived'
  | 'in_progress'
  | 'completed'
  | 'disputed'
  | 'resolved';

export interface CustomerTimelineEvent {
  key: CustomerTimelineKey;
  label: string;
  description: string;
  tone: CustomerTimelineTone;
  /** ISO-8601 timestamp from `booking_timeline.timestamp`. May be null on legacy rows. */
  at: string | null;
  /** True iff the row is the customer's own action (currently only `cancel`). */
  isSelfAction: boolean;
  /** Sanitized meta. Backend whitelists `reason` and `eta`. */
  meta: {
    reason?: string;
    eta?: string;
  };
}

/** REST response shape. Mirror of `GET /api/customer/bookings/{id}/timeline`. */
export interface CustomerTimelineSnapshot {
  bookingId: string;
  events: CustomerTimelineEvent[];
  count: number;
}

/** WS envelope sent by the customer hub. */
export interface CustomerTimelineWsEnvelope {
  type: 'timeline.updated';
  scope: 'customer';
  bookingId: string;
  event: CustomerTimelineEvent;
}

export type ConnectionStatus =
  | 'idle'
  | 'hydrating'
  | 'live'
  | 'reconnecting'
  | 'offline';
