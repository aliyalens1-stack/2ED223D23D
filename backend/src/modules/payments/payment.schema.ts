import { Schema } from 'mongoose';

// Full payment lifecycle statuses
export enum PaymentStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
  REQUIRES_ACTION = 'requires_action',
  PAID = 'paid',
  FAILED = 'failed',
  REFUNDED = 'refunded',
  PARTIALLY_REFUNDED = 'partially_refunded',
  CANCELLED = 'cancelled',
}

export const PaymentSchema = new Schema(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, unique: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    // Amounts (in smallest currency unit - kopecks for RUB)
    amount: { type: Number, required: true },
    currency: { type: String, default: 'rub' },
    platformFee: { type: Number, required: true },
    providerAmount: { type: Number, required: true },
    platformFeePercent: { type: Number, default: 15 },
    // 🔥 Commission Engine Log - detailed breakdown
    commissionLog: {
      base: { type: Number, default: null },
      final: { type: Number, default: null },
      providerId: { type: String, default: null },
      bookingId: { type: String, default: null },
      calculatedAt: { type: Date, default: null },
      modifiers: [{
        name: { type: String },
        value: { type: Number },
        reason: { type: String },
      }],
    },
    // Status
    status: {
      type: String,
      enum: Object.values(PaymentStatus),
      default: PaymentStatus.DRAFT,
      index: true,
    },
    // Stripe fields
    paymentProvider: { type: String, default: 'stripe' },
    paymentIntentId: { type: String, default: null, index: true },
    clientSecret: { type: String, default: null },
    chargeId: { type: String, default: null },
    refundId: { type: String, default: null },
    paymentMethod: { type: String, default: 'card' },
    // Timestamps
    paidAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    // Snapshot for history
    snapshot: {
      serviceName: { type: String, default: '' },
      orgName: { type: String, default: '' },
      userName: { type: String, default: '' },
    },
    // Metadata
    stripeMetadata: { type: Schema.Types.Mixed, default: null },
    failureReason: { type: String, default: null },
  },
  { timestamps: true },
);

PaymentSchema.index({ status: 1, createdAt: -1 });
PaymentSchema.index({ organizationId: 1, status: 1 });
