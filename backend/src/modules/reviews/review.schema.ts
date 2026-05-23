import { Schema } from 'mongoose';

export const ReviewSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, unique: true, index: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: '' },
    // Snapshot for historical data
    snapshot: {
      serviceName: { type: String, default: '' },
      userName: { type: String, default: '' },
      vehicleInfo: { type: String, default: '' },
    },
    // Provider response
    response: {
      text: { type: String, default: '' },
      respondedAt: { type: Date, default: null },
    },
    status: { type: String, enum: ['active', 'hidden', 'flagged'], default: 'active', index: true },
    // P0.d — moderation. Invariant M3:
    // exclude-rating MUST NOT mutate rating/comment. It only flags this review
    // out of the org reputation aggregate. When toggled, org.ratingAvg is
    // recomputed by the moderation service. `restore` clears `flag` but keeps
    // `excludedFromReputation` until separately toggled.
    flagReason: { type: String, default: null },
    flaggedAt: { type: Date, default: null },
    flaggedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    excludedFromReputation: { type: Boolean, default: false, index: true },
    excludedReason: { type: String, default: null },
    excludedAt: { type: Date, default: null },
    excludedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

ReviewSchema.index({ organizationId: 1, createdAt: -1 });
ReviewSchema.index({ userId: 1, createdAt: -1 });
ReviewSchema.index({ organizationId: 1, excludedFromReputation: 1 });
