import { Schema } from 'mongoose';

// Ledger: every payment operation is recorded
export enum TransactionType {
  INTENT_CREATED = 'intent_created',
  INTENT_CONFIRMED = 'intent_confirmed',
  PAYMENT_CAPTURED = 'payment_captured',
  PAYMENT_FAILED = 'payment_failed',
  REFUND_INITIATED = 'refund_initiated',
  REFUND_COMPLETED = 'refund_completed',
  WEBHOOK_SYNC = 'webhook_sync',
}

export const PaymentTransactionSchema = new Schema(
  {
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', required: true, index: true },
    type: {
      type: String,
      enum: Object.values(TransactionType),
      required: true,
    },
    amount: { type: Number, default: 0 },
    status: { type: String, default: '' },
    externalId: { type: String, default: null },
    payloadSnapshot: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

PaymentTransactionSchema.index({ paymentId: 1, createdAt: -1 });
