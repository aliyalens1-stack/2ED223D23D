import { Schema } from 'mongoose';

export enum DisputeStatus {
  OPEN = 'open',
  REVIEWING = 'reviewing',
  ESCALATED = 'escalated',
  RESOLVED = 'resolved',
  RESOLVED_PARTIAL = 'resolved_partial',
  REFUNDED = 'refunded',
  REJECTED = 'rejected',
}

// Terminal statuses — once dispute lands here, only append-only `note` action
// is allowed. Resolution lock per invariant I2.
export const DISPUTE_TERMINAL_STATUSES: ReadonlyArray<DisputeStatus> = [
  DisputeStatus.RESOLVED,
  DisputeStatus.RESOLVED_PARTIAL,
  DisputeStatus.REFUNDED,
  DisputeStatus.REJECTED,
];

export function isDisputeTerminal(status: string | DisputeStatus | undefined | null): boolean {
  if (!status) return false;
  return (DISPUTE_TERMINAL_STATUSES as ReadonlyArray<string>).includes(status as string);
}

export enum DisputeReason {
  SERVICE_NOT_PROVIDED = 'service_not_provided',
  POOR_QUALITY = 'poor_quality',
  QUALITY = 'quality',
  OVERCHARGED = 'overcharged',
  RUDE_SERVICE = 'rude_service',
  NO_SHOW = 'no_show',
  OTHER = 'other',
}

const DisputeMessageSchema = new Schema(
  {
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    senderRole: { type: String, enum: ['customer', 'provider', 'admin'], required: true },
    message: { type: String, required: true },
    attachments: [{ type: String }],
  },
  { timestamps: true },
);

export const DisputeSchema = new Schema(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', default: null },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    // Dispute details
    reason: {
      type: String,
      enum: Object.values(DisputeReason),
      required: true,
    },
    description: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(DisputeStatus),
      default: DisputeStatus.OPEN,
      index: true,
    },
    // Messages
    messages: [DisputeMessageSchema],
    // Resolution
    resolution: { type: String, default: '' },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
    // P0.a additions — admin governance fields.
    // Optional, default-null/false so they don't break existing documents.
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    assignedAt: { type: Date, default: null },
    payoutFrozen: { type: Boolean, default: false, index: true },
    payoutFrozenReason: { type: String, default: '' },
    payoutFrozenAt: { type: Date, default: null },
    payoutFrozenBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    // Last admin warning issued (for repeat-warning detection).
    lastWarnedAt: { type: Date, default: null },
    warnCount: { type: Number, default: 0 },
    // Snapshot
    snapshot: {
      serviceName: { type: String, default: '' },
      orgName: { type: String, default: '' },
      userName: { type: String, default: '' },
      amount: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);

DisputeSchema.index({ status: 1, createdAt: -1 });
