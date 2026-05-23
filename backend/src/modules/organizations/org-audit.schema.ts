// P0.c — Append-only audit log for org admin actions.
// Invariant I1 (P0.c) — every admin mutation writes one row. Never updated, never deleted.
import { Schema } from 'mongoose';

export const OrgAuditActionValues = [
  'verify',
  'unverify',
  'suspend',
  'unsuspend',
  'boost_activate',
  'boost_deactivate',
  'commission_set',
  'commission_clear',
  'note',
] as const;

export type OrgAuditAction = (typeof OrgAuditActionValues)[number];

export const OrgAuditSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    action: { type: String, enum: OrgAuditActionValues, required: true },
    adminId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    timestamp: { type: Date, default: Date.now, index: true },
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { versionKey: false },
);

OrgAuditSchema.index({ organizationId: 1, timestamp: -1 });
