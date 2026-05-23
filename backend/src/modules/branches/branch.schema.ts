import { Schema } from 'mongoose';
import { BranchStatus } from '../../shared/enums';

export const BranchSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    name: { type: String, required: true },
    city: { type: String, required: true, index: true },
    address: { type: String, required: true },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] },
    },
    workingHours: { type: Schema.Types.Mixed, default: {} },
    timezone: { type: String, default: 'Europe/Moscow' },
    status: {
      type: String,
      enum: Object.values(BranchStatus),
      default: BranchStatus.PENDING_SETUP,
      index: true,
    },
    ratingAvg: { type: Number, default: 0 },
    reviewsCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

BranchSchema.index({ location: '2dsphere' });
