/**
 * P0.b.C.d.UI.b — Provider booking timeline types.
 *
 * Mirror of `backend/app/booking/projections/provider.py`. Duplicated
 * verbatim — NOT imported from `src/customer/booking-timeline/types.ts`.
 *
 * Tone vocabulary, key vocabulary, and safe-meta keys all differ from
 * the customer surface. Even where overlap exists today, the two
 * projections are guaranteed to diverge as the product matures.
 * Duplication here is semantic insulation, not waste.
 */

export type ProviderTimelineTone =
  | 'action_required'
  | 'neutral'
  | 'in_flight'
  | 'settled'
  | 'alert';

export type ProviderTimelineKey =
  | 'matched'
  | 'confirmed'
  | 'on_route'
  | 'arrived'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'dispute_opened'
  | 'dispute_resolved';

export interface ProviderTimelineEvent {
  key: ProviderTimelineKey;
  label: string;
  description: string;
  tone: ProviderTimelineTone;
  /** ISO-8601 timestamp; may be null on legacy rows. */
  at: string | null;
  /** True iff the provider themselves authored the row. */
  isSelfAction: boolean;
  /**
   * Whitelisted meta. Backend allows: `eta`, `reason`, `payoutAmount`,
   * `customerNote`, `note`. Anything else is silently dropped.
   */
  meta: {
    eta?: string;
    reason?: string;
    payoutAmount?: number | string;
    customerNote?: string;
    note?: string;
  };
}

/** REST: `GET /api/provider/bookings/{id}/timeline`. */
export interface ProviderTimelineSnapshot {
  bookingId: string;
  events: ProviderTimelineEvent[];
  count: number;
}

/** WS envelope on the provider hub. Inbound only. */
export interface ProviderTimelineWsEnvelope {
  type: 'timeline.updated';
  scope: 'provider';
  bookingId: string;
  event: ProviderTimelineEvent;
}

export type ProviderConnectionStatus =
  | 'idle'
  | 'hydrating'
  | 'live'
  | 'reconnecting'
  | 'offline';
