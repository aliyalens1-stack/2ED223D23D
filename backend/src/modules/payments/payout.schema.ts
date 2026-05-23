// P0.d — Payouts schema. Separate aggregating entity for provider payouts.
// Sourced from one or more PAID payments. Lifecycle is governed by an
// explicit state machine (M2):
//   pending → approved → processing → paid       (forward only)
//      ↓        ↓           ↓
//     hold ←── hold ←──── hold                   (side-branch from non-terminal)
//   processing → failed                          (terminal)
//   hold → approved                              (resume)
import { Schema } from 'mongoose';

export enum PayoutStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  PROCESSING = 'processing',
  PAID = 'paid',
  HOLD = 'hold',
  FAILED = 'failed',
}

export const PAYOUT_TERMINAL_STATUSES: ReadonlyArray<PayoutStatus> = [
  PayoutStatus.PAID,
  PayoutStatus.FAILED,
];

export function isPayoutTerminal(s: string | undefined | null): boolean {
  if (!s) return false;
  return (PAYOUT_TERMINAL_STATUSES as ReadonlyArray<string>).includes(s);
}

/**
 * Allowed transitions per state machine. Returns true if `from → to` is legal.
 * Invariant M2: paid/failed are terminal, no outgoing transitions.
 */
export function isAllowedPayoutTransition(from: string, to: string): boolean {
  const T: Record<string, PayoutStatus[]> = {
    [PayoutStatus.PENDING]: [PayoutStatus.APPROVED, PayoutStatus.HOLD],
    [PayoutStatus.APPROVED]: [PayoutStatus.PROCESSING, PayoutStatus.HOLD],
    [PayoutStatus.PROCESSING]: [PayoutStatus.PAID, PayoutStatus.FAILED, PayoutStatus.HOLD],
    [PayoutStatus.HOLD]: [PayoutStatus.APPROVED],
    [PayoutStatus.PAID]: [],
    [PayoutStatus.FAILED]: [],
  };
  const allowed = T[from] || [];
  return (allowed as ReadonlyArray<string>).includes(to);
}

export const PayoutSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    // Source payments rolled into this payout (PAID payments only).
    paymentIds: [{ type: Schema.Types.ObjectId, ref: 'Payment' }],
    // Aggregated amounts (smallest currency unit).
    totalAmount: { type: Number, required: true }, // gross
    platformFee: { type: Number, required: true },
    providerAmount: { type: Number, required: true }, // net to provider
    currency: { type: String, default: 'rub' },
    // Lifecycle
    status: {
      type: String,
      enum: Object.values(PayoutStatus),
      default: PayoutStatus.PENDING,
      index: true,
    },
    // Hold state — set when admin places hold; cleared on resume.
    holdReason: { type: String, default: null },
    holdAt: { type: Date, default: null },
    holdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    // Lifecycle timestamps (append-only intent — never rewritten retroactively)
    approvedAt: { type: Date, default: null },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    processingStartedAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
    // Stripe Connect transfer tracking (sandbox in dev, live in prod).
    stripeTransferId: { type: String, default: null, index: true },
    stripeAccountId: { type: String, default: null },
  },
  { timestamps: true },
);

PayoutSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
