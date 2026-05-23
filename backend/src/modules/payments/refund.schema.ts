// P0.d — Append-only refund records. Invariant M1:
// Money mutations are monotonic — refunds NEVER mutate the original Payment
// document's amount/providerAmount. They are recorded as separate rows here.
// The Payment.status may transition to REFUNDED or PARTIALLY_REFUNDED, but
// historical amounts remain immutable.
import { Schema } from 'mongoose';

export enum RefundStatus {
  PENDING = 'pending',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
}

export const RefundSchema = new Schema(
  {
    paymentId: {
      type: Schema.Types.ObjectId,
      ref: 'Payment',
      required: true,
      index: true,
    },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', default: null },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    amount: { type: Number, required: true }, // smallest currency unit
    currency: { type: String, default: 'rub' },
    reason: { type: String, required: true },
    kind: { type: String, enum: ['full', 'partial'], required: true },
    status: {
      type: String,
      enum: Object.values(RefundStatus),
      default: RefundStatus.SUCCEEDED, // sandbox-mode immediate-success default
      index: true,
    },
    initiatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    stripeRefundId: { type: String, default: null },
    failureReason: { type: String, default: null },
    // Idempotency key — generated server-side as `${paymentId}_${ts}` if not provided.
    idempotencyKey: { type: String, default: null, index: true },
  },
  { timestamps: true, versionKey: false },
);

RefundSchema.index({ paymentId: 1, createdAt: -1 });
RefundSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
