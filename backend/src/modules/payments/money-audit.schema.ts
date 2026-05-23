// P0.d — Append-only money audit log. Single source of truth for all admin
// money/review actions across payouts/payments/reviews. Invariant M1.
// Never mutated. Never deleted. Indexed for fast trail retrieval.
import { Schema } from 'mongoose';

export const MoneyAuditEntityValues = ['payout', 'payment', 'refund', 'review'] as const;
export type MoneyAuditEntity = (typeof MoneyAuditEntityValues)[number];

export const MoneyAuditActionValues = [
  // payouts
  'payout_create',
  'payout_approve',
  'payout_hold',
  'payout_resume',
  'payout_process',
  'payout_paid',
  'payout_failed',
  // payments / refunds
  'refund_create',
  'payment_retry',
  // reviews
  'review_flag',
  'review_restore',
  'review_exclude_rating',
  'review_include_rating',
] as const;
export type MoneyAuditAction = (typeof MoneyAuditActionValues)[number];

export const MoneyAuditSchema = new Schema(
  {
    entity: { type: String, enum: MoneyAuditEntityValues, required: true, index: true },
    entityId: { type: Schema.Types.ObjectId, required: true, index: true },
    action: { type: String, enum: MoneyAuditActionValues, required: true },
    adminId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    timestamp: { type: Date, default: Date.now, index: true },
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { versionKey: false },
);

MoneyAuditSchema.index({ entity: 1, entityId: 1, timestamp: -1 });
MoneyAuditSchema.index({ action: 1, timestamp: -1 });
