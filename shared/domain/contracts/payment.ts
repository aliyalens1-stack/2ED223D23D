/**
 * Payment — entity contract.
 *
 * MIRRORS the operational reality of three payment surfaces in the
 * backend (Stripe + PayPal):
 *   - `app/payments/router.py`         (booking quote checkout)
 *   - `app/payments/checkout_simple.py` (auto-request inline checkout)
 *   - `app/packages/service.py`        (credit-package purchases)
 *
 * Backend stores payment state across two raw fields per document:
 *   - `status`        ('initiated' | 'pending' | 'open' | 'processing'
 *                     | 'paid' | 'complete' | 'expired' | 'cancelled'
 *                     | 'failed' | 'error' | 'refunded')
 *   - `paymentStatus` ('unpaid' | 'paid' | 'no_payment_required'
 *                     | 'processing' | undefined)
 *
 * Shared owns the *semantic* domain — three orthogonal projections
 * (operational / customer / provider). The state-machine module
 * exports normalisers that fold the raw backend pair into one of these
 * projections. Surfaces import the projection they care about; they
 * never branch on raw `status` strings.
 *
 * KEEP IN SYNC: when a new backend status string lands, extend
 * `RAW_BACKEND_STATUS_MAP` in `state-machines/payment.ts` *first*,
 * then adapt consumers. There is no auto-generation by design
 * (Section K of `architecture.md` — no plugin systems / registries).
 */

// ─────────────────────────────────────────────────────────────────────
// (1) OPERATIONAL LIFECYCLE — backend truth.
//
// What the platform internally believes about the money. Admins and
// reconciliation tools care about this projection. Customers and
// providers do NOT — they get filtered slices below.
// ─────────────────────────────────────────────────────────────────────

export type PaymentStatus =
  /** Payment intent created — no checkout session opened yet. Backend
   *  insertion side-effect; never the result of a user action alone. */
  | 'created'
  /** Stripe / PayPal Checkout session opened, awaiting customer
   *  action. Customer is on the gateway page, not yet redirected back. */
  | 'checkout_pending'
  /** Gateway confirmed customer initiated payment but funds are not
   *  yet captured (3-D Secure, async banking, processing window). */
  | 'processing'
  /** Funds captured. Monotonic — does NOT revert. */
  | 'paid'
  /** Gateway returned a non-recoverable failure (card declined,
   *  authentication abandoned, fraud rule). Terminal. */
  | 'failed'
  /** Customer cancelled or session expired before paying. Terminal. */
  | 'cancelled'
  /** Funds returned after `paid`. Terminal. NOTE: a customer who paid
   *  and is later refunded still consumed the service — see
   *  `customerVisibilityFor` below. */
  | 'refunded';

export const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'created',
  'checkout_pending',
  'processing',
  'paid',
  'failed',
  'cancelled',
  'refunded',
] as const;

// ─────────────────────────────────────────────────────────────────────
// (2) CUSTOMER VISIBILITY — what the buyer is allowed to see.
//
// This is a perception domain, not a backend mirror. Two intentional
// asymmetries vs. operational:
//
//   - `processing` and `checkout_pending` collapse into one customer
//     state ('processing'). Customers don't care which gateway phase
//     they're in; they care "is my card being charged?".
//   - `refunded` does NOT downgrade to 'failed'. The customer DID
//     receive the service while it was paid; their UI still says
//     "Payment completed" with a refund banner. Mixing refund into
//     the visibility ladder destroys post-purchase analytics.
// ─────────────────────────────────────────────────────────────────────

export type PaymentCustomerVisibility =
  /** Nothing to show — payment intent doesn't exist or `created` only. */
  | 'hidden'
  /** Loading / spinner. Maps from `checkout_pending` + `processing`. */
  | 'processing'
  /** Success state. Maps from `paid` AND `refunded` (refund is a
   *  *separate* notification surface — see `customerRefundNoticeFor`). */
  | 'completed'
  /** Hard fail — card declined, expired session, customer abandon. */
  | 'failed';

