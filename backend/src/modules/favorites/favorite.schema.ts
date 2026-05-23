import { Schema } from 'mongoose';

export const FavoriteSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    // Snapshot for quick display
    snapshot: {
      name: { type: String, default: '' },
      ratingAvg: { type: Number, default: 0 },
      reviewsCount: { type: Number, default: 0 },
      city: { type: String, default: '' },
    },
  },
  { timestamps: true },
);

// Unique constraint - one favorite per user-org pair
FavoriteSchema.index({ userId: 1, organizationId: 1 }, { unique: true });
