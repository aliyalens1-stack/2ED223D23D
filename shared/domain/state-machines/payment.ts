/**
 * Payment — state machine, projections, monotonic merge, invariants.
 *
 * Three orthogonal truths for the SAME payment domain:
 *
 *   1. Operational (`PaymentStatus`)        — backend reality.
 *   2. Customer visibility                   — what the buyer sees.
 *   3. Provider settlement visibility        — what the seller sees.
 *
 * Surfaces import the projection they care about. They MUST NOT
 * branch on raw backend status strings, and they MUST NOT collapse
 * the three truths into one enum (`'paid' | 'visible' | 'earned'`
 * is a well-known anti-pattern that breaks on the first refund).
 *
 * Backend reference:
 *   - `app/payments/router.py::payment_status`
 *   - `app/payments/checkout_simple.py::get_status`
 *   - `app/packages/router_packages.py::get_status`
 *   - `app/packages/service.py::mark_payment_paid`
 *
 * Used by:
 *   - web-app/src/pages/customer/PaymentSuccessPage.tsx       (this sprint)
 *   - web-app/src/pages/provider/EarningsPage.tsx             (Payment 0C)
 *
 * Deferred (Payment 0C/0D):
 *   - `partially_refunded` granularity
 *   - `disputed` (chargeback)
 *   - `payout_in_transit` (Stripe Connect mid-flight)
 *   These are Stripe internals; we model the *product* domain first
 *   ("did the customer receive the service?") not the gateway domain.
 */
import type {
  PaymentStatus,
  PaymentCustomerVisibility,
  PaymentProviderSettlement,
  PaymentDoc,
  RawBackendPaymentStatus,
  RawGatewayPaymentStatus,
} from '../contracts/payment';

// ─────────────────────────────────────────────────────────────────────
// Lifecycle ordering — used by mergeMonotonic.
//
// Two terminal branches (`failed`, `cancelled`) sit OFF the forward
// ladder; they cannot upgrade to `paid`, only `processing` can. The
// `refunded` state is a terminal that exclusively succeeds `paid`.
// ─────────────────────────────────────────────────────────────────────

const LIFECYCLE_ORDER: Readonly<Record<PaymentStatus, number>> = {
  created: 0,
  checkout_pending: 1,
  processing: 2,
  paid: 3,
  refunded: 4,   // strictly post-`paid`, monotonic
  failed: -1,    // off-ladder terminal
  cancelled: -1, // off-ladder terminal
} as const;

// ─────────────────────────────────────────────────────────────────────
// (A) Backend → operational normalisation.
//
// Folds the raw `(status, paymentStatus)` pair seen on the wire into
// one canonical `PaymentStatus`. The pair is necessary because the
// outer `status` reflects the *session* state (Stripe Checkout) while
// `paymentStatus` reflects the *money* state (Payment Intent). When
// they disagree, the money side wins.
//
// Unknown raw values fall back to `'created'` — the safest projection,
// which never grants the customer "completed" or the provider any
// settlement. The dev invariant runner catches drift early.
// ─────────────────────────────────────────────────────────────────────

const RAW_BACKEND_STATUS_MAP: Readonly<Record<string, PaymentStatus>> = {
  // operational truths reused verbatim across the three payment surfaces
  initiated: 'created',
  pending: 'created',
  open: 'checkout_pending',
  processing: 'processing',
  paid: 'paid',
  complete: 'paid',
  expired: 'cancelled',
  cancelled: 'cancelled',
  failed: 'failed',
  error: 'failed',
  refunded: 'refunded',
} as const;

const RAW_GATEWAY_STATUS_MAP: Readonly<Record<string, PaymentStatus>> = {
  // gateway-level overrides (Stripe `payment_status`)
  paid: 'paid',
  processing: 'processing',
  unpaid: 'checkout_pending',
  // Subscription-style endpoints (no charge required) collapse to 'paid'
  // — the customer "got their thing" without money moving. Treating
  // this as `paid` is intentional: the customer projection becomes
  // 'completed', and the provider projection stays 'unavailable'
  // because there is no money to settle.
  no_payment_required: 'paid',
} as const;

