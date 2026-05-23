/**
 * P0.b.C.i — Customer payment chronology types.
 *
 * THIS IS NOT A SHARED CHRONOLOGY CONTRACT.
 *
 * The wire shape comes from `app/payments/chronology/projector.py`
 * function `project_customer`. The customer projection emits a fixed
 * closed set of `kind` literals plus a whitelisted meta dict; this
 * file duplicates that shape verbatim. The duplication is the point —
 * provider/admin/inspector surfaces will NEVER import from this file.
 *
 * If `project_customer` changes its kind whitelist OR meta whitelist,
 * this file must be edited. There is no schema generator and no
 * cross-surface contract.
 */

/** Closed set — exactly the 11 kinds the customer projection emits. */
export type CustomerPaymentKind =
  | 'payment.initiated'
  | 'payment.failed'
  | 'escrow.held'
  | 'escrow.release_requested'
  | 'escrow.release_rejected'
  | 'escrow.released'
  | 'refund.requested'
  | 'refund.succeeded'
  | 'refund.failed'
  | 'dispute.linked'
  | 'dispute.resolved';

/** Visual tone for the row — a SURFACE concern, not a backend one. */
export type CustomerPaymentTone =
  | 'neutral'
  | 'positive'
  | 'celebratory'
  | 'alert';

/**
 * Customer-projected row, byte-equal to one element of the REST
 * `rows[]` array AND to the `event` field of a WS frame. The shape
 * is enforced by the backend projector — frontend never invents.
 *
 * `actor.id` is REDACTED on this surface (per F.3 opacity rules).
 * Only `actor.role` is present.
 */
export interface CustomerPaymentEvent {
  /** Unique row id minted by `append_payment_event()`. Used as dedup key. */
  id: string;
  /** Same as path param. Used for envelope-level filter only. */
  paymentId: string;
  /** Closed-set kind literal. */
  kind: CustomerPaymentKind;
  /** ISO-8601 timestamp. */
  at: string;
  /** Customer/Provider see only `role` (id redacted by backend). */
  actor: { role: string };
  /** Whitelisted meta dict — see CUSTOMER_META_WHITELIST in projector.py. */
  meta: {
    amount?: number;
    currency?: string;
    releaseEta?: string;
    disputeId?: string;
    resolution?: string;
    reason?: string;
  };
}

/** REST response shape: `GET /api/customer/payments/{id}/chronology`. */
export interface CustomerPaymentChronologySnapshot {
  /** Always `payment-activity.customer` per F.4. */
  surface: string;
  paymentId: string;
  rows: CustomerPaymentEvent[];
}

/** WS envelope on the customer hub. `event` is byte-equal to REST rows[i]. */
export interface CustomerPaymentChronologyWsEnvelope {
  type: 'payment.chronology.updated';
  scope: 'customer';
  paymentId: string;
  event: CustomerPaymentEvent;
}

export type ConnectionStatus =
  | 'idle'
  | 'hydrating'
  | 'live'
  | 'reconnecting'
  | 'offline';