// ─────────────────────────────────────────────────────────────────────
// (3) PROVIDER SETTLEMENT VISIBILITY — what the seller is allowed to see.
//
// Provider earnings ≠ customer payment completion. Two reasons:
//
//   - Stripe payouts run on a schedule (T+2…T+7 in EU). Funds may be
//     `paid` from the customer's perspective long before the provider
//     can withdraw them.
//   - A refund / chargeback after `paid` MUST hide the earning from
//     the provider's "available" bucket even if customer-side it's
//     still 'completed'.
//
// Settlement is therefore advanced INDEPENDENTLY of customer visibility
// by a backend reconciliation job (out of scope for 0B). For now the
// projection is conservative: only `paid` shows as `pending_payout`,
// nothing flips to `earned` / `paid_out` until the backend ships
// payout state. Consumers reading `'unavailable' | 'pending_payout'`
// today must NOT assume `'earned'` will ever arrive without a backend
// migration.
// ─────────────────────────────────────────────────────────────────────

export type PaymentProviderSettlement =
  /** Provider sees no earning. Either no payment exists, payment is
   *  not yet `paid`, or it was refunded / cancelled / failed. */
  | 'unavailable'
  /** Customer paid; settlement clock is running. Funds NOT withdrawable. */
  | 'pending_payout'
  /** Stripe payout window cleared; provider may withdraw. Backend must
   *  set this explicitly via reconciliation. */
  | 'earned'
  /** Provider already withdrew the funds. Terminal. */
  | 'paid_out';

// ─────────────────────────────────────────────────────────────────────
// Wire shape — what surfaces actually receive from the backend.
//
// We model the union of fields seen across the three payment surfaces;
// a given endpoint may omit some of them. Callers should treat every
// field except `id`, `status`, `amount`, `currency` as optional.
// ─────────────────────────────────────────────────────────────────────

export type PaymentProvider = 'stripe' | 'paypal';

/**
 * Backend status string as it appears on the wire. We keep this as a
 * permissive union so a freshly-added backend status doesn't crash the
 * client — `normalizeBackendPaymentStatus` falls back to `'created'`
 * for unknown values and logs (in dev) via the invariant runner.
 */
export type RawBackendPaymentStatus =
  | 'initiated'
  | 'pending'
  | 'open'
  | 'processing'
  | 'paid'
  | 'complete'
  | 'expired'
  | 'cancelled'
  | 'failed'
  | 'error'
  | 'refunded'
  | (string & {}); // permissive — see `normalizeBackendPaymentStatus`

/**
 * Stripe / emergentintegrations `payment_status` field. Some endpoints
 * surface this in addition to the operational status. When both are
 * present, normalisers look at this first (it reflects the gateway's
 * authoritative view of *the money*; the outer `status` reflects the
 * platform's view of *the session*).
 */
export type RawGatewayPaymentStatus =
  | 'unpaid'
  | 'paid'
  | 'processing'
  | 'no_payment_required'
  | (string & {});

export interface PaymentDoc {
  /** Stable platform id (uuid or Mongo `_id` string). */
  id: string;
  /** ISO-8601 currency code, lowercase. */
  currency: string;
  /** Decimal amount in the currency's major unit (EUR, USD…). */
  amount: number;
  /** Gateway used to process the payment. */
  provider?: PaymentProvider;
  /** Operational status on the wire. `null` allowed for very-new docs
   *  the backend hasn't initialised yet. */
  status: RawBackendPaymentStatus | null;
  /** Optional gateway-level payment status (`paid` / `processing` /
   *  `unpaid`…). When present, takes precedence over `status` for
   *  customer/provider projections. */
  paymentStatus?: RawGatewayPaymentStatus | null;
  /** ISO-8601 timestamp of when the payment was captured. Set only
   *  after the operational status reaches `paid`. */
  paidAt?: string | null;
  /** ISO-8601 timestamp of last backend-side update. */
  updatedAt?: string | null;
  /** Optional refund timestamp — surfaced by webhook handlers that
   *  set `status='refunded'`. */
  refundedAt?: string | null;
}