/**
 * Fold raw backend `(status, paymentStatus)` into a canonical
 * `PaymentStatus`. Pure, side-effect free, never throws.
 *
 * Resolution order:
 *   1. `paymentStatus` (gateway truth) wins if present and recognised.
 *   2. Else `status` (session truth) is mapped.
 *   3. Else `'created'` (safe minimum).
 *
 * Unknown strings fall back to `'created'`; consumers should never
 * have to handle an unmapped value.
 */
export function normalizeBackendPaymentStatus(
  status: RawBackendPaymentStatus | null | undefined,
  paymentStatus?: RawGatewayPaymentStatus | null,
): PaymentStatus {
  if (paymentStatus) {
    const mapped = RAW_GATEWAY_STATUS_MAP[String(paymentStatus).toLowerCase()];
    if (mapped) {
      // Gateway says "paid" but session says "expired"/"cancelled" →
      // gateway wins. This is a real Stripe edge case (late capture
      // arriving after a session-level expiry). Money trumps session.
      return mapped;
    }
  }
  if (status) {
    const mapped = RAW_BACKEND_STATUS_MAP[String(status).toLowerCase()];
    if (mapped) return mapped;
  }
  return 'created';
}

/**
 * Convenience overload that takes the wire `PaymentDoc` directly.
 * Equivalent to `normalizeBackendPaymentStatus(doc.status, doc.paymentStatus)`.
 */
export function statusOf(doc: Pick<PaymentDoc, 'status' | 'paymentStatus'> | null | undefined): PaymentStatus {
  if (!doc) return 'created';
  return normalizeBackendPaymentStatus(doc.status, doc.paymentStatus);
}

// ─────────────────────────────────────────────────────────────────────
// (B) Allowed transitions on the operational ladder.
//
// Mirrors backend write-paths in router.py / checkout_simple.py /
// service.py. Surfaces NEVER drive transitions directly — only the
// backend mutates state — but they may compare two snapshots (poll N
// vs poll N+1) and assert legality before applying the new value.
// That is exactly what `mergeMonotonic` does.
// ─────────────────────────────────────────────────────────────────────

export function allowedTransitions(
  current: PaymentStatus,
): readonly PaymentStatus[] {
  switch (current) {
    case 'created':
      return ['checkout_pending', 'cancelled', 'failed'] as const;
    case 'checkout_pending':
      return ['processing', 'paid', 'cancelled', 'failed'] as const;
    case 'processing':
      // 'cancelled' intentionally absent — once funds are in flight
      // the customer-visible "you cancelled" path is gone; only a
      // failure or a successful capture can resolve.
      return ['paid', 'failed'] as const;
    case 'paid':
      // Refund is the ONLY post-paid transition. Re-charge is a
      // brand-new payment row, not a state change on this one.
      return ['refunded'] as const;
    case 'failed':
    case 'cancelled':
    case 'refunded':
      return [] as const;
    default:
      return [] as const;
  }
}

export function isTerminal(status: PaymentStatus): boolean {
  return status === 'paid' /* monotonic; only `refunded` may follow */
      || status === 'failed'
      || status === 'cancelled'
      || status === 'refunded';
}

// ─────────────────────────────────────────────────────────────────────
// (C) Customer visibility projection.
//
// Asymmetries vs. operational:
//   - `created` + `checkout_pending` + `processing` collapse into a
//     single 'processing' UI state. Customers don't care about gateway
//     phases; they care about a spinner.
//   - `refunded` stays `'completed'` — the customer DID receive the
//     service. Refund banner is a separate notice surface (see
//     `customerRefundNoticeFor`), not a visibility downgrade.
// ─────────────────────────────────────────────────────────────────────

