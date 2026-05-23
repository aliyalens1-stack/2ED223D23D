// Append-only audit log for dispute admin actions.
// Invariant I1 — every admin mutation writes one row here. Never updated, never deleted.
import { Schema } from 'mongoose';

export const DisputeAuditActionValues = [
  'assign',
  'unassign',
  'add_evidence',
  'request_evidence',
  'freeze_payout',
  'unfreeze_payout',
  'warn',
  'status_change',
  'note',
  'resolve',
] as const;

export type DisputeAuditAction = (typeof DisputeAuditActionValues)[number];

export const DisputeAuditSchema = new Schema(
  {
    disputeId: {
      type: Schema.Types.ObjectId,
      ref: 'Dispute',
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: DisputeAuditActionValues,
      required: true,
    },
    adminId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
    // Flexible meta — reason, target party, evidence ids, status from/to, etc.
    meta: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    // No timestamps — we have explicit `timestamp` field.
    // Append-only: no updates allowed. Enforced at service level.
    versionKey: false,
  },
);

DisputeAuditSchema.index({ disputeId: 1, timestamp: -1 });
