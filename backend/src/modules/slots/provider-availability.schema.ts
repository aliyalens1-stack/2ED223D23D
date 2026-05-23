import { Schema } from 'mongoose';

/**
 * Provider weekly schedule: which days/hours the branch works
 */
export const ProviderAvailabilitySchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    // 0=Sunday, 1=Monday ... 6=Saturday
    weekday: { type: Number, required: true, min: 0, max: 6 },
    startTime: { type: String, required: true }, // "09:00"
    endTime: { type: String, required: true },   // "21:00"
    isWorkingDay: { type: Boolean, default: true },
  },
  { timestamps: true },
);

ProviderAvailabilitySchema.index({ branchId: 1, weekday: 1 }, { unique: true });