export function customerVisibilityFor(
  status: PaymentStatus | null | undefined,
): PaymentCustomerVisibility {
  switch (status) {
    case 'paid':
    case 'refunded':
      return 'completed';
    case 'checkout_pending':
    case 'processing':
      return 'processing';
    case 'failed':
    case 'cancelled':
      return 'failed';
    case 'created':
    case null:
    case undefined:
    default:
      return 'hidden';
  }
}

/**
 * Should the customer-success surface show a "refund issued" banner?
 * Refund is an *additive* notice on top of `'completed'`, not a
 * visibility downgrade — see the rationale on `customerVisibilityFor`.
 */
export function customerRefundNoticeFor(
  status: PaymentStatus | null | undefined,
): boolean {
  return status === 'refunded';
}

// ─────────────────────────────────────────────────────────────────────
// (D) Provider settlement projection.
//
// Conservative for 0B: only `paid` flips the provider into
// `'pending_payout'`. `'earned'` and `'paid_out'` require a backend
// reconciliation pipeline that does NOT exist yet — this projection
// will never surface them by reading payment status alone.
//
// When the backend ships payout state it will be a SEPARATE field
// (e.g. `payoutStatus`) and `providerSettlementFor` will accept it as
// a second argument. Until then, provider UI must understand that
// settlement progress beyond `pending_payout` is opt-in.
// ─────────────────────────────────────────────────────────────────────

export function providerSettlementFor(
  status: PaymentStatus | null | undefined,
): PaymentProviderSettlement {
  switch (status) {
    case 'paid':
      return 'pending_payout';
    case 'refunded':
      // Refund REVOKES provider's earned status (regardless of customer
      // visibility). Funds went back to the customer; provider must
      // not see them in the "available for payout" bucket.
      return 'unavailable';
    case 'created':
    case 'checkout_pending':
    case 'processing':
    case 'failed':
    case 'cancelled':
    case null:
    case undefined:
    default:
      return 'unavailable';
  }
}

// ─────────────────────────────────────────────────────────────────────
// (E) Monotonic merge — refuses silent downgrades.
//
// Same role as `inspection-report.ts::mergeMonotonic`. Out-of-order
// poll responses or webhook deliveries can deliver a stale
// `'checkout_pending'` after the page has already seen `'paid'`.
// The merge function preserves the more-settled value.
//
// Rules:
//   - `paid` is sticky — never downgrades to anything except
//     `refunded` (the explicit forward-step of refund).
//   - `refunded` is sticky terminal.
//   - `failed` and `cancelled` are off-ladder; an incoming forward
//     step (e.g. `processing`) does NOT win over them — once the
//     gateway told us the payment failed, it stays failed.
//   - `null/undefined` is treated as the very bottom (any state wins).
// ─────────────────────────────────────────────────────────────────────

export function mergeMonotonic(
  prev: PaymentStatus | null | undefined,
  next: PaymentStatus | null | undefined,
): PaymentStatus | null {
  if (!prev && !next) return null;
  if (!prev) return next ?? null;
  if (!next) return prev;
  if (prev === next) return prev;

  // Refunded is the absolute terminal — nothing supersedes it.
  if (prev === 'refunded') return 'refunded';
  // Refund only legally succeeds `paid`.
  if (next === 'refunded') return prev === 'paid' ? 'refunded' : prev;

  // Paid is sticky vs. lower ladder positions and off-ladder fails.
  if (prev === 'paid') return 'paid';
  if (next === 'paid') return 'paid';

  // Off-ladder terminals are sticky vs. forward ladder positions —
  // a stale "processing" arriving after "failed" must not resurrect
  // the payment.
  if (prev === 'failed' || prev === 'cancelled') return prev;
  if (next === 'failed' || next === 'cancelled') return next;

  // Otherwise both sides are on the forward ladder; pick the higher.
  return LIFECYCLE_ORDER[next] > LIFECYCLE_ORDER[prev] ? next : prev;
}

