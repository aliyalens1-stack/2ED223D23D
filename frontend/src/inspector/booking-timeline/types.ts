/**
 * P0.b.C.d.UI.c — Inspector job timeline types.
 *
 * Mirror of `backend/app/booking/projections/inspector.py`.
 *
 * Crucial identity-shape difference from customer / provider:
 *
 *   This API is keyed by **jobId** — NOT bookingId / requestId.
 *
 * The wire format never echoes the underlying request id. The server
 * resolves jobId → requestId internally for chronology lookup, but
 * the consumer surface deliberately treats the job as the durable
 * identifier. If a future field "bookingId" or "requestId" ever
 * surfaces in REST or WS payload, this contract is broken.
 */

/** Inspector tone vocabulary — DIFFERENT from customer/provider. */
export type InspectorTimelineTone =
  | 'ready'
  | 'travel'
  | 'on_site'
  | 'documenting'
  | 'submitted'
  | 'closed'
  | 'attention';

/** Visible projection keys for the inspector surface. */
export type InspectorTimelineKey =
  | 'assigned'
  | 'on_route'
  | 'arrived'
  | 'inspecting'
  | 'completed'
  | 'cancelled'
  | 'dispute_opened'
  | 'dispute_resolved';

export interface InspectorTimelineEvent {
  key: InspectorTimelineKey;
  label: string;
  description: string;
  tone: InspectorTimelineTone;
  /** ISO-8601 timestamp; may be null on legacy rows. */
  at: string | null;
  /** True iff the inspector themselves authored the row. */
  isSelfAction: boolean;
  /**
   * Whitelisted meta — DIFFERENT from customer/provider:
   *   - eta                     (own ETA on on_route)
   *   - reason                  (cancel / dispute reason)
   *   - note                    (own milestone note)
   *   - reportId                (primary deliverable on completion)
   *   - inspectorPayoutAmount   (own payout — NOT provider's payoutAmount)
   *
   * Inspector deliberately CANNOT see `customerNote` or `payoutAmount`.
   */
  meta: {
    eta?: string;
    reason?: string;
    note?: string;
    reportId?: string;
    inspectorPayoutAmount?: number | string;
  };
}

/**
 * REST: `GET /api/inspector/jobs/{jobId}/timeline`.
 *
 * Note: server echoes `jobId` only. NEVER `requestId` / `bookingId`.
 */
export interface InspectorTimelineSnapshot {
  jobId: string;
  events: InspectorTimelineEvent[];
  count: number;
}

/** WS envelope on the inspector hub. Wire is jobId-only. */
export interface InspectorTimelineWsEnvelope {
  type: 'timeline.updated';
  scope: 'inspector';
  jobId: string;
  event: InspectorTimelineEvent;
}

export type InspectorConnectionStatus =
  | 'idle'
  | 'hydrating'
  | 'live'
  | 'reconnecting'
  | 'offline';
