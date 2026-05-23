/**
 * P6.2 — Provider payout chronology types.
 *
 * THIS IS NOT A SHARED CHRONOLOGY CONTRACT.
 *
 * The wire shape comes from `app/payments/chronology/projector.py`
 * function `project_provider`. The provider projection emits a fixed
 * closed set of `kind` literals plus a whitelisted meta dict; this
 * file duplicates that shape verbatim.
 *
 * The duplication is the point — customer/admin/inspector surfaces
 * have their own files. `payout-activity.provider` ≠
 * `payment-activity.customer` ≠ `payment-forensic.admin`. Three
 * different ontologies, three different files, no shared kit.
 *
 * If `project_provider` changes its kind whitelist OR meta whitelist,
 * this file must be edited. There is no schema generator and no
 * cross-surface contract.
 */

/** Closed set — exactly the 8 kinds the provider projection emits. */
export type ProviderPayoutKind =
  | 'escrow.held'
  | 'escrow.released'
  | 'transfer.initiated'
  | 'transfer.succeeded'
  | 'transfer.failed'
  | 'refund.succeeded'
  | 'dispute.linked'
  | 'dispute.resolved';

/** Visual tone for the row — a SURFACE concern, not a backend one. */
export type ProviderPayoutTone =
  | 'neutral'
  | 'positive'
  | 'celebratory'
  | 'alert';

/**
 * Provider-projected row, byte-equal to one element of the REST
 * `rows[]` array AND to the `event` field of a WS frame. The shape
 * is enforced by the backend projector — frontend never invents.
 *
 * `actor.id` is REDACTED on this surface (per F.3 opacity rules).
 * Only `actor.role` is present.
 */
export interface ProviderPayoutEvent {
  /** Unique row id minted by `append_payment_event()`. Used as dedup key. */
  id: string;
  /** Same as path param. Used for envelope-level filter only. */
  paymentId: string;
  /** Closed-set kind literal. */
  kind: ProviderPayoutKind;
  /** ISO-8601 timestamp. */
  at: string;
  /** Provider sees only `role` (id redacted by backend). */
  actor: { role: string };
  /** Whitelisted meta dict — see PROVIDER_META_WHITELIST in projector.py. */
  meta: {
    amount?: number;
    currency?: string;
    /** Net amount transferred to provider's account (cents). */
    payoutAmount?: number;
    /** Stripe transfer reference (e.g. tr_…). */
    transferRef?: string;
    /** When funds are expected to land in provider's bank. */
    arrivalEta?: string;
    /** Dispute id when dispute.linked / dispute.resolved. */
    disputeId?: string;
    /** Resolution code for dispute.resolved or refund.succeeded. */
    resolution?: string;
  };
}

/** REST response shape: `GET /api/provider/payouts/{id}/chronology`. */
export interface ProviderPayoutChronologySnapshot {
  /** Always `payout-activity.provider` per F.4. */
  surface: string;
  paymentId: string;
  rows: ProviderPayoutEvent[];
}

/** WS envelope on the provider hub. `event` is byte-equal to REST rows[i]. */
export interface ProviderPayoutChronologyWsEnvelope {
  type: 'payment.chronology.updated';
  scope: 'provider';
  paymentId: string;
  event: ProviderPayoutEvent;
}

export type ConnectionStatus =
  | 'idle'
  | 'hydrating'
  | 'live'
  | 'reconnecting'
  | 'offline';