// ─────────────────────────────────────────────────────────────────────
// (F) Self-test invariants — runtime-callable, framework-free.
//
// Same pattern as `inspection-report.ts`. Surfaces opt-in by calling
// `assertPaymentInvariants()` once on dev cold-start. Tree-shaken in
// production builds.
// ─────────────────────────────────────────────────────────────────────

export function assertPaymentInvariants(): void {
  const eq = <T>(a: T, b: T, label: string) => {
    if (a !== b) {
      throw new Error(
        `payment invariant failed: ${label} (got=${String(a)} want=${String(b)})`,
      );
    }
  };

  // ── (A) backend normalisation ──────────────────────────────────────
  eq(normalizeBackendPaymentStatus('paid'), 'paid', 'raw paid → paid');
  eq(normalizeBackendPaymentStatus('complete'), 'paid', 'raw complete → paid');
  eq(normalizeBackendPaymentStatus('initiated'), 'created', 'raw initiated → created');
  eq(normalizeBackendPaymentStatus('pending'), 'created', 'raw pending → created');
  eq(normalizeBackendPaymentStatus('open'), 'checkout_pending', 'raw open → checkout_pending');
  eq(normalizeBackendPaymentStatus('processing'), 'processing', 'raw processing → processing');
  eq(normalizeBackendPaymentStatus('expired'), 'cancelled', 'raw expired → cancelled');
  eq(normalizeBackendPaymentStatus('cancelled'), 'cancelled', 'raw cancelled → cancelled');
  eq(normalizeBackendPaymentStatus('failed'), 'failed', 'raw failed → failed');
  eq(normalizeBackendPaymentStatus('error'), 'failed', 'raw error → failed');
  eq(normalizeBackendPaymentStatus('refunded'), 'refunded', 'raw refunded → refunded');
  eq(normalizeBackendPaymentStatus(null), 'created', 'null → created (safe minimum)');
  eq(normalizeBackendPaymentStatus(undefined), 'created', 'undefined → created (safe minimum)');
  eq(normalizeBackendPaymentStatus('totally_unknown_status'), 'created', 'unknown → created (safe fallback)');
  // gateway-status precedence
  eq(normalizeBackendPaymentStatus('open', 'paid'), 'paid', 'gateway paid wins over session open');
  eq(normalizeBackendPaymentStatus('expired', 'paid'), 'paid', 'gateway paid wins over session expired (late capture)');
  eq(normalizeBackendPaymentStatus('paid', 'unpaid'), 'checkout_pending', 'gateway unpaid wins over session paid');
  eq(normalizeBackendPaymentStatus(null, 'no_payment_required'), 'paid', 'no_payment_required → paid');

  // ── (B) allowed transitions ────────────────────────────────────────
  eq(allowedTransitions('created').includes('checkout_pending'), true, 'created → checkout_pending allowed');
  eq(allowedTransitions('checkout_pending').includes('processing'), true, 'checkout_pending → processing allowed');
  eq(allowedTransitions('checkout_pending').includes('paid'), true, 'checkout_pending → paid allowed (skip processing)');
  eq(allowedTransitions('processing').includes('cancelled'), false, 'processing → cancelled forbidden');
  eq(allowedTransitions('paid').length, 1, 'paid has exactly one forward transition');
  eq(allowedTransitions('paid').includes('refunded'), true, 'paid → refunded allowed');
  eq(allowedTransitions('refunded').length, 0, 'refunded is terminal');
  eq(allowedTransitions('failed').length, 0, 'failed is terminal');
  eq(allowedTransitions('cancelled').length, 0, 'cancelled is terminal');

  eq(isTerminal('paid'), true, 'paid is terminal (modulo refund)');
  eq(isTerminal('refunded'), true, 'refunded is terminal');
  eq(isTerminal('failed'), true, 'failed is terminal');
  eq(isTerminal('cancelled'), true, 'cancelled is terminal');
  eq(isTerminal('processing'), false, 'processing is not terminal');
  eq(isTerminal('created'), false, 'created is not terminal');

  // ── (C) customer visibility ladder ─────────────────────────────────
  eq(customerVisibilityFor('paid'), 'completed', 'paid → completed');
  eq(customerVisibilityFor('refunded'), 'completed', 'refunded → still completed (NOT downgrade)');
  eq(customerVisibilityFor('processing'), 'processing', 'processing → processing');
  eq(customerVisibilityFor('checkout_pending'), 'processing', 'checkout_pending → processing (collapsed)');
  eq(customerVisibilityFor('failed'), 'failed', 'failed → failed');
  eq(customerVisibilityFor('cancelled'), 'failed', 'cancelled → failed (customer perception)');
  eq(customerVisibilityFor('created'), 'hidden', 'created → hidden');
  eq(customerVisibilityFor(null), 'hidden', 'null → hidden');
  eq(customerVisibilityFor(undefined), 'hidden', 'undefined → hidden');

  eq(customerRefundNoticeFor('refunded'), true, 'refunded shows refund banner');
  eq(customerRefundNoticeFor('paid'), false, 'paid does not show refund banner');

  // ── (D) provider settlement projection ─────────────────────────────
  eq(providerSettlementFor('paid'), 'pending_payout', 'paid → pending_payout');
  eq(providerSettlementFor('refunded'), 'unavailable', 'refunded → unavailable (revokes provider visibility)');
  eq(providerSettlementFor('processing'), 'unavailable', 'processing → unavailable');
  eq(providerSettlementFor('checkout_pending'), 'unavailable', 'checkout_pending → unavailable');
  eq(providerSettlementFor('failed'), 'unavailable', 'failed → unavailable');
  eq(providerSettlementFor('cancelled'), 'unavailable', 'cancelled → unavailable');
  eq(providerSettlementFor('created'), 'unavailable', 'created → unavailable');
  eq(providerSettlementFor(null), 'unavailable', 'null → unavailable');

  // ── (E) monotonic merge — downgrade prevention ─────────────────────
  eq(mergeMonotonic('paid', 'processing'), 'paid', 'paid sticks vs processing');
  eq(mergeMonotonic('paid', 'checkout_pending'), 'paid', 'paid sticks vs checkout_pending');
  eq(mergeMonotonic('paid', 'cancelled'), 'paid', 'paid sticks vs late cancelled');
  eq(mergeMonotonic('paid', 'failed'), 'paid', 'paid sticks vs late failed');
  eq(mergeMonotonic('refunded', 'paid'), 'refunded', 'refunded sticks vs paid');
  eq(mergeMonotonic('paid', 'refunded'), 'refunded', 'paid → refunded forward step');
  eq(mergeMonotonic('processing', 'refunded'), 'processing', 'refunded NOT legal from processing — keeps prev');
  eq(mergeMonotonic('checkout_pending', 'refunded'), 'checkout_pending', 'refunded NOT legal pre-paid');
  eq(mergeMonotonic('processing', 'paid'), 'paid', 'processing → paid forward');
  eq(mergeMonotonic('checkout_pending', 'processing'), 'processing', 'checkout_pending → processing forward');
  eq(mergeMonotonic('failed', 'processing'), 'failed', 'failed terminal vs stale processing');
  eq(mergeMonotonic('cancelled', 'processing'), 'cancelled', 'cancelled terminal vs stale processing');
  eq(mergeMonotonic(null, 'paid'), 'paid', 'null is the bottom of the ladder');
  eq(mergeMonotonic('processing', null), 'processing', 'null does not erase a known status');
  eq(mergeMonotonic('paid', 'paid'), 'paid', 'idempotent on equality');
}
